---
status: active
shipped: 2026-06-15
owner: null
---

# Pinokio one-click installer (ops-16)

> Status: active — code landed, on-box acceptance owed
> Key files: `pinokio.js`, `pinokio-scripts/{install,start,stop,update,reset}.js`, `pinokio-scripts/lib/{resolve-release,write-env,menu}.js`, `scripts/run-pinokio-tests.mjs`
> URL surface: indirect — Pinokio menu → `http://localhost:8080` (the existing app)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** a no-terminal, no-Python-bootstrap install for [Pinokio](https://pinokio.computer) users — paste the repo URL, click Install, click Start. The same "click and it's running" path the `.exe`/`.dmg` give Windows/macOS deployers, reducing a read-INSTALL.md bootstrap to one click.
- **Technical:** a third first-class install path that reuses the existing shared bootstrap chain verbatim (`bootstrap-venv.mjs` + `accelerator-profile.mjs` + `launch.mjs`/server + `stop:prod`) — zero duplicated install logic, so it tracks the native installers automatically.
- **Architectural:** builds from the latest **published** release (GitHub Releases API, not `git tag`), so a Pinokio install always resolves to a verified release with **no `release.yml` plumbing** — the tag resolution is self-updating at install/update time.

## Architectural impact

- **New seams:** the root package.json is `"type":"commonjs"` (flipped from `"module"` — see the "Automated coverage" bullet below for why) and `pinokio-scripts/` additionally carries its own `pinokio-scripts/package.json` `{"type":"commonjs"}` (now redundant with the root, kept as explicit documentation of the CommonJS boundary); testable logic is factored into Node CLI helpers (`resolve-release`, `write-env`) invoked via Pinokio `shell.run` + the `menu` builder, all unit-tested with `node:test` via `scripts/run-pinokio-tests.mjs` (`npm run test:pinokio`, wired into `test:all` + a `verify-cache` step). `eslint.config.js` was renamed to `eslint.config.mjs` (explicit ESM extension, immune to the root type flip) to keep its `import` syntax working.
- **Invariants preserved:** GPU/overlay selection stays solely in `accelerator-profile.mjs` (the Pinokio script never inspects the GPU); the venv is created by the shared `bootstrap-venv.mjs`; teardown goes through `stop:prod`. No change to `release.yml`, `build-release-zip.mjs` MANIFEST (allowlist already excludes `pinokio-scripts/`), `fs-21`, or `launch.mjs` internals.
- **Reversibility:** the entire surface is additive (`pinokio-scripts/` + helper tests + docs); deleting `pinokio-scripts/` and the `test:pinokio` wiring fully reverts it.

## Invariants to preserve

1. **Build from the latest PUBLISHED release, never `main` and never an un-published tag.** `pinokio-scripts/lib/resolve-release.js` resolves via the GitHub Releases API (`/releases/latest`); a 404 ("no release yet") aborts with a clear message, a network error falls back to the highest local `git tag` — it never silently checks out `main`. (A tag can exist in git whose `release.yml` verification failed; the Releases API returns only published, gate-passed releases.)
2. **Self-contained provisioning — zero system prerequisites.** conda provides Python 3.12 + ffmpeg; Pinokio's bundled node provides npm. `install.js` step order is fixed (conda → resolve+checkout → `npm ci --include=dev` → build → `bootstrap-venv.mjs python` → `write-env.js`).
2a. **Every `pinokio-scripts/*.js` script sets `path: '..'` on every `shell.run`/`fs.rm` step.** Pinokio resolves a `shell.run`'s cwd — and any `fs.rm` target — relative to the **currently running script's own directory**, not the app root. Since these scripts live in `pinokio-scripts/` (one level below `package.json`/`server/`), every step needs the explicit `path: '..'` override, or it silently operates one directory too deep (confirmed on-box 2026-07-11: `conda: { path: 'env' }` resolved to `pinokio-scripts/env` instead of `<app>/env`, and would have made `resolve-release.js`'s own `existsSync('pinokio-scripts/start.js')` guard always fail once reached). `script.start`'s `uri` is unaffected — sibling-script resolution is correctly relative to the caller's own directory.
3. **`server/.env` write is idempotent** (`buildEnvContents` returns `null` when `server/.env` exists), so Update / re-install preserve a user's `WORKSPACE_DIR`.
4. **Lifecycle:** `start.js` runs the server in the **foreground** under Pinokio (`daemon: true`) so `info.running()` is accurate and Pinokio's native Stop SIGTERMs the daemon (the server reaps the sidecar via its SIGTERM handler, `server/src/index.ts:494`). `stop.js` (`stop:prod`) is a defensive sweep.
4a. **`start.js` launches the server with cwd = `server/`, via `cd server && node dist/index.js`.** The server's env load is CWD-relative (`process.loadEnvFile('.env')` in `server/src/load-env.ts:35`), so `server/.env` (`WORKSPACE_DIR`/`GEN_WORKERS`/`GPU_VRAM_BUDGET`/analyzer/GPU tuning) only loads when the process runs from `server/` — exactly what the prod launcher does (`scripts/start-app-prod.mjs:257-258` spawns `node dist/index.js` with `cwd: serverDir`). `path: '..'` stays (CONDA's relative `env` path resolves against the app root); only the node process's own cwd moves via `cd server &&`. Confirmed on-box 2026-07-11: running `node server/dist/index.js` from the app root left `server/.env` unloaded → server silently on bare defaults (the `formatMissingEnvWarning` `[server] WARNING: no .env found` line was the tell).
5. **Release-sequencing guard:** after `git checkout <tag>`, `resolve-release.js` aborts if `pinokio-scripts/start.js` is absent (a release predating Pinokio support would otherwise delete the scripts mid-run). The Pinokio install path is announced only from the release that first contains `pinokio-scripts/` onward.

## Automated coverage

- `pinokio-scripts/lib/resolve-release.test.js` (6), `write-env.test.js` (2), `menu.test.js` (3) — `npm run test:pinokio` (node:test), in `test:all` + the `verify-cache` `test:pinokio` step (scope `pinokio-scripts/**`).
- The declarative `pinokio-scripts/*.js` scripts are not unit-testable (no headless Pinokio); they are validated by the on-box acceptance matrix below.
- `scripts/tests/pinokio-entry.test.mjs` (`npm run test:hooks`) `require()`s root `pinokio.js` via `createRequire` — the same synchronous `require(filepath)` call Pinokio's own kernel uses (`pinokiocomputer/pinokiod` `kernel/loader.js` `requireJS`) — and asserts it loads without error and that `.menu()` delegates correctly. This pins two bugs in sequence: #1458 (CommonJS globals thrown as a `ReferenceError` under `type:module`) and its follow-up regression, where the #1460 "fix" made `pinokio.js` genuine ESM (`import`/`export default`) on the mistaken assumption that Pinokio dynamically `import()`s scripts — Pinokio's kernel actually `require()`s them, which cannot load an ES module at all. Root `pinokio.js` must stay genuine CommonJS (`require`/`module.exports`), same as every other `pinokio-scripts/**` script; the root package.json is `"type":"commonjs"` accordingly.

## On-box manual acceptance (Windows + macOS)

Clean-machine Pinokio install → **Install** → **Start** → **Open Web UI** → fs-21 wizard runs → Kokoro installs → generate a chapter; then **Update**, **Stop** (confirm no orphaned sidecar on :9000), **Reset**.

Resolve the open verifications:
1. **[highest risk] `start.js` foreground launch** — `node server/dist/index.js` from the app root autostarts the sidecar and loads `server/.env`/`WORKSPACE_DIR`; if not, set `WORKSPACE_DIR` explicitly in the `start.js` step env. Confirm Pinokio's native Stop reaps the sidecar.
2. Pinokio's bundled Node ≥ 20.19 (Vite 8 floor) — else add `conda install -c conda-forge nodejs` to `install.js` step 1.
3. `python -m venv` from a conda interpreter on all 3 OSes.
4. Confirm the Pinokio API spelling on-box: `conda: { path, python }`, `info.exists`/`info.running`/`info.local(script)`, `fs.rm`, `script.start` uri base-dir, `on:` regex capture. (Validated against shipping apps — TRELLIS/comfy/facefusion — but no headless runtime exists.) **Partially confirmed 2026-07-11**: real on-box Install surfaced that `shell.run`/`fs.rm` steps default their cwd to the *script's own* directory, not the app root — see invariant 2a. Fixed in code; still needs a full on-box Install→Start→Update→Reset pass to confirm nothing else in this list is also off.
5. **AMD-Windows** inherits the known Phase-2 DirectML→CPU degrade (not Pinokio-specific).

## Ship notes

Merged to `main` **2026-06-15** via **PR #821** (merge commit `90bc51eb`), closing #738.
All code + docs + 11 `node:test` cases landed; typecheck / build / `test:all` / lint green
locally. **Plan stays `active`** because the runtime can only be validated on a live
Pinokio install — **on-box / beta-tester acceptance is tracked by #822** (the open gate).
When #822 confirms (Windows + macOS), apply any Pinokio-API-spelling fixes it surfaces,
flip this plan to `stable`, and `git mv` it to `docs/features/archive/`.

Source spec: `docs/superpowers/specs/2026-06-15-pinokio-installer-design.md`; plan: `docs/superpowers/plans/2026-06-15-pinokio-installer.md`.
