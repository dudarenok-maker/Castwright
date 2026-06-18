---
title: Authorize a browser over LAN via Admin device-linking
date: 2026-06-18
status: draft
area: server + frontend
issue: srv-NN (to be filed)
revision: 2 (adversarial security + architecture review folded in)
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
3. The Admin screen **lists** authorized devices (label · added · last-seen ·
   expires) and can **revoke** any one immediately.
4. The lifetime is a configurable env knob (`LAN_DEVICE_TTL_DAYS`, default 30)
   surfaced in the **Advanced configuration** screen.
5. Make the failed-library-scan dead-end recoverable: show a "Couldn't load —
   Retry" state instead of an eternal skeleton.
6. **Introducing cookie auth must not open a CSRF hole** the header-token model
   didn't have. (Added in review — see Security model.)

## Non-goals

- Changing **when** the guard enforces. It still engages only when
  `LAN_HTTPS=1` **and** `LAN_AUTH_TOKEN` is set. Broadening it would silently
  lock out existing token-less LAN users. *(But the Admin card must surface this
  state — see §Security/footgun.)*
- Touching the companion's existing header-token redeem
  (`POST /api/pair/redeem`) request/response contract. *(Existing companion
  tokens ARE grandfathered through the schema migration — see §Migration — so
  paired phones keep working.)*
- Per-user accounts / roles. Single-owner LAN tool; "authorize a device" is a
  convenience gated by physical access to the desktop.
- Editing the device label on the phone (decided: **desktop-only** label).

## User experience

**On desktop** (`#/admin` → new **"LAN access"** card):

1. Click **"Authorize a device"**.
2. Type a **label** (e.g. "Mike's iPhone").
3. A **QR code** appears with a short countdown (the pairing code is one-time and
   expires in ~5 min; a **Regenerate** button re-mints).
   - If `!isLanTokenEnforced()` (LAN auth not actually on), the card **refuses to
     mint** and shows: *"Device authorizations have no effect until LAN auth is
     enabled (set `LAN_AUTH_TOKEN`)."*

**On the phone:**

4. Open the **native camera**, point at the QR. It encodes a real URL
   (`https://<host>:8443/#/pair?c=<code>`, code in the **hash fragment**); the
   phone browser opens it.
5. The app shows **"Authorize this browser until <date>?"** → one tap
   **"Authorize"**.
6. Server validates the code, mints a 30-day device token, and **sets an
   `HttpOnly` cookie**. The page strips the code from history
   (`history.replaceState`), re-hydrates the library, and routes into the app.

**Back on desktop**, the "LAN access" card lists the new device with **Revoke**.
Revoke takes effect on the device's next request. (Renaming in v1 = revoke +
re-authorize; there's no rename endpoint.)

*Prerequisite (already satisfied on the user's setup):* the phone trusts the
mkcert root CA, so the HTTPS LAN URL opens without a warning, and the `Secure`
cookie is honored. The Admin card links to the existing cert-install steps.

## Architecture

### Server

**`server/src/workspace/device-tokens.ts`** — add expiry, keep purity.

- `DeviceTokenRecord` gains `expiresAt?: string` (ISO; optional so legacy reads
  type-check).
- `createDevice(label, ttlDays)` — signature gains `ttlDays` (the route passes
  the resolved config value; the module imports **nothing** from `config/`).
  Stamps `expiresAt = now + ttlDays·86400s`.
- **Expiry is enforced in the IO caller `isValidDeviceToken`, not in the pure
  `findValidDevice`.** `findValidDevice(devices, rawToken, now)` gains an
  injected `now` param (default `Date.now()`) so it stays deterministic/testable;
  it rejects a record when `revoked`, OR `expiresAt === undefined`
  (legacy/never-stamped), OR `now > Date.parse(expiresAt)`. This is the single
  hot-path expiry check the guard relies on.
- `redactDevice` / `PublicDevice` expose `expiresAt`.
- Token entropy unchanged (`randomBytes(32)` → 256-bit, SHA-256 hashed) — fine.

**Migration (`loadSync`)** — persistence shape bumps to `{schema: 2, devices}`.
On load, any record with **no `expiresAt`** (a `schema: 1` companion token) is
**grandfathered**: stamped in-memory with `expiresAt = createdAt +
ttlDays·86400s` so existing paired phones keep working for their nominal
lifetime rather than being force-re-paired. (Resolves the review's
"insta-expiry contradicts the companion non-goal" finding.)

**`server/src/routes/pairing-sessions.ts`** — carry the label (net-new).

- `Session` gains `label?: string`.
- `createPairingSession(label?, now?)` stashes it (keep `label` optional so the
  existing companion `POST /api/pair/session` caller and
  `_resetPairingSessionsForTests` compile unchanged).
- `redeemPairingSession(code, now?)` returns `{ ok: true; label?: string }` on
  success (was `{ ok: true }`).

**`server/src/lan-auth.ts`** — accept the cookie.

- `extractToken(req)` gains a `cw_lan`/`__Host-cw_lan` **cookie** source. There
  is **no cookie-parser mounted** (`req.cookies` does not exist), so parse
  `req.headers.cookie` with the zero-dep **`cookie` package** (`cookie.parse`),
  not a hand-rolled splitter. Precedence: cookie is checked **first** for the
  browser path; Bearer/`X-Lan-Token`/`?token=` remain for the companion.
- Enforcement conditions (`isLanTokenEnforced`) unchanged.

**`server/src/csrf-origin.ts`** (new) — CSRF defense for cookie auth.

- Middleware applied to **state-changing** `/api` methods (`POST`/`PUT`/`PATCH`/
  `DELETE`): reject (403) when the request carries a `cw_lan` cookie **and** its
  `Origin` (fallback `Referer`) is not in the allow-list (`enumerateLanUrls()`
  origins + the loopback origins). Loopback requests and header/Bearer-token
  (companion) requests pass — only cookie-bearing browser writes are gated.
- Mounted **inside** the `/api` surface, after `requireLanToken`, before the
  route handlers. One middleware; **no change to the ~100 fetch call sites.**

**`server/src/routes/devices.ts`** — mint session + reuse list/revoke.

- Reuse `GET /api/devices` (list) and `DELETE /api/devices/:id` (revoke) —
  loopback-gated behind the `/api` guard.
- **New** `POST /api/devices/pair-session` (loopback-only; also `409` when
  `!isLanHttpsEnabled()`): body `{ label }`; calls `createPairingSession(label)`;
  returns `{ url, code, expiresAt }` where `url =
  https://<hostPort>/#/pair?c=<code>` (full-URL QR payload; code in the **hash
  fragment**, never a real query param — Referer/log hygiene).

**`server/src/routes/pairing.ts`** — browser redeem (pre-guard).

- **New** `POST /api/pair/redeem-browser`, mounted on the **pre-guard** router
  next to `/api/pair/redeem`, hardened:
  - `409` when `!isLanHttpsEnabled()` (never mint/emit a `Secure` cookie over
    HTTP — the browser would silently drop it).
  - Scoped `express.json({ limit: '1kb' })` + a **dedicated strict rate limiter**
    (e.g. 5/min/IP) that is **NOT skipped under Vitest** (the global `apiLimiter`
    is — so it must be its own limiter and it must be tested).
  - Body `{ code }`. `redeemPairingSession(code)` is single-use; add a
    **per-code failed-attempt burn** (N misses ⇒ session consumed) in
    `pairing-sessions.ts`.
  - On success: `createDevice(label, ttlDays)` (label from the session; `ttlDays`
    computed **once** here and reused for the cookie), then
    `res.cookie('__Host-cw_lan', token, { httpOnly: true, secure: true,
    sameSite: 'strict', path: '/', maxAge: ttlDays·86400_000 })`. Responds
    `{ label, expiresAt }` — **the raw token never reaches JS.**
  - **Code entropy:** the browser pair-session code is **≥80-bit** (the URL QR
    has room; only the companion's compact `CWP1` payload needed 40-bit). Either
    widen the shared generator's output for this path or add a wider browser
    code.

**`server/src/config/registry.ts`** — new knob + group.

- Group: `{ id: 'lan-access', label: 'LAN access & device tokens', help: '…',
  risk: 'low', collapsedByDefault: false }` (**`collapsedByDefault` is required**
  by `ConfigGroup` — `config/types.ts`).
- Knob: `{ key: 'lan.deviceTokenTtlDays', env: 'LAN_DEVICE_TTL_DAYS', group:
  'lan-access', label: 'Device authorization lifetime (days)', help: '…', type:
  'integer', min: 1, default: 30, apply: 'live', risk: 'low' }`.
- The `redeem-browser` handler reads the effective value via
  **`configValue('lan.deviceTokenTtlDays')`** (`config/resolver.ts`) — the knob
  default `30` is the single source of truth; `device-tokens.ts` keeps no
  independent default.

### Frontend

**Router (`src/lib/router.ts` + `src/routes/index.tsx`)** — `#/pair` is a
**sibling of `<Layout>`**, NOT a child. Every existing route nests under
`<Layout>`, which fires ~6 authed boot fetches (`fetchAccountSettings`,
`getSetupReadiness`, `getLibrary`, `getActiveAnalyses`, `getVoices`,
`getBaseVoices`) + a setup-readiness splash — all 401 on an unauth phone. `#/pair`
gets its **own minimal, effect-free shell** so it paints immediately and makes
exactly one call (`redeem-browser`). `parseHash` must parse `?c=` out of the
**fragment** (not `window.location.search`).

**`src/views/pair.tsx`** (new) — reads `?c=<code>`, shows the one-tap
**"Authorize this browser until <date>"** screen, POSTs to
`/api/pair/redeem-browser`. On success: `history.replaceState` to drop the code,
dispatch a **library re-hydrate**, navigate to `#/`. Error states: invalid /
expired / rate-limited code → "This code expired — generate a new one on the
desktop."

**`src/components/lan-access-card.tsx`** (new, rendered in `src/views/admin.tsx`)
— "Authorize a device" → label input → QR + countdown + Regenerate, plus the
device list (label · added · last-seen · expires · **Revoke**). When
`createDevicePairSession()`/`listDevices()` returns **401** (the message-string
status, matched the way `pair-device.tsx:49` regexes `409`, OR via a new typed
`.status` on the error), render the "manage from desktop" note. When the server
reports LAN auth is **not enforced**, render the footgun warning and disable
minting.

**Shared QR component** — extract the QR + countdown + Regenerate block from
`src/modals/pair-device.tsx` (which today renders the compact `CWP1` payload for
the Listen-banner companion flow) into a shared component **parameterized by
payload string + session-fetch fn**, so both the companion modal and the new
Admin card use it. This is a real extraction, not a copy.

**`src/lib/api.ts`** — new functions (`createDevicePairSession`, `listDevices`,
`revokeDevice`, `redeemBrowserPair`) + mock mirrors. New real impls throw a
typed error carrying `.status` (so 401-detection isn't a string-sniff). **No
change to existing call sites** — default `credentials: 'same-origin'` already
attaches the cookie.

### Resilience fix (failed library scan) — bundled (the pair flow needs it)

- `src/components/layout.tsx` library-hydrate effect: on `getLibrary()` failure,
  dispatch `libraryActions.hydrateError(message)` so `loaded` becomes `true`
  with an `error` set (instead of only `console.error`).
- `src/store/library-slice.ts`: add `error: string | null`.
- `src/views/book-library.tsx` / `library-grid.tsx`: when `loaded && error`,
  render "Couldn't load your library — Retry" (Retry re-runs the hydrate) instead
  of skeleton/empty. The `pair.tsx` success path reuses this re-hydrate.

## Data flow

```
Desktop Admin                 Server                          Phone browser
─────────────                 ──────                          ─────────────
"Authorize" + label
 └ POST /api/devices/pair-session {label}  (loopback; 409 if !LAN_HTTPS)
       └ createPairingSession(label) ─► {url(#/pair?c=…), code(≥80b), expiresAt}
 ◄ QR(url)
                                                    scan QR (native camera)
                                                    open https://host/#/pair?c=…
                                              ◄──── GET static shell (Layout-free)
                                                    tap "Authorize"
                       POST /api/pair/redeem-browser {code}
                         (pre-guard; strict limiter; 1kb; 409 if !LAN_HTTPS)
                         └ redeemPairingSession(code) → label  (single-use, burn-on-miss)
                         └ ttl = configValue('lan.deviceTokenTtlDays')
                         └ createDevice(label, ttl)  → expiresAt
                         └ Set-Cookie __Host-cw_lan=<token>
                              HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=ttl
                       ──────────────────────────────────────► {label, expiresAt}
                                                    history.replaceState (drop code)
                                                    re-hydrate library → #/
                                                    GET /api/library (cookie) ✓
                                                    (writes also pass Origin check)
GET /api/devices ─► list incl. new device
DELETE /api/devices/:id ─► revoke
```

## Security model

- **Cookie:** `__Host-cw_lan`, `HttpOnly` (XSS can't read it), `Secure`
  (HTTPS-only; redeem `409`s under plain HTTP so the cookie is never silently
  dropped), `SameSite=Strict`, `Path=/`, no `Domain` (the `__Host-` prefix
  enforces Secure + Path=/ + host-only). `Max-Age = ttl`; the **server also
  enforces `expiresAt`** in `findValidDevice`, so the client-controlled `Max-Age`
  is not the authority.
- **CSRF:** `SameSite=Strict` is necessary but **not sufficient** — on a bare
  LAN IP, `SameSite` is port-agnostic (any service on the same host/IP is
  "same-site"). So a server-side **Origin/Referer allow-list** middleware gates
  every cookie-authenticated **state-changing** request against the known LAN +
  loopback origins. Header/Bearer (companion) and loopback requests are exempt.
  This restores the CSRF-immunity the header model had for free.
- **Unauthenticated mint hardening:** `redeem-browser` is pre-guard by necessity
  (the phone has no token yet). It is gated by `isLanHttpsEnabled()`, a dedicated
  **tested** 5/min/IP limiter, a 1 KB body cap, an **≥80-bit** single-use code
  with **burn-on-miss**, and a 5-min code TTL. A LAN peer who races/guesses a
  live code can mint a token; entropy + lockout + TTL keep that impractical, and
  the code rides only in the URL **fragment** (no Referer/log leak) and is
  stripped from history post-redeem.
- **Expiry authority:** enforced in `findValidDevice` (the function the guard
  calls), tested **through the guard** with a past-expiry record. Wall-clock,
  no skew tolerance (documented).
- **Footgun surfaced:** if `LAN_AUTH_TOKEN` is unset the guard no-ops and the
  device list is decorative — the Admin card refuses to mint and warns. (We do
  not auto-enable enforcement; that stays an explicit opt-in per the non-goal.)
- **Loopback gate invariant:** `isLoopbackRequest` is the *entire* gate for the
  minting endpoints. `trust proxy` is currently unset (verified) so `req.ip` ==
  socket address and `X-Forwarded-For` can't spoof loopback. A test asserts
  `trust proxy` stays unset; `lan-auth.ts` documents the un-proxied-bind
  assumption.

## Testing plan

- **Server unit/integration (`server/src/**/*.test.ts`)**:
  - `device-tokens.pure.test.ts` — **update existing**: seed fixtures with
    `expiresAt`; fix the `redactDevice` `toEqual` to include `expiresAt`; add
    `findValidDevice` cases for expired / undefined-`expiresAt` / `now` injection.
  - `device-tokens.test.ts` — grandfather migration stamps legacy records;
    expired token rejected; revoke still works.
  - `lan-auth.test.ts` — valid `__Host-cw_lan` cookie passes; expired/revoked/
    garbage cookie 401s **through the guard**; header/Bearer/query still work;
    loopback bypasses; `cookie.parse` handles dup/quoted values.
  - **`csrf-origin.test.ts`** (new) — cookie write with bad/absent Origin → 403;
    allowed LAN origin → pass; companion header write → pass; loopback → pass.
  - `devices.test.ts` — `pair-session` loopback-only + `409` without LAN_HTTPS +
    URL payload; redeem-browser sets `__Host-cw_lan` + returns `{label,expiresAt}`
    and **does not leak the raw token**; list/revoke reflect the device.
  - **`redeem-browser` limiter test** — 6th request in a minute → 429 (limiter
    NOT skipped under test).
  - `pairing-sessions.test.ts` — label stash + return; burn-on-miss after N.
  - `config/registry.test.ts` — knob present (default 30, integer, `apply:live`),
    group registers with `collapsedByDefault`.
  - **trust-proxy invariant test** — asserts the app never sets `trust proxy`.
- **Frontend (`src/**/*.test.tsx`)**:
  - `lan-access-card.test.tsx` — authorize→label→QR; device list + Revoke;
    401→desktop-only note; not-enforced→warning + mint disabled.
  - `pair.test.tsx` — `#/pair?c=…` renders confirm; Authorize POSTs, strips code,
    re-hydrates, routes to `#/`; expired/rate-limited error states; renders with
    **no Layout boot effects** (sibling-route shell).
  - `book-library.test.tsx` / `library-slice.test.ts` — failed scan → error +
    Retry (regression: fails before the resilience fix).
- **E2E (`e2e/`)** — a **UI-flow** spec (mock mode): Admin → authorize shows a
  QR; `#/pair?c=<mock>` renders the confirm screen and routes to `#/` after a
  mocked redeem. **This does not test the cookie auth** (mock mode has no real
  cookie) — that is covered by the supertest integration test + manual
  acceptance. (Stated honestly so the e2e isn't mistaken for auth coverage.)
- **Manual acceptance (real device)** — `npm run start:lan` with `LAN_HTTPS=1` +
  `LAN_AUTH_TOKEN`: desktop Admin → Authorize → scan on the phone → library loads
  + survives reload; revoke on desktop → phone 401s next navigation; confirm an
  already-paired **companion** device still works (grandfathering).

## Backlog

File a new `srv-NN` issue ("Authorize a browser over LAN via Admin
device-linking") with `area:server`/`area:frontend`, `type:feature`, and add a
thin row to `docs/BACKLOG.md`. Nothing in the backlog covers browser-over-LAN
auth today (related items — `app-10` stream-over-LAN, `app-17` deep-link pairing
— are companion-app oriented).

## Decisions locked (post-review)

- Cookie propagation (`__Host-cw_lan`), `SameSite=Strict` **+** server Origin
  allow-list for CSRF.
- QR (URL payload, code in fragment) only; no manual entry; ≥80-bit code,
  burn-on-miss, dedicated tested limiter, `isLanHttpsEnabled()` gate.
- Managed device list + per-device revoke; desktop-only label.
- 30-day default via `LAN_DEVICE_TTL_DAYS`, surfaced in Advanced config; read via
  `configValue` in the route handler.
- Expiry enforced in `findValidDevice` (guard path); legacy companion tokens
  **grandfathered**, not insta-expired.
- `#/pair` is a Layout-free sibling route.
- Library resilience fix bundled (the pair success path reuses the re-hydrate).
