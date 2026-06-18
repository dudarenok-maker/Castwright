---
status: active
shipped: null
owner: null
---

# LAN browser device authorization (srv-42)

> Status: stable (shipping via PR #901 / srv-42 / #900)
> Key files: `server/src/lan-auth.ts`, `server/src/csrf-origin.ts`, `server/src/lan-safety.ts`, `server/src/workspace/device-tokens.ts`, `server/src/routes/pairing.ts`, `server/src/routes/devices.ts`, `server/src/app.ts`, `server/src/config/registry.ts`, `src/views/pair.tsx`, `src/components/lan-access-card.tsx`, `src/components/pairing/pairing-qr.tsx`, `src/lib/api.ts`, `src/store/library-slice.ts`, `src/routes/index.tsx`
> URL surface: `#/admin` ("LAN access" card), `#/pair?c=<code>` (Layout-free)
> OpenAPI ops: `POST /api/devices/pair-session`, `POST /api/pair/redeem-browser`, `GET /api/devices`, `DELETE /api/devices/:id` (companion `POST /api/pair/redeem` unchanged)

Design of record: [`../superpowers/specs/2026-06-18-lan-browser-device-auth-design.md`](../superpowers/specs/2026-06-18-lan-browser-device-auth-design.md) (rev 6 — 3 adversarial review rounds + a defense-in-depth pass). Implementation plan: [`../superpowers/plans/2026-06-18-lan-browser-device-auth.md`](../superpowers/plans/2026-06-18-lan-browser-device-auth.md).

## Benefit / Rationale

- **User:** a phone's **browser** can use the app over LAN HTTPS. The desktop Admin → "LAN access" card mints a QR; the phone's native camera opens it, one tap authorizes, and the web app works. Before this, with `LAN_AUTH_TOKEN` set, every `/api` call from a non-loopback browser was 401'd and the books view hung on an eternal loading skeleton. The card lists authorized devices and revokes any one.
- **Technical:** auth rides an `HttpOnly` cookie on same-origin requests, so the ~100 existing `fetch('/api/…')` call sites are untouched. A single `findValidDevice` chokepoint enforces expiry + revocation.
- **Architectural:** introducing cookie auth where only a header token existed could have opened CSRF; it's closed by a server-side Origin allow-list, so the cookie tier is no weaker than the header tier. The `app.ts` extraction (assembly out of `index.ts`) gives an importable app for true end-to-end integration tests.

## Architectural impact

- **New seams:** `readCwLanCookie` (shared cookie parser for guard + CSRF), `isPrivateNetworkRequest` (shared with app-17's `/redeem` gate), `requireSameOrigin` middleware, `lan-safety.ts` (`assertNoTrustProxy`, `lanExposureWarning`), `clampTtlDays`, the `lan.deviceTokenTtlDays` config knob, the `#/pair` top-level route, and `app.ts` (assembled Express app, imported by `index.ts` and by `lan-cookie-integration.test.ts`).
- **Invariants preserved:** the LAN guard's enforcement trigger is unchanged (`isLanTokenEnforced` = `isLanHttpsEnabled() && LAN_AUTH_TOKEN set`); loopback bypass intact (plan 157 / srv-19); the companion `POST /api/pair/redeem` request/response contract is unchanged (only gains a TTL + 1 KB body cap + app-17's local-network gate, none of which change its shape).
- **Migration:** `device-tokens.json` schema 1→2 adds `expiresAt`; there is **no** grandfather migration — a legacy `schema: 1` record (no `expiresAt`) is rejected by `findValidDevice`, so that device re-pairs once. Forward-only; reversible by not setting `LAN_AUTH_TOKEN` (guard no-ops).
- **Reversibility:** unset `LAN_AUTH_TOKEN` → the whole guard is a no-op and the cookie gates nothing (this state is surfaced by `lanExposureWarning()` at startup and the Admin card's "not enforced" warning).

## Invariants to preserve

1. **`extractToken` reads the cookie first** (`server/src/lan-auth.ts`, `extractToken` → `readCwLanCookie`): the `__Host-cw_lan` cookie is checked before Bearer / `X-Lan-Token` / `?token=`. `readCwLanCookie` wraps `cookie.parse` in try/catch (runs on every `/api` request — an unguarded throw would 500 the API).
2. **Expiry + revocation live ONLY in `findValidDevice`** (`server/src/workspace/device-tokens.ts`): rejects `revoked`, `expiresAt === undefined`, or `now > Date.parse(expiresAt)`. `isValidDeviceToken` stays single-arg and calls it with the default clock. The client cookie `Max-Age` is not authoritative.
3. **Every `createDevice` caller passes a clamped TTL** (`devices.ts` admin mint, `pairing.ts` companion `/redeem`, `pairing.ts` `/redeem-browser`): `createDevice(label, clampTtlDays(configValue('lan.deviceTokenTtlDays')))`. `createDevice` stamps `expiresAt` and caps the label at 64 chars (app-17). No token is born without an `expiresAt`.
4. **`persist()` writes then sets the cache** (`device-tokens.ts`): `await writeJsonAtomic(...); cache = devices;` — never cache-before-write (else a failed write leaves a phantom device or resurrects a revoked one on restart). `persist` writes `{ schema: 2 }`.
5. **CSRF: cookie-bearing writes are Origin-gated** (`server/src/csrf-origin.ts`, `requireSameOrigin`): only state-changing methods carrying `__Host-cw_lan` are checked, via the SAME `readCwLanCookie` parser as the guard (no parser divergence). Allow-list = `enumerateLanUrls(port,'https').urls` + explicit loopback origins, recomputed per request, **fails closed** to loopback-only if enumeration throws, and 403s when Origin+Referer are both absent.
6. **All token-minting paths are loopback-gated** (`devices.ts`: `POST /api/devices` admin mint + `POST /api/devices/pair-session`) — a stolen browser cookie cannot mint a fresh durable token that survives revocation.
7. **`/redeem-browser` is pre-guard, code-gated, and LAN-only** (`server/src/routes/pairing.ts` + mount order in `app.ts`): mounted on `pairRedeemRouter` **before** `requireLanToken`; `isPrivateNetworkRequest` 403 + `isLanTokenEnforced` 409 + dedicated 5/min `browserRedeemLimiter` + its own `express.json({ limit: '1kb' })`. Sets `__Host-cw_lan` (`HttpOnly; Secure; SameSite=Strict; Path=/`) and **never returns the raw token in the body**.
8. **`app.ts` middleware order** (`server/src/app.ts`): `pairRedeemRouter` (pre-guard, before the global `express.json({limit:'20mb'})` so the 1 KB caps engage) → `requireLanToken` → `requireSameOrigin` → routers. `assertNoTrustProxy(app)` runs at assembly; `trust proxy` stays unset (loopback gate would be spoofable otherwise).
9. **`#/pair` is a top-level, Layout-free route** (`src/routes/index.tsx`): a second `createHashRouter` entry (NOT under `Layout.children`), so an unauthorized phone doesn't fire Layout's boot effects (no 401-storm). `PairShell` reads `c` via `useSearchParams`.
10. **Library scan failure is recoverable** (`src/store/library-slice.ts` `error`/`hydrateError`; `src/components/layout.tsx` catch; `src/views/book-library.tsx`): a failed `/api/library` shows "Couldn't load — Retry", not an eternal skeleton. `hydrate` clears `error`.

## Test plan

### Automated coverage

- `server/src/workspace/device-tokens.pure.test.ts` / `device-tokens.test.ts` — expiry (expired / undefined / injected-now), `clampTtlDays`, throttled `lastSeenAt` touch, label cap, schema-2 persist.
- `server/src/lan-auth.test.ts` — cookie-auth pass/reject through the guard; header/Bearer/query paths intact; loopback bypass.
- `server/src/csrf-origin.test.ts` — allowed/loopback origin pass, foreign origin 403, no-Origin+no-Referer 403, header-token bypass, parser-agreement (a cookie `cookie.parse` accepts still gates).
- `server/src/routes/devices.test.ts` — `pair-session` loopback-only URL payload + 409; admin mint 403 from non-loopback; label cap.
- `server/src/routes/pairing.test.ts` — `/redeem-browser` cookie-set + no-raw-token + 409 + 5/min 429 + **403 off-network**; `/redeem` **403 off-network**; body-size 413 caps on both routes (parser-order regression anchor).
- `server/src/routes/lan-cookie-integration.test.ts` — **the real chain**: redeem-browser → capture `Set-Cookie` → replay on a guarded `GET /api/library` (not 401) + foreign-Origin write → 403. No mocks, temp workspace, real `app`.
- `server/src/lan-safety.test.ts` + `server/src/lan-auth.invariants.test.ts` — `assertNoTrustProxy` throws when set; `lanExposureWarning` fires only when bound-LAN + token-unset; `app.ts` mount order (`requireSameOrigin` after `requireLanToken`) + no `trust proxy` in source.
- `server/src/config/registry.test.ts` — `lan.deviceTokenTtlDays` knob (default 30, integer, `apply: live`) + the `lan-access` group.
- Frontend: `src/lib/api.devices.test.ts` (`ApiError` + 4 fns on real+mock), `src/store/library-slice.test.ts` + `src/views/book-library.test.tsx` (error/Retry), `src/components/pairing/pairing-qr.test.tsx`, `src/views/pair.test.tsx`, `src/components/lan-access-card.test.tsx`.
- E2E: `e2e/lan-device-auth.spec.ts` (mock-mode UI flow — Admin authorize → QR; `#/pair?c=…` → Authorize → `#/`). Explicitly NOT an auth test (mock mode has no real cookie); the cookie chain is the supertest integration test above.

### Manual acceptance walkthrough

Real device, the real backend (`npm run start:lan` with `LAN_HTTPS=1` + `LAN_AUTH_TOKEN` set; phone trusts the mkcert root CA):

1. **Desktop `#/admin`** → "LAN access" card → "Authorize a device" → type a label → a **QR + countdown** appears.
2. **Phone native camera** scans the QR → opens `https://<host>:8443/#/pair?c=<code>` → "Authorize this browser until <date>?" → tap **Authorize**.
3. Phone lands on `#/`, **library loads** (cookie now rides every `/api` call) and **survives a reload**.
4. **Desktop card** lists the device (label · added · last seen · expires); after the phone is used a minute, **"last seen" updates**.
5. **Revoke** the device on desktop → the phone **401s on its next navigation**.
6. A phone write (e.g. edit book meta) **passes** the Origin check; a forged cross-origin write → **403**. `/redeem-browser` from off-LAN → **403**.
7. If `LAN_AUTH_TOKEN` is unset, the server logs the `lanExposureWarning` at startup and the Admin card refuses to mint.

## Out of scope

- Per-user accounts / roles, or a read-only token tier — any valid token grants the full `/api` surface (single-owner LAN tool). See the design's "Defense-in-depth notes".
- The shared-secret `LAN_AUTH_TOKEN` remains an unexpiring, unrevocable, CSRF-exempt superuser (companion bootstrap; exposed in the LAN QR) — device tokens are the revocable/expiring tier.
- Global `apiLimiter` does not cover the pre-guard pair routes (pre-existing; `/redeem-browser` has its own limiter, `/redeem` is single-use code-gated) — follow-up on #900.
- A direct unit test for the `/redeem-browser` 410 path — follow-up on #900.

## Ship notes

Shipping via **PR #901** (`srv-42` / closes #900), merged into `main` after a full `npm run verify` (green) on the post-app-17-merge HEAD. Built subagent-driven (15 tasks + per-task review + opus whole-branch review + defense-in-depth review); reconciled against app-17 (deep-link pairing, PR #899) which landed concurrently in the same pairing files — app-17's `isPrivateNetworkRequest` local-network gate was extended to the new `/redeem-browser`. (Merge SHA to be appended on merge.)
