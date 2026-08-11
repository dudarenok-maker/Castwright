# One-click `castwright.local` re-bind + a longer device-token lifetime

**Date:** 2026-08-11
**Status:** approved (design, revision 2)
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
   (`server/src/routes/pairing.ts:163-172`).
2. **The failing origin cannot fix itself.** The cookie is `__Host-` prefixed,
   so it is origin-scoped and only a response served *from* `castwright.local`
   can set it. Minting requires loopback (`POST /api/devices/pair-session`) or
   an already-authenticated friendly-host request (`mayStartPairingSession`,
   `server/src/lan-auth.ts:138`). An expired browser on `castwright.local` is
   neither, so recovery must start on the loopback origin.

The host's own browser is genuinely non-loopback on the `:443` path: the
forwarder presents peer IP `127.0.0.2`, which the loopback allowlist
(`lan-auth.ts:103`) deliberately excludes — see `lan-auth.ts:133-136`. That
exclusion is **not** revisited here.

## What already exists

The mechanism is entirely built; it is only buried. Today's path: Account → LAN
access → type a device name → **Authorize a device** → QR renders → small link
_"Open pairing link on castwright.local"_ (`src/components/lan-access-card.tsx:70-77`)
→ `castwright.local/#/pair?c=CODE` → **Authorize** (`src/views/pair.tsx`) →
`POST /api/pair/redeem-browser` sets the cookie → library loads.

A typed label and four clicks through a flow designed for phones, with no
pointer to it from the screen that actually fails. This design adds a direct
entry point, a way out at the failure site, and a lifetime long enough that the
first two are rarely needed.

## Revision 2 — what changed and why

Revision 1 proposed sliding `expiresAt` forward inside `touchLastSeen`. An
adversarial review killed it, correctly:

- **The cookie is never re-issued.** `res.cookie('__Host-cw_lan', …)` at
  `pairing.ts:166` is the *only* `Set-Cookie` in the entire server (verified:
  `grep -rn "res.cookie" server/src` returns one non-test hit). `touchLastSeen`
  is never given a `Response`. Sliding the server-side record leaves the
  browser dropping its cookie on schedule — the reported failure was untouched.
- **The write closure has no validity check.** `touchLastSeen`
  (`device-tokens.ts:535-542`) re-reads and writes inside `enqueueWrite`, which
  queues behind every prior write; the `revoked`/`expiresAt` test lives in
  `isValidDeviceToken` *before* that queue. Adding `expiresAt` to the closure's
  `map` would let a token that lapsed between check and write receive a fresh
  expiry.

Both problems disappear by raising the lifetime instead of renewing it.

## Decisions taken

| Decision | Choice |
|---|---|
| Lifetime | Raise the `lan.deviceTokenTtlDays` **default**; no renewal machinery |
| Recovery | One-click self-bind button + a way out at the 401 |
| Self-bind confirm screen | **Auto-redeem** on the self-bind hop; confirm stays for QR-scanned devices |
| `:443` forwarder trust | Unchanged — `127.0.0.2` stays outside the loopback allowlist |

## Component 1 — Longer default lifetime (server)

**File:** `server/src/config/registry.ts:1254-1263`

Change `lan.deviceTokenTtlDays`'s `default` from `30` to `365`. The descriptor
already carries `label`, `help`, `type: 'integer'`, `min: 1`, `apply: 'live'`
and a `lan-access` group, so it already renders a Settings row and needs no new
UI. `env: LAN_DEVICE_TTL_DAYS` continues to override it.

Align `clampTtlDays`'s hardcoded fallback (`device-tokens.ts:84-87`, currently
`30`) with the new default, so a malformed config value doesn't silently
reinstate the old lifetime. Both constants must move together, with a test that
pins them equal.

Three consequences to state plainly:

- **New mints only.** Existing device records keep their stored `expiresAt`;
  nothing rewrites them. Today's expired browser picks up the longer lifetime
  by re-binding once, via Component 2.
- **365 stays under the browser cap.** Chrome and Safari clamp cookie
  `Max-Age` to ~400 days; `maxAge: 365 * 86_400_000` is inside it. A larger
  value would be silently truncated by the browser while the server-side record
  kept the longer date — so 365 is a ceiling of convenience, not an arbitrary
  pick, and the spec deliberately does not go higher.
- **Ageing a device out is now deliberate.** A year is long enough that
  revoking in the LAN access list becomes the real removal path. This is the
  accepted trade of the chosen option.

## Component 2 — One-click self-bind (frontend + a small server fix)

**Files:** `src/components/lan-access-card.tsx`, `server/src/routes/devices.ts`

Add a second button, **"Authorize this browser"**, beside the existing device
flow. It calls `api.createDevicePairSession({ label: 'This computer' })` and
navigates to the returned `friendlyUrl`, with `self=1` appended.

Two corrections the review surfaced:

- **`friendlyUrl` is emitted too narrowly.** Today it requires *both* the mDNS
  responder alive and the `:443` forwarder bound (`server/src/index.ts:360-362`
  feeding `devices.ts:106-110`). But re-binding works fine over
  `https://castwright.local:8443` — `mayStartPairingSession`
  (`lan-auth.ts:138-140`) accepts friendly-hostname + enforced regardless of the
  forwarder. So the emitter must fall back to the actual bound port when the
  forwarder is not bound, instead of returning `undefined` and hiding a button
  that would have worked.
- **Repeat binds accumulate credentials.** Each click mints a new record; the
  old token stays valid even though its cookie was overwritten in that browser.
  The self-bind path revokes any prior non-revoked record carrying the same
  self-bind marker before minting, so the list holds one "This computer" row.
  The marker must be a stored field, not the display label, which the user can
  edit.

The existing "Authorize a device" QR flow is untouched; phones and tablets
behave exactly as today.

## Component 3 — Auto-redeem on the self-bind hop (frontend)

**File:** `src/views/pair.tsx`

When the URL carries `self=1`, redeem on mount instead of waiting for a click.

**Scrub the code from the URL *before* the redeem call, not after.** Today
`pair.tsx:19` calls `window.history.replaceState(null, '', '#/')` inside the
`try`, only on success — so a failed or interrupted redeem leaves
`#/pair?c=CODE&self=1` live in history for the rest of the code's TTL, now
armed to fire on a tab restore, a Back navigation, or a refresh. With
auto-redeem that turns a stale history entry into an unattended side effect.

The security argument for auto-redeem, corrected: the gate is the one-time
code, which is single-use, rate-limited to 5/min per IP
(`pairing.ts:90-100`), carries 80 bits of entropy, and expires in **5 minutes**
(`TTL_MS` at `server/src/workspace/pairing-sessions.ts:11` — note the third
argument to `createPairingSession(label, undefined, 10)` is `bytes`, i.e. code
length, **not** minutes; revision 1 misread this). `self=1` is client-controlled
and is not a trust signal. What it genuinely trades away is the
accidental-navigation guard the confirm screen provided — which is why the
scrub-before-redeem above is a requirement of this component, not a nicety.

## Component 4 — A way out at the failure site (frontend)

**Files:** `src/lib/api.ts`, `src/store/library-slice.ts`,
`src/components/layout.tsx`, `src/views/book-library.tsx`,
`src/components/lan-access-card.tsx`

The status code is not currently available where the message is rendered.
`realGetLibrary` (`api.ts:1943-1946`) throws a plain `Error`, not `ApiError`;
`layout.tsx:581` flattens it to `err.message`; `library-slice.ts:15` stores
`error: string | null`; `book-library.tsx:399` prints that string. So the
implementation must:

1. Throw `ApiError` from `realGetLibrary` (matching `realCreateDevicePairSession`
   at `api.ts:7298`, which already does).
2. Carry the status through the slice and into the view.
3. Branch on `401` to render plain language plus a recovery link — and stop
   printing raw JSON in every case.

**Do not string-match `/\(401\)/` on the message.** A test asserting that would
be circular, and the seam above is what makes a real assertion possible.

Also fix the second dead end the review found: on `castwright.local` with a
lapsed cookie, the Account page's LAN card renders only "Manage devices from
the desktop app." (`lan-access-card.tsx:55-56`) with no pointer anywhere. It
gets the same recovery text.

**The link address must not be hardcoded to `:8443`.** Production enables
auto-rebind (`server/src/index.ts:425`, `:436-441`), so a taken 8443 shifts the
real bind to 8444+, and the 401'd page cannot ask the server which port it got.
Two acceptable resolutions, to be chosen in the plan: expose the bound loopback
URL on an unguarded surface the failing page can read, or word the copy so it
names the computer rather than promising a specific port. A dead link in the
component whose entire job is un-stranding the user is the one outcome that is
not acceptable.

## Data flow

```
loopback page (https://localhost:<bound port>)
  └─ POST /api/devices/pair-session          → { url, code, expiresAt, friendlyUrl }
     └─ navigate https://castwright.local/#/pair?c=CODE&self=1
        └─ scrub code from history
           └─ POST /api/pair/redeem-browser  → createDevice(label, ttlDays)
              └─ Set-Cookie __Host-cw_lan    (pairing.ts:166)
                 └─ redirect '/' → library loads
```

Cookies ignore port, so one bind covers `castwright.local` on both `:443` and
`:8443`. It does **not** cover `https://localhost:8443`, a different host, which
relies entirely on the loopback exemption.

## Error handling

| Condition | Response | Surfaced as |
|---|---|---|
| LAN HTTPS not active | `409 not-lan-https` | Button hidden |
| Guard not enforced | `409 lan-auth-not-enforced` | Button hidden |
| Off-LAN redeem | `403` "Pairing can only be redeemed from the local network." | Needs a branch — see below |
| Stale / reused code | `401` / `410` | "This code expired — generate a new one on the desktop." |
| Rate cap (5/min per IP) | `429` | "Too many attempts — wait a minute and try again." |
| Device store degraded | `503` | Needs a branch — see below |

`pair.tsx:22-26` currently maps everything that is not 401/410/429 to the
generic "Could not authorize this browser." With auto-redeem the user took no
action to explain the failure, so `403` and `503` need their own messages —
`503` in particular is transient and worth saying so. `PAIRING_ORIGIN_HINT` is
**not** what `/redeem-browser` returns; it only ever reaches the loopback card
(`lan-access-card.tsx:34-35`). Revision 1's table was wrong on both rows.

## Testing

**Server unit:** the registry default is 365 and `clampTtlDays`'s fallback
equals it (one test pinning both, so they can never drift); a token minted
today expires ~365 days out.

**Frontend unit:** the self-bind button mints with the self-bind marker and
navigates to `friendlyUrl` with `self=1`; a prior self-bind record is revoked
before the new mint; `#/pair?self=1` redeems on mount while bare `#/pair` still
waits for a click; the code is scrubbed from history **before** the redeem
resolves (assert ordering, not just the end state); a 401 library error renders
the recovery link via the `ApiError` status, not a string match; `403` and `503`
render their own messages.

**E2E** (`e2e/lan-device-auth.spec.ts`, extended): only the
`#/pair?c=…&self=1` auto-redeem half is reachable — the button navigates to an
absolute `https://castwright.local/…` URL that Playwright's mock-mode server on
:5174 cannot resolve. The button half is a unit test with `window.location`
stubbed. Note `mockCreateDevicePairSession` (`api.ts:7341-7347`) always returns
`friendlyUrl`, so the absent-`friendlyUrl` case cannot come from mock mode.

**On-box acceptance:** `friendlyUrl` is only emitted under
`NODE_ENV === 'production'` (`lan-port-forwarder.ts:40-43` gates the responder
and forwarder), so `npm run dev:lan` can never render the button. The on-box row
is therefore load-bearing, not supplementary: it must confirm a cleared-cookie
browser recovers in one click on the real box, and that a freshly bound device
shows an `expires` roughly a year out in the LAN access list.

## Repo obligations (not optional)

- A GitHub issue, with this spec's implementation brief as a comment, and
  `Closes #NN` in the PR body (`pr-issue-link.yml` + required status check).
- `docs/features/225-lan-browser-device-auth.md` is `active` and documents the
  30-day behaviour (its "No token is born without an `expiresAt`" line and the
  knob's default) — it moves in the same diff.
- `docs/features/INDEX.md` if the plan doc is new.
- `npm run config:sync` after the default change, so `server/.env.example`
  regenerates; `config:check` runs in the verify battery.
- Release notes in **both** `docs/release-notes-next.md` and `RELEASE_NOTES.md`
  — this is user-visible.

## Out of scope

- Widening the loopback allowlist to include the `:443` forwarder's `127.0.0.2`.
- Re-issuing the cookie from the LAN guard (the revision-1 renewal approach).
- Any change to QR-based pairing for phones and tablets.
