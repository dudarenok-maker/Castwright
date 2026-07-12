---
status: active
owner: null
---

# LAN HTTPS on by default (phone/tablet work out of the box)

> Status: active — code landed on `feat/server-lan-default-secure`; on-box pairing acceptance owed.
> Key files: `server/src/routes/export-lan.ts` (`isLanHttpsEnabled`), `server/src/index.ts` (effective-LAN boot + fallback + token), `server/src/lan-auth.ts` (`ensureLanAuthToken`), `scripts/start-app-prod.mjs` (launcher target + boot cert provision), `scripts/setup-lan-certs.mjs` (non-fatal + APP_RUN_DIR), `pinokio-scripts/install.js` (mkcert via conda).
> Depends on: #1540 (`start.js` URL capture) for the **Pinokio** Open-Web-UI tab under LAN — merge that first.

## Benefit / Rationale

- **User:** phone + tablet listening and companion pairing work immediately after any install, instead of requiring the user to discover and run `npm run start:lan` + `install:cert-mobile` by hand. LAN sharing was the feature that "didn't work" for every fresh installer.
- **Technical:** one effective-LAN model (`requested && certsPresent`) shared by the server and the prod launcher; a cert-less box degrades to loopback HTTP instead of `process.exit(1)`.
- **Security:** flipping LAN on **safely** — the LAN `/api` is never left unauthenticated, because a `LAN_AUTH_TOKEN` is auto-minted whenever LAN is on and none is set.

## What changed

1. **`isLanHttpsEnabled()` default flip.** Was `LAN_HTTPS === '1'` (opt-in). Now: `'1'`→on, `'0'`→off, unset → **`NODE_ENV === 'production'`**. So native installers / Pinokio / `start:prod` get LAN by default; `npm run dev`, `npm start`, and the whole test suite (non-production) keep plain-HTTP localhost untouched.
2. **Boot never crashes on missing certs.** `index.ts` computes `lanRequested` (the flag) vs `lanHttps` (effective = requested **and** certs present). Requested-but-cert-less → serve loopback HTTP + a loud one-command-fix warning, instead of the old `process.exit(1)`. The former `exit(1)` branch is gone.
3. **`ensureLanAuthToken()` (lan-auth.ts).** When LAN is requested and no `LAN_AUTH_TOKEN` is set, mint `randomBytes(32)` hex, set `process.env`, and persist it to a **shared cross-release token file** (`<runDir>/lan-auth.token`, `APP_RUN_DIR`-aware — NOT the per-release `server/.env`, which a versioned upgrade would reset, re-pairing every device). Exclusive-create (`wx`) so a concurrent boot adopts the winner's token. Precedence: explicit `LAN_AUTH_TOKEN` env > existing token file > mint. Closes the hole where LAN-on-without-a-token makes `requireLanToken` a no-op → whole `/api` open on the LAN. Device tokens are still accepted; loopback still bypasses; the pairing QR carries the token.
4. **Universal cert provisioning.**
   - `scripts/setup-lan-certs.mjs` is now **non-fatal** (returns `null` on mkcert-missing/failure instead of `process.exit(1)`) and writes to the **`APP_RUN_DIR`-honouring** run dir (so versioned installs generate certs where the server reads them).
   - `scripts/start-app-prod.mjs` **auto-provisions certs on first launch** (best-effort) — the universal hook every non-Pinokio prod start uses (native installer, manual `start:prod`, versioned restart). Its `resolveLaunchTarget(env, certsPresent)` health-checks the port the server will actually bind.
   - `pinokio-scripts/install.js` installs mkcert via conda (`ffmpeg mkcert`) and runs `node scripts/setup-lan-certs.mjs` — Pinokio runs `node dist/index.js` directly and never hits the launcher's auto-provision.

## Invariants to preserve

1. **Dev/test are never LAN-by-default.** `isLanHttpsEnabled()` only defaults on when `NODE_ENV === 'production'`. A test or `npm run dev` that needs LAN must set `LAN_HTTPS=1` explicitly.
2. **A cert-less production box still boots** (loopback HTTP), never `exit(1)`. `lanHttps` (effective) is `false` unless both cert files exist.
3. **LAN is never exposed unauthenticated.** Whenever LAN is requested, `ensureLanAuthToken()` guarantees a token exists before `app.listen()`. It is idempotent across restarts (persisted) and swallows persist failures (still sets it in-process).
4. **Cert location parity.** `setup-lan-certs.mjs` and the server both resolve certs under `APP_RUN_DIR ?? <root>/.run` + `/certs`.
5. **Cert provisioning is best-effort.** Missing mkcert never aborts an install or a launch — it degrades to HTTP with a documented one-command fix (`install:cert-mobile`).

## Automated coverage

- `server/src/routes/export-lan.test.ts` — `isLanHttpsEnabled` prod-default matrix (dev off / prod on / explicit `0`/`1` wins / non-0/1 falls back to NODE_ENV).
- `server/src/lan-auth.test.ts` — `ensureLanAuthToken`: no-op when off, mint+persist, idempotent return, persist-failure swallowed.
- `scripts/tests/start-app-prod.test.mjs` — `resolveLaunchTarget(env, certsPresent)`: prod default → :8443, requested-but-cert-less → :8080, explicit opt-out, port overrides.
- Not unit-testable (declarative / OS-integration): `index.ts` boot wiring, mkcert invocation, the Pinokio `install.js` step — validated by the on-box acceptance below.

## On-box acceptance (owed)

1. Fresh install (Pinokio + a native/manual `start:prod`) → server comes up HTTPS on :8443, `[cert] LAN certs provisioned` logged, `server/.env` gains a `LAN_AUTH_TOKEN`.
2. Desktop Open-Web-UI tab loads `https://localhost:8443` with no warning (needs #1540 for the Pinokio tab).
3. Phone: install the mkcert root CA once (pairing QR / fingerprint pin), browse `https://castwright.local:8443`, complete pairing, listen.
4. Force `LAN_HTTPS=0` → back to loopback HTTP :8080. Delete certs, set `LAN_HTTPS=1` → server boots HTTP with the missing-cert warning (no crash).

## Review fixes (2026-07-12, high-effort code-review round)

The first implementation passed unit tests but a high-effort review found 9 real defects. Fixed before merge:

- **Dead under Pinokio (critical).** Pinokio's `start.js` runs `node dist/index.js` with no `NODE_ENV`, so the production default never fired. Fix: `start.js` now sets `env: { NODE_ENV: 'production' }`. (dist/ static serving was already `NODE_ENV`-OR-dist-exists, so unaffected.)
- **Token in per-release `server/.env` (critical).** Persistence moved to the shared `<runDir>/lan-auth.token` (invariant 3) so upgrades don't re-pair every device; also fixes the blank-`LAN_AUTH_TOKEN=` duplicate-key and the concurrent-boot dup-line races (dedicated file + `wx` exclusive create).
- **`GET /lan` + `/pair/session` advertised the requested flag, not the bind (critical).** New `server/src/lan-runtime.ts` (`get/setLanRuntime`) records the ACTUAL bound protocol/port at boot; both consumers read it, so a cert-less HTTP degrade never hands out dead `https://…:8443` URLs / QR codes.
- **cert-regenerate false success.** `setup-lan-certs.mjs`'s CLI exits non-zero on failure again (restoring the `lan-cert.ts` regenerate route's exit-code contract); install flows pass `--best-effort` to stay non-fatal.
- **Accepted as-is:** the `:443` port-forwarder being default-on can log an `EADDRINUSE` warning behind an existing reverse proxy — it's non-fatal (handled at `lan-port-forwarder.ts`), and default LAN reachability is the intent. Cert-path resolution is duplicated across `app-dirs.ts` (TS) and the two `.mjs` scripts because the ESM scripts can't import the compiled server module; kept cross-referenced.

## Review fixes round 2 (2026-07-12)

A second high-effort review confirmed round-1 fixes held but found the default-flip rippling into more consumers of the old `LAN_HTTPS` signal. Fixed:

- **`loopback-url.ts` sent sidecar callbacks to the wrong port** (checked `LAN_HTTPS` env, not the bind) → design-progress silently stalled. Now reads `getLanRuntime()` (effective protocol+port) — correct for both default-on and cert-degrade.
- **`LAN_HTTPS=false` read as ON.** `isLanHttpsEnabled()` (and `resolveLaunchTarget`) now: unset → prod default; any explicit value must be exactly `'1'` — so `false`/`off`/`no` disable.
- **mDNS + `:443` forwarder fired on every prod boot.** Narrowed `shouldSpawnMdnsResponder`/`shouldSpawnPortForwarder` to the EXPLICIT `LAN_HTTPS=1` opt-in (`start:lan`) — the bare production default gives LAN HTTPS on `:8443` and pairs via the IP QR; `castwright.local` + the privileged `:443` forwarder stay opt-in (no unrequested broadcast, no non-root bind failures).
- **Empty/corrupt token file wedged persistence** (`wx` refused to overwrite → in-memory token every boot → re-pair). Now self-heals: on `wx` EEXIST, re-read (adopt a racing writer's token) else overwrite the unusable file.
- **Launcher spawned a duplicate server** when certs appeared after an HTTP-first start. `start-app-prod.mjs` now also probes the alternate port for a live Castwright server before spawning.
- Stale `lan-cert.ts` comment updated (setup-lan-certs is now `APP_RUN_DIR`-aware). `lanExposureWarning()` is now effectively unreachable (ensureLanAuthToken always mints) but kept as a defensive net.

## Ship notes

_(fill on merge: date + SHA)_
