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

### Correction from adversarial review, round 1 (2026-07-06)

The first draft gated `friendlyUrl` purely on `NODE_ENV === 'production'` (via
`shouldSpawnMdnsResponder(true)`) — a **Critical/Contradicted** finding from the mandatory
`assumption-checker` pass: that predicate proves configuration *intent*, not that the mDNS
responder or the `:443` forwarder actually came up. Both `spawnMdnsResponder` and
`startPortForwarder` are documented to **never throw** on failure — a bind/spawn failure is
only logged, and the caller still gets a handle back (`mdns-owner.ts`'s own docstring;
`lan-port-forwarder.ts:51-53`). So the env-only gate could hand the UI a `friendlyUrl` that
resolves to nothing, for exactly the same-machine-without-a-camera user this feature exists to
help — worse than the QR-only status quo, since that user has no fallback. Fixed below by
gating on **actual observed liveness** of both processes, not the launch predicate.

### Correction from adversarial review, round 2 (2026-07-06)

Round 1's fix had its own hole, also **Critical/Contradicted**: the proposed `isAlive` closure
only flipped `alive = false` when `code !== 0` — but `scripts/mdns-responder.mjs`'s *only*
voluntary exit path, a multicast bind failure (EACCES, or blocked by a firewall/OS policy), is
`mdns.once('error', ...) → process.exit(0)` (mdns-responder.mjs:111-119). So the exact
graceful-give-up case the gate exists to catch left `alive === true` for a process that had
already exited and was serving nothing — reopening the original gap it was meant to close.

**Fix:** since this script has no *other* voluntary self-exit path (a healthy responder is a
long-running process that only ever leaves via an external kill), any non-intentional exit —
code 0 included — reliably means "no longer serving," not just a nonzero one:

```ts
child.once('exit', (code, signal) => {
  if (killedIntentionally) return;
  alive = false; // ANY non-intentional exit means no longer serving — this script's only
                  // voluntary exit path (a bind failure) is itself code 0, so code===0 is not
                  // a "fine, ignore it" case here, unlike a typical long-running service.
  if (code !== 0) {
    warn(`[mdns] responder for ${hostname} exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ''})`);
  }
});
```

(The `warn()` call stays gated to `code !== 0` — the graceful bind-failure case already logs
its own message from inside `mdns-responder.mjs` itself, so a second warning here would be
redundant, not incorrect.)

**Residual, accepted limitation (distinct from the gap just fixed):** there's a brief
millisecond-scale window right after spawn, before the responder's async multicast bind
either succeeds or fails, where `alive` is optimistically `true` and no exit has fired yet.
A `friendlyUrl` click landing in that exact window could still fail once. This is inherent to
any async-readiness signal without a dedicated ready/bind-failed IPC handshake (out of scope —
would mean changing `spawnMdnsResponder`'s `stdio: 'ignore'` to add an IPC channel, a
meaningfully bigger change for a race too narrow to be worth it) — not a regression from the
current QR-only status quo, which has no readiness signal at all.

### Backend — liveness tracking for the two LAN helper processes

**`server/src/lan-port-forwarder.ts`**: add a closure-scoped `bound` flag to
`PortForwarderHandle`, set `true` only on the server's `'listening'` event (never reset back to
`false` by a later transient `'error'` — matching the file's existing reasoning for using `.on`
over `.once`: an EMFILE hiccup after a successful bind doesn't mean the forwarder is dead).

```ts
export interface PortForwarderHandle {
  server: net.Server;
  close: () => Promise<void>;
  isBound: () => boolean;
}
// ...
let bound = false;
server.once('listening', () => { bound = true; });
// ... existing server.on('error', ...) unchanged ...
return { server, isBound: () => bound, close: /* unchanged */ };
```

**`server/src/mdns-owner.ts`**: add a closure-scoped `alive` flag to `MdnsResponderHandle`,
mirroring the existing `killedIntentionally` bookkeeping in the `child.once('exit', ...)`
handler — using the round-2-corrected logic above (any non-intentional exit, not just a
nonzero one, flips `alive` false):

```ts
export interface MdnsResponderHandle {
  child: ChildProcess;
  kill: () => Promise<void>;
  isAlive: () => boolean;
}
// ...
let alive = true;
child.once('exit', (code, signal) => {
  if (killedIntentionally) return;
  alive = false;
  if (code !== 0) {
    warn(`[mdns] responder for ${hostname} exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ''})`);
  }
});
return { child, isAlive: () => alive, kill: /* unchanged */ };
```

(`spawnMdnsResponder` already returns `null` on a *synchronous* spawn failure — `isAlive`
closes the remaining gap: both an async crash after a successful spawn, and a graceful
bind-failure `exit(0)`, per the round-2 correction above.)

**`server/src/index.ts`**: **Correction from adversarial review, round 2** — the first revision
proposed `export function isFriendlyHostnameReachable()` from `index.ts`, importable from
`devices.ts`. Round 2 confirmed (not just suspected) this is circular: `index.ts` imports
`app.js`, which mounts `devicesRouter`; `devices.ts` importing back from `index.ts` is exactly
the case this same file already solved for the cert-regen route, via `app.set()`/`app.get()`
(`index.ts:376-382`: *"expose the live server so the cert-regen route can call
setSecureContext() on it without a circular import… Express's own app.set()/app.get() is the
idiomatic pattern for exactly this 'expose a singleton to route handlers' need"*). Reusing that
exact idiom instead of inventing a second mechanism:

```ts
if (shouldSpawnMdnsResponder(lanHttps)) {
  mdnsResponderHandle = spawnMdnsResponder('castwright.local', repoRoot);
}
if (shouldSpawnPortForwarder(lanHttps)) {
  portForwarderHandle = startPortForwarder(LAN_HTTPS_PORT);
}
app.set('isFriendlyHostnameReachable', () =>
  mdnsResponderHandle?.isAlive() === true && portForwarderHandle?.isBound() === true,
);
```

### Backend — `server/src/routes/devices.ts`

In the `POST /devices/pair-session` handler, after minting `{ code, expiresAt }` via
`createPairingSession`, read the accessor off `req.app` — no new import, no circularity:

```ts
const isFriendlyHostnameReachable = req.app.get('isFriendlyHostnameReachable') as
  (() => boolean) | undefined;
const friendlyUrl = isFriendlyHostnameReachable?.() === true
  ? `https://castwright.local/#/pair?c=${code}`
  : undefined;
res.json({ url: `https://${host}/#/pair?c=${code}`, code, expiresAt, friendlyUrl });
```

This also keeps `devices.test.ts` cheap: a test can call `app.set('isFriendlyHostnameReachable',
() => true/false)` directly on a bare test Express app, with no need to import `index.ts` (and
therefore none of its top-level side effects — `installTimestamps()`, `installCrashHandlers()`,
the full sidecar-supervisor/GPU import graph — reaching the test at all).

No change to the existing `url` field, `code`, or `expiresAt` — additive only.

### Frontend — `src/lib/api.ts`

**Gap in the first draft:** `realCreateDevicePairSession`'s return type is hand-cast to
`Promise<{ url: string; code: string; expiresAt: number }>` (this endpoint has no OpenAPI
entry — confirmed zero hits for `pair-session` in `openapi.yaml` — so it's already hand-typed
off-contract). `friendlyUrl` would arrive at runtime via `res.json()` regardless, silently
invisible to the type until `lan-access-card.tsx`'s widened `useState` re-introduces it — the
exact "true at runtime, invisible to types" smell CLAUDE.md's OpenAPI-source-of-truth
convention exists to avoid. Widen the cast:

```ts
return res.json() as Promise<{ url: string; code: string; expiresAt: number; friendlyUrl?: string }>;
```

Also add `friendlyUrl` (present or absent, matching whatever mock-mode scenario is being
exercised) to `mockCreateDevicePairSession` so the new UI branch is exercisable under
`VITE_USE_MOCKS`.

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

No new secret surface: `friendlyUrl` carries the exact same short-lived, single-use code
already exposed via the QR image, gated behind the same loopback-only `/devices/pair-session`
endpoint. **Correction from adversarial review:** the TTL is **5 minutes**
(`pairing-sessions.ts`'s hardcoded `TTL_MS`), not 10 — the first draft misread the `10` in
`createPairingSession(label, undefined, 10)` as minutes; it's actually the **byte count** for
the code (→16 chars for the browser flow, vs. 5 bytes/8 chars for the companion QR).

Two characteristics the first draft glossed over as "harmless" — both accepted, neither fixed
here, but named explicitly rather than left implicit:

- **The QR and the link share one code.** `createPairingSession` mints a single code per
  "Authorize a device" click; `redeemPairingSession` is single-use (`consumed = true` on first
  redemption). So scanning the QR with a phone *and* clicking the link on the same click's
  session are mutually exclusive — the second redemption gets `410` (mapped by both
  `pairing.ts`'s `/redeem-browser` and `PairShell` to "This code expired — generate a new one,"
  which is a misleading message for a *consumed*-not-*expired* code, but not a functional bug:
  click **Authorize a device** again for a second code). Accepted for this same-machine,
  single-admin-click scope; not engineered around (that would mean minting two independent
  codes per click, adding complexity this spec doesn't need).
- **The friendly link's redemption travels through the `:443` forwarder**, which presents
  every client as `127.0.0.2` (`lan-port-forwarder.ts`'s documented rate-limit-bucket
  collapse, ops-24/#1309) — so it shares a `redeemLimiter` identity with every other
  bare-hostname/bare-IP client, distinct from the QR's explicit-`:8443` identity. Immaterial at
  this feature's volume (one click, one redemption), noted for completeness.

**Certificate coverage (resolves a reviewer question):** already confirmed by prior work —
`scripts/setup-lan-certs.mjs`'s `buildCertHosts()` unconditionally includes `castwright.local`
in the LAN cert's SAN list (see `docs/superpowers/specs/2026-07-04-castwright-local-port-cert-design.md`),
so a non-stale cert presents cleanly on the opened tab with no browser warning. A *stale* cert
(LAN-IP churn) is an existing, separately-handled condition (the LAN Access card's "Regenerate
certificate" button) — not a new failure mode this feature introduces.

### Error handling

A stale/expired/already-consumed code clicked after the fact hits `PairShell`'s existing "This
code expired — generate a new one on the desktop" branch (`src/views/pair.tsx:22-23`) exactly
as it does today for the QR path — see the consumed-vs-expired message caveat above.

**New failure mode requiring explicit handling:** when the `isFriendlyHostnameReachable`
accessor (set via `app.set()` in `index.ts`, read via `req.app.get()` in `devices.ts`) returns
false — mDNS responder or `:443` forwarder didn't come up — `friendlyUrl` is `undefined` and
`LanAccessCard` simply doesn't render the link — falling back to the QR, exactly like the
dev:lan case. No error message needed; this is the same "friendly hostname unavailable, raw-IP
path still works" degradation plan 239 already established for the hostname feature itself.

## Testing

- **`server/src/lan-port-forwarder.test.ts`**: assert `isBound()` is `false` before
  `'listening'` fires, `true` after; assert it stays `true` across a subsequent `'error'`
  event (the EMFILE-hiccup-after-bind case), and `false` if `'error'` fires before
  `'listening'` ever does (never-bound case).
- **`server/src/mdns-owner.test.ts`**: assert `isAlive()` is `true` after a normal spawn;
  `false` after a non-intentional **exit code 0** (the graceful bind-failure path — the case
  round 2 caught missing coverage for); `false` after a non-intentional nonzero exit; and
  unaffected (stays whatever it already was) by an intentional `kill()`.
- **`server/src/routes/devices.test.ts`**: assert `friendlyUrl` is present and correctly formed
  when the full chain holds — loopback request, `isLanTokenEnforced()` true, **and**
  `req.app.get('isFriendlyHostnameReachable')()` true (set directly on a bare test app, no
  `index.ts` import); assert it's `undefined` when any one of those three is false, including
  the case that predicate returning `false` despite `NODE_ENV=production` (simulating a
  bind/spawn failure), and the case the getter itself is unset (mirrors a real server where
  `app.set` never ran, e.g. non-LAN-HTTPS mode).
- **`src/components/lan-access-card.test.tsx`**: assert the link renders with the correct
  `href` when the mocked `createDevicePairSession` response includes `friendlyUrl`; assert it
  does not render when the field is absent (dev:lan, or a live-but-unreachable start:lan).

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
