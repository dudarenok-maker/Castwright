# Castwright Pinokio one-click installer — design (ops-16 / #738)

**Status:** approved design, pre-plan
**Date:** 2026-06-15
**Issue:** [ops-16 — Pinokio one-click installer (#738)](https://github.com/dudarenok-maker/Castwright/issues/738)

## Goal

Ship a **Pinokio** install script as a third first-class install path alongside the
native installers (`ops-1` Windows `.exe`, `ops-15` macOS `.dmg`). One click in the
Pinokio browser provisions a fully self-contained runtime, builds Castwright from the
latest published release, launches it, and hands off to the existing `fs-21` first-run
wizard for GPU detect + model install — identical post-install setup to the native
installers, with **no terminal and no system prerequisites**.

## Decisions (locked during brainstorming)

1. **Acquisition: public-repo, Pinokio-native git clone.** The repo is public by
   open-beta day. `pinokio.js` lives at the repo root (Pinokio's required entry-point
   location); the user pastes the public GitHub URL into the Pinokio browser, Pinokio
   clones the repo, discovers `pinokio.js`, and runs Install. No separate launcher repo,
   no release-zip download.
2. **Fully self-contained provisioning.** The script installs everything into Pinokio's
   isolated app directory — a bundled conda Python 3.12 + ffmpeg, Pinokio's bundled
   Node, the Python venv (torch), and Node modules. The user installs **zero** system
   prerequisites.
3. **Reuse the shared bootstrap chain; duplicate nothing.** The script calls the
   existing `bootstrap-venv.mjs` (which runs the `accelerator-profile.mjs` resolver +
   `install-torch.mjs` + pip install) and `launch.mjs`. GPU/overlay selection stays the
   sole responsibility of `accelerator-profile.mjs` — the Pinokio script never inspects
   the GPU itself.
4. **Build from the latest published release, not `main`.** Beta users get a verified,
   released build, never bleeding-edge `main`.
5. **No new `release.yml` job** (deliberate deviation from the issue's literal AC — see
   §"release.yml" below). The script resolves the latest *published* release at
   install/update time, so a Pinokio install always tracks the newest release with zero
   release-pipeline plumbing. User-approved.
6. **Testing: extract pure CommonJS helpers, unit-test them with Vitest; the Pinokio
   runtime is on-box manual acceptance** (same tier as the `.exe`/`.dmg`).

## Architecture

```
repo root
├── pinokio.js                 # menu entry-point (thin; requires pinokio/lib/menu.js)
├── pinokio/
│   ├── install.js             # provisioning steps (conda → checkout → npm → venv → .env)
│   ├── start.js               # launch inside conda env, capture ready URL
│   ├── update.js              # fetch tags → checkout newest published → rebuild
│   ├── reset.js               # remove .venv + node_modules + dist, reinstall
│   ├── icon.png               # reused public/ brand asset
│   └── lib/                   # pure CommonJS helpers, required by BOTH the scripts and the tests
│       ├── latest-release.js  # parse GitHub Releases API JSON → latest published tag
│       ├── env.js             # buildInstallEnv({ appDir }) → WORKSPACE_DIR + env map
│       ├── ready-url.js       # parseReadyUrl(stdoutLine) → http://localhost:PORT
│       └── menu.js            # buildMenu(state) → ordered menu items
```

`pinokio.js` and the `pinokio/*.js` scripts run inside **Pinokio's CommonJS script
runtime** (not Node directly). All non-trivial logic is factored into
`pinokio/lib/*.js` **CommonJS** modules that are `require`d by the scripts AND imported
by Vitest — so the unit-tested code is the exact code that runs in production.

## Provisioning (`pinokio/install.js`, ordered steps)

All steps run **inside the conda env** (so python + ffmpeg are on PATH) with `NODE_ENV`
unset.

1. **conda env — Python 3.12 + ffmpeg.** `shell.run` with a conda spec creates an
   isolated env carrying `python=3.12` and `ffmpeg` (conda-forge). Pinokio's bundled
   `node`/`npm` are already on PATH. *Plan verifies Pinokio's bundled Node ≥ 20.19
   (Vite 8 floor); if it is older, `conda install -c conda-forge nodejs` into the same
   env.* ffmpeg version is unconstrained — torchcodec was dropped (torch 2.8 < 2.9), so
   the server's ffmpeg-CLI use (`server/src/tts/mp3.ts`) is version-agnostic.
2. **Checkout the latest *published* release.** `git fetch --tags`; resolve the latest
   release tag via the **GitHub Releases API**
   (`GET /repos/<owner>/Castwright/releases/latest`) parsed by
   `pinokio/lib/latest-release.js`; `git checkout <tag>` (detached HEAD). Fallback to the
   highest `vX.Y.Z` from `git tag` only if the API is unreachable.
   *Rationale (adversarial finding):* a `vX.Y.Z` tag can exist in git whose `release.yml`
   verification failed and was never published (the tag is pushed *before* the publish
   gate runs). The Releases API returns only *published* releases, which passed the full
   cross-OS battery — so we never build a failed/un-published tag.
3. **`npm ci --include=dev`** (root) + **`npm --prefix server ci --include=dev`.**
   `--include=dev` is load-bearing: `npm run build` needs Vite, a devDependency; if
   Pinokio's shell carries `NODE_ENV=production`, a plain `npm ci` omits it and the build
   dies.
4. **`npm run build`** → produces `dist/` + `server/dist/`.
5. **Venv bootstrap** — hand the conda Python to the existing
   `node server/tts-sidecar/scripts/bootstrap-venv.mjs <condaPython>`. This runs the
   `accelerator-profile.mjs` resolver (its own GPU detection → `nvidia-cuda` / `cpu` /
   `amd-rocm` overlay) + `install-torch.mjs` + pip install (~2.5 GB; the long step). We
   bypass `ensure-python312.mjs`'s system-install branch entirely — conda already
   provided 3.12.
6. **Write `server/.env`** from `server/.env.example` with **`WORKSPACE_DIR` auto-set**
   to `<appDir>/workspace` (computed by `pinokio/lib/env.js`). No manual edit, unlike the
   native INSTALL.md path. `<appDir>/workspace` is gitignored/outside the tracked tree,
   so updates (git checkout) never touch user data.

**Kokoro weights are NOT installed here** — deferred to the `fs-21` wizard at first run,
matching the issue's install/wizard split.

## Launch & first-run handoff (`pinokio/start.js`)

`shell.run` the existing prod launcher (`node launch.mjs`) **inside the conda env** with
`WORKSPACE_DIR` set. Capture stdout and regex the ready URL via
`pinokio/lib/ready-url.js` → Pinokio shows **"Open Web UI"** (`http://localhost:8080`).
First load drops the user into the `fs-21` wizard for GPU detect + Kokoro model install —
identical post-install setup to the native installers. Stop = Pinokio terminates the
daemon.

The `fs-21` wizard's own venv-bootstrap step sees the already-built venv as `noop`
(shared stamp via `venv-migration.mjs`) and skips — no double-bootstrap. *(On-box
verification point.)*

## Menu / lifecycle (`pinokio.js` → `pinokio/lib/menu.js`)

`buildMenu(state)` returns an ordered, state-dependent menu:

- **Install** — shown when not yet installed → runs `install.js`.
- **Start / Stop** — toggles on the running state → `start.js` / terminate.
- **Open Web UI** — shown when running → opens the captured ready URL.
- **Update** — `update.js`: `git fetch --tags`, checkout the newest *published* release
  (same Releases-API resolver), re-run `npm ci --include=dev` + build + `bootstrap-venv`.
  We own the update path explicitly; we do **not** wire Pinokio's built-in `git pull`
  update, which would fight our detached-HEAD checkout.
- **Reset** — `reset.js`: remove `.venv` + `node_modules` + `dist`, then reinstall.

## release.yml

**No change.** The issue's AC asks for a `release.yml` job to publish/refresh the script
on tag push. Model A (build-from-latest-published-release) makes this moot: the script
resolves the latest *published* release at install/update time via the Releases API, so a
Pinokio install always tracks the newest release with zero release-pipeline plumbing.
This satisfies the AC's **intent** (always-latest) without a no-op publish job.
User-approved deviation.

## Error handling / prereq gaps

Self-contained provisioning means python/node/ffmpeg cannot be "missing." Remaining real
failure modes and their handling:

- **Disk (~6 GB) / network / conda-env creation / torch-wheel download** — each
  `install.js` step is wrapped so a failure raises a Pinokio notification naming the
  failed step; no silent failure.
- **GPU/driver mismatch** — `accelerator-profile.mjs` `detectVendor` degrades to `cpu`
  and never throws; `resolveProfile` honors `ACCELERATOR`/wizard overrides. AMD-Windows
  inherits the known Phase-2 S0.1 DirectML→CPU degrade (not Pinokio-specific).
- **venv interpreter/profile mismatch** — `bootstrap-venv.mjs` already exits non-zero
  with remediation text, surfaced by Pinokio.
- **Releases API unreachable** — `latest-release.js` falls back to the highest local
  `git tag`.

## Testing

Pure CommonJS helpers, colocated Vitest specs (`pinokio/lib/*.test.js`), wired into the
Vitest include:

- `latest-release.js` — `latestReleaseTag(apiJson)`: parse the Releases-API payload →
  tag string; handle missing/malformed payloads (→ fallback signal).
- `env.js` — `buildInstallEnv({ appDir })`: WORKSPACE_DIR path + env map.
- `ready-url.js` — `parseReadyUrl(line)`: extract `http://localhost:PORT` (and the
  no-match case).
- `menu.js` — `buildMenu(state)`: asserts the expected items appear in the right order
  for `not-installed` / `stopped` / `running` states.

The helpers are `require`d by the Pinokio scripts, so the tested code is the code that
runs. The **Pinokio runtime integration itself is on-box manual acceptance** — a
clean-machine Pinokio install on Windows + macOS, same acceptance tier as the native
installers. Captured in the regression plan.

## Files

**New:**
- `pinokio.js` (root)
- `pinokio/{install,start,update,reset}.js`
- `pinokio/lib/{latest-release,env,ready-url,menu}.js` (+ `*.test.js`)
- `pinokio/icon.png` (reused `public/` brand asset)
- `docs/features/NNN-pinokio-installer.md` (regression plan; number assigned at plan time)

**Modified:**
- Vitest include (add `pinokio/**/*.test.js`)
- `INSTALL.md` + `README.md` — new "Install — Pinokio (one click)" section
- `docs/features/INDEX.md` — new plan entry
- `docs/BACKLOG.md` — remove the ops-16 row
- Close **#738** (`Closes #738` in the delivering PR)

**Explicitly NOT changed:**
- `release.yml` (see §release.yml)
- `build-release-zip.mjs` MANIFEST — it is an allowlist; `pinokio.js`/`pinokio/` are not
  on it, so they are excluded from the release zip by default. No edit needed.

## Out of scope

- A `release.yml` publish/refresh job (deviation §release.yml).
- Linux Pinokio acceptance as a release gate (the script should work on Linux —
  conda/node/ffmpeg are cross-platform — but the on-box acceptance matrix is Windows +
  macOS, matching the native-installer tiers).
- Any change to `fs-21`, `accelerator-profile.mjs`, `bootstrap-venv.mjs`, or `launch.mjs`
  internals — the Pinokio script is a pure consumer of those.
```

This design holds together. The one open verification carried into the plan is Pinokio's
bundled-Node version vs the Vite 8 ≥20.19 floor.
