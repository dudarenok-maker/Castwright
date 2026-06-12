# fs-21 Wave 1b — Venv bootstrap (decision Z) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Let the first-run wizard one-click **bootstrap the sidecar Python venv** — the artifact upstream of every TTS engine (no venv → sidecar won't start → no engine runs). Per **decision Z**: do it in-app when a Python 3.11 interpreter is found, and **degrade to copy-paste per-OS instructions** when it isn't (the wizard never owns provisioning Python itself).

**Architecture:** A Python-interpreter discovery helper + a Node `bootstrap-venv.mjs` that runs `python -m venv` then `<venv>/python -m pip install -r requirements.txt` (idempotent — no-op if the venv python already exists), fronted by a `VenvBootstrap` job class + a `/api/setup/venv` polling route + a `fetch`-polling component, mirroring the install-bootstrap pattern Wave 1 used for Kokoro.

**Tech Stack:** Node 20 + TS (ESM `.js` imports), `node:child_process` (`spawn`/`spawnSync`), Vitest, React 18 + `fetch`-polling.

**Spec:** `docs/superpowers/specs/2026-06-12-fs21-first-run-wizard-design.md` · **Epic:** #474 · **Branch:** `feat/fs21-wave1b-venv-bootstrap` off `main` (worktree `C:\Claude\Projects\wt-fs21-wave1b`).

> **Split from Wave 1 by the adversarial review.** Inherently **OWED (not CI-gated):** a real fresh `python -m venv` + multi-GB `pip install -r requirements.txt` on a box WITHOUT a venv (this box has one → the idempotent guard no-ops). All *logic + wiring* (discovery, helpers, job state, route shapes, component states, the degrade path) IS unit-tested here.

> **Verified by Explore (2026-06-12):** Express 5.2.1 handles `app.use('/api/setup', readinessRouter)` + `app.use('/api/setup/venv', venvRouter)` cleanly in either mount order (readiness has no catch-all) — no `setupRouter` merge needed. Nothing in the repo creates a venv programmatically today; the existing `install-*.mjs` all `findVenvPython()` and exit if absent — `bootstrap-venv.mjs` is the opposite (it CREATES it).

> **Standing rule:** this plan gets an adversarial review BEFORE any task executes.

---

## File Structure
- Create `server/src/tts/python-discovery.ts` — `findPython311(opts?)` → `{ cmd, args } | null`.
- Create `server/tts-sidecar/scripts/bootstrap-venv.mjs` — venv creator + pip installer (exports pure helpers `venvPythonPath`, `venvAlreadyBootstrapped`).
- Create `server/src/tts/venv-bootstrap.ts` — `class VenvBootstrap` (job manager, mirror `KokoroInstallBootstrap`).
- Create `server/src/routes/venv-bootstrap.ts` — `venvBootstrapRouter` at `/api/setup/venv`.
- Create `src/components/venv-bootstrap.tsx` — polling component with the degrade path.
- Modify `server/src/index.ts` (register), `server/vitest.config.slow.ts` + `server/vitest.config.ts` (pin the route test).
- Tests beside each.

---

## Task B1: `python-discovery.ts`

**Files:** Create `server/src/tts/python-discovery.ts`, `server/src/tts/python-discovery.test.ts`.

- [ ] **Step 1: Failing test** — inject a stub `runFn(cmd, args) → { status, stdout, stderr }`:
  - win32: prefers `py` with args `['-3.11']` when `py -3.11 --version` → `Python 3.11.x`.
  - posix: tries `python3.11` then `python3`; accepts the first whose `--version` parses to 3.10–3.12.
  - returns `null` when no candidate reports a 3.10–3.12 version.
  - parses the version from EITHER stdout or stderr (older pythons print `--version` to stderr).

```ts
import { describe, it, expect } from 'vitest';
import { findPython311 } from './python-discovery.js';
const ok = (v: string) => ({ status: 0, stdout: `Python ${v}\n`, stderr: '' });
const fail = () => ({ status: 1, stdout: '', stderr: 'not found' });

describe('findPython311', () => {
  it('win32 prefers py -3.11', () => {
    const r = findPython311({ platform: 'win32', runFn: (c, a) => (c === 'py' && a[0] === '-3.11' ? ok('3.11.9') : fail()) });
    expect(r).toEqual({ cmd: 'py', args: ['-3.11'] });
  });
  it('posix falls back python3.11 → python3', () => {
    const r = findPython311({ platform: 'linux', runFn: (c) => (c === 'python3' ? ok('3.12.2') : fail()) });
    expect(r).toEqual({ cmd: 'python3', args: [] });
  });
  it('rejects too-old / too-new', () => {
    expect(findPython311({ platform: 'linux', runFn: () => ok('3.9.1') })).toBeNull();
    expect(findPython311({ platform: 'linux', runFn: () => ok('3.13.0') })).toBeNull();
  });
  it('null when nothing found', () => {
    expect(findPython311({ platform: 'win32', runFn: () => fail() })).toBeNull();
  });
  it('parses version from stderr', () => {
    const r = findPython311({ platform: 'linux', runFn: (c) => (c === 'python3.11' ? { status: 0, stdout: '', stderr: 'Python 3.11.0\n' } : fail()) });
    expect(r).toEqual({ cmd: 'python3.11', args: [] });
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `export function findPython311(opts?: { platform?: NodeJS.Platform; runFn?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string } }): { cmd: string; args: string[] } | null`. Default `runFn` = `(cmd, args) => spawnSync(cmd, [...args, '--version'], { windowsHide: true, encoding: 'utf8' })` (map to `{ status, stdout, stderr }`). Candidates: win32 → `[['py',['-3.11']], ['python',[]]]`; posix → `[['python3.11',[]], ['python3',[]]]`. For each, run `--version`, parse `/Python (\d+)\.(\d+)/` from `stdout || stderr`, accept major===3 && minor 10–12. Return first match or null.
- [ ] **Step 4: Run → PASS; Step 5: Commit** `feat(server): Python 3.11 interpreter discovery (fs-21 wave 1b)`.

---

## Task B2: `bootstrap-venv.mjs`

**Files:** Create `server/tts-sidecar/scripts/bootstrap-venv.mjs`, `server/src/tts/bootstrap-venv-helpers.test.ts`.

- [ ] **Step 1: Failing helper test** (mirror `install-kokoro-helpers.test.ts`'s `@ts-expect-error` import). The `.mjs` exports `venvPythonPath(venvDir, platform)` (→ `join(venvDir,'Scripts','python.exe')` on win32 else `join(venvDir,'bin','python')`) and `venvAlreadyBootstrapped(venvDir, platform)` (`existsSync(venvPythonPath(...))`). Test both layouts + a temp dir with/without the python file.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `bootstrap-venv.mjs`:**
  - `export function venvPythonPath(venvDir, platform)` and `export function venvAlreadyBootstrapped(venvDir, platform)`.
  - `main()` (under the import-meta main-guard from `install-kokoro.mjs`): resolve `venvDir = process.env.SIDECAR_VENV_DIR ?? join(repoRoot,'server','tts-sidecar','.venv')`. If `venvAlreadyBootstrapped(venvDir, process.platform)` → `[bootstrap-venv] venv already present` + exit 0 (idempotent). Else: `process.argv[2]` = python cmd, `process.argv.slice(3)` = its args; run `spawnSync(pyCmd, [...pyArgs, '-m', 'venv', venvDir], { stdio:'inherit', windowsHide:true })` (throw on non-zero), then `spawnSync(venvPythonPath(venvDir, process.platform), ['-m','pip','install','-r', join(repoRoot,'server','tts-sidecar','requirements.txt')], { stdio:'inherit', windowsHide:true })` (throw on non-zero). Emit `[bootstrap-venv] <step>` lines (creating venv, installing requirements, done). Exit 1 with `[bootstrap-venv] FAIL: ...` on error.
- [ ] **Step 4: Run → PASS; Step 5: Commit** `feat(sidecar): bootstrap-venv.mjs (python -m venv + pip install) (fs-21 wave 1b)`.

---

## Task B3: `VenvBootstrap` class

**Files:** Create `server/src/tts/venv-bootstrap.ts`, `server/src/tts/venv-bootstrap.test.ts`.

- [ ] **Step 1: READ `server/src/tts/kokoro-install-bootstrap.ts` (Wave 1) in full.** Mirror as `VenvBootstrap`:
  - State: `'present' | 'absent'` (binary).
  - `detect()` → `{ venvPresent: sidecarVenvPresent(repoRoot) /* from ../diagnostics/venv.js */, python: findPython311() /* {cmd,args}|null */, installed: venvPresent }`.
  - `start()`: if `venvPresent` → short-circuit job `status:'installed'`; else if `findPython311()` returns null → job `status:'error'` whose `error` is the per-OS manual instructions string (the **decision-Z degrade** — `py -3.11 -m venv .venv` / `python3.11 -m venv .venv` + the pip line); else spawn `this.spawnFn('node', [join(repoRoot,'server','tts-sidecar','scripts','bootstrap-venv.mjs'), python.cmd, ...python.args], { cwd: repoRoot, windowsHide: true })`, surfacing `[bootstrap-venv]` step lines.
  - injectable `spawnFn`, `detectVenvFn` (= sidecarVenvPresent), `findPythonFn` (= findPython311); `getJob/getActiveJob/recheck/_reset`. Export the class + `VenvBootstrapJob` interface.
- [ ] **Step 2: Failing test** (stubbed deps): venv present → short-circuits `installed` no spawn; venv absent + python found → spawns once, `[bootstrap-venv]` updates step, exit 0 → installed; venv absent + NO python → `error` job carrying instructions, NO spawn; non-zero exit → error with stderr tail.
- [ ] **Step 3: Run → FAIL; Step 4: implement; Step 5: Run → PASS; Step 6: Commit** `feat(server): VenvBootstrap job manager (decision Z) (fs-21 wave 1b)`.

---

## Task B4: `/api/setup/venv` route + registration (slow-pool test)

**Files:** Create `server/src/routes/venv-bootstrap.ts`, `server/src/routes/venv-bootstrap.route.test.ts`; modify `server/src/index.ts`, `server/vitest.config.slow.ts`, `server/vitest.config.ts`.

- [ ] **Step 1: READ `server/src/routes/kokoro-install.ts` (Wave 1).** Mirror as `venvBootstrapRouter`: `GET /detect` → bootstrap.detect(); `POST /bootstrap` → start() → 202 + job; `GET /bootstrap/:id` → getJob (404 if null). Module-singleton `VenvBootstrap` + the same test-injection hook. (Path verbs are `/bootstrap` not `/install` — it's not installing a model.)
- [ ] **Step 2: Failing slow-pool route test** (stubbed bootstrap, mirror `kokoro-install.route.test.ts`): detect shape; POST `/bootstrap` → 202; no-python → error job carries the instructions string. Pin `'src/routes/venv-bootstrap.route.test.ts'` to `SLOW_FILES` (slow config) + `SLOW_FILES_TO_EXCLUDE` (fast config).
- [ ] **Step 3: Run → FAIL; Step 4: implement + register `app.use('/api/setup/venv', venvBootstrapRouter)` AFTER the `app.use('/api/setup', setupReadinessRouter)` line (express 5 multi-mount verified safe); Step 5: slow test → PASS + `npm run typecheck`.**
- [ ] **Step 6: Commit** `feat(server): /api/setup/venv bootstrap route (decision Z) (fs-21 wave 1b)`.

---

## Task B5: `venv-bootstrap.tsx` component

**Files:** Create `src/components/venv-bootstrap.tsx`, `src/components/venv-bootstrap.test.tsx`.

- [ ] **Step 1: READ `src/components/kokoro-install.tsx` (Wave 1).** Mirror as `VenvBootstrap({ onBootstrapped })`, polling `/api/setup/venv/detect`, `POST /api/setup/venv/bootstrap`, `GET /api/setup/venv/bootstrap/:id`. States: `venvPresent` → green "TTS engine ready"; `!venvPresent && python found` → one-click "Set up the TTS engine" (POST + poll `[bootstrap-venv]` steps; note this can take several minutes — show the live step + a "this can take a few minutes" hint); `!venvPresent && NO python` → render the **per-OS manual instructions** (decision-Z degrade) + a "Re-check" button; error → message + retry. Design tokens, no hex.
- [ ] **Step 2: Failing test** (mock fetch): renders one-click when python found; renders manual instructions when not; calls `onBootstrapped` when a poll flips to present/installed.
- [ ] **Step 3: Run → FAIL; Step 4: implement; Step 5: Run → PASS + typecheck.**
- [ ] **Step 6: Commit** `feat(frontend): venv bootstrap component (decision Z) (fs-21 wave 1b)`.

---

## Task B6: Full verify + draft PR

- [ ] **Step 1:** `npm run verify` green (cache-aware retry for the `test:server` contention flake).
- [ ] **Step 2:** `gh pr create --draft --title "feat(server,frontend,sidecar): fs-21 wave 1b — venv bootstrap (decision Z)" --body "... Refs #474. OWED: real fresh venv create + pip install on a box without a venv (Win/mac/linux); logic + degrade path fully tested here."` → `gh pr ready` once green.

---

## Self-Review
- Covers decision Z end-to-end: discovery (B1) → creator (B2) → job (B3) → route (B4) → component with the degrade path (B5).
- **Open questions for the adversarial review:** (1) confirm `sidecarVenvPresent` is exported from `server/src/diagnostics/venv.js` (Wave 0) with the signature `(repoRoot)`; (2) confirm the `/api/setup/venv` mount truly doesn't collide with the readiness router on THIS codebase (Explore verified on express 5.2.1 — re-confirm the readiness router has no `/*`); (3) does `bootstrap-venv.mjs`'s idempotent no-op make B2/B3 trivially green here while the real path stays OWED — is the OWED framing honest in the PR body; (4) should `venv-bootstrap.tsx` reuse any copy from the Wave 0 readiness-blocker remediation, or is it standalone.
