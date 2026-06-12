---
status: active
shipped: null
owner: null
---

# fs-21 — First-run setup wizard (cross-platform setup owner)

> Status: active — code-complete + CI-green across all five waves; on-box acceptance OWED (see below).
> Key files: `server/src/routes/setup-readiness.ts` (readiness + complete + smoke), `server/src/routes/kokoro-install.ts`, `server/src/routes/venv-bootstrap.ts`; `server/src/tts/kokoro-install-bootstrap.ts`, `server/src/tts/venv-bootstrap.ts`; `server/tts-sidecar/scripts/install-kokoro.mjs`, `server/tts-sidecar/scripts/bootstrap-venv.mjs`; `server/src/tts/python-discovery.ts`, `server/src/tts/engine-presence.ts`, `server/src/tts/kokoro-install-detect.ts`, `server/src/diagnostics/venv.ts`; `src/views/setup.tsx`, `src/components/setup/` (setup-wizard + 5 steps), `src/components/kokoro-install.tsx`, `src/components/venv-bootstrap.tsx`, `src/components/ollama-install.tsx`; `src/routes/index.tsx` (SetupRoute + boot gate), `src/components/layout.tsx` (boot-splash gate), `src/lib/api.ts` (`getSetupReadiness` / `completeSetup` / `runSmokeTest`); `setupCompletedAt` user-setting.
> URL surface: `#/setup`
> OpenAPI ops: `GET /api/setup/readiness`, `POST /api/setup/complete`, `POST /api/setup/smoke`, `GET /api/kokoro/status`, `POST /api/kokoro/install`, `GET /api/setup/venv`, `POST /api/setup/venv`

## Benefit / Rationale

- **User:** turns a multi-step manual bootstrap (read INSTALL.md, run PowerShell scripts, install models by hand) into one guided in-app path. Every platform — Windows, macOS, Linux, Docker — enters the app through the same wizard, so there is no OS-specific install choreography to document or maintain separately.
- **Technical:** the readiness gate is derived from `buildDiagnostics()` (the existing diagnostics aggregator), so the wizard never duplicates the health-probe logic; a single source of truth drives both the `/api/diagnostics` board and the setup gate. The Kokoro installer uses the same Node-spawn path (`install-kokoro.mjs`) on every OS; the venv bootstrapper wraps `python -m venv + pip install -r requirements.txt` with a graceful no-Python degrade.
- **Architectural:** the `{ kind: 'setup' }` discriminated-union stage is a first-class state-machine variant: it gates the entire app (fail-open on probe error so a network/sidecar issue can't lock the UI), can be re-entered via Account → "Re-run setup," and is unlocked only by `POST /api/setup/complete` — never by the `setupCompletedAt` timestamp alone (the gate is derived from `readiness.blockers`, not the flag).

## Architectural impact

- **New seams:** `{ kind: 'setup' }` stage in `ui-slice.ts`; `api.getSetupReadiness`, `api.completeSetup`, `api.runSmokeTest` on the api object (real + mock); `SetupRoute` wrapper in `src/routes/index.tsx`; `setupCompletedAt` in `UserSettings`; `/api/setup/venv` mounted alongside `/api/setup` as a separate router; `/api/kokoro` polling route + `KokoroInstallBootstrap` shared with the Model Manager.
- **Invariants preserved:** the discriminated-union `ui.stage` (`src/store/ui-slice.ts`) — `{ kind: 'setup' }` is a new first-class variant added without flattening the union. Boot splash gate in `layout.tsx` (fails open on any probe error, never blocks on a slow sidecar). All existing stage variants and their `view`/`currentChapterId`/`openProfileId` fields remain unchanged.
- **Migration story:** `setupCompletedAt` is additive on `UserSettings`; absent on upgrade means the wizard fires once on first open of the new build. No cast.json / state.json shape change.
- **Reversibility:** remove the `{ kind: 'setup' }` branch, the `/api/setup/*` routes, and the `SetupRoute` wrapper. The rest of the app is byte-identical.

## Invariants to preserve

1. **Gate is derived, not flag-driven.** `SetupRoute` (`src/routes/index.tsx`) opens the wizard when `readiness.blockers.length > 0` — NOT when `setupCompletedAt` is absent. `setupCompletedAt` only suppresses the initial check (skip re-gate on subsequent boots when blockers cleared); it does not open the gate by itself.
2. **`/api/setup/readiness` is a thin mapper.** It calls `buildDiagnostics()` (`server/src/diagnostics/`) and maps its output to the `SetupReadiness` shape. It must not re-implement any probe logic independently.
3. **Boot gate fails open.** `layout.tsx`'s boot-splash check: if the readiness probe throws or times out, the app opens (not blocked). Only a definitive `blockers.length > 0` triggers the redirect.
4. **Kokoro/venv/smoke routes return graceful errors, never 500.** Error shape is `{ ok: false, error: string }` (or per-stage breakdown for smoke). An internal failure (spawn error, Python missing, ffmpeg missing) is a 200 with `ok:false`.
5. **Smoke button is always-enabled.** The Step-Finish smoke button is never gated on readiness scores — the user can always re-run the light smoke test regardless of blocker state.
6. **`/api/setup/venv` mounts cleanly alongside `/api/setup`.** The venv router is mounted at `/api/setup/venv`, not nested under `/api/setup` (which is the readiness/complete/smoke router). Both coexist without path collisions.
7. **Install components survive reload (polling, not SSE).** `KokoroInstall` and `VenvBootstrap` poll the status endpoint at a fixed interval; they do not require a persistent SSE connection and resume correctly after a browser reload.
8. **Decision-Z degrade.** When Python 3.11 is absent, the venv bootstrap step shows installation instructions and marks the step as manually actionable — it does not fail the wizard.
9. **Guided-Next is never blocker-gated.** The wizard's "Next" button in guided mode advances regardless of the step's blocker status; the derived gate (readiness blockers) is the actual lock, not per-step gating.

## Test plan

### Automated coverage

**Wave 0 (readiness spine):**
- Vitest server (`server/src/routes/setup-readiness.route.test.ts`) — asserts the mapper shape, blocker derivation, and sidecar-down degradation; stubs `buildDiagnostics` to confirm thin-mapper contract.
- Vitest server (`server/src/routes/setup-readiness.test.ts`) — asserts the `complete` and smoke route shapes.
- Vitest frontend (`src/routes/index.test.tsx`) — asserts `SetupRoute` redirects to `#/setup` when blockers present; passes through when clear.
- Vitest frontend (`src/components/layout.test.tsx`) — asserts boot-splash gate fails open on probe error.
- Vitest frontend (`src/views/setup.test.tsx`) — asserts the `SetupView` stub renders correctly for the `{ kind: 'setup' }` stage.
- Playwright e2e (`e2e/setup-gate.spec.ts`) — asserts the gate fires when the mock readiness returns blockers.

**Wave 1 (in-app Kokoro installer):**
- Vitest server (`server/src/tts/kokoro-install-bootstrap.test.ts`) — asserts SHA256 verification path, progress events, error shape.
- Vitest server (`server/src/routes/kokoro-install.route.test.ts`) — asserts the install route (stubbed spawn) + polling status endpoint.
- Vitest server (`server/src/tts/kokoro-install-detect.test.ts`) — asserts `detectKokoroInstalledOnDisk` DRY path.
- Vitest server (`server/src/tts/install-kokoro-helpers.test.ts`) — asserts helper utilities for the install script.
- Vitest frontend (`src/components/kokoro-install.test.tsx`) — asserts the `KokoroInstall` component renders install/progress/done states.
- Vitest frontend (`src/lib/api.test.ts`) — asserts `api.getSetupReadiness` mock dual-state.

**Wave 1b (venv bootstrap):**
- Vitest server (`server/src/tts/python-discovery.test.ts`) — asserts `findPython311` resolution across platforms.
- Vitest server (`server/src/tts/venv-bootstrap.test.ts`) — asserts the bootstrap helper (detect, install, no-Python degrade).
- Vitest server (`server/src/tts/bootstrap-venv-helpers.test.ts`) — asserts streaming progress + error shape.
- Vitest server (`server/src/routes/venv-bootstrap.route.test.ts`) — asserts the route endpoints.
- Vitest server (`server/src/diagnostics/venv.test.ts`) — asserts venv probe output (present / absent / broken).
- Vitest frontend (`src/components/venv-bootstrap.test.tsx`) — asserts `VenvBootstrap` renders detect/progress/done/no-python states.

**Wave 2 (wizard UI):**
- Vitest frontend (`src/components/setup/setup-wizard.test.tsx`) — asserts the `SetupWizard` orchestrator: guided vs checklist mode, step sequencing, re-run-setup entry.
- Vitest frontend (`src/components/setup/step-models.test.tsx`) — asserts the models step pass/fail/remediation states.
- Vitest frontend (`src/components/setup/step-environment.test.tsx`) — asserts the environment step.
- Vitest frontend (`src/components/setup/step-ffmpeg.test.tsx`) — asserts the ffmpeg step pass/fail/remediation.
- Vitest frontend (`src/components/setup/step-defaults.test.tsx`) — asserts the defaults step form fields.
- Vitest frontend (`src/components/setup/step-finish.test.tsx`) — asserts the finish step smoke-test integration.
- Vitest frontend (`src/views/account.test.tsx`) — asserts the "Re-run setup" Account entry renders and fires the correct action.
- Vitest frontend (`src/components/ollama-install.test.tsx`) — asserts `OllamaInstall` `onInstalled` callback wiring.
- Playwright e2e (`e2e/setup-wizard.spec.ts`) — asserts happy-path progression through all five wizard steps; asserts guided vs checklist mode; asserts `coverage.spec.ts` entry for the `#/setup` view.

**Wave 3 (two-tier smoke test):**
- Vitest server (`server/src/routes/setup-readiness.test.ts`) — asserts `POST /api/setup/smoke` per-stage breakdown (sidecar / analyzer / audio), `ok:false`-never-500 contract.
- Vitest frontend (`src/components/setup/step-finish.test.tsx`) — asserts the two-tier smoke UI (Tier-1 play, Tier-2 demo-book card, completion stamp).
- Vitest frontend (`src/lib/api.test.ts`) — asserts `api.runSmokeTest` mock stub.
- Playwright e2e (`e2e/setup-wizard.spec.ts`) — asserts the Tier-1 smoke test renders audio and the wizard can be completed (mock mode).

### Manual acceptance walkthrough

Run `npm start` against a real workspace with a fresh `setupCompletedAt` absent (or cleared) and the sidecar + Kokoro weights present.

1. **Cold boot, wizard gates** — navigate to `http://localhost:5173/#/`. Expected: `ui.stage = { kind: 'setup' }`, redirected to `#/setup`. The gate fired because blockers are present (e.g. Kokoro not installed).
2. **Step 1 — Models:** Kokoro not installed. Click "Install Kokoro." `KokoroInstall` starts polling `/api/kokoro/status`; progress bar advances. On completion, step status flips green.
3. **Step 2 — Environment (venv):** Python 3.11 detected. Click "Bootstrap sidecar environment." `VenvBootstrap` polls `/api/setup/venv`; progress bar advances. On completion, step flips green. (No-Python path: instructions shown, step marked "manual" — wizard still advances.)
4. **Step 3 — ffmpeg check:** ffmpeg on PATH → step green automatically. If absent, instructions shown.
5. **Step 4 — Defaults:** engine + analyzer + theme pickers. Confirm selections.
6. **Step 5 — Finish / Smoke:** click "Run smoke test." `POST /api/setup/smoke` returns per-stage breakdown. Tier-1 audio plays inline. "Complete setup" button active.
7. **Complete setup** — `POST /api/setup/complete` → `setupCompletedAt` stamped → `ui.stage` transitions out of `{ kind: 'setup' }` → app lands on `#/`.
8. **Re-entry via Account** — navigate to `#/account`. "Re-run setup" entry visible. Clicking it resets the wizard (checklist mode — all previously-complete steps shown as checked, individual steps can be re-run). URL goes to `#/setup`.
9. **Headless / Docker** — open `http://<host>:5173/#/` on a box with no Kokoro weights. Gate fires identically; wizard serves all model installs in-browser.

## OWED on-box acceptance matrix

The following acceptance items are CI-green but not yet validated on real hardware. They are NOT CI gates — they are on-box verification tasks before any release announce that includes this feature:

| Item | Platform | Notes |
|------|----------|-------|
| Real Kokoro install via wizard (one-click) | macOS (Apple Silicon + Intel) | `install-kokoro.mjs` spawns `node`; mkcert not required here |
| Real Kokoro install via wizard (one-click) | Linux (Ubuntu 22.04+) | Same `install-kokoro.mjs` path |
| Fresh venv bootstrap (Z decision) on a box with Python 3.11 | Windows | `bootstrap-venv.mjs` + real pip install |
| Fresh venv bootstrap on a box with Python 3.11 | macOS | Same; confirm `python3.11` resolution via `findPython311` |
| Fresh venv bootstrap on a box with Python 3.11 | Linux | Same |
| No-Python degrade (decision Z) | macOS / Linux | Python 3.11 absent → instructions shown, wizard advances |
| Tier-1 smoke produces audible output | Windows (GPU) | Real sidecar + Kokoro + ffmpeg present |
| Tier-2 demo-book full run plays audio | Windows (GPU) | Loads The Coalfall Commission via `POST /api/samples/:slug/load`, generates, opens Listen |
| `cross-os.yml` workflow green | Windows + macOS | Run `workflow_dispatch` before any release that ships this feature |

## Out of scope / deferred

- **ffmpeg auto-install** — wizard shows instructions only; no auto-install. Instruct-only by design.
- **Owning Python/CUDA provisioning** — the Z venv bootstrap bootstraps the venv only when Python 3.11 is already present on the box. Python install is not owned by the wizard.
- **Layout `completedAt`-aware splash-skip optimization** — the layout boot gate always probes readiness on cold boot; deferred optimization to skip the probe when `setupCompletedAt` is set and no blockers are expected.
- **Tier-2 "re-analyze first" toggle** — not built; the demo book's analysis cache is frozen (pre-built in the sample bundle).
- **i18n of wizard copy** — defers to `fs-14`.
- **Intended-destination restore after gating** — a not-ready user hitting `#/listen` lands on `#/` after setup; no deep-link restore in v1.
- **Installer packaging** (`ops-1` / `ops-15` / `ops-2`) — separate work that hands off to this wizard. Native installers pre-build the sidecar venv; Docker bakes the venv into the image (wizard venv step = no-op there).

## Ship notes

Shipped 2026-06-12. Five waves across five PRs, all CI-green. On-box acceptance OWED (see matrix above).

- **Wave 0** — readiness spine (`GET /api/setup/readiness`, `{ kind: 'setup' }` stage, `#/setup` route + SetupView stub, boot-splash gate, `setupCompletedAt`, dual-state mock). PR #744, merge `3cacff98`.
- **Wave 1** — in-app Kokoro installer (`install-kokoro.mjs` SHA256-verify, `KokoroInstallBootstrap`, `/api/kokoro` polling route, `KokoroInstall` component, Model Manager wiring, `detectKokoroInstalledOnDisk` DRY; + REPO_ROOT off-by-one fix). PR #748, merge `24afe6c6`.
- **Wave 1b** — venv bootstrap (decision Z): `findPython311`, `bootstrap-venv.mjs`, `VenvBootstrap` + `/api/setup/venv`, no-Python degrade-to-instructions path. PR #749, merge `10fae6b6`.
- **Wave 2** — 5-step hybrid guided/checklist wizard UI: `SetupWizard` + 5 step components, `POST /api/setup/complete`, `api.completeSetup`, `OllamaInstall` `onInstalled`, Account "Re-run setup" entry, `SetupRoute` re-fetch. PR #750, merge `3f0b206b`.
- **Wave 3** — two-tier smoke test: `POST /api/setup/smoke` (Tier 1, `ok:false`-never-500), `api.runSmokeTest`, Step-Finish smoke UI, Tier-2 demo-book run via the fs-22 flow. PR #751, merge `1179ce9f`.
