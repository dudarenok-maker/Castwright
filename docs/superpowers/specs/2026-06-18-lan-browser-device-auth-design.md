---
title: Authorize a browser over LAN via Admin device-linking
date: 2026-06-18
status: draft
area: server + frontend
issue: srv-NN (to be filed)
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
(`server/src/routes/pairing.ts`) already exist — they were built for the
companion. This feature extends them so a **browser** can be authorized too,
managed from the desktop **Admin** screen.

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
   surfaced in the **Advanced configuration** screen alongside the other knobs.
5. Make the failed-library-scan dead-end recoverable: show a "Couldn't load —
   Retry" state instead of an eternal skeleton.

## Non-goals

- Changing **when** the guard enforces. It still engages only when
  `LAN_HTTPS=1` **and** `LAN_AUTH_TOKEN` is set. Broadening it would silently
  lock out existing token-less LAN users.
- Touching the companion's existing header-token redeem
  (`POST /api/pair/redeem`) — it stays exactly as is.
- Per-user accounts / roles. This is a single-owner LAN tool; "authorize a
  device" is a convenience, gated by physical access to the desktop.
- Editing the device label on the phone (decided: **desktop-only** label).

## User experience

**On desktop** (`#/admin` → new **"LAN access"** card):

1. Click **"Authorize a device"**.
2. Type a **label** (e.g. "Mike's iPhone") — keyboards are easy on desktop.
3. A **QR code** appears with a short countdown (the underlying pairing code is
   one-time and expires in a few minutes; a **Regenerate** button re-mints).

**On the phone:**

4. Open the **native camera**, point at the QR. It encodes a real URL
   (`https://<host>:8443/#/pair?c=<code>`); the phone browser opens it.
5. The app shows **"Authorize this browser until <date>?"** → one tap
   **"Authorize"**.
6. Server validates the code, mints a 30-day device token, and **sets an
   `HttpOnly` cookie**. The page routes into the app; the library loads.

**Back on desktop**, the "LAN access" card lists the new device with **Revoke**.
Revoke takes effect on the device's next request. (Renaming in v1 = revoke +
re-authorize; there's no rename endpoint.)

*Prerequisite (already satisfied on the user's setup):* the phone trusts the
mkcert root CA, so the HTTPS LAN URL opens without a warning. If the cert isn't
trusted, the camera-opened page fails to load — the Admin card links to the
existing cert-install instructions.

## Architecture

### Server

**`server/src/workspace/device-tokens.ts`** — add expiry.

- `DeviceTokenRecord` gains `expiresAt: string` (ISO).
- `createDevice(label, ttlDays = 30)` stamps `expiresAt = now + ttlDays`.
- `findValidDevice(token)` rejects records whose `expiresAt` is in the past (in
  addition to the existing `revoked` check) — so an expired token fails even if
  the cookie still carries it.
- `redactDevice` / `PublicDevice` expose `expiresAt`.
- Persistence shape bumps to `{schema: 2, devices: […]}` with a lazy migration:
  a `schema: 1` record with no `expiresAt` is treated as **already expired**
  (forces a clean re-pair rather than granting an unbounded legacy token).

**`server/src/lan-auth.ts`** — accept the cookie.

- `extractToken(req)` gains a 4th source after Bearer / `X-Lan-Token` /
  `?token=`: a **`cw_lan`** cookie. Parse `req.headers.cookie` with a tiny local
  helper (no new dependency). The cookie value is the raw device token; the
  existing `isValidDeviceToken` hash-compare is unchanged.
- No change to enforcement conditions (`isLanTokenEnforced`).

**`server/src/routes/devices.ts`** — mint + browser-redeem.

- Reuse the existing `GET /api/devices` (list) and `DELETE /api/devices/:id`
  (revoke) — both already loopback-gated behind the `/api` guard, so only the
  desktop can call them.
- **New** `POST /api/devices/pair-session` (loopback-only): body `{ label }`;
  mints a pairing session via `createPairingSession()` (reuse
  `pairing-sessions.ts`), stashing the `label`. Returns
  `{ url, code, expiresAt }` where `url =
  https://<hostPort>/#/pair?c=<code>` — a **full URL** QR payload (the
  native camera needs a URL, unlike the companion's compact `CWP1*…` payload).
- **New** `POST /api/pair/redeem-browser` (pre-guard, mounted next to the
  existing `/api/pair/redeem`): body `{ code }`. Validates via
  `redeemPairingSession(code)`, reads the stashed `label`, calls
  `createDevice(label, ttlDays)` where `ttlDays` comes from the config knob,
  and responds:
  - `Set-Cookie: cw_lan=<token>; HttpOnly; Secure; SameSite=Lax; Path=/;
    Max-Age=<ttlSeconds>`
  - body `{ label, expiresAt }` — **the raw token never reaches JS.**

**`server/src/config/registry.ts`** — new knob + group.

- New group `{ id: 'lan-access', label: 'LAN access & device tokens', help:
  'Lifetime of browser/device authorizations minted from Admin.', risk: 'low'
  }`.
- New knob `{ key: 'lan.deviceTokenTtlDays', env: 'LAN_DEVICE_TTL_DAYS', group:
  'lan-access', label: 'Device authorization lifetime (days)', help: '…', type:
  'integer', min: 1, default: 30, apply: 'live', risk: 'low' }`.
- `createDevice`'s default `ttlDays` reads the **effective** config value at
  mint time (`apply: 'live'` → no restart needed). The literal `30` lives in one
  place (the knob default) and is referenced by the device-tokens default.

### Frontend

**`src/views/admin.tsx`** — new **"LAN access" card** (mirrors the existing
card pattern). Holds:
- An **"Authorize a device"** button → label input → QR. The QR rendering is
  lifted from / shared with `src/modals/pair-device.tsx` (it already renders a
  QR + countdown + Regenerate). The card calls
  `api.createDevicePairSession({label})`.
- A **device list**: `api.listDevices()` → rows of label · added · last-seen ·
  expires · **Revoke** (`api.revokeDevice(id)`), with a small "expired" / "expires
  soon" treatment. (Rename = revoke + re-pair in v1; no rename endpoint.)
- The card is naturally **desktop-only**: its endpoints are loopback-gated, so on
  a phone they 401 — the card renders a short "Manage devices from the desktop"
  note instead of the controls when `listDevices()` returns 401.

**New SPA route `#/pair`** (`src/views/pair.tsx`, registered in
`src/lib/router.ts` + `src/routes/index.tsx`): reads `?c=<code>`, shows the
one-tap **"Authorize this browser until <date>"** confirmation, POSTs to
`/api/pair/redeem-browser`, and on success routes to `#/`. Renders fine
pre-auth because the static shell + this route are unguarded; it makes exactly
one guarded-free call. Error states: invalid/expired code → "This code expired —
generate a new one on the desktop."

**`src/lib/api.ts`** — three new functions (`createDevicePairSession`,
`listDevices`, `revokeDevice`, `redeemBrowserPair`) plus their mock mirrors.
**No change to existing `fetch` call sites** — the `cw_lan` cookie rides
same-origin requests automatically.

### Resilience fix (failed library scan)

- **`src/components/layout.tsx`** (library hydrate effect, ~line 521): on
  `getLibrary()` failure, dispatch a new `libraryActions.hydrateError()` (or
  `hydrate` with an `error` flag) so `loaded` becomes `true` with an `error`
  set, instead of only `console.error`.
- **`src/store/library-slice.ts`**: add an `error: string | null` field.
- **`src/views/book-library.tsx`** / `library-grid.tsx`: when
  `loaded && error`, render a "Couldn't load your library — Retry" panel (Retry
  re-runs the hydrate) instead of the skeleton or the empty state. This is what
  would have shown the 401 instead of hanging.

## Data flow

```
Desktop Admin                Server                         Phone browser
─────────────                ──────                         ─────────────
"Authorize" + label
  └─ POST /api/devices/pair-session {label}   (loopback)
        └─ createPairingSession(label) ──► {url, code, expiresAt}
  ◄── QR(url)
                                                   scan QR (native camera)
                                                   open https://host/#/pair?c=…
                                             ◄───── GET static shell (unguarded)
                                                   tap "Authorize"
                              POST /api/pair/redeem-browser {code}  (pre-guard)
                                └─ redeemPairingSession(code) → label
                                └─ createDevice(label, ttlDays)
                                └─ Set-Cookie cw_lan=<token> (HttpOnly…)
                              ─────────────────────────────► {label, expiresAt}
                                                   route to #/
                                                   GET /api/library (cookie) ✓
GET /api/devices ──► list incl. new device
DELETE /api/devices/:id ──► revoke
```

## Security model

- Cookie: `HttpOnly` (XSS can't read the token), `Secure` (HTTPS only),
  `SameSite=Lax` (allows the top-level navigation arriving from the QR while
  mitigating cross-site POST CSRF), `Path=/`, `Max-Age = ttlDays·86400`.
- The server **also** enforces `expiresAt` server-side, so a forged/edited
  cookie or a clock-skewed `Max-Age` can't outlive the token; revocation flips
  `revoked` and the next request fails the hash lookup.
- Raw token is shown to **no one**: the browser never receives it in a JS-
  readable form (cookie only); the companion path that returns the raw token is
  untouched and separate.
- Minting (`pair-session`, `redeem-browser` are the only token-creating paths)
  requires either physical desktop access (loopback) or a **one-time, short-
  lived** pairing code — a stolen QR is useless after it's redeemed or expires.
- Pairing code reuse is prevented by the existing `redeemPairingSession`
  single-use semantics.

## Testing plan

- **Server (`server/src/**/*.test.ts`)**:
  - `device-tokens.test.ts`: `expiresAt` stamped from `ttlDays`; expired token
    rejected by `findValidDevice`; schema-1 migration treats legacy records as
    expired; revoke still works.
  - `lan-auth.test.ts`: a request with a valid `cw_lan` cookie passes; expired /
    revoked / garbage cookie 401s; header/Bearer/query paths still work;
    loopback still bypasses.
  - `devices.test.ts`: `pair-session` is loopback-only and returns a URL
    payload; `redeem-browser` sets the cookie + returns `{label, expiresAt}` and
    does **not** leak the raw token in the body; list/revoke reflect the new
    device.
  - `config/registry.test.ts`: the new knob exists with default 30, integer,
    `apply: 'live'`, and the new group registers.
- **Frontend (`src/**/*.test.tsx`)**:
  - `admin.test.tsx`: LAN access card renders; "Authorize a device" → label →
    QR; device list rows + Revoke; 401-on-phone shows the desktop-only note.
  - `pair.test.tsx`: `#/pair?c=…` renders the confirm screen; Authorize POSTs
    and routes to `#/`; expired-code error state.
  - `book-library.test.tsx` / `library-slice.test.ts`: failed scan → error
    state + Retry (regression test that fails before the resilience fix).
- **E2E (`e2e/`)**: one Playwright spec — Admin → authorize-a-device shows a QR;
  visiting `#/pair?c=<mock-code>` in mock mode authorizes and lands on a loaded
  library. (Cookie behavior over real LAN HTTPS is covered by the manual
  acceptance below — Playwright runs same-origin localhost.)
- **Manual acceptance (real device)**: on the box, `npm run start:lan` with
  `LAN_HTTPS=1` + `LAN_AUTH_TOKEN` set; desktop Admin → Authorize → scan on the
  phone → confirm the library loads and survives a reload; revoke on desktop →
  confirm the phone 401s on next navigation.

## Backlog

File a new `srv-NN` issue ("Authorize a browser over LAN via Admin
device-linking") with `area:server`/`area:frontend`, `type:feature`, and add a
thin row to `docs/BACKLOG.md`. Nothing in the backlog covers browser-over-LAN
auth today (the related items — `app-10` stream-over-LAN, `app-17` deep-link
pairing — are companion-app oriented).

## Open questions

None outstanding. Decisions locked: cookie-based propagation; QR (URL payload)
only, no manual entry; managed device list with per-device revoke; desktop-only
label; 30-day default via `LAN_DEVICE_TTL_DAYS` surfaced in Advanced config.
