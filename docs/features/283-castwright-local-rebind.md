---
status: active
shipped: null
owner: null
---

# One-click `castwright.local` re-bind (srv-90)

> Status: active — code shipped, on-box acceptance owed (register row E10)
> Key files: `server/src/config/registry.ts`, `server/src/workspace/device-tokens.ts`,
> `server/src/routes/pairing.ts`, `src/lib/api.ts`, `src/components/lan-access-card.tsx`,
> `src/views/pair.tsx`, `src/lib/lan-recovery-hint.ts`, `src/store/library-slice.ts`,
> `src/views/book-library.tsx`, `src/components/layout.tsx`
> URL surface: `#/pair?c=<code>&self=1` (new — the self-bind hop); `#/admin` "LAN access"
> card (existing route, new "Authorize this browser" control)
> OpenAPI ops: none new — reuses `POST /api/devices/pair-session`,
> `POST /api/pair/redeem-browser`, `GET /api/devices`, `GET /api/library` (only the last
> gains a typed `ApiError` on the client, no wire-shape change)

Design of record: [`../superpowers/specs/2026-08-11-castwright-local-rebind-design.md`](../superpowers/specs/2026-08-11-castwright-local-rebind-design.md)
(revision 5). Implementation plan: [`../superpowers/plans/2026-08-11-castwright-local-rebind.md`](../superpowers/plans/2026-08-11-castwright-local-rebind.md).
Issue: [#2247](https://github.com/dudarenok-maker/Castwright/issues/2247) (srv-90).
Builds directly on plan 225 ([`225-lan-browser-device-auth.md`](225-lan-browser-device-auth.md)),
whose device-token / pairing / cookie machinery this plan reuses unchanged.

## Benefit / Rationale

- **User:** re-linking this computer's browser to `https://castwright.local` after a
  lapsed authorization is now one click ("Authorize this browser" on the LAN access
  card) instead of a four-step QR dance through a phone-shaped flow. A lapsed
  authorization is also needed far less often — the device-token lifetime moved from
  30 days to 365 (ceiling 400). And the previous dead end — a raw
  `Library scan failed (401): Missing or invalid LAN access token.` string with no way
  out short of knowing to visit `/#/admin` — now names the problem in plain language
  and points at the fix.
- **Technical:** `getLibrary()` now throws a typed `ApiError` carrying an HTTP status,
  so the books view can branch on `error.status === 401` instead of string-matching
  `/\(401\)/` on the message (the design spec explicitly forbids that string-match —
  a future change to the server's error text would have silently broken it).
  `clampTtlDays` now clamps symmetrically instead of falling back to the default on
  any out-of-range value, closing a footgun that got worse as the default grew (an
  operator hand-editing a stored override to `0` to *shorten* the lifetime used to
  silently get the *longest* one instead — a curiosity at a 30-day default, a 12×
  footgun at 365).
- **Architectural:** the frontend's mock config registry (`src/lib/api.ts`) is now
  guarded against drifting from the server registry on `{key, default, min, max}` for
  every knob present in both catalogues — closing the vector that let the mock's
  `lan.deviceTokenTtlDays` default, `tts.preload.kokoro` default, and
  `analyzer.gemini.model` default silently diverge from what actually ships. The guard
  is intersection-only and field-narrow by design (see "Out of scope"); it is a floor,
  not full parity.

## Architectural impact

- **New seams:**
  - `authorizeThisBrowser` handler + `selfErr` state in `lan-access-card.tsx` — mints a
    pairing session labelled exactly `'This computer'` and navigates to
    `friendlyUrl + '&self=1'` when the server reports the friendly hostname reachable.
  - The `self=1` query flag and the `codeRef`-based auto-redeem effect in `pair.tsx` —
    on that flag only, the pairing code is captured into a ref, the URL is scrubbed via
    `replaceState` *before* the redeem call fires (not after, and not on the manual QR
    path), and a `didRun` ref guards against a double-fire.
  - `src/lib/lan-recovery-hint.ts` — `recoveryHint()`, a new module exporting the
    three-branch "how do I get back in" copy (loopback, friendly-hostname, bare LAN
    IP), consumed by `book-library.tsx`'s 401 panel. `lan-access-card.tsx`'s own
    `manageHint` branch (pre-existing) keeps its own hardcoded string — that branch
    never renders the "Authorize this browser" button, so the non-loopback wording
    this module gives does not apply there.
  - `isLoopbackHost()`, also exported from `src/lib/lan-recovery-hint.ts` — the same
    true-loopback check `recoveryHint()` uses internally, re-exported so
    `lan-access-card.tsx` can gate the "Authorize this browser" button on it directly
    (see invariant 6 below).
  - `LibraryState.error` widens from `string | null` to `{ message: string; status?:
    number } | null`; `hydrateError` takes that same shape.
  - The mock-registry parity guard in `src/lib/api.config.test.ts`.
- **Invariants preserved:** plan 225's invariant 7 (`/redeem-browser` is pre-guard,
  code-gated, LAN-only, never returns the raw token) — the self-bind hop is a new
  *caller* of the same endpoint, not a new endpoint. Plan 225's invariant 6 (all
  token-minting paths are loopback-gated) — `authorizeThisBrowser` calls
  `createDevicePairSession`, the same loopback-gated mint every other pairing flow
  uses. Plan 225's invariant 10 (library scan failure is recoverable) — this plan
  makes the 401 case of that invariant *specifically* recoverable rather than just
  "Retry"-recoverable.
- **Migration:** none for persisted data. `device-tokens.json` stays schema 2 — only
  the registry `default`/`max` on `lan.deviceTokenTtlDays` changed, and per
  `clampTtlDays`'s contract that only affects a *newly minted* token's `expiresAt`; an
  already-persisted device record's `expiresAt` is never rewritten by this change.
  `LibraryState.error`'s widened shape is in-memory Redux state only, never persisted.
- **Reversibility:** the TTL default/ceiling revert cleanly (registry values +
  `clampTtlDays`'s two literals). The button, the self-bind hop, and the 401 recovery
  panel are additive UI — deleting them reverts to the plan-225 QR-only flow with no
  data migration in either direction.

## Invariants to preserve

1. **`clampTtlDays` clamps symmetrically, not toward the default.** An integer `< 1`
   clamps to `1`; an integer `> 400` clamps to `400`; only a non-integer (including
   `NaN`, `null`, a string) falls back to the `365` default
   (`server/src/workspace/device-tokens.ts`). This is deliberate, not a simplification
   target — see the function's own header comment for why "clamp toward default"
   would be a footgun at this TTL size.
2. **`self=1` is never treated as a trust signal.** The gate on `/redeem-browser` is
   always the one-time pairing code; `self=1` only controls whether `pair.tsx`
   auto-fires the redeem instead of waiting for a click (`src/views/pair.tsx`).
3. **The self-bind label is exactly `'This computer'`, minted only by
   `lan-access-card.tsx`; the flag is exactly `self=1`, minted by
   `lan-access-card.tsx` and read (not written) by `pair.tsx`.** `pair.tsx` never
   reads or checks the label — only the `self` query param. A mismatch on the
   `self=1` string silently breaks the one-click path without failing any type
   check.
4. **Both `hydrateError` dispatch sites stay in sync.** There are exactly two —
   `src/components/layout.tsx` (first load) and `src/views/book-library.tsx` (the
   Retry handler on the panel this feature adds) — and both must dispatch the same
   `{ message, status? }` shape. Fixing only one makes the recovery panel vanish the
   moment the user presses Retry, which is worse than never having a panel.
5. **The self-bind URL scrub happens before the redeem call, and only on the
   `self=1` path.** Scrubbing unconditionally (including the manual QR click handler)
   would strand a phone user who refreshes after a failed redeem with no code in the
   URL — reintroducing the dead-end this feature exists to remove, on the one flow
   the design spec says stays untouched.
6. **"Authorize this browser" only renders behind `isLoopbackHost()`.** A phone or
   any other device reaching the card over the LAN (including via
   `castwright.local`, which every device on the LAN resolves and which is
   therefore not evidence of loopback) must never see the button — it mints a
   pairing session labelled exactly `'This computer'`, and a non-host device
   minting that label would produce two identically-labelled `'This computer'`
   entries in the device list with no way for Revoke to disambiguate them by
   label. A later refactor that lifts the button out of this guard — e.g. to
   render it disabled with an explanation instead of hiding it outright — must
   keep the mint itself gated, not just the enabled state.

## Test plan

### Automated coverage

- `server/src/workspace/device-tokens.pure.test.ts` — `describe('clampTtlDays', ...)`:
  non-integer inputs fall back to 365; below-floor integers clamp to 1, not the
  default; above-ceiling integers clamp to 400; in-range values pass through
  untouched; the fallback literal equals the registry's own `default`.
- `server/src/config/registry.test.ts` — the `lan.deviceTokenTtlDays` knob registers
  with `default: 365, min: 1, max: 400`; `coerceAndValidate` rejects `'401'` and `'0'`,
  accepts `'400'`.
- `server/src/routes/pairing.test.ts` — the `Set-Cookie` response on `/redeem-browser`
  carries `Max-Age=31536000` (365 days), asserted against the cookie itself, not just
  the server-side device record.
- `src/lib/api.config.test.ts` — the mock config catalogue matches the server registry
  on `{key, default, min, max}` for every knob present in both, with a
  non-emptiness floor so the comparison can't silently degrade to `[] === []`.
- `src/components/lan-access-card.test.tsx` — "Authorize this browser" navigates to
  `friendlyUrl + '&self=1'` when the server reports the friendly hostname reachable;
  explains rather than navigates when `friendlyUrl` is absent. Two more pin invariant
  6's gate directly: the button is absent when `location.hostname` is
  `castwright.local` (a phone-mintable, non-loopback origin), and present when it is
  `localhost` — including the bare `:443`-forwarder shape (`hostname: 'localhost',
  port: ''`), the motivating scenario for the loopback check existing at all.
- `src/views/pair.test.tsx` — auto-redeems on mount when `self=1`, scrubbing the URL
  before the call; does **not** auto-redeem without `self=1` (regression guard); fires
  exactly once even across a re-render; offers Retry after a `503` and reuses the
  captured code; does **not** offer Retry after a `429`.
- `src/store/library-slice.test.ts` + `src/views/book-library.test.tsx` — a 401 library
  error renders a recovery pointer and suppresses the raw server text; a non-401 error
  still shows the raw message; the recovery pointer survives a Retry that fails again
  with 401; `recoveryHint()`'s three branches (loopback, friendly hostname, bare LAN
  IP) each render the right copy.
- `e2e/lan-device-auth.spec.ts` — `#/pair?c=<code>&self=1` lands on the library with no
  click (mock mode). The button half is not e2e-testable in mock mode — it navigates to
  an absolute `castwright.local` origin the mock server on `:5174` cannot resolve.

### Manual acceptance walkthrough

Real hardware — `friendlyUrl` requires **both** the mDNS responder and the `:443`
forwarder, and both are gated to `NODE_ENV === 'production'`, so `npm run dev:lan` can
never render a working "Authorize this browser" button. The local production route is
`npm run build && npm run start:lan`, which needs elevation to bind `:443`.

1. **A fresh device pairs and stays paired.** `npm run build && npm run start:lan`
   (elevated). From a loopback tab, Account → LAN access → **Authorize this browser**
   → the browser navigates to `https://castwright.local/#/pair?c=…&self=1` → lands on
   the library with no click. `GET /api/devices` shows a `'This computer'` record whose
   `expires` is roughly a year out, not a month.
2. **A lapsed cookie recovers in one click.** Clear the `__Host-cw_lan` cookie in
   DevTools — the actual fast path. `LAN_DEVICE_TTL_DAYS=1` is the lowest value the
   config accepts (`0` is rejected and falls through to the 365-day default), and
   even that means waiting out a full day, so it is not a fast repro. Reload
   `https://castwright.local`. The library panel reads "This browser
   is no longer authorized for Castwright on your network," not the raw
   `Library scan failed (401): …` string, and names the recovery step for the hostname
   you're actually on. Following that step re-authorizes without a restart.
3. **The QR path is unaffected.** A second device (a phone, or a second desktop
   browser) authorized via the existing "Authorize a device" + QR flow still works
   end to end, unchanged.

On-box acceptance for this walkthrough is tracked as register row **E10** in
[`docs/testing/onbox-acceptance-register.md`](../testing/onbox-acceptance-register.md)
until run.

## Out of scope

- **Revoking the prior self-bind record on re-authorize.** Repeated use of "Authorize
  this browser" mints a fresh device-token record each time rather than replacing the
  previous one — harmless (an extra valid token, not a security hole) but it clutters
  the device list. Needs a self-bind marker threaded across
  `pairing-sessions.ts`/`pairing.ts`/`device-tokens.ts`/`devices.ts` plus a
  non-nesting `enqueueWrite` composition. Filed as
  [#2257](https://github.com/dudarenok-maker/Castwright/issues/2257).
- **`friendlyUrl` when mDNS is alive but the `:443` forwarder is down.**
  `server/src/index.ts:360-362` collapses both prerequisites into a single boolean, so
  a forwarder outage hides the friendly-hostname flow entirely even though
  `https://castwright.local:8443` would work. Needs splitting the boolean and deciding
  the port-carrying URL shape. Filed as
  [#2258](https://github.com/dudarenok-maker/Castwright/issues/2258).
- **Full mock-config-registry parity.** The mock is a documented 98-of-115 subset (plus
  2 UI-only entries not in the registry at all); this plan's parity guard covers only
  the shared-key intersection, and only on `{key, default, min, max}` — `help`, `type`,
  `risk`, `apply`, `group`, and `label` can still drift silently on a shared key (the
  `analyzer.gemini.model` stale-`help` fix in this same branch, commit `0c539b21`, was
  caught by human review, not the guard). Filed as
  [#2259](https://github.com/dudarenok-maker/Castwright/issues/2259).

## Ship notes

_(fill in when status flips to `stable` — on-box acceptance row E10 discharging is the
remaining gate)_
