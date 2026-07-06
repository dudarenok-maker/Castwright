---
status: draft
date: 2026-07-06
topic: one-click LAN-pairing link for castwright.local, alongside the existing QR
---

# One-click castwright.local pairing link

_Design spec · 2026-07-06_

This spec is **design/plan only** — implementation is a separate handover.

## Problem

`LAN_AUTH_TOKEN` (srv-20/srv-33, `server/src/lan-auth.ts`) requires every non-loopback
request to pair before the library loads. The friendly hostnames from plan 239
(`castwright.local` under `start:lan`) go through this same non-loopback path — even when
typed into a browser on the desktop machine itself — so `https://castwright.local/#/` loads
the app shell but the library fetch 401s with "Missing or invalid LAN access token" until
that browser is paired (see `docs/wiki/Troubleshooting.md`'s new entry, added while
diagnosing this).

The only shipped way to pair a browser today is `LanAccessCard`'s QR code
(`src/components/lan-access-card.tsx`, backed by `POST /api/devices/pair-session`,
`server/src/routes/devices.ts:46-66`) — designed for a phone camera. For the common
same-machine case (testing `castwright.local` from the same desktop that's already running
the loopback-authorized admin session), there is no camera to scan through: the QR component
(`src/components/pairing/pairing-qr.tsx`) renders only an `<img>`, never the code as text, and
the frontend's session state doesn't even retain the `code` field the API already returns —
so there's no supported manual path either. The only current workaround is using
`https://localhost:8443` instead, which sidesteps the friendly hostname entirely rather than
authorizing it.

## Goal

Add a one-click way to authorize the *same browser* for `https://castwright.local` from an
already-loopback-authorized tab (e.g. `localhost:8443`) — no camera, no manual code entry, no
`localhost`-only workaround.

## Approaches considered

- **A (chosen): additive same-origin link.** `POST /api/devices/pair-session` gains an
  optional `friendlyUrl` field pointing at `https://castwright.local/#/pair?c=<code>`,
  populated only when the server is actually serving that hostname (start:lan/production).
  `LanAccessCard` renders a plain link next to the existing QR when present. The QR/raw-IP
  `url` field is untouched — this is purely additive.
- **B (rejected): make the friendly hostname the primary QR target everywhere.** Would avoid a
  new field, but changes the QR a real phone scans too. `castwright.local` mDNS resolution is
  a known-flakier path across devices/routers than the raw LAN IP (plan 239's own accepted
  limitations, ops-21/#1239) — not worth risking the real phone-pairing case to fix a desktop
  convenience gap.
- **C (rejected): return every candidate URL (all LAN IPs + friendly hostname) for the UI to
  pick from.** More general than what's needed — nothing here calls for multi-host choice.

## Scope

**start:lan (production) only.** The server only reliably knows `castwright.local` is being
served under that mode — the same `NODE_ENV === 'production'` discriminator already used by
`shouldSpawnMdnsResponder`/`shouldSpawnPortForwarder` (`server/src/mdns-owner.ts`,
`server/src/lan-port-forwarder.ts`). Under `dev:lan`, `castwright.dev.local` is served by a
sibling `concurrently` process the server doesn't track — extending this there would need a
new env var threading the hostname into the dev server leg, deliberately deferred (confirmed
with the user — smaller change now, dev:lan keeps the QR-only flow).

## Design

### Backend — `server/src/routes/devices.ts`

In the `POST /devices/pair-session` handler, after minting `{ code, expiresAt }` via
`createPairingSession`, add (new import: `shouldSpawnMdnsResponder` from `../mdns-owner.js`):

```ts
// isLanTokenEnforced() above already returned 409 if LAN HTTPS were off, so
// lanHttps is known true here — only NODE_ENV is still in question.
const friendlyUrl = shouldSpawnMdnsResponder(true)
  ? `https://castwright.local/#/pair?c=${code}`
  : undefined;
res.json({ url: `https://${host}/#/pair?c=${code}`, code, expiresAt, friendlyUrl });
```

Reuses `shouldSpawnMdnsResponder` directly rather than re-deriving the
`NODE_ENV === 'production'` condition, so the two can never silently drift — same reasoning
already documented in `lan-port-forwarder.ts`'s `shouldSpawnPortForwarder`.

No change to the existing `url` field, `code`, or `expiresAt` — additive only.

### Frontend — `src/components/lan-access-card.tsx`

Widen the session state type:

```ts
const [session, setSession] = useState<
  { url: string; friendlyUrl?: string; expiresAt: number } | null
>(null);
```

Render, directly below the existing `<PairingQr>` block, only when `session.friendlyUrl` is
set:

```tsx
{session.friendlyUrl && (
  <a
    href={session.friendlyUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="mt-3 inline-block text-sm text-magenta hover:underline"
  >
    Open pairing link on castwright.local
  </a>
)}
```

Plain `<a target="_blank">`, not a `window.open()` call — standard link semantics (middle-click
/ "open in new tab" / accessibility all work for free, no popup-blocker edge cases).

Clicking it opens `PairShell` (`src/views/pair.tsx`) in a new tab at `castwright.local`,
showing its existing "Authorize this browser?" confirmation — that extra click stays exactly
as it is today for QR-scanned pairing; this only removes the *photograph a QR code* step, not
the confirmation step.

### Security

No new surface: `friendlyUrl` carries the exact same short-lived (10-minute TTL), single-use,
rate-limited (`redeemLimiter`, `pairing.ts`) code already exposed via the QR image, gated
behind the same loopback-only `/devices/pair-session` endpoint. It's a second rendering of a
secret the caller could already see, not a new one.

### Error handling

None new. A stale/expired code clicked after the TTL hits `PairShell`'s existing "This code
expired — generate a new one on the desktop" branch (`src/views/pair.tsx:22-23`) exactly as it
does today for the QR path.

## Testing

- **`server/src/routes/devices.test.ts`**: assert `friendlyUrl` is present and correctly
  formed when the request is loopback + LAN HTTPS enforced + `NODE_ENV=production`; assert
  it's `undefined` when `NODE_ENV` is anything else (dev:lan shape).
- **`src/components/lan-access-card.test.tsx`**: assert the link renders with the correct
  `href` when the mocked `createDevicePairSession` response includes `friendlyUrl`; assert it
  does not render when the field is absent (today's dev:lan / non-production behavior
  unchanged).

No e2e coverage needed — this is additive UI behind an already-loopback-gated admin flow, not
a new user-facing surface reachable from `npm run test:e2e`'s mock-mode Vite instance (which
doesn't run under `NODE_ENV=production` LAN HTTPS).

## Out of scope

- `dev:lan` / `castwright.dev.local` support (see Scope above) — deferred, would need a new
  env var threading the friendly hostname into the dev server leg.
- Manual short-code text entry as a fallback for devices without a camera — a real gap for
  actual phones/tablets with a broken camera, but out of scope for this same-machine-focused
  change; a candidate follow-up if it comes up again.
- Any change to the QR/raw-IP pairing path used by real phone/tablet/companion-app pairing —
  untouched by this spec.
