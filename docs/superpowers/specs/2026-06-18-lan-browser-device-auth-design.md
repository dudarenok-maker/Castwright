---
title: Authorize a browser over LAN via Admin device-linking
date: 2026-06-18
status: draft
area: server + frontend
issue: srv-NN (to be filed)
revision: 5 (three review rounds folded in; grandfather dropped — legacy re-pairs; lastSeenAt populated)
---

# Authorize a browser over LAN via Admin device-linking

## Problem

With `LAN_HTTPS=1` and `LAN_AUTH_TOKEN` set, the LAN token guard
(`server/src/lan-auth.ts`) returns `401 "Missing or invalid LAN access token."`
for every non-loopback `/api/*` request that doesn't carry a valid token. The
web frontend's ~100 `fetch('/api/…')` calls send **no** token, so a phone's
**browser** on the LAN is locked out of the entire API:

- `getLibrary()` → 401 → `library.loaded` never flips → the books grid sits in
  its `animate-pulse` skeleton forever, with no error and no retry.
- Because the books grid **is** the navigation hub on the `books` stage (the
  Cast/Manuscript/Listen tabs only render once a book is open; there is no
  hamburger by design), the user is stranded.

Desktop works only because `isLoopbackRequest()` bypasses the guard for
`127.0.0.1`/`::1`. The Android **companion** redeems a pairing code into a
per-device token sent as a header. A plain browser has neither path.

The per-device token machinery (`srv-33`,
`server/src/workspace/device-tokens.ts`) and the QR pairing flow
(`server/src/routes/pairing.ts` + `server/src/workspace/pairing-sessions.ts`)
already exist — built for the companion. This feature extends them so a
**browser** can be authorized too, managed from the desktop **Admin** screen.

## Goals

1. From the desktop **Admin** screen, mint a time-limited authorization for a
   phone's browser via a **QR code** the phone's **native camera** opens — no
   typing on the phone.
2. Once authorized, the browser's same-origin API calls **just work** for the
   token's lifetime (default **30 days**), with **zero changes** to the ~100
   `fetch` call sites.
3. The Admin screen **lists** authorized devices and can **revoke** any one.
4. Lifetime is a configurable env knob (`LAN_DEVICE_TTL_DAYS`, default 30)
   surfaced in **Advanced configuration**.
5. Make the failed-library-scan dead-end recoverable (Retry, not eternal skeleton).
6. Introducing cookie auth must **not** open a CSRF hole the header model didn't have.

## Non-goals

- Changing **when** the guard enforces. Enforcement = `isLanTokenEnforced()` =
  `isLanHttpsEnabled() && getLanAuthToken() !== undefined` (`lan-auth.ts:53`).
  The Admin card must **surface** this state (§Security).
- Changing the companion's `POST /api/pair/redeem` request/response contract.
  Legacy device tokens predating this change require a one-time **re-pair** (see
  §Legacy tokens) — companion pairing was not reliably in use, so there is no
  install base to grandfather.
- Per-user accounts / roles. Minting is gated by physical desktop (loopback) access.
- Editing the device label on the phone (decided: **desktop-only** label).

## User experience

**Desktop** (`#/admin` → new **"LAN access"** card):
1. **"Authorize a device"** → type a **label** → a **QR** appears with a ~5-min
   countdown + **Regenerate**.
   - If `!isLanTokenEnforced()`, the card **refuses to mint** and warns:
     *"Device authorizations have no effect until LAN auth is enabled (set
     `LAN_AUTH_TOKEN`)."*

**Phone:**
2. Native camera scans the QR → `https://<host>:8443/#/pair?c=<code>` (code in
   the **hash fragment**) → browser opens it.
3. **"Authorize this browser until <date>?"** → one tap **Authorize**.
4. Server validates the code, mints a device token, **sets an `HttpOnly`
   cookie**. The page `history.replaceState`s the code away and navigates to
   `#/`; Layout mounts there and fetches the library (now carrying the cookie).

**Desktop** card then lists the device (label · added · last seen · expires) with
**Revoke** (immediate on next request; rename in v1 = revoke + re-authorize).

*Prerequisite (already true on the user's box):* the phone trusts the mkcert
root CA, so HTTPS opens cleanly and the `Secure` cookie is honored. Card links to
the cert-install steps.

## Architecture

### Server

**`server/src/workspace/device-tokens.ts`**

- `DeviceTokenRecord` gains `expiresAt?: string` (ISO; optional so an existing
  legacy file type-checks before any record carries it).
- `createDevice(label, ttlDays)` — `ttlDays` is **required**; stamps `expiresAt =
  now + ttlDays·86400s`. Every caller passes it (callers below), so every
  newly-minted token always has an `expiresAt`.
- **Expiry is checked in exactly one place:** `findValidDevice(devices, rawToken,
  now = Date.now())` (the pure fn gains a defaulted, injected clock — stays
  deterministic/testable). Rejects when `revoked`, OR `expiresAt === undefined`
  (a legacy/never-stamped token → forces re-pair; for a freshly-minted token this
  would be a bug — fail safe either way), OR `now > Date.parse(expiresAt)`.
  `isValidDeviceToken(rawToken)` keeps its **single-arg**
  signature and calls `findValidDevice(loadSync(), rawToken)` (default `now`).
- `redactDevice`/`PublicDevice` expose `expiresAt` via a **conditional spread**
  (mirroring the existing `lastSeenAt` pattern) so a record without it doesn't
  emit `expiresAt: undefined`.
- **`lastSeenAt` touch-on-use (new — done properly from the start).** Today
  `lastSeenAt` is declared but never written. Add a throttled `touchLastSeen(id,
  now)` that updates the matched record's `lastSeenAt` in the cache and persists
  **fire-and-forget**, but only when `now − lastSeenAt > LASTSEEN_THROTTLE_MS`
  (hardcoded ~1 h — not a user knob), so the hot guard path writes disk at most
  ~hourly per active device. `isValidDeviceToken(rawToken)` performs the touch on
  a successful match (it already has the matched record from `findValidDevice`,
  which returns the record); `findValidDevice` stays pure (the side-effect lives
  in the IO caller). Best-effort: a failed/raced persist is harmless (last-writer-
  wins on a timestamp; the atomic write keeps the file intact). This populates the
  device list's "last seen" for browser **and** companion tokens going forward.
- `DeviceTokensFile.schema` is currently the literal `1` and `persist()`
  hardcodes `{schema: 1, …}` (`device-tokens.ts:39-42,92`). **Widen the type to
  `1 | 2` and make `persist()` write `schema: 2`** so files this version writes
  are tagged correctly (readers ignore the field regardless).
- This module imports **nothing** from `config/` — `ttlDays` is supplied by each
  route caller (callers below), so `device-tokens.ts` stays a leaf module.

**Legacy tokens — no migration pass.** Companion pairing was not reliably in use,
so there is **no install base to preserve**. Any pre-existing `schema: 1` record
has no `expiresAt`, so `findValidDevice` rejects it (the `expiresAt === undefined`
branch) → that device does a one-time **re-pair**. This deliberately avoids the
grandfather migration's resurrection/anchor pitfalls the review flagged (no
startup migration, no `configValue` in `device-tokens.ts`, no clock-anchor
debate). `persist()` writes `{schema: 2}` going forward and the type widens to
`schema: 1 | 2`; readers ignore the `schema` field (they always have), so a stale
schema-1 file on disk is read fine and rewritten as schema 2 on the next mutation
(or `lastSeenAt` touch).

**`server/src/workspace/pairing-sessions.ts`**

- `Session` gains `label?: string` and a `misses: number` counter.
- Signature becomes `createPairingSession(label?, now?, bytes = 5)` (label first
  so the browser path reads naturally). **The 3 existing positional callers in
  `pairing-sessions.test.ts` (`createPairingSession(now)`) must change to
  `createPairingSession(undefined, now)`**, and `pairing.ts:54` (companion) stays
  `createPairingSession()`. The code is `randomBytes(bytes)` Crockford-base32: the
  **browser path calls `createPairingSession(label, undefined, 10)` (80-bit → 16
  chars)**; the companion path keeps `bytes = 5` (40-bit → 8 chars), so its
  compact `CWP1` payload and the `pairing.test.ts` 8-char assertion are untouched.
- `redeemPairingSession(code, now?)` returns `{ ok: true; label?: string }` on
  success (companion caller reads only `ok`/`reason` → backward-compatible).
  **Burn-on-miss is per-code**: sessions are keyed by the code, so a wrong guess
  hits `undefined` and burns nothing — the `misses++`-then-consume only applies
  to repeated misses against a *known live* code. Defense-in-depth only (entropy +
  rate-limit + 5-min TTL are the real controls); cannot become a victim-burn
  vector because sessions are code-keyed, not id-keyed.
  `_resetPairingSessionsForTests` already clears the whole map.

**`server/src/lan-auth.ts`**

- `extractToken(req)` gains a **cookie** source via the **`cookie` package**
  (`cookie.parse(req.headers.cookie ?? '')`) — `req.cookies` does not exist (no
  cookie-parser mounted). Reads **exactly `__Host-cw_lan`**. Cookie is checked
  **first** for the browser path; Bearer/`X-Lan-Token`/`?token=` remain for the
  companion. Document the un-proxied-bind assumption on `isLoopbackRequest`.

**`server/src/csrf-origin.ts`** (new) — CSRF defense for cookie auth.

- Applied to **state-changing** methods (`POST`/`PUT`/`PATCH`/`DELETE`) inside
  `/api`, mounted **after `requireLanToken`**, before route handlers. Only gates
  requests carrying the `__Host-cw_lan` **cookie**; loopback and header/Bearer
  (companion) requests pass → **no change to the ~100 fetch call sites.** (Safe:
  the shared secret / Bearer token never lands in a cookie or in JS, so the only
  ambient browser credential is the Origin-gated cookie.)
- **Allow-list** (recomputed per request, never empty): the full, un-stripped
  `enumerateLanUrls(port, 'https').urls` (already `https://<ip>:<port>` form;
  `export-lan.ts:54`) **plus** explicit `https://localhost:<port>`,
  `https://127.0.0.1:<port>`, `https://[::1]:<port>`. Compares the request `Origin`
  (fallback `Referer`'s origin). **Fail-closed**: a cookie-bearing write with
  **neither Origin nor Referer** → 403 (browsers always send `Origin` on non-GET
  fetch). **Documented limitations** (both fail *closed*, functional not security):
  hostname / `.local` access, and **IPv6-routable LAN** addresses (`enumerateLanUrls`
  is IPv4-only) — use the IP from the QR.

**`server/src/routes/devices.ts`**

- Reuse `GET /api/devices` (list) + `DELETE /api/devices/:id` (revoke) —
  loopback-gated behind the `/api` guard.
- The existing **admin mint** caller (`devices.ts:27`) updates to
  `createDevice(label, configValue('lan.deviceTokenTtlDays'))`.
- **New** `POST /api/devices/pair-session` (loopback-only; `409` when
  `!isLanTokenEnforced()`): body `{ label }` → `createPairingSession(label,
  undefined, 10)` → `{ url, code, expiresAt }`, `url =
  https://<hostPort>/#/pair?c=<code>` (code in the **hash fragment**).

**`server/src/routes/pairing.ts`**

- The existing **companion redeem** caller (`pairing.ts:71`) updates to
  `createDevice(label, configValue('lan.deviceTokenTtlDays'))` too — so
  companion-minted tokens also get an `expiresAt` (else the reject-on-undefined
  rule would lock out every freshly-paired companion device).
- **New** `POST /api/pair/redeem-browser` on the **pre-guard** router (next to
  `/api/pair/redeem`):
  - `409` when `!isLanTokenEnforced()` (which implies HTTPS — so a `Secure`
    cookie is never minted on the plain-HTTP listener — and that minting while the
    guard no-ops is refused).
  - Scoped `express.json({ limit: '1kb' })` + a **dedicated** rate limiter
    (5/min, `keyGenerator: req => req.ip`, in-memory single-process store) that is
    **NOT skipped under Vitest** (the global `apiLimiter` is) and is tested.
  - Body `{ code }` → `redeemPairingSession(code)` (single-use, per-code burn) →
    `ttl = configValue('lan.deviceTokenTtlDays')` (read **once**) →
    `createDevice(label, ttl)` → `res.cookie('__Host-cw_lan', token, { httpOnly:
    true, secure: true, sameSite: 'strict', path: '/', maxAge: ttl·86400_000 /*
    ms */ })`. Responds `{ label, expiresAt }` — **the raw token never reaches JS.**

**`server/src/config/registry.ts`**

- Group `{ id: 'lan-access', label: 'LAN access & device tokens', help: '…',
  risk: 'low', collapsedByDefault: false }` (`collapsedByDefault` is **required**).
- Knob `{ key: 'lan.deviceTokenTtlDays', env: 'LAN_DEVICE_TTL_DAYS', group:
  'lan-access', label: 'Device authorization lifetime (days)', help: '…', type:
  'integer', min: 1, default: 30, apply: 'live', risk: 'low' }`. The knob default
  `30` is the **single source of truth**.
- **Update `registry.test.ts:5`** — the exact-array "ten groups" assertion
  becomes eleven (append `lan-access`).

### Frontend

**Router — `src/routes/index.tsx`.** There is **no `App.tsx`**; `main.tsx` mounts
`<Provider store><RouterProvider router={createHashRouter([...])}/>`, with the
theme applied to `document.documentElement` pre-mount. The router today is a
**single** top-level route `{ path: '/', element: <Layout/>, children: [...] }`.
Add a **second top-level entry** (a *sibling*, not a child):

```js
createHashRouter([
  { path: '/pair', element: <PairShell/> },              // NEW — no <Layout>, no boot effects
  { path: '/', element: <Layout/>, children: [ ... ] },  // unchanged; NotFound catch-all stays INSIDE children
])
```

Because `<Provider>` + theme live **above** the router, `PairShell` gets store +
theme for free without mounting `<Layout>` — so none of Layout's ~6 authed boot
fetches or its Redux→URL sync run on the unauth phone, and a rehydrated persisted
`ui.stage` cannot yank `PairShell` off `/pair` (the sync lives only in Layout).
There is **no `parseHash`** (removed) — read the code via
`useSearchParams().get('c')` (the `HelpRoute` idiom).

**`src/views/pair.tsx` (`PairShell`)** — reads `c`, shows the one-tap **"Authorize
this browser until <date>"** screen, POSTs `redeemBrowserPair({code})`. On
success: `history.replaceState` to drop the code, then `navigate('/')` — **no
explicit re-hydrate dispatch** (no fetching library action exists; Layout mounts
on `/` and its effect fetches because `library.loaded === false`, regardless of
`stageKind`). The `Set-Cookie` lands with the redeem response (before its promise
resolves), so the subsequent `getLibrary()` carries it. Errors: invalid / expired
/ rate-limited → "This code expired — generate a new one on the desktop."

**`src/components/lan-access-card.tsx` (new, in `src/views/admin.tsx`)** —
"Authorize a device" → label → QR + countdown + Regenerate, plus the device list
(**label · added · last seen · expires** · **Revoke**); "last seen" reads the
now-populated `lastSeenAt` (renders "—" until the device's first throttled touch).
Detects not-enforced (warn + disable mint) and
401-on-phone (show "manage from desktop") via a **typed `ApiError.status`** on the
new api fns (a new pattern — today's idiom is message-regex; the four new fns are
the first to throw it).

**Shared QR component** — extract the QR + countdown + Regenerate block out of
`src/modals/pair-device.tsx` (today it renders the compact `CWP1` payload for the
Listen-banner companion flow) into a component **parameterized by payload string +
session-fetch fn**, used by both the companion modal and the new Admin card. Real
extraction, not a copy.

**`src/lib/api.ts`** — new fns `createDevicePairSession`, `listDevices`,
`revokeDevice`, `redeemBrowserPair` (+ mock mirrors, required for mock-mode &
e2e), throwing a typed `ApiError` carrying `.status`. **No change to existing call
sites** — default `credentials: 'same-origin'` attaches the cookie.

### Resilience fix (failed library scan) — bundled

- `src/store/library-slice.ts`: add `error: string | null` (init `null`);
  `hydrateError(message)` sets `loaded = true` + `error`; `hydrate(...)` **clears
  `error` to `null`** on success.
- `src/components/layout.tsx` library-hydrate effect (`:529-531`): on
  `getLibrary()` failure dispatch `hydrateError(message)` (instead of only
  `console.error`).
- `src/views/book-library.tsx` **and** `src/components/library/library-grid.tsx`:
  when `loaded && error`, render "Couldn't load your library — Retry" (Retry
  re-runs the hydrate).

## Data flow

```
Desktop Admin                  Server                              Phone browser
─────────────                  ──────                              ─────────────
"Authorize"+label
 └ POST /api/devices/pair-session {label}  (loopback; 409 if !isLanTokenEnforced)
       └ createPairingSession(label, _, 10) ─► {url(#/pair?c=…), code(16ch/80b), expiresAt}
 ◄ QR(url)
                                                       scan QR (native camera)
                                                       open https://host/#/pair?c=…
                                                 ◄──── GET static shell → PairShell (no Layout)
                                                       tap Authorize
                        POST /api/pair/redeem-browser {code}
                          (pre-guard; 5/min limiter; 1kb; 409 if !isLanTokenEnforced)
                          └ redeemPairingSession(code) → label  (single-use, per-code burn)
                          └ ttl = configValue('lan.deviceTokenTtlDays')   (read once)
                          └ createDevice(label, ttl) → expiresAt = now + ttl·86400 s
                          └ Set-Cookie __Host-cw_lan=<token>
                               HttpOnly; Secure; SameSite=Strict; Path=/
                               Max-Age = ttl·86400 s   (Express maxAge = ttl·86400_000 ms)
                        ───────────────────────────────────────► {label, expiresAt}
                                                       history.replaceState (drop code)
                                                       navigate('/') → Layout mounts
                                                       getLibrary() (cookie) ✓  (writes also Origin-checked)
GET /api/devices ─► list ;  DELETE /api/devices/:id ─► revoke
```

## Security model

- **Cookie:** `__Host-cw_lan` — `HttpOnly`, `Secure` (mint `409`s under HTTP so
  it's never silently dropped), `SameSite=Strict`, `Path=/`, no `Domain`
  (`__Host-` enforces Secure + Path=/ + host-only). `Max-Age = ttl·86400 s`, but
  the **server enforces `expiresAt`** in `findValidDevice` — the client `Max-Age`
  is not the authority.
- **CSRF:** `SameSite=Strict` is necessary but insufficient (on a bare LAN IP it
  is port-agnostic), so the server **Origin allow-list** middleware gates every
  cookie-authenticated state-changing request (full LAN URLs + explicit loopback
  origins, per-request, never empty, fail-closed on absent Origin+Referer).
  Header/Bearer (companion) and loopback writes are exempt — restoring the
  CSRF-immunity the header model had.
- **Unauth mint hardening:** `redeem-browser` is necessarily pre-guard (the phone
  has no cookie yet — CSRF N/A there; a forged cross-site POST would still need a
  live 80-bit single-use code). Gated by `isLanTokenEnforced()`, a dedicated
  **tested** 5/min/IP limiter, a 1 KB body cap, an 80-bit code, 5-min TTL, per-code
  burn-on-miss. Brute force ≈ 25 guesses / 2^80 ≈ 2×10⁻²³ per window. The code
  rides only in the URL **fragment** (no Referer/log leak) and is stripped from
  history post-redeem. A shoulder-surf redeem race is bounded by the loopback-only
  mint + single-use burn + the device showing up in the list (detectable, revocable).
- **Loopback gate invariant:** the only `/api` mounts **before** `requireLanToken`
  are the two redeem routes (both code-gated mints) and read-only `/audio`; a test
  asserts that set doesn't grow. `trust proxy` is unset (verified) so
  `X-Forwarded-For` can't spoof loopback; a test asserts it stays unset.
- **Footgun surfaced:** unset `LAN_AUTH_TOKEN` → guard no-ops → the Admin card
  refuses to mint and warns; the server mint endpoints `409` on
  `!isLanTokenEnforced()` too.

## Testing plan

**Server**
- `device-tokens.pure.test.ts` (**update**): reseed **all** fixtures with
  `expiresAt`; fix the `redactDevice` `toEqual` (conditional `expiresAt`); add
  `findValidDevice` cases — expired, `expiresAt===undefined`, injected `now`.
- `device-tokens.test.ts`: `createDevice` stamps `expiresAt`; a legacy record
  with no `expiresAt` is rejected (forces re-pair); `persist()` writes
  `{schema: 2}`; revoke still works. **`lastSeenAt` touch:** first valid use stamps
  `lastSeenAt` (fire-and-forget persist); a second use within `LASTSEEN_THROTTLE_MS`
  does **not** re-persist; a use after the throttle updates it; `findValidDevice`
  stays pure (no write).
- `devices.test.ts` (**update**): the direct `createDevice('Phone')` calls
  (`:98,111`) pass a ttl; the mint-then-guard-accepts test still passes with a
  stamped `expiresAt`.
- `lan-auth.test.ts`: valid `__Host-cw_lan` cookie passes; expired/revoked/garbage
  cookie 401s **through the guard**; header/Bearer/query still work; loopback
  bypasses; `cookie.parse` handles quoted/dup values.
- `csrf-origin.test.ts` (new): allowed LAN origin / `localhost` origin → pass;
  bad origin → 403; **no Origin + no Referer POST → 403**; companion header write →
  pass; loopback → pass; empty-NIC list still allows loopback origins.
- `devices.test.ts`/`pairing.test.ts` route tests: `pair-session` loopback-only +
  `409` when `!isLanTokenEnforced` + URL payload; `redeem-browser` sets
  `__Host-cw_lan`, returns `{label,expiresAt}`, **no raw token in body**; companion
  redeem now stamps `expiresAt` (the `pairing.test.ts:43` mock acknowledged);
  existing companion 8-char code + unknown-code-401 still pass.
- `redeem-browser` limiter test: 6th req/min → 429 (limiter not test-skipped;
  comment notes raw-`req.ip` keying is fine because entropy, not rate, is the
  control).
- `pairing-sessions.test.ts` (**update**): the 3 `createPairingSession(now)` calls
  → `(undefined, now)`; label stash + return; `bytes=10` code = 16 chars; companion
  `bytes=5` code still 8 chars; per-code burn-on-miss.
- `config/registry.test.ts` (**update**): knob present (default 30, integer,
  `apply:live`); group count → eleven incl. `lan-access`.
- Invariant tests: `trust proxy` never set; only the two redeem routes + `/audio`
  mount pre-guard.

**Frontend**
- `lan-access-card.test.tsx`: authorize→label→QR; device list
  (label·added·last-seen·expires, "—" before first touch) + Revoke;
  401→desktop-only note; not-enforced→warn + mint disabled.
- `pair.test.tsx`: renders confirm from `useSearchParams` `c`; Authorize POSTs,
  strips code, `navigate('/')`; **no Layout boot effects fire** (sibling shell);
  expired / rate-limited errors; re-hydrate GET runs **after** redeem resolves
  (not in parallel — slow-device cookie race).
- `book-library.test.tsx` **and a `library-grid` case**: failed scan → error +
  Retry (regression: red before the resilience fix); `library-slice.test.ts`:
  `hydrate` clears `error`.
- shared-QR component test: renders both the companion `CWP1` payload and the
  `#/pair?c=` browser payload; `pair-device` modal regression stays green.

**E2E** (`e2e/`) — a **UI-flow** spec (mock mode): Admin → authorize shows a QR;
`#/pair?c=<mock>` renders the confirm and routes to `#/` after a **mocked** redeem.
**Not an auth test** (mock mode has no real cookie) — the real cookie→guarded-GET
chain is the supertest integration test + manual acceptance.

**Manual acceptance (real device)** — `npm run start:lan`, `LAN_HTTPS=1` +
`LAN_AUTH_TOKEN`: desktop Admin → Authorize → scan on phone → library loads +
survives reload; revoke on desktop → phone 401s next nav; the device's "last seen"
updates in the list after use; a phone write passes the Origin check, a forged
cross-origin write is 403. (A legacy companion token, if any, re-pairs once.)

## Dependencies

- Declare **`cookie@^1.1.1`** in `server/package.json` (currently only transitive
  via Express 5 — pin the installed version to avoid a duplicate in the tree;
  `cookie` ships its own types, no `@types/cookie`).

## Backlog

File `srv-NN` ("Authorize a browser over LAN via Admin device-linking",
`area:server`/`area:frontend`, `type:feature`) + a thin `docs/BACKLOG.md` row.
Nothing covers browser-over-LAN auth today.

## Decisions locked (after three review rounds)

- `__Host-cw_lan` cookie; `SameSite=Strict` **+** server Origin allow-list (full
  LAN URLs + explicit loopback origins, per-request, fail-closed; IPv6/`.local`
  documented limitations).
- QR URL with code in the **fragment**; 80-bit / 16-char browser code via a
  **separate** `createPairingSession(label, _, 10)` (companion 40-bit/8-char
  untouched); 5/min tested limiter; `isLanTokenEnforced()` mint gate; per-code
  burn-on-miss as defense-in-depth.
- **Every** `createDevice` caller (companion, admin, browser) passes
  `configValue('lan.deviceTokenTtlDays')`; expiry enforced once in
  `findValidDevice` (single-arg `isValidDeviceToken` calls it with default `now`).
  **No grandfather migration** — companion pairing wasn't reliably in use, so a
  legacy `schema: 1` token (no `expiresAt`) is rejected → one-time re-pair;
  `persist()` writes `schema: 2`, type widens to `1 | 2`. `device-tokens.ts`
  imports nothing from `config/`.
- `lastSeenAt` is **populated** via a throttled (~1 h) touch-on-use in
  `isValidDeviceToken`, so the device list shows real "last seen" for browser and
  companion tokens.
- `#/pair` is a **second top-level `createHashRouter` entry** (Layout-free,
  effect-free, URL-driven via `useSearchParams`); no `parseHash`. Re-hydrate is
  implicit via Layout mounting on `/` (no dispatch).
- `cookie@^1.1.1` declared. Managed device list (label·added·last-seen·expires) +
  per-device revoke; desktop-only label; 30-day default in Advanced config.
  Library resilience fix bundled.
```
