---
status: active
shipped: null
owner: dudarenok-maker
---

# Auto-start TTS sidecar (user preference)

> Status: active
> Key files: `server/src/workspace/user-settings.ts`, `server/src/tts/spawn-sidecar.ts`, `server/src/index.ts`, `scripts/start-app.ps1`, `src/views/account.tsx`
> URL surface: `#/account` (toggle)
> OpenAPI ops: `GET /api/user/settings`, `PUT /api/user/settings`

## Benefit / Rationale

Today the Python TTS sidecar runs as a separate process the user launches via
`npm run tts:sidecar` (or `start-app.bat`, which `Start-Process`-es all three
services in parallel). That was originally a deliberate "Won't do" decision
(BACKLOG #2): Coqui XTTS v2's ~30 s cold-start + ~3–5 GB VRAM competition
with the analyzer Ollama meant explicit launch kept the tradeoff visible.

Plan 14a flipped the calculus by making **Kokoro v1** the default engine:
~1 GB VRAM, ~1 s eager-load, eagerly preloaded inside the sidecar. With
Kokoro as the default, the _only_ reason TTS isn't ready when the server is
is that the sidecar process hasn't been launched. So this plan flips the
"Won't" to a per-user preference.

- **User:** on a fresh install (default `defaultTtsModelKey: 'kokoro-v1'`),
  starting `start-app.bat` brings up frontend + server + sidecar in one
  shot. No second terminal, no `npm run tts:sidecar` step.
- **Technical:** Node owns the sidecar child process lifecycle. Spawn fires
  at `app.listen()`; SIGINT/SIGTERM tears it down via Windows
  `taskkill /T /F` (which cascades through the powershell→uvicorn→python
  process tree). `.run/tts.pid` is written so the existing
  `scripts/stop-app.ps1` reaps the same PID it always did.
- **Architectural:** the existing `defaultTtsModelKey` preference now
  controls _both_ picker-default AND server-side eager-load gating
  (PRELOAD_COQUI=1 iff modelKey === 'coqui-xtts-v2'). Boolean × existing
  enum = effective 3-state outcome without a new schema field.

## Architectural impact

- **New seams:**
  - `server/src/workspace/user-settings.ts` adds `autoStartSidecar?:
boolean` (optional with `true` default) and
    `getResolvedAutoStartSidecar(): boolean` resolver that honours
    `DISABLE_AUTOSTART_SIDECAR=1` env override (for CI / tests / debugging).
  - `server/src/tts/spawn-sidecar.ts` new module: port probe + child
    spawn + PID file write + cross-platform tree-kill handle. Pure
    function with injectable `spawnFn` and `probeFn` for testability.
- **Invariants preserved:**
  - OpenAPI remains the type source of truth (CLAUDE.md). The field is
    added to both `UserSettings` and `UserSettingsPatch`; `api-types.ts`
    regenerates cleanly.
  - The mocked / real api dichotomy is unchanged — this is a backend-only
    spawn lifecycle; the frontend only sees a boolean preference round-trip.
  - `scripts/stop-app.ps1`'s `$names = @("frontend","server","tts")` array
    keeps working unchanged: Node now writes `.run/tts.pid` instead of
    `start-app.ps1`, but the path and the `taskkill /T /F` cascade are
    identical.
- **Migration story:**
  - `autoStartSidecar` is `z.boolean().optional()` so legacy
    `user-settings.json` files (without the field) parse cleanly and
    `getResolvedAutoStartSidecar()` falls through to the `true` default.
  - No on-disk migration needed.
- **Reversibility:**
  - Set `autoStartSidecar: false` in Account view — server stops
    spawning. Revert: toggle back on and restart.
  - Catastrophic: `DISABLE_AUTOSTART_SIDECAR=1` env hard-disables
    regardless of preference (CI / tests use this).
  - The original manual workflow (`npm run tts:sidecar`) still works:
    if it's already listening on :9000 when Node starts, the spawn
    self-skips with `[sidecar] already listening, skipping spawn`.

## Invariants to preserve

1. `userSettingsSchema` in `server/src/workspace/user-settings.ts:72`
   includes `autoStartSidecar: z.boolean().optional()`.
2. `DEFAULT_USER_SETTINGS.autoStartSidecar` in the same file is `true`.
3. `getResolvedAutoStartSidecar()` returns `false` iff
   `process.env.DISABLE_AUTOSTART_SIDECAR === '1'`; otherwise honours the
   cached preference or the `true` default.
4. `spawnSidecar` in `server/src/tts/spawn-sidecar.ts` propagates
   `PRELOAD_COQUI=1` iff `modelKey === 'coqui-xtts-v2'`, else
   `PRELOAD_COQUI=0`. Kokoro's eager-load is unconditional inside
   `server/tts-sidecar/main.py:644` — Node doesn't override it.
5. `spawnSidecar` writes `<repoRoot>/.run/tts.pid` so the existing
   `scripts/stop-app.ps1:18` `taskkill` loop reaps the Node-spawned child.
6. On `win32`, the handle's `kill()` invokes `taskkill /T /F /PID <pid>`
   so the powershell→uvicorn→python tree all dies; on other platforms,
   `process.kill(pid, 'SIGTERM')` cascades naturally.
7. `scripts/start-app.ps1`'s `$services` array no longer includes
   `tts` — Node owns the spawn. `stop-app.bat` / `stop-app.ps1` still
   reap the PID at `.run/tts.pid` unchanged.
8. `FRONTEND_ACCOUNT_DEFAULTS` in `src/lib/account-defaults.ts` mirrors
   `DEFAULT_USER_SETTINGS` for first-paint coherence.

## Test plan

### Automated coverage

- **Vitest server** (`server/src/tts/spawn-sidecar.test.ts`, 6 tests):
  - `autoStart=false` → spawn not called, returns null.
  - port 9000 already listening → spawn not called, returns null.
  - `modelKey='kokoro-v1'` → spawn called with `PRELOAD_COQUI=0`.
  - `modelKey='coqui-xtts-v2'` → spawn called with `PRELOAD_COQUI=1`.
  - Child exiting unexpectedly logs the warning with code+signal.
  - `handle.kill()` on `win32` shells out to
    `taskkill /PID <pid> /T /F`.
- **Vitest server** (`server/src/workspace/user-settings.test.ts`):
  - `autoStartSidecar` default is `true`.
  - Schema accepts both booleans, rejects non-booleans.
  - Field is optional — legacy file parses cleanly.
  - `getResolvedAutoStartSidecar` returns `false` only when
    `DISABLE_AUTOSTART_SIDECAR === '1'` (other values ignored).
- **Vitest frontend** (`src/views/account.test.tsx`, 5 tests):
  - Toggle renders checked / unchecked from persisted value.
  - Defaults to true on legacy / undefined.
  - Round-trips through Save patch.
  - Restart-required pill appears on dirty.

No Playwright e2e — process spawn isn't user-visible from the browser; the
existing e2e specs run in mock mode and never touch the sidecar.

### Manual acceptance walkthrough

Run with the **real** backend (not mock mode) — this plan is about server
process lifecycle, not UI.

1. **Cold boot — default install.** From a clean state (`stop-app.bat`,
   verify `.run/` is empty and `:9000` is free), run `start-app.bat`.
   _Expect:_ `logs/tts.log` shows the `start.ps1` banner within ~1 s,
   then Kokoro eager-load. `/api/sidecar/health` returns green.
   `.run/tts.pid` exists.
2. **Toggle off, restart.** Navigate to `#/account`, untick "Auto-start
   with server", click Save. _Expect:_ "Saved." pill flashes; restart-
   required pill is visible. Ctrl+C the Node terminal, `cd server && npm
run dev` again. _Expect:_ `logs/server.log` says
   `[sidecar] auto-start disabled`. No python process running.
   `/api/sidecar/health` returns red (sidecar unreachable).
3. **Toggle back on, switch default to Coqui.** In `#/account` re-check
   the box, change TTS model to `coqui-xtts-v2`, Save, restart server.
   _Expect:_ `logs/tts.log` shows `PRELOAD_COQUI=1` in env; XTTS load
   begins; the in-app Ollama-eviction notice fires.
4. **Pre-existing manual sidecar.** Stop everything, then run `npm run
tts:sidecar` first. While it's listening on :9000, `cd server && npm
run dev`. _Expect:_ `logs/server.log` says `[sidecar] already
listening on :9000, skipping spawn`. The manual sidecar keeps
   serving; Node doesn't spawn a duplicate.
5. **Clean teardown.** Run `stop-app.bat`. _Expect:_ port 9000 is free,
   no python/uvicorn lingerers in Task Manager, `.run/tts.pid` is gone.
6. **Ctrl+C teardown.** Spawn from `cd server && npm run dev`, hit Ctrl+C.
   _Expect:_ `[server] SIGINT received, tearing down sidecar...` in
   stdout, then the python child dies before Node exits. Port 9000 free.

## Out of scope

- **Coqui-vs-Kokoro engine switch automation.** A user flipping
  `defaultTtsModelKey` from `kokoro-v1` to `coqui-xtts-v2` (or vice
  versa) must restart the server for the change to take effect — the
  `PRELOAD_COQUI` env is captured at spawn time. Hot-swap would mean
  killing and re-spawning the sidecar from the user-settings PUT
  handler; not in this plan's scope. Track as a follow-up if it bites.
- **Auto-install of the sidecar venv.** If
  `server/tts-sidecar/.venv\Scripts\python.exe` doesn't exist,
  `start.ps1` fails and Node's child exits non-zero — surfaced via
  `/api/sidecar/health` going red. The plan does NOT auto-bootstrap
  the venv; that's a one-time install step documented in
  `server/tts-sidecar/README.md`.
- **Auto-install of Ollama / auto-pull of models.** That's BACKLOG
  Won't #1, untouched here.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA,
any behaviour delta vs. the original spec. Move to
`docs/features/archive/` in the same PR as the ship.)
