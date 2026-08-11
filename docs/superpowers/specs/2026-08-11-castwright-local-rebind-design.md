# One-click `castwright.local` re-bind + sliding device-token renewal

**Date:** 2026-08-11
**Status:** approved (design)
**Area:** `frontend` + `server` (LAN device auth)

## Problem

Browsing the app at `https://castwright.local` returns a dead-end error —
_"Couldn't load your library / Library scan failed (401): {"error":"Missing or
invalid LAN access token."}"_ — every time the host browser's device token
lapses.

Two things make this bite:

1. **It expires on a 30-day clock.** `POST /api/pair/redeem-browser` mints the
   device with `ttl()` days (`lan.deviceTokenTtlDays`, default 30) and sets the
   `__Host-cw_lan` cookie with a matching `maxAge`
   (`server/src/routes/pairing.ts:163-172`). Nothing renews either.
2. **The failing origin cannot fix itself.** The cookie is `__Host-` prefixed,
   so it is origin-scoped and only a response served *from* `castwright.local`
   can set it. But minting requires loopback (`POST /api/devices/pair-session`)
   or an already-authenticated friendly-host request
   (`mayStartPairingSession`, `server/src/lan-auth.ts:138`). An expired browser
   on `castwright.local` is neither, so recovery must start on
   `https://localhost:8443`.

Note the host's own browser is genuinely non-loopback on the `:443` path: the
forwarder presents peer IP `127.0.0.2`, which the loopback allowlist
(`lan-auth.ts:103`) deliberately excludes — see the rationale at
`lan-auth.ts:133-136`. That exclusion is **not** revisited here.

## What already exists

The mechanism is entirely built; it is only buried and unrenewed. Today's path:

Account → LAN access → type a device name → **Authorize a device** → QR renders
→ small link _"Open pairing link on castwright.local"_
(`src/components/lan-access-card.tsx:70-77`) → `castwright.local/#/pair?c=CODE`
→ **Authorize** (`src/views/pair.tsx`) → `POST /api/pair/redeem-browser` sets
the cookie → library loads.

That is a typed label and four clicks through a flow designed for phones, with
no pointer to it from the screen that actually fails. This design does not add
a new mechanism; it adds a direct entry point, a way out at the failure site,
and renewal.

## Decisions taken

| Decision | Choice |
|---|---|
| Expiry policy | Button **and** auto-renew — recovery is one click, and renewal means it is rarely needed |
| Renewal scope | **Any device still in use**, not just the host browser (uniform, simpler) |
| Self-bind confirm screen | **Auto-redeem** on the self-bind hop; the confirm screen stays for QR-scanned devices |
| `:443` forwarder trust | Unchanged — `127.0.0.2` stays outside the loopback allowlist |

## Component 1 — Sliding renewal (server)

**File:** `server/src/workspace/device-tokens.ts`

`touchLastSeen` already runs on guarded requests behind an hourly throttle
(`shouldTouch`, ~`device-tokens.ts:520`). Extend that same write to also
advance `expiresAt` to `now + clampTtlDays(configValue('lan.deviceTokenTtlDays'))`.

Invariants, all of which need a test:

- **Only currently-valid, non-revoked records renew.** An expired or revoked
  token is never resurrected — that is the security-relevant line, and the
  renewal must be computed after the existing validity check, not before it.
- **Write frequency is unchanged.** Renewal piggybacks on the existing hourly
  throttle; it never adds a write of its own.
- **A genuinely idle device still lapses.** Nothing touches it, so nothing
  renews it, and it expires on the original clock.

This is an *explicit granted renewal on use*, which is deliberately distinct
from the "never silently re-issue an expiry the operator never granted" rule at
`device-tokens.ts:160-168` — that rule governs **repairing malformed records**
at load time. The distinction is worth a comment in the code, because it is the
first question a reviewer will ask.

**Accepted consequence:** a device that authenticates at least once per TTL
window never expires. That is the intent of the chosen policy; ageing a device
out now means revoking it, which the LAN access card already supports.

## Component 2 — One-click self-bind (frontend)

**File:** `src/components/lan-access-card.tsx`

Add a second button, **"Authorize this browser"**, beside the existing device
flow. It calls `api.createDevicePairSession({ label: 'This computer' })` and
navigates to the returned `friendlyUrl` with `&self=1` appended.

- Rendered **only** when the response carries `friendlyUrl`, which the server
  emits solely when `isFriendlyHostnameReachable()` is true
  (`server/src/routes/devices.ts:106-110`). A box where `castwright.local`
  is not reachable shows no button rather than a dead link.
- No label field and no QR on this path.
- The existing "Authorize a device" QR flow is **untouched**, so phones and
  tablets behave exactly as they do today.

## Component 3 — Auto-redeem on the self-bind hop (frontend)

**File:** `src/views/pair.tsx`

When the URL carries `self=1`, redeem immediately on mount instead of waiting
for a click; render the existing error states unchanged on failure.

`self=1` is client-controlled, so it must not be treated as a trust signal —
and it is not one. The gate is the one-time code, which is obtainable only from
loopback or an already-authenticated friendly-host request, is single-use, is
rate-limited to 5/min per IP (`pairing.ts:90-100`), and expires in 10 minutes
(`createPairingSession(label, undefined, 10)`). The flag removes a click, not a
check: anyone holding the URL already holds the code, which the confirm screen
never protected against.

## Component 4 — A way out at the failure site (frontend)

The library error state currently surfaces the raw
`Library scan failed (401): {"error":…}`. When the failure is a 401 from the
LAN guard it becomes plain language plus a link to `https://localhost:8443` —
the only origin that can start a re-bind — and stops printing raw JSON.

This is the piece that removes the "not easy" part: the failure always lands on
the one origin that cannot fix itself, so the message has to point off-origin.

## Data flow

```
loopback page (https://localhost:8443)
  └─ POST /api/devices/pair-session          → { url, code, expiresAt, friendlyUrl }
     └─ navigate https://castwright.local/#/pair?c=CODE&self=1
        └─ POST /api/pair/redeem-browser     → createDevice(label, ttlDays)
           └─ Set-Cookie __Host-cw_lan       (pairing.ts:166)
              └─ redirect '/' → library loads
```

Cookies ignore port, so one bind covers both `:443` and `:8443`.

## Error handling

Every failure mode is already handled by the endpoints in play; this design
keeps their behaviour rather than adding paths:

| Condition | Response | Surfaced as |
|---|---|---|
| LAN HTTPS not active | `409 not-lan-https` | Button hidden (no `friendlyUrl`) |
| Guard not enforced | `409 lan-auth-not-enforced` | Button hidden |
| Wrong origin | `403` + `PAIRING_ORIGIN_HINT` | Existing hint text |
| Stale / reused code | `401` / `410` | "This code expired — generate a new one on the desktop." |
| Rate cap (5/min per IP) | `429` | "Too many attempts — wait a minute and try again." |
| Device store degraded | `503` | Existing message; the one-time code is restored (`pairing.ts:177`) |

## Testing

**Server unit** (`device-tokens`): touch advances `expiresAt`; an expired record
is never renewed; a revoked record is never renewed; the hourly throttle still
suppresses the write (and therefore the renewal); a device idle past the TTL
still lapses.

**Frontend unit**: the self-bind button mints with the fixed label and navigates
to `friendlyUrl` with `self=1`; it does not render when `friendlyUrl` is absent;
`#/pair?self=1` redeems on mount while the bare `#/pair` still waits for a
click; the 401 library error renders the recovery link and no raw JSON.

**E2E** (`e2e/lan-device-auth.spec.ts`, extended): the change crosses
router/redux seams, which is the repo's bar for a Playwright spec.

**On-box acceptance**: the real round-trip needs live mDNS, the `:443`
forwarder and a real cert, none of which CI has — this becomes a row in
`docs/testing/onbox-acceptance-register.md`, observing that a browser whose
cookie was cleared recovers via the button in one click, and that a device used
daily shows a receding `expires` date in the LAN access list.

## Out of scope

- Widening the loopback allowlist to include the `:443` forwarder's `127.0.0.2`.
- Any change to QR-based pairing for phones and tablets.
- Changing the default `lan.deviceTokenTtlDays`.
