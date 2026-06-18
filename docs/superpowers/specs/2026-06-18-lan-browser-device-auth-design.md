---
title: Authorize a browser over LAN via Admin device-linking
date: 2026-06-18
status: draft
area: server + frontend
issue: srv-NN (to be filed)
revision: 3 (two adversarial review rounds — security + architecture — folded in)
---

# Authorize a browser over LAN via Admin device-linking

## Problem

With `LAN_HTTPS=1` and `LAN_AUTH_TOKEN` set, the LAN token guard
(`server/src/lan-auth.ts`) returns `401 "Missing or invalid LAN access
token."` for every non-loopback `/api/*` request that doesn't carry a valid
token. The web frontend's ~100 `fetch('/api/…')` calls send **no** token, so a
phone's **browser** on the LAN is locked out of the entire API:

- `getLibrary()` → 401 → `library.loaded` never flips → the books grid sits in
  its `animate-pulse` skeleton forever, with no error and no retry.
- Because the books grid **is** the navigation hub on the `books` stage (the
  Cast/Manuscript/Listen tabs only render once a book is open, and there is no
  hamburger by design), the user is stranded.

Desktop works only because `isLoopbackRequest()` bypasses the guard for
`127.0.0.1`/`::1`. The Android **companion** app works because it redeems a
pairing code into a per-device token and sends it as a header. A plain browser
has neither path.

The per-device token machinery (`srv-33`,
`server/src/workspace/device-tokens.ts`) and the QR pairing flow
(`server/src/routes/pairing.ts` + `server/src/routes/pairing-sessions.ts`)
already exist — they were built for the companion. This feature extends them so
a **browser** can be authorized too, managed from the desktop **Admin** screen.

## Goals

1. From the desktop **Admin** screen, mint a time-limited authorization for a
   phone's browser by showing a **QR code** the phone's **native camera** can
   open — no typing, no token copy-paste on the phone.
2. Once authorized, the browser's same-origin API calls **just work** for the
   token's lifetime (default **30 days**), with **zero changes** to the ~100
   `fetch` call sites.
3. The Admin screen **lists** authorized devices and can **revoke** any one
   immediately.
4. Lifetime is a configurable env knob (`LAN_DEVICE_TTL_DAYS`, default 30)
   surfaced in **Advanced configuration**.
5. Make the failed-library-scan dead-end recoverable (Retry, not eternal skeleton).
6. Introducing cookie auth must **not** open a CSRF hole the header-token model
   didn't have.

## Non-goals

- Changing **when** the guard enforces (still `LAN_HTTPS=1` **and**
  `LAN_AUTH_TOKEN`). But the Admin card must **surface** this state (§Security).
- Changing the companion's `POST /api/pair/redeem` request/response contract.
  *(Existing companion tokens are grandfathered — §Migration — so paired phones
  keep working.)*
- Per-user accounts / roles. Single-owner LAN tool; minting is gated by physical
  desktop (loopback) access.
- Editing the device label on the phone (decided: **desktop-only** label).

## User experience

**Desktop** (`#/admin` → new **"LAN access"** card):
1. **"Authorize a device"** → type a **label** → a **QR** appears with a ~5-min
   countdown + **Regenerate**.
   - If `!isLanTokenEnforced()`, the card **refuses to mint** and warns:
     *"Device authorizations have no effect until LAN auth is enabled (set
     `LAN_AUTH_TOKEN`)."*

**Phone:**
2. Native camera scans the QR → it's `https://<host>:8443/#/pair?c=<code>` (code
   in the **hash fragment**) → browser opens it.
3. **"Authorize this browser until <date>?"** → one tap **Authorize**.
4. Server validates the code, mints a 30-day device token, **sets an `HttpOnly`
   cookie**. The page `history.replaceState`s the code away and navigates to
   `#/`; mounting Layout there triggers its library fetch (which now carries the
   cookie).

**Desktop** card then lists the device (label · added · last-seen · expires) with
**Revoke** (immediate on next request; rename in v1 = revoke + re-authorize).

*Prerequisite (already true on the user's box):* the phone trusts the mkcert root
CA, so HTTPS opens cleanly and the `Secure` cookie is honored. Card links to the
cert-install steps.

## Architecture

### Server

**`server/src/workspace/device-tokens.ts`**

- `DeviceTokenRecord` gains `expiresAt?: string` (ISO; optional so legacy files
  type-check pre-migration).
- `createDevice(label, ttlDays)` — `ttlDays` is **required** and stamps
  `expiresAt = now + ttlDays·86400s`. **Every** caller passes it (see callers
  below), so every newly-minted token always has an `expiresAt`.
- **Expiry check lives in `findValidDevice(devices, rawToken, now = Date.now())`**
  (the pure function gains a defaulted, injected clock so it stays
  deterministic/testable). It rejects when: `revoked`, OR `expiresAt === undefined`
  (post-migration this means corruption — fail safe), OR `now >
  Date.parse(expiresAt)`. `isValidDeviceToken(rawToken)` keeps its **single-arg**
  signature and calls `findValidDevice(loadSync(), rawToken)` (default `now`).
  *(There is no second, contradictory location for the check — it is here only.)*
- `redactDevice`/`PublicDevice` expose `expiresAt` via a **conditional spread**
  (mirroring the existing `lastSeenAt` pattern) so a record without it doesn't
  emit `expiresAt: undefined`.
- This module **does** import `configValue` from `config/resolver.ts` (only for
  the migration below). *(The earlier "imports nothing from config" rule is
  dropped — it was irreconcilable with the migration needing a TTL.)*

**Migration — `migrateLegacyDeviceTokens()`, run once at server startup**
(before `listen`, alongside other workspace init). On a `schema: 1` file
(records with no `expiresAt`), stamp each `expiresAt = createdAt +
configValue('lan.deviceTokenTtlDays')·86400s`, bump to `{schema: 2}`, and
**persist to disk once**. Thereafter every record has a concrete, **immutable**
`expiresAt`, so later changes to `LAN_DEVICE_TTL_DAYS` affect only *new* tokens —
raising the TTL can **never resurrect** an expired/revoked legacy token. Existing
companion devices keep working for their nominal lifetime (no forced re-pair).

**`server/src/routes/pairing-sessions.ts`**

- `Session` gains `label?: string` and a `misses: number` counter.
- `createPairingSession(label?, now?, bytes = 5)` stashes `label` and generates
  the code from `randomBytes(bytes)`. **The browser path calls it with
  `bytes = 10` (≥80-bit)**; the companion path keeps `bytes = 5` (40-bit) so its
  compact `CWP1` payload and `pairing.test.ts` 8-char assertion are **untouched**.
- `redeemPairingSession(code, now?)` returns `{ ok: true; label?: string }` on
  success (was `{ ok: true }`; the companion caller only reads `ok`/`reason`, so
  this is backward-compatible). **Burn-on-miss is per-code**: sessions are keyed
  by the code (`sessions.get(code)`), so a wrong guess hits `undefined` and burns
  nothing — the `misses++`-then-consume only applies to repeated misses against a
  *known live* code. It is **defense-in-depth, not the primary control** (entropy
  + rate-limit + 5-min TTL are). Cannot become a victim-burn vector because
  sessions are code-keyed, not id-keyed. `_resetPairingSessionsForTests` already
  clears the whole map.

**`server/src/lan-auth.ts`**

- `extractToken(req)` gains a **cookie** source read with the **`cookie`
  package** (`cookie.parse(req.headers.cookie ?? '')`) — `req.cookies` does not
  exist (no cookie-parser mounted). It reads **exactly `__Host-cw_lan`** (the
  literal Set-Cookie name; the unprefixed alias is dropped). Cookie is checked
  **first** for the browser path; Bearer/`X-Lan-Token`/`?token=` remain for the
  companion.
- Enforcement conditions unchanged. `isLoopbackRequest` documents the
  un-proxied-bind assumption.

**`server/src/csrf-origin.ts`** (new) — CSRF defense for cookie auth.

- Applied to **state-changing** methods (`POST`/`PUT`/`PATCH`/`DELETE`) inside the
  `/api` surface, mounted **after `requireLanToken`**, before route handlers.
  Only gates requests that **carry the `__Host-cw_lan` cookie**; loopback and
  header/Bearer (companion) requests pass untouched → **no change to the ~100
  fetch call sites.**
- **Allow-list** (recomputed per request, never empty): the **full, un-stripped**
  `enumerateLanUrls(port, 'https').urls` (already `https://<ip>:<port>` form)
  **plus** explicit `https://localhost:<port>`, `https://127.0.0.1:<port>`,
  `https://[::1]:<port>`. Compares the request's `Origin` (fallback `Referer`'s
  origin) against the set. **Fail-closed**: a cookie-bearing write with **neither
  Origin nor Referer** → 403 (browsers always send `Origin` on non-GET fetch).
  Hostname / `.local` access is a **documented limitation** (use the IP from the
  QR).

**`server/src/routes/devices.ts`**

- Reuse `GET /api/devices` (list) + `DELETE /api/devices/:id` (revoke) —
  loopback-gated behind the `/api` guard.
- Its existing **admin mint** caller updates to `createDevice(label,
  configValue('lan.deviceTokenTtlDays'))`.
- **New** `POST /api/devices/pair-session` (loopback-only; `409` when
  `!isLanHttpsEnabled()`): body `{ label }` → `createPairingSession(label,
  undefined, 10)` → `{ url, code, expiresAt }`, `url =
  https://<hostPort>/#/pair?c=<code>` (code in the **hash fragment**; never a
  real query param).

**`server/src/routes/pairing.ts`**

- The existing **companion redeem** caller updates to `createDevice(label,
  configValue('lan.deviceTokenTtlDays'))` too — so companion-minted tokens also
  get an `expiresAt` (else the new reject-on-undefined rule would lock out every
  freshly-paired companion device).
- **New** `POST /api/pair/redeem-browser` on the **pre-guard** router (next to
  `/api/pair/redeem`), hardened:
  - `409` when `!isLanHttpsEnabled()` (never mint/emit a `Secure` cookie over HTTP).
  - Scoped `express.json({ limit: '1kb' })` + a **dedicated** rate limiter
    (5/min, `keyGenerator: req => req.ip`, in-memory single-process store) that is
    **NOT skipped under Vitest** (the global `apiLimiter` is) — and is tested.
  - Body `{ code }` → `redeemPairingSession(code)` (single-use, burn-on-miss) →
    `ttl = configValue('lan.deviceTokenTtlDays')` (read **once**) →
    `createDevice(label, ttl)` → `res.cookie('__Host-cw_lan', token, {
    httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge:
    ttl·86400_000 })`. Responds `{ label, expiresAt }` — **the raw token never
    reaches JS.**

**`server/src/config/registry.ts`**

- Group `{ id: 'lan-access', label: 'LAN access & device tokens', help: '…',
  risk: 'low', collapsedByDefault: false }` (`collapsedByDefault` is **required**
  by `ConfigGroup`).
- Knob `{ key: 'lan.deviceTokenTtlDays', env: 'LAN_DEVICE_TTL_DAYS', group:
  'lan-access', label: 'Device authorization lifetime (days)', help: '…', type:
  'integer', min: 1, default: 30, apply: 'live', risk: 'low' }`. The knob default
  `30` is the **single source of truth**; no module keeps an independent default.
- **Update `registry.test.ts`** — its exact-array "declares the ten groups"
  assertion becomes eleven (`lan-access`).

### Frontend

**Router — `src/routes/index.tsx`.** There is **no `App.tsx`**; `main.tsx`
mounts `<Provider store><RouterProvider router={createHashRouter([...])}/>`. The
router today is a **single** top-level route `{ path: '/', element: <Layout/>,
children: [...] }`. Add a **second top-level entry** (a *sibling*, not a child):

```js
createHashRouter([
  { path: '/pair', element: <PairShell/> },          // NEW — no <Layout>, no boot effects
  { path: '/', element: <Layout/>, children: [ ... ] }, // unchanged
])
```

Because Redux `<Provider>` and the theme (applied to `document.documentElement`
in `main.tsx`) live **above** the router, `PairShell` gets store + theme for
free **without** mounting `<Layout>` — so none of Layout's ~6 authed boot fetches
(`fetchAccountSettings`, `getSetupReadiness`, `getLibrary`, `getActiveAnalyses`,
`getVoices`, `getBaseVoices`) or its Redux→URL sync run on the unauth phone.
`PairShell` must **not** read/act on a rehydrated persisted `ui.stage` (it owns no
stage; it renders purely from the URL). There is **no `parseHash`** (it was
removed) — read the code via `useSearchParams().get('c')` (the `HelpRoute` idiom).

**`src/views/pair.tsx` (`PairShell`)** — reads `c`, shows the one-tap
**"Authorize this browser until <date>"** screen, POSTs `redeemBrowserPair({code})`.
On success: `history.replaceState` to drop the code, then `navigate('/')` —
**no explicit re-hydrate dispatch** (there is no fetching library action; Layout
mounts on `/` and its effect fetches because `library.loaded === false`). The
`getLibrary()` GET carries the freshly-set cookie (Set-Cookie lands with the
redeem response, before its promise resolves). Error states: invalid / expired /
rate-limited → "This code expired — generate a new one on the desktop."

**`src/components/lan-access-card.tsx` (new, in `src/views/admin.tsx`)** —
"Authorize a device" → label → QR + countdown + Regenerate, plus the device list
(label · added · last-seen · expires · **Revoke**). Detects the not-enforced
state (warn + disable mint) and the 401-on-phone state (show "manage from
desktop") via a **typed error `.status`** on the new api fns (not a message regex).

**Shared QR component** — extract the QR + countdown + Regenerate block out of
`src/modals/pair-device.tsx` (today it renders the compact `CWP1` payload for the
Listen-banner companion flow) into a component **parameterized by payload string
+ session-fetch fn**, used by both the companion modal and the new Admin card.
Real extraction, not a copy.

**`src/lib/api.ts`** — new fns `createDevicePairSession`, `listDevices`,
`revokeDevice`, `redeemBrowserPair` (+ mock mirrors, required for mock-mode &
e2e). New real impls throw a typed `ApiError` carrying `.status`. **No change to
existing call sites** — default `credentials: 'same-origin'` attaches the cookie.

### Resilience fix (failed library scan) — bundled

- `src/store/library-slice.ts`: add `error: string | null` (init `null`);
  `hydrateError(message)` sets `loaded = true` + `error`; `hydrate(...)` **clears
  `error` to `null`** on success.
- `src/components/layout.tsx` library-hydrate effect: on `getLibrary()` failure
  dispatch `hydrateError(message)` (instead of only `console.error`).
- `src/views/book-library.tsx` / `library-grid.tsx`: when `loaded && error`,
  render "Couldn't load your library — Retry" (Retry re-runs the hydrate).

## Data flow

```
Desktop Admin                  Server                              Phone browser
─────────────                  ──────                              ─────────────
"Authorize"+label
 └ POST /api/devices/pair-session {label}  (loopback; 409 if !LAN_HTTPS)
       └ createPairingSession(label, _, bytes=10) ─► {url(#/pair?c=…), code≥80b, expiresAt}
 ◄ QR(url)
                                                       scan QR (native camera)
                                                       open https://host/#/pair?c=…
                                                 ◄──── GET static shell → PairShell (no Layout)
                                                       tap Authorize
                        POST /api/pair/redeem-browser {code}
                          (pre-guard; 5/min limiter; 1kb; 409 if !LAN_HTTPS)
                          └ redeemPairingSession(code) → label  (single-use, per-code burn)
                          └ ttl = configValue('lan.deviceTokenTtlDays')
                          └ createDevice(label, ttl) → expiresAt
                          └ Set-Cookie __Host-cw_lan=<token>
                               HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=ttl
                        ───────────────────────────────────────► {label, expiresAt}
                                                       history.replaceState (drop code)
                                                       navigate('/') → Layout mounts
                                                       getLibrary() (cookie) ✓   (writes also Origin-checked)
GET /api/devices ─► list ;  DELETE /api/devices/:id ─► revoke
```

## Security model

- **Cookie:** `__Host-cw_lan` — `HttpOnly`, `Secure` (redeem `409`s under HTTP so
  it's never silently dropped), `SameSite=Strict`, `Path=/`, no `Domain`
  (`__Host-` enforces Secure + Path=/ + host-only). `Max-Age = ttl`, but the
  **server enforces `expiresAt` in `findValidDevice`** — the client `Max-Age` is
  not the authority.
- **CSRF:** `SameSite=Strict` is necessary but insufficient (on a bare LAN IP it
  is port-agnostic), so the server **Origin allow-list** middleware gates every
  cookie-authenticated state-changing request (full LAN URLs + explicit loopback
  origins, per-request, never empty, fail-closed on absent Origin+Referer).
  Header/Bearer (companion) and loopback writes are exempt. This restores the
  CSRF-immunity the header model had.
- **Unauth mint hardening:** `redeem-browser` is necessarily pre-guard (the phone
  has no cookie yet — so CSRF is N/A there, and a forged cross-site POST would
  still need a live ≥80-bit single-use code). Gated by `isLanHttpsEnabled()`, a
  dedicated **tested** 5/min/IP limiter, a 1 KB body cap, ≥80-bit code, 5-min TTL,
  per-code burn-on-miss (defense-in-depth). The code rides only in the URL
  **fragment** (no Referer/log leak) and is stripped from history post-redeem.
- **Loopback gate invariant:** the only `/api` mounts **before** `requireLanToken`
  are the two redeem routes (`/api/pair/redeem`, `/api/pair/redeem-browser`, both
  code-gated mints) and read-only `/audio`; a test asserts that set doesn't grow.
  `trust proxy` is unset (verified) so `X-Forwarded-For` can't spoof loopback; a
  test asserts it stays unset.
- **Footgun surfaced:** unset `LAN_AUTH_TOKEN` → guard no-ops → the Admin card
  refuses to mint and warns (we do not auto-enable enforcement).

## Testing plan

**Server**
- `device-tokens.pure.test.ts` (**update**): reseed **all** fixtures with
  `expiresAt`; fix the `redactDevice` `toEqual` (conditional `expiresAt`); add
  `findValidDevice` cases — expired, `expiresAt===undefined`, injected `now`.
- `device-tokens.test.ts`: `createDevice` stamps `expiresAt`; `migrateLegacyDevice
  Tokens` persists concrete expiry once (idempotent on re-run; raising TTL after
  migration does **not** move a migrated record); revoke still works.
- `lan-auth.test.ts`: valid `__Host-cw_lan` cookie passes; expired/revoked/garbage
  cookie 401s **through the guard**; header/Bearer/query still work; loopback
  bypasses; `cookie.parse` handles quoted/dup values.
- `csrf-origin.test.ts` (new): cookie write with allowed LAN origin / `localhost`
  origin → pass; bad origin → 403; **no Origin + no Referer POST → 403**;
  companion header write → pass; loopback → pass; empty-NIC list still allows
  loopback origins.
- `devices.test.ts`: `pair-session` loopback-only + `409` w/o LAN_HTTPS + URL
  payload; `redeem-browser` sets `__Host-cw_lan`, returns `{label,expiresAt}`,
  **no raw token in body**; admin mint stamps `expiresAt`; list/revoke reflect it.
- `redeem-browser` limiter test: 6th req/min → 429 (limiter not test-skipped).
- `pairing-sessions.test.ts`: label stash + return; `bytes=10` code ≥16 Crockford
  chars; companion `bytes=5` code still 8 chars; per-code burn-on-miss.
- `pairing.test.ts` (**update**): companion redeem now stamps `expiresAt` (mock /
  assertions); existing 8-char code + unknown-code-401 still pass.
- `config/registry.test.ts` (**update**): knob present (default 30, integer,
  `apply:live`); group count → eleven incl. `lan-access`.
- Invariant tests: `trust proxy` never set; only the two redeem routes + `/audio`
  mount pre-guard.

**Frontend**
- `lan-access-card.test.tsx`: authorize→label→QR; device list + Revoke;
  401→desktop-only note; not-enforced→warn + mint disabled.
- `pair.test.tsx`: renders confirm from `useSearchParams` `c`; Authorize POSTs,
  strips code, `navigate('/')`; **no Layout boot effects fire** (sibling shell);
  expired / rate-limited errors; re-hydrate GET runs **after** redeem resolves
  (not in parallel — slow-device cookie race).
- `book-library.test.tsx` / `library-slice.test.ts`: failed scan → error + Retry
  (regression: red before the resilience fix); `hydrate` clears `error`.

**E2E** (`e2e/`) — a **UI-flow** spec (mock mode): Admin → authorize shows a QR;
`#/pair?c=<mock>` renders the confirm and routes to `#/` after a **mocked** redeem.
**Not an auth test** (mock mode has no real cookie) — stated so it isn't mistaken
for auth coverage; the real cookie→guarded-GET chain is the supertest integration
test + manual acceptance.

**Manual acceptance (real device)** — `npm run start:lan`, `LAN_HTTPS=1` +
`LAN_AUTH_TOKEN`: desktop Admin → Authorize → scan on phone → library loads +
survives reload; revoke on desktop → phone 401s next nav; a previously-paired
**companion** device still works (grandfathering); a write from the phone passes
the Origin check, a forged cross-origin write is 403.

## Backlog

File `srv-NN` ("Authorize a browser over LAN via Admin device-linking",
`area:server`/`area:frontend`, `type:feature`) + a thin `docs/BACKLOG.md` row.
Nothing covers browser-over-LAN auth today.

## Decisions locked (after two review rounds)

- `__Host-cw_lan` cookie; `SameSite=Strict` **+** server Origin allow-list (full
  LAN URLs + explicit loopback origins, per-request, fail-closed).
- QR URL with code in the **fragment**; ≥80-bit browser code via a **separate**
  `bytes=10` session (companion 40-bit untouched); 5/min tested limiter;
  `isLanHttpsEnabled()` gate; per-code burn-on-miss as defense-in-depth.
- **Every** `createDevice` caller (companion, admin, browser) passes
  `configValue('lan.deviceTokenTtlDays')`; expiry enforced once in
  `findValidDevice`; legacy tokens grandfathered by a **one-time persisted**
  schema 1→2 migration (no resurrection on TTL change).
- `#/pair` is a **second top-level `createHashRouter` entry** (Layout-free,
  effect-free, URL-driven via `useSearchParams`); no `parseHash`.
- Re-hydrate happens implicitly when Layout mounts on `/` (no dispatch).
- `cookie` declared in `server/package.json`.
- Managed device list + per-device revoke; desktop-only label; 30-day default in
  Advanced config. Library resilience fix bundled.
