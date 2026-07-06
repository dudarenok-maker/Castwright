---
status: active
shipped: null
owner: null
---

# Friendly LAN hostnames (castwright.local / castwright.dev.local)

> Status: active
> Key files: `scripts/mdns-responder.mjs`, `scripts/setup-lan-certs.mjs`, `server/src/mdns-owner.ts`, `server/src/index.ts`, `vite.config.ts`, `package.json` (`dev:lan`)
> URL surface: `https://castwright.dev.local:5173` (dev:lan), `https://castwright.local:8443` (start:lan)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** LAN testing (phone/tablet) now uses a memorable, stable hostname instead of a raw IP that changes on every DHCP renewal.
- **Technical:** no new infrastructure — reuses the existing mkcert LAN-cert machinery (`scripts/setup-lan-certs.mjs`, `vite-plugin-mkcert`) and the existing server-owned child-process lifecycle pattern (mirrors the TTS sidecar).
- **Architectural:** establishes a "server owns its own LAN-facing helper processes, the fire-and-forget launcher does not" pattern (`server/src/mdns-owner.ts`) that any future LAN-mode helper process should follow instead of trying to hang off `start-app-prod.mjs`.

## Architectural impact

- **New seams:** `server/src/mdns-owner.ts` (`shouldSpawnMdnsResponder`, `spawnMdnsResponder`); `scripts/mdns-responder.mjs` (`primaryLanIp`, `buildAnswer`); `buildCertHosts()` export on `scripts/setup-lan-certs.mjs`; `server/src/lan-port-forwarder.ts`'s `PortForwarderHandle.isBound()` and `server/src/mdns-owner.ts`'s `MdnsResponderHandle.isAlive()` (real liveness checks, combined via `app.get('isFriendlyHostnameReachable')` in `server/src/routes/devices.ts`) — added by the one-click pairing-link feature; see `docs/superpowers/specs/2026-07-06-lan-pairing-friendly-hostname-link-design.md`.
- **Invariants preserved:** `dev:lan` / `start:lan` LAN-IP URLs are unaffected and remain the fallback in every failure mode (responder bind failure, stale cert, Windows LAN peer). Plain `npm run dev` / `npm run start` are untouched.
- **Migration story:** n/a — no persisted data shape changes.
- **Reversibility:** revert the `dev:lan` script line and the `shouldSpawnMdnsResponder` gate in `server/src/index.ts`; both hostnames simply stop resolving and the existing LAN-IP flow is unaffected. No cleanup needed elsewhere — a stale cert SAN entry or an unused `multicast-dns` dependency is harmless.

## Invariants to preserve

1. `shouldSpawnMdnsResponder` in `server/src/mdns-owner.ts` must stay gated on `lanHttps && NODE_ENV === 'production'`, not `lanHttps` alone — gating on `lanHttps` alone spins up an extra, unwanted `castwright.local` responder process during `dev:lan` (its server leg also sets `LAN_HTTPS=1`) that `dev:lan`'s own `concurrently` neither advertises nor reaps on Ctrl+C. (Not a literal port-5353 collision — `multicast-dns` binds with `reuseAddr:true`, so two responders on one box coexist rather than erroring; the harm is the orphaned extra process, not a bind failure.)
2. `scripts/mdns-responder.mjs`'s `primaryLanIp()` must stay a single address, never reuse `enumerateLanIps()` — that helper returns every non-internal IPv4 interface, correct for cert SANs (an unused SAN is inert) but wrong for an mDNS answer (an extra A-record can misdirect a client).
3. `dev:lan`'s `concurrently` invocation must keep `--kill-others-on-fail`, not `-k`/`--kill-others` — the mDNS leg's graceful bind-failure exit (code 0) must not be treated as a reason to tear down the Vite/server legs.

## Test plan

### Automated coverage

- `node:test` (`scripts/tests/mdns-responder.test.mjs`) — `primaryLanIp` resolves the OS-bound address or null on no-route; `buildAnswer` returns a single-address A-record for a configured hostname, null for an unconfigured one, null with no primary IP.
- `node:test` (`scripts/tests/setup-lan-certs.test.mjs`) — `buildCertHosts` always includes `localhost`/`127.0.0.1`/both friendly hostnames, appends detected LAN IPs after them.
- Vitest server (`server/src/mdns-owner.test.ts`) — `shouldSpawnMdnsResponder` pins the `NODE_ENV` discriminator (the dev:lan double-spawn regression case explicitly covered); `spawnMdnsResponder` pins the spawn args, the null-on-throw path, and both `kill()` branches (win32 `taskkill`, POSIX `SIGTERM`).

No e2e coverage — this is dev/LAN tooling, not shipped product behavior reachable from `npm run test:e2e`'s mock-mode Vite instance.

### Manual acceptance walkthrough

1. Run `npm run install:cert-mobile` (regenerates the LAN cert with the new SANs; one-time per LAN-IP change, same as today).
2. Run `npm run dev:lan`. Confirm the terminal shows three `concurrently` legs (`frontend`, `server`, `mdns`) all starting cleanly.
3. From a real phone/tablet on the same LAN (iOS or Android), browse to `https://castwright.dev.local:5173`. Expected: loads with no certificate warning (once the mkcert root CA is trusted on that device, per the existing `install:cert-mobile` flow), same app as the raw LAN-IP URL.
4. Stop `dev:lan` (Ctrl+C). Confirm all three processes exit.
5. Run `npm run build && npm run start:lan`. From the same phone/tablet, browse to `https://castwright.local:8443`. Expected: loads with no certificate warning.
6. Stop `start:lan` (Ctrl+C or `npm run stop:prod`). Confirm the server process AND the spawned mDNS responder child both exit (no orphaned `node scripts/mdns-responder.mjs` process left running — check via Task Manager / `ps`).
7. (Optional, confirms the non-fatal-degrade path) A real bind failure is hard to force on demand — `multicast-dns` binds with `reuseAddr:true`, so simply starting a second process on UDP :5353 does NOT reproduce a conflict (both coexist). Instead, temporarily edit `scripts/mdns-responder.mjs`'s `main()` to call `process.exit(0)` immediately after parsing `--name` (simulating the graceful bind-failure path without needing a real `EACCES`/blocked-multicast condition), then run `npm run dev:lan`. Expected: the `mdns` leg exits immediately with code 0; the `frontend` and `server` legs keep running unaffected (this is the exact behavior Task 6's `-k` → `--kill-others-on-fail` change exists to guarantee). Revert the temporary edit afterward.
8. Run `npm run build && npm run start:lan`. From a real phone/tablet on the same LAN, browse
   to `https://castwright.local` with **no port**. Expected: loads exactly like the explicit
   `:8443` URL, with no certificate warning.
9. From that same connection, perform a mutating action (e.g. rename a book, revoke a paired
   device). Expected: succeeds — no 403 "Cross-origin request rejected".
10. In the app's LAN Access card (desktop session), click "Regenerate certificate". Expected:
    the app keeps serving uninterrupted throughout (no dropped requests), the button shows the
    new host list on success, and a **fresh** browser tab opened afterward shows no certificate
    warning — without restarting the app.
11. From the same desktop session (loopback, e.g. `https://localhost:8443`), open **Admin →
    LAN access** and click **Authorize a device**. Expected: alongside the existing pairing QR,
    an **"Open pairing link on castwright.local"** link now appears. Click it (opens a new
    tab). Expected: the new tab loads `PairShell`'s "Authorize this browser?" confirmation at
    `https://castwright.local`; click **Authorize**; the tab redirects to `#/` and the library
    loads with no further pairing step. Confirm the link is absent under `dev:lan` (QR-only,
    unchanged).

## Out of scope

- Robust per-interface / multi-address mDNS answers under a VPN or dual-homed LAN — tracked as **ops-21** ([#1239](https://github.com/dudarenok-maker/Castwright/issues/1239)).
- The `npm start` + `server/.env` `LAN_HTTPS=1` path (`start-app.ps1`) — keeps today's LAN-IP-only behavior, no friendly hostname.
- Publicly-trusted certificates for `.local` names — impossible per RFC 6762 / CA/Browser Forum rules. See [`project_lan_public_cert_broker`] for the separate `lan.castwright.ai` effort that solves the zero-install-trust problem for a real (non-`.local`) domain.

## Ship notes

(Filled in once this PR merges.)
