---
status: stable
shipped: 2026-05-19
owner: null
---

# 61 — In-app multi-model management UX

> Status: stable
> Key files: `src/views/account.tsx` (Models card), `src/components/ollama-install.tsx`, `src/components/model-pull-status.tsx`, `server/src/routes/ollama-health.ts` (extended), `server/src/ollama/install-bootstrap.ts`, `server/src/ollama/pull-bootstrap.ts`, `server/tts-sidecar/scripts/install-coqui.{sh,ps1}`
> URL surface: `#/account` (the Models card sits inside the existing Account view)
> OpenAPI ops: `GET /api/ollama/detect`, `POST /api/ollama/install`, `GET /api/ollama/install/:id`, `POST /api/ollama/install/:id/recheck`, `POST /api/ollama/pull`, `GET /api/ollama/pull/:id`, `POST /api/ollama/refresh` (all new in this plan)

## Benefit / Rationale

- **User:** closes the gap that plan 49's Kokoro-only install left. A deployer who shipped via the release bundle could only ever use Gemini (cloud) or pre-pull Ollama from a terminal. The Models card now lets them install Ollama, pull qwen3.5:4b, and analyze a book without leaving the app — matching plan 49's "deployer-first, no terminal needed" promise.
- **Technical:** introduces a small, dependency-injectable state-machine pattern (`InstallBootstrap` + `PullBootstrap`) that the route layer drives via 202 + poll. Tests stub `httpFn` / `spawnFn` / `fetchFn` so the entire surface is exercised offline.
- **Architectural:** keeps the existing `GET /api/ollama/health` envelope load-bearing — the new `/refresh` endpoint just re-runs the same probe with POST semantics so the UI can request a re-read without conflating it with normal polling. Install + pull are kept in separate modules under `server/src/ollama/` so the surface area can grow (e.g. multi-engine install) without re-touching `ollama-health.ts`.

## Architectural impact

**New seams / extension points:**

- `server/src/ollama/install-bootstrap.ts`: `InstallBootstrap` class with injectable `resolveAssetUrl` / `httpFn` / `spawnFn` / `detectOllama` / `getPlatform` / `getArch` / `downloadDir`. Tests use a fully stubbed bootstrap; production uses the module-level singleton wired to `process.platform` + global `fetch` + `node:child_process.spawn`.
- `server/src/ollama/pull-bootstrap.ts`: `PullBootstrap` with injectable `fetchFn`. The static `DEFAULT_ALLOWED_MODELS` set (mirroring the analyzer's `MODEL_OPTIONS`) refuses non-allowlisted tags at the route layer, so the user can't `/pull` arbitrary upstream tags from the UI.
- `setOllamaBootstraps({...})` + `_resetOllamaBootstraps()` in `server/src/routes/ollama-health.ts` — dependency-injection seam for the route's tests.
- Frontend: `OllamaInstall` + `ModelPullStatus` components are self-contained (no redux). They own their own poll loops and tear down on terminal states.

**Invariants preserved:**

- `GET /api/ollama/health` (plan 29) untouched. The new `POST /api/ollama/refresh` re-runs the same probe but is a separate route so existing pollers in `useTtsLifecycle.ts` keep working unchanged.
- `POST /api/ollama/{load,unload}` (plan 30) untouched — the in-app pill semantics still warm/evict using Ollama's `keep_alive` idiom.
- `MODEL_OPTIONS` (`src/lib/models.ts`) remains the source of truth for which tags the analyzer supports. `DEFAULT_ALLOWED_MODELS` in the server is a static mirror; if a new tag lands in `MODEL_OPTIONS`, update the server allowlist in the same PR.
- `start-app.bat` + the release bundle's `install-kokoro.{ps1,sh}` still handle Kokoro v1 weights; this plan ADDS `install-coqui.{ps1,sh}` for XTTS v2. Kokoro stays the default-resident TTS.

**Migration story:** None. The new endpoints + UI are additive; existing settings remain in `server/user-settings.json` untouched. A user who never visits Account → Models gets the same behaviour they had before this plan.

**Reversibility:** Drop the Models card from `account.tsx`, drop the new route handlers from `ollama-health.ts`, drop `server/src/ollama/`. The install-coqui scripts can stay or be deleted — they're idempotent and harmless.

## Invariants to preserve

1. **Install allowlist** — `DEFAULT_ALLOWED_MODELS` in `server/src/ollama/pull-bootstrap.ts:64-72` MUST mirror the local-engine subset of `MODEL_OPTIONS` (`src/lib/models.ts:19-38`). Drift means the UI offers Pull buttons for tags the analyzer can't dispatch, OR refuses Pull for tags the analyzer would happily use.
2. **No auto-pull on first run** — the install state machine never spawns a pull. Pull is always a separate, explicit user click. Surfaced in `server/src/ollama/install-bootstrap.ts:25-29` (module docstring).
3. **State machines are linear + terminal** — `idle → detecting → downloading → installing → installed` for install; `idle → pulling → pulled` for pull. Errors short-circuit to terminal `error`. No mid-flight branching.
4. **Windows is GUI-install only** — `runInstaller` in `install-bootstrap.ts:251-272` refuses to run an `.exe` headlessly. The job parks in `installing` with `manualInstallerPath` set; the user double-clicks and clicks "I've finished — re-check" to flip the state.
5. **Coqui scripts are venv-aware** — `install-coqui.{sh,ps1}` MUST refuse to run if the sidecar venv isn't bootstrapped. Otherwise we'd silently use the system Python, which doesn't have the `TTS` lib.
6. **All routes are dependency-injectable from tests** — `setOllamaBootstraps()` swaps both bootstraps. Tests MUST `_resetOllamaBootstraps()` in `afterEach` so cross-test leakage doesn't surface as a flake.

## Test plan

### Automated coverage

- Vitest server (`server/src/ollama/install-bootstrap.test.ts`) — walks the full state machine (detect short-circuit, linux happy path, windows GUI park, download error, byte-truncation error, progress reporting, coalescing parallel `start()`).
- Vitest server (`server/src/ollama/pull-bootstrap.test.ts`) — allowlist enforcement, NDJSON progress consumption, error-line short-circuit, coalescing same-model pulls, distinct ids for different models.
- Vitest server (`server/src/routes/ollama-health.test.ts`) — extended with `/detect`, `/install`, `/install/:id`, `/pull`, `/pull/:id`, `/refresh` coverage. Existing `/health`, `/load`, `/unload` assertions still pass unchanged.
- Vitest frontend (`src/components/ollama-install.test.tsx`) — detected / not-detected / windows-manual / error render branches, click → POST /install → render job card transition.
- Vitest frontend (`src/components/model-pull-status.test.tsx`) — present/absent row rendering, configured-default highlight, daemon-unreachable banner, pull POST + progress bar, allowlist-error rendering, refresh button re-renders.
- Vitest frontend (`src/views/account.test.tsx`) — the Models card mounts + lists both POSIX + PowerShell install snippets for Coqui.
- Playwright e2e (`e2e/account-models.spec.ts`) — install → pull → ready loop with mocked routes. Walks the install state machine through two ticks, pulls qwen3.5:4b, confirms the row flips to "on disk." Refresh button re-runs `/refresh`.

### Manual acceptance walkthrough

1. **Cold boot** at `#/account` → Models card appears below "Server configuration." → `OllamaInstall` reports "Ollama is not installed" (assuming a fresh box).
2. Click **Install Ollama** → job card appears, status flips to `downloading` with a progress bar. → Job card status flips to `installing` (linux/macOS auto-runs the installer; windows stops at "double-click this file"). → Job card eventually flips to `installed`, and the green ready pill replaces the job card.
3. The **Analyzer models** list now shows `qwen3.5:4b` (and the other allowlist entries) as "Not pulled yet."
4. Click **Pull** on `qwen3.5:4b` → progress bar appears. NDJSON status messages cycle (`pulling manifest` → `downloading` → `verifying sha256 digest` → `success`).
5. Once pulled, the row flips to "On disk" + the Pull button becomes "Pulled" (disabled).
6. Click **Refresh available models** → POSTs `/api/ollama/refresh`; the dropdown stays in sync.
7. Navigate to `#/` → click **Start a new book** → pick `qwen3.5:4b` as the analysis model → analysis runs end-to-end against the freshly-pulled local model.
8. Open `server/tts-sidecar/scripts/install-coqui.sh` on macOS/Linux (or `.ps1` on Windows) → script pre-fetches XTTS v2 weights into `voices/coqui/`, skips on re-run.

## Out of scope

- **Headless / CI auto-install** stays parked as BACKLOG Won't #1. This plan unparks the install-and-pull-from-UI subset only.
- **Auto-pull on first run** — explicit opt-in only. Pull is always a button click.
- **Multi-engine install** (e.g. fetching Kokoro weights via the UI) — Kokoro v1 ships pre-installed via plan 49's bundle; if a user wants the alt path, they run `scripts/install-kokoro.{sh,ps1}` manually. The state-machine pattern would generalise, but the trigger doesn't exist.
- **GPU concurrency arbitration** when multiple pulls hit Ollama at once — Ollama itself serialises pulls. Our state machine just polls; we don't gate.
- **Coqui XTTS in-app install button** — the in-app affordance is a docs-only snippet (POSIX + PowerShell). A real button would have to spawn Python from the server, which is materially more complex than the bash/ps1 scripts the deployer can run from the bundle. Tracked as a follow-up if the bash/ps1 path proves friction-iest.

## Known multi-model gaps after this ship

Per the [packaging multi-model-gap memory](../../C:%5CUsers%5Cdudar%5C.claude%5Cprojects%5CC--Claude-Projects-Audiobook-Generator%5Cmemory%5CMEMORY.md): this plan does NOT close every gap. Remaining gaps a fresh deployer must work around:

1. **Kokoro v1 weights** are still bundled via plan 49's `install-kokoro.{ps1,sh}` — eager-loaded at sidecar startup; no in-app affordance to re-install if the weights file is deleted. (Wake when: deployers report deletion-and-re-install confusion.)
2. **Coqui XTTS v2 install is script-driven, not in-app** — the Account → Models card surfaces the script paths and the command but does not run them via a button. Reason: the script needs the sidecar venv's Python on PATH, which the Node server can't reliably locate from an arbitrary install location. The script itself handles that, but spawning it from the UI is a follow-up. Workaround: deployer runs the script from the release bundle once. The on-disk pre-fetch is OPTIONAL — XTTS auto-downloads on first synth call anyway, so this is only a "skip the first-synth wait" affordance.
3. **Ollama install on Windows requires a GUI double-click** — the vendor only ships an `.exe` GUI installer. The job parks in `installing` with `manualInstallerPath` set; the user double-clicks, then clicks "I've finished — re-check." Closing the full headless loop on Windows requires either bundling a portable Ollama (license risk) or scripting the .exe in silent mode (vendor doesn't document a flag).
4. **Allowlist drift** — adding a new analyzer tag to `src/lib/models.ts` MUST also add it to `server/src/ollama/pull-bootstrap.ts` `DEFAULT_ALLOWED_MODELS`. There's no test that pins the two sets to each other yet. Tracked as a follow-up.
5. **Linux distro coverage** — the `bash <installer>` step assumes the vendor script works against the host's package manager. Tested by the vendor against Ubuntu/Debian/Fedora; behaviour on Arch / Alpine / NixOS may need manual intervention. Surfaces as an error toast, not a hang.

## Ship notes

Shipped 2026-05-19 on branch `feat/frontend+server-in-app-model-mgmt`.

- Server: new modules under `server/src/ollama/` (`install-bootstrap.ts` + `pull-bootstrap.ts`), seven new routes on `ollama-health.ts` (`/detect`, `/install`, `/install/:id`, `/install/:id/recheck`, `/pull`, `/pull/:id`, `/refresh`).
- Frontend: `OllamaInstall` + `ModelPullStatus` components, `ModelsCard` section appended to the Account view below the existing server-config card.
- Sidecar scripts: `install-coqui.sh` (POSIX) + `install-coqui.ps1` (Windows) parallel to the existing `install-kokoro.*` pair.
- Tests: 4 new spec files (server install + pull bootstraps, frontend ollama-install + model-pull-status), extended `ollama-health.test.ts` + `account.test.tsx`, one new Playwright spec (`e2e/account-models.spec.ts`).
- Closes BACKLOG Could #37. Unparks the install-and-pull-from-UI subset of Won't #1; the headless-CI variant stays parked.
