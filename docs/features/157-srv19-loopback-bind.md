---
status: draft
shipped: null
owner: null
---

# 157 — Default-bind the HTTP server to loopback (srv-19)

> Status: draft
> Key files: `server/src/bind-host.ts`, `server/src/index.ts`, `server/src/routes/export-lan.ts`, `server/.env.example`
> URL surface: none (server bind behaviour)
> OpenAPI ops: none

## Benefit / Rationale

Source: the [2026-05-31 security review](../security/2026-05-31-security-review.md) findings #1 + #2.

- **User:** removes the "any device on the same Wi-Fi can read all my books and burn my Gemini quota" exposure in the default dev mode. Before this, plain HTTP `app.listen(PORT)` bound `0.0.0.0`, so every unauthenticated route — including the `/workspace` static mount serving all manuscripts / audio / `state.json` / `cast.json` — was reachable by any LAN peer. Now the default binds loopback only.
- **Technical:** the cheapest meaningful hardening from the review — one host argument threaded through the existing listen wiring, no new auth surface, no behaviour change for the single-user local flow (`http://127.0.0.1:8080` works exactly as before).
- **Architectural:** establishes an explicit bind-host policy (`selectBindHost`) instead of relying on Node's implicit all-interfaces default. The deliberate LAN HTTPS mobile flow (`npm run start:lan`) keeps binding all interfaces — that exposure is intended and gated behind the opt-in flag.

## Architectural impact

- **New seam:** `server/src/bind-host.ts` exports the pure `selectBindHost(lanHttps, env)` helper. Injectable `env` so it's unit-testable without importing `index.ts`'s side effects (same rationale as `attachListenErrorHandler` living in `crash-logging.ts`).
- **Env flags:** `BIND_HOST` (preferred) / `HOST` (fallback) override the default loopback bind in plain-HTTP mode — a power-user escape hatch to restore all-interface HTTP. Documented in `server/.env.example`.
- **Invariants preserved:** the LAN HTTPS path (`LAN_HTTPS=1`) is unchanged — `selectBindHost(true, …)` always returns `0.0.0.0`, ignoring `BIND_HOST`/`HOST`, so the mobile flow stays reachable. The `GET /api/export/lan` endpoint + its URL enumeration are untouched (they only matter in LAN mode, which still binds all interfaces).
- **Migration story:** none — no data shape change. Behaviour delta is bind-host only.
- **Reversibility:** set `BIND_HOST=0.0.0.0` to restore the pre-srv-19 all-interface plain-HTTP behaviour, or revert the one-line listen change.

## Invariants to preserve

- `selectBindHost` in `server/src/bind-host.ts`: LAN HTTPS mode → always `'0.0.0.0'`; plain-HTTP mode → `BIND_HOST ?? HOST ?? '127.0.0.1'`.
- `server/src/index.ts` listen block: both listeners receive `bindHost` as the host argument; `attachListenErrorHandler(server, port)` (plan 145/srv-17) stays wired on both.
- `isLanHttpsEnabled()` (`server/src/routes/export-lan.ts`) remains the single gate for LAN mode.

## Test plan

### Automated coverage

- Vitest server (`server/src/bind-host.test.ts`) — pins `selectBindHost` for: default → `127.0.0.1`; LAN → `0.0.0.0`; LAN ignores `BIND_HOST`/`HOST`; `BIND_HOST` override; `HOST` override; `BIND_HOST` precedence over `HOST`.
- Regression: `server/src/routes/export-lan.test.ts` (LAN protocol/port/CORS cases) stays green — it asserts the route response, not the bind host.

### Manual acceptance walkthrough

1. **Default:** `npm start` (no env flags) → reachable at `http://127.0.0.1:8080`; from another machine on the LAN, the connection is **refused**.
2. **LAN mobile flow:** `npm run start:lan` → still reachable from the phone/tablet on the LAN over HTTPS, exactly as before.
3. **Power-user escape hatch:** `BIND_HOST=0.0.0.0 npm start` → plain HTTP reachable from another LAN machine again.

## Out of scope

- A shared-secret token for the LAN flow (`srv-20`), `sidecarUrl` SSRF validation (`srv-21`), the sync-folder write-probe (`srv-22`), the Qwen `.pt` safe-load (`side-12`), and download SHA pinning (`ops-7`) — the rest of the 2026-05-31 security review, deferred to a follow-up round.

## Ship notes

(Filled in when status flips to `stable`.)
