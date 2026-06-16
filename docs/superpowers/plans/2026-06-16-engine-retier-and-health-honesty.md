# Engine re-tiering + honest per-engine health — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 3 (2026-06-16, post plan-adversarial-review + ORT-merge reconcile):** the concurrent `fix/sidecar-nvidia-ort-gpu-enforce` branch **merged** (PR #828, `main`=`d941ea83`); this plan's `feat` branch is **rebased onto it**. Corrections folded in: Task 1 rewritten against the REAL `requirements-layout.test.ts` (helper is `read`, and the three overlay tests are regression *fences* asserting `coqui-tts` present — they must be inverted); the per-engine `package-missing` data-flow now carries **separate package+weights booleans** end-to-end (Tasks 7/8/10) instead of the collapsing install-state string; Task 11 wires to the **existing** `venv-bootstrap` route + `api.restartSidecar`; Task 13 audits `anyTtsEnginePresent` callers; test-helper references made concrete.

**Goal:** Move Qwen into the GPU requirements (standard) and Coqui to an opt-in secondary installer, then make the Model Manager + readiness gate report honest per-engine health (package vs weights vs integrity) across Kokoro/Qwen/Coqui/Whisper.

**Architecture:** A new `engine-health.ts` derives a 4-state health (`ready` / `package-missing` / `weights-missing` / `not-installed`) + `tier` per engine. **Package-importability** comes from the sidecar `/health` per-engine boolean (`find_spec`, authoritative when reachable) falling back to a Node disk probe; **weight-presence** comes from Node disk probes (authoritative for files). Inventory, the badge, and the readiness gate all read it. Repair is routed by tier: standard engines (Kokoro/Qwen/Whisper) → venv re-bootstrap + sidecar restart; Coqui → its own installer (now pip-installs the package).

**Tech Stack:** Node/Express + TypeScript (server), Python/FastAPI (sidecar), React + Redux + Vitest (frontend), Playwright (e2e), pytest (sidecar), pip requirements overlays.

**Spec:** `docs/superpowers/specs/2026-06-16-engine-retier-and-health-honesty-design.md`

---

## Prerequisite — DONE: ORT branch reconciled

`fix/sidecar-nvidia-ort-gpu-enforce` merged to `main` (PR #828, `d941ea83`: "force onnxruntime-gpu via ORT swap, not kokoro-onnx[gpu]"). `feat/engine-retier-health-honesty` is rebased onto it. Two interactions to keep in mind while implementing:

- **Fleet self-heal (benefit):** their venv-migration keys re-bootstrap off a `reqHash`. Editing `nvidia-cuda.txt` in Task 1 flips that hash, so **every existing nvidia box auto-runs `pip install -r` on next start → qwen-tts installs automatically** — the original bug self-heals fleet-wide, not just on fresh installs.
- **Decision 4 auto-satisfied:** `pip install -r` never *uninstalls*, so an upgraded box's existing `coqui-tts` **stays**; only genuinely fresh venvs lose it. No migration code needed.
- **Repair inherits a fatal ORT swap:** their `installForProfile` now runs `planOrtSwap` and a swap failure is FATAL. The standard-engine "venv re-bootstrap" Repair (Task 11) routes through this — note it in the Repair error copy.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `server/tts-sidecar/requirements/nvidia-cuda.txt` | NVIDIA overlay | qwen-tts IN, coqui-tts OUT |
| `server/tts-sidecar/requirements/amd-rocm.txt` | AMD overlay | qwen-tts IN, coqui-tts OUT |
| `server/tts-sidecar/requirements/cpu.txt` | CPU overlay | coqui-tts OUT (qwen stays out) |
| `server/tts-sidecar/requirements/base.txt` | vendor-neutral | re-comment transformers pin rationale |
| `server/tts-sidecar/scripts/install-coqui.mjs` | Coqui installer | + pip-install step (`-c base.txt`) |
| `server/tts-sidecar/scripts/install-qwen3.mjs` | Qwen installer | torch-safe (drop `-U`, `-c base.txt`) |
| `server/src/tts/coqui-install-bootstrap.ts` | Coqui job machine | update stale "not importable" message |
| `server/src/tts/kokoro-install-detect.ts` | Kokoro probe | + `kokoroPackageInstalled` + 4-state |
| `server/src/tts/whisper-install-detect.ts` | Whisper probe | **NEW** |
| `server/src/tts/engine-health.ts` | unified health + tier | **NEW** |
| `server/src/tts/model-integrity.ts` | integrity verdict | generalize to all engines |
| `server/tts-sidecar/main.py` | `/health` | + per-engine package/weights/state |
| `server/src/routes/sidecar-health.ts` | health proxy | forward per-engine booleans + state |
| `server/src/routes/models-inventory.ts` | inventory API | health + integrity + tier per row |
| `src/views/model-manager.tsx` | Model Manager UI | badge reads health; Repair; tier |
| `server/src/tts/engine-presence.ts` | readiness gate | health-aware, warn-not-block |
| `e2e/` | browser regression | Needs-repair + Repair + integrity chips |
| `docs/...` | docs | INSTALL + wizard + regression plan |

**Test-helper note (applies to Tasks 4, 5):** there is no shared `makeTempVenv`. Reuse the temp-tree pattern already in `server/src/tts/qwen-install-detect.test.ts` (it builds a `mkdtempSync` dir with `Lib/site-packages/<pkg>` subdirs and points the probe at it). Either lift that into a small local helper in each test file or copy the `mkdtempSync` setup inline. Do NOT invent a global helper.

---

## Phase 1 — Re-tier the engines

### Task 1: Re-tier requirements overlays

**Files:**
- Modify: `server/tts-sidecar/requirements/nvidia-cuda.txt`, `amd-rocm.txt`, `cpu.txt`, `base.txt`
- Test: `server/src/tts/requirements-layout.test.ts`, `server/src/upgrade/zip-validate.test.ts`, `server/tts-sidecar/tests/test_requirements.py`

> The three overlay tests in `requirements-layout.test.ts` are regression *fences* that currently assert `coqui-tts` is PRESENT and are titled "== TODAY". Our re-tier deliberately changes "today", so we REWRITE those assertions (the helper is `read(f)`, defined at the top of the file). Leave their ORT-swap assertions (`kokoro-onnx` plain, no `[gpu]`, no `onnxruntime-gpu`, `torch==2.8.0`) untouched.

- [ ] **Step 1: Rewrite the overlay fence assertions (write the failing assertions first)**

In `requirements-layout.test.ts`, in the **nvidia** test, replace `expect(n).toMatch(/^coqui-tts/m);` with:
```ts
expect(n).not.toMatch(/^coqui-tts/m);   // re-tiered: Coqui is opt-in now
expect(n).toMatch(/^qwen-tts\b/m);      // Qwen is standard on GPU profiles
```
In the **cpu** test, replace `expect(c).toMatch(/^coqui-tts/m);` with:
```ts
expect(c).not.toMatch(/^coqui-tts/m);   // opt-in
expect(c).not.toMatch(/^qwen-tts\b/m);  // Qwen is GPU-only standard
```
In the **amd** test, replace `expect(a).toMatch(/^coqui-tts/m);` with:
```ts
expect(a).not.toMatch(/^coqui-tts/m);
expect(a).toMatch(/^qwen-tts\b/m);
```
Update each test's title (e.g. nvidia → `'nvidia overlay: qwen-tts standard, coqui-tts opt-in, plain kokoro-onnx, pinned torch 2.8'`) and the explanatory comment above it (the "== TODAY" fence comment now describes the re-tier).

- [ ] **Step 2: Run the test, verify it FAILS**

Run: `cd server && npx vitest run src/tts/requirements-layout.test.ts`
Expected: FAIL (qwen-tts still commented, coqui-tts still present in the overlays).

- [ ] **Step 3: Edit the overlays**

- `nvidia-cuda.txt`: delete the `coqui-tts>=0.24.0` line and collapse its big `[codec]`/coqui comment to one line: `# Coqui XTTS is now opt-in — install it from the Model Manager (it pip-installs coqui-tts under base.txt's pins).` Uncomment the trailing `# qwen-tts` → `qwen-tts`, and trim its comment to drop the "if pip reports a conflict, run EITHER Coqui OR Qwen" hedge (Coqui is no longer co-resident in base): keep "per-character bespoke voices; weights fetched by install-qwen3.mjs".
- `amd-rocm.txt`: same (delete `coqui-tts`, uncomment/add `qwen-tts`).
- `cpu.txt`: delete `coqui-tts`; leave qwen absent; add `# Qwen is GPU-only standard — on CPU boxes install Coqui or Qwen on demand from the Model Manager.`
- `base.txt`: keep `transformers>=4.45,<5.0` + `faster-whisper`; replace the transformers comment with: `# Shared transformers lockstep. Qwen + Kokoro resolve under <5.0; this pin also keeps the OPT-IN Coqui (installed later via the Model Manager) on a compatible transformers — coqui-tts imports a 4.x-only private util (isin_mps_friendly).`

- [ ] **Step 4: Update `zip-validate.test.ts` and `test_requirements.py`**

In `zip-validate.test.ts` (~L118) change the `OVERLAY` fixture string `'-r base.txt\ncoqui-tts[codec]>=0.24.0\nkokoro-onnx[gpu]>=0.4.0,<0.5.0\n'` to the new shape: `'-r base.txt\nqwen-tts\nkokoro-onnx>=0.4.0,<0.5.0\n'` (qwen present, coqui absent, plain kokoro per the merged ORT work). In `test_requirements.py`, invert any `coqui-tts in nvidia/amd overlay` assertion to absent + add `qwen-tts` present in the GPU overlays.

- [ ] **Step 5: Run all three test files, verify PASS**

Run: `cd server && npx vitest run src/tts/requirements-layout.test.ts src/upgrade/zip-validate.test.ts`
Run: `npm run test:sidecar -- -k requirements`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/requirements/ server/src/tts/requirements-layout.test.ts server/src/upgrade/zip-validate.test.ts server/tts-sidecar/tests/test_requirements.py
git commit -m "feat(sidecar): re-tier engines — qwen-tts standard (GPU), coqui-tts opt-in"
```

### Task 2: Coqui opt-in installer pip-installs the package

**Files:**
- Modify: `server/tts-sidecar/scripts/install-coqui.mjs` (add pip step), `server/src/tts/coqui-install-bootstrap.ts` (message)
- Test: `server/src/tts/coqui-install-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test for the not-installed → installed path**

```ts
it('installs coqui-tts then weights when starting from not-installed', async () => {
  const states: CoquiInstallState[] = ['not-installed', 'ready'];
  const boot = new CoquiInstallBootstrap({
    repoRoot: '/repo',
    detectFn: () => states.shift() ?? 'ready',
    spawnFn: () => makeFakeChild(0, { stdout: '[install-coqui] Installing coqui-tts (opt-in)\n' }),
  });
  const job = boot.start();
  await vi.waitFor(() => expect(boot.getJob(job.id)?.status).toBe('installed'));
});
```
(`makeFakeChild` already exists in this test file — see its current `coqui-install-bootstrap.test.ts:68`.)

- [ ] **Step 2: Run it, verify FAIL/that it exercises the new path**

Run: `cd server && npx vitest run src/tts/coqui-install-bootstrap.test.ts`

- [ ] **Step 3: Add the pip step to `install-coqui.mjs`**

Before the weights auto-download, locate the venv python (mirror `install-qwen3.mjs`'s `findVenvPython`) and run, streaming a `[install-coqui] Installing coqui-tts (opt-in)…` step line:
```js
const baseTxt = join(SIDECAR_DIR, 'requirements', 'base.txt');
if (run(python, ['-m', 'pip', 'install', 'coqui-tts', '-c', baseTxt], env) !== 0) {
  step('FAIL: pip install coqui-tts failed. Check network + sidecar venv.');
  process.exit(1);
}
```

- [ ] **Step 4: Update the stale assumption message in `coqui-install-bootstrap.ts` (the `else` branch of `run()`)**

Change `'Installer finished but the coqui-tts (TTS) package is not importable in the sidecar venv. Check the sidecar venv bootstrap.'` → `'Installer finished but the coqui-tts (TTS) package is still not importable. Retry the install, or repair the sidecar venv.'`

- [ ] **Step 5: Run tests, verify PASS** — `cd server && npx vitest run src/tts/coqui-install-bootstrap.test.ts`

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-coqui.mjs server/src/tts/coqui-install-bootstrap.ts server/src/tts/coqui-install-bootstrap.test.ts
git commit -m "feat(sidecar): coqui opt-in installer pip-installs coqui-tts under base constraints"
```

### Task 3: Make Qwen reinstall/prefetch torch-safe

**Files:**
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs`
- Test: `server/src/tts/install-qwen3-helpers.test.ts`

- [ ] **Step 1: Write a helper test asserting torch-safe pip args**

```ts
it('installs qwen-tts without -U and under base constraints', () => {
  const args = qwenPipInstallArgs('/repo/server/tts-sidecar/requirements/base.txt');
  expect(args).not.toContain('-U');
  expect(args).toEqual(['-m', 'pip', 'install', 'qwen-tts', '-c', '/repo/server/tts-sidecar/requirements/base.txt']);
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/tts/install-qwen3-helpers.test.ts`

- [ ] **Step 3: Implement `qwenPipInstallArgs` and use it**

```js
export function qwenPipInstallArgs(baseTxtPath) {
  return ['-m', 'pip', 'install', 'qwen-tts', '-c', baseTxtPath];
}
```
In `install-qwen3.mjs`, replace the `['-m', 'pip', 'install', '-U', 'qwen-tts']` call with `qwenPipInstallArgs(join(SIDECAR_DIR, 'requirements', 'base.txt'))`. Update the step log to note the package now ships in the GPU overlay; this path is primarily weights prefetch + repair.

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/tts/install-qwen3-helpers.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/install-qwen3.mjs server/src/tts/install-qwen3-helpers.test.ts
git commit -m "fix(sidecar): qwen install path drops -U and pins via base constraints"
```

---

## Phase 2 — Health detection (server + sidecar)

### Task 4: Kokoro package probe + 4-state detector

**Files:**
- Modify: `server/src/tts/kokoro-install-detect.ts`
- Test: `server/src/tts/kokoro-install-detect.test.ts`

- [ ] **Step 1: Write failing tests** (build the temp venv with the `mkdtempSync` pattern from `qwen-install-detect.test.ts`)

```ts
it('kokoroPackageInstalled true when kokoro_onnx dir present', () => {
  const root = makeVenvTree({ 'Lib/site-packages/kokoro_onnx': {} });
  expect(kokoroPackageInstalled(root)).toBe(true);
});
it('detectKokoroInstallStateOnDisk: package present, weights absent → weights-missing', () => {
  const root = makeVenvTree({ 'Lib/site-packages/kokoro_onnx': {} }); // no weights
  expect(detectKokoroInstallStateOnDisk(root)).toBe('weights-missing');
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/tts/kokoro-install-detect.test.ts`

- [ ] **Step 3: Implement** — add `kokoroPackageInstalled(repoRoot)` mirroring `coquiPackageInstalled` (probe `Lib/site-packages/kokoro_onnx` + posix `lib/*/site-packages/kokoro_onnx`) and `detectKokoroInstallStateOnDisk(repoRoot): 'not-installed' | 'weights-missing' | 'ready'` (package first, then existing weights check). Keep the existing weights-only `detectKokoroInstalledOnDisk` (other callers depend on it).

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/tts/kokoro-install-detect.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/kokoro-install-detect.ts server/src/tts/kokoro-install-detect.test.ts
git commit -m "feat(server): kokoro package probe + 4-state install detector"
```

### Task 5: Whisper install detector (NEW)

**Files:**
- Create: `server/src/tts/whisper-install-detect.ts`
- Test: `server/src/tts/whisper-install-detect.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('whisperPackageInstalled true when faster_whisper present', () => {
  expect(whisperPackageInstalled(makeVenvTree({ 'Lib/site-packages/faster_whisper': {} }))).toBe(true);
});
it('detectWhisperInstallStateOnDisk: no package → not-installed', () => {
  expect(detectWhisperInstallStateOnDisk(makeVenvTree({}))).toBe('not-installed');
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/tts/whisper-install-detect.test.ts`

- [ ] **Step 3: Implement** mirroring `coqui-install-detect.ts`: `whisperPackageInstalled(repoRoot)` (probe `faster_whisper`), `whisperWeightsPresent()` (a model blob under `whisperRepoDir()` from `model-paths.ts` — already imported by `models-inventory.ts`), `detectWhisperInstallStateOnDisk(repoRoot)` (package → weights → ready).

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/tts/whisper-install-detect.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/whisper-install-detect.ts server/src/tts/whisper-install-detect.test.ts
git commit -m "feat(server): whisper (faster-whisper) install detector"
```

### Task 6: Unified `engine-health.ts` (NEW)

**Files:**
- Create: `server/src/tts/engine-health.ts`
- Test: `server/src/tts/engine-health.test.ts`

- [ ] **Step 1: Write failing tests** (the crux: `package-missing` must NOT collapse to `not-installed`)

```ts
it('package absent + weights present → package-missing', () => {
  expect(deriveEngineHealth('qwen', { packageInstalled: false, weightsPresent: true, loaded: false }).state).toBe('package-missing');
});
it('both present → ready; tier(qwen)=standard, tier(coqui)=secondary, tier(whisper)=standard', () => {
  expect(deriveEngineHealth('qwen', { packageInstalled: true, weightsPresent: true, loaded: false }).state).toBe('ready');
  expect(engineTier('qwen')).toBe('standard');
  expect(engineTier('coqui')).toBe('secondary');
  expect(engineTier('whisper')).toBe('standard');
});
it('repair routing: standard → venv-bootstrap, coqui → installer', () => {
  expect(repairActionFor('qwen', 'package-missing')).toBe('venv-bootstrap');
  expect(repairActionFor('coqui', 'package-missing')).toBe('installer');
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/tts/engine-health.test.ts`

- [ ] **Step 3: Implement**

```ts
export type EngineId = 'kokoro' | 'qwen' | 'coqui' | 'whisper';
export type EngineHealthState = 'ready' | 'package-missing' | 'weights-missing' | 'not-installed' | 'loaded';
export type EngineTier = 'standard' | 'secondary';
export type RepairAction = 'venv-bootstrap' | 'installer';

const STANDARD: ReadonlySet<EngineId> = new Set(['kokoro', 'qwen', 'whisper']);
export const engineTier = (id: EngineId): EngineTier => (STANDARD.has(id) ? 'standard' : 'secondary');

export interface EngineProbe { packageInstalled: boolean; weightsPresent: boolean; loaded: boolean; }

export function deriveEngineHealth(_id: EngineId, p: EngineProbe): { state: EngineHealthState } {
  if (p.loaded) return { state: 'loaded' };
  if (p.packageInstalled && p.weightsPresent) return { state: 'ready' };
  if (!p.packageInstalled && p.weightsPresent) return { state: 'package-missing' };
  if (p.packageInstalled && !p.weightsPresent) return { state: 'weights-missing' };
  return { state: 'not-installed' };
}

// Standard engines ride requirements → repair = venv re-bootstrap; Coqui is opt-in.
export function repairActionFor(id: EngineId, _state: EngineHealthState): RepairAction {
  return engineTier(id) === 'secondary' ? 'installer' : 'venv-bootstrap';
}
```

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/tts/engine-health.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/engine-health.ts server/src/tts/engine-health.test.ts
git commit -m "feat(server): unified per-engine health (4-state) + tier + repair routing"
```

### Task 7: Sidecar `/health` — per-engine package + weights + state

> **Key correctness fix (B1):** the collapsing `*_install_state` string can't express `package-missing`. Expose **separate booleans** per engine (mirror the existing `qwen_package_installed`/`qwen_weights_present`) so Node can derive `package-missing`. Also lift the weights short-circuit so weights are reported **independently of** the package.

**Files:**
- Modify: `server/tts-sidecar/main.py`
- Test: `server/tts-sidecar/tests/test_install_state.py` (NEW)

- [ ] **Step 1: Write failing pytest**

```python
def test_health_reports_per_engine_package_and_weights(monkeypatch, health_body):
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: False)
    monkeypatch.setattr(main, "_coqui_weights_present", lambda: True)  # weights without package
    body = health_body()
    assert body["coqui_package_installed"] is False
    assert body["coqui_weights_present"] is True   # NOT short-circuited to False
    for e in ("coqui", "kokoro", "whisper"):
        assert f"{e}_install_state" in body
```

- [ ] **Step 2: Run, verify FAIL** — `npm run test:sidecar -- -k install_state`

- [ ] **Step 3: Implement**

Add `_coqui_package_installed()` / `_kokoro_package_installed()` / `_whisper_package_installed()` — each `importlib.util.find_spec("TTS" | "kokoro_onnx" | "faster_whisper") is not None`, guarded exactly like `_qwen_package_installed`. Add `_coqui_weights_present()` etc. (reuse each engine's on-disk check). Add `_coqui_install_state(loaded)` / `_kokoro_install_state(loaded)` / `_whisper_install_state(loaded)` mirroring `_qwen_install_state`. In the `/health` dict, beside the qwen keys, add per engine: `<e>_package_installed`, `<e>_weights_present`, `<e>_install_state`.
**Lift the short-circuit:** change `qwen_weights_present = _qwen_weights_present() if qwen_package_installed else False` to `qwen_weights_present = _qwen_weights_present()` (and report the new engines' weights unconditionally too), so `package-missing` is observable.

- [ ] **Step 4: Run, verify PASS** — `npm run test:sidecar -- -k install_state`

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_install_state.py
git commit -m "feat(sidecar): /health reports per-engine package+weights+install-state"
```

### Task 8: Forward per-engine booleans through `sidecar-health.ts`

**Files:**
- Modify: `server/src/routes/sidecar-health.ts`
- Test: `server/src/routes/sidecar-health.test.ts`

- [ ] **Step 1: Write failing test** asserting `probeSidecarHealth` forwards, per engine, `<e>PackageInstalled` / `<e>WeightsPresent` / `<e>InstallState` from a stub body, defaulting an old sidecar (fields absent) to `false`/`false`/`'not-installed'`.

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/routes/sidecar-health.test.ts`

- [ ] **Step 3: Implement** — extend `SidecarHealthResult` with `coquiPackageInstalled?`, `coquiWeightsPresent?`, `coquiInstallState?` (and the kokoro/whisper triples). Reuse the existing `QWEN_INSTALL_STATES` list via a generic `normaliseInstallState(raw)`. Forward each from `body.coqui_package_installed` / `body.coqui_weights_present` / `body.coqui_install_state` on the reachable path (mirror the existing qwen forwarding at L256-258).

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/routes/sidecar-health.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/sidecar-health.ts server/src/routes/sidecar-health.test.ts
git commit -m "feat(server): forward per-engine package/weights/install-state from sidecar"
```

---

## Phase 3 — Inventory, integrity, UI

### Task 9: Generalize integrity to all engines

**Files:**
- Modify: `server/src/tts/model-integrity.ts`
- Test: `server/src/tts/model-integrity.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('engineIntegrity(kokoro) verifies pinned weights', () => {
  expect(engineIntegrity('kokoro', repoWithGoodKokoro)).toBe('verified');
});
it('engineIntegrity(qwen) → unpinned (no manifest entry)', () => {
  expect(engineIntegrity('qwen', anyRepo)).toBe('unpinned');
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/tts/model-integrity.test.ts`

- [ ] **Step 3: Implement** — add `export function engineIntegrity(engine: EngineId, repoRoot: string): 'verified' | 'unpinned' | 'mismatch' | undefined`. For `kokoro` delegate to the existing size-check but return `'unpinned'` (not `undefined`) when the manifest has no `kokoro` entry. For `qwen`/`coqui`/`whisper` (no pins) return `'unpinned'`. Keep `kokoroIntegrity` as a thin wrapper so existing callers compile.

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/tts/model-integrity.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/model-integrity.ts server/src/tts/model-integrity.test.ts
git commit -m "feat(server): integrity verdict for every engine (verified/unpinned/mismatch)"
```

### Task 10: Inventory composes health + integrity + tier per row

> **Composition rule (B1):** `packageInstalled` = sidecar `<e>PackageInstalled` when the sidecar is reachable, else the Node disk package probe; `weightsPresent` = **Node disk weight probe** (authoritative for files, regardless of sidecar); `loaded` = sidecar `<e>Loaded`. Then `deriveEngineHealth(engineId, probe)`.

**Files:**
- Modify: `server/src/routes/models-inventory.ts`
- Test: `server/src/routes/models-inventory.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('qwen-base: sidecar package=false + node weights present → package-missing', () => {
  const inv = buildModelInventory({ ...deps,
    sidecar: { ...up, qwenPackageInstalled: false, qwenWeightsPresent: true, qwenLoaded: false } });
  const row = inv.items.find(i => i.id === 'qwen-base')!;
  expect(row.installState).toBe('package-missing');
  expect(row.tier).toBe('standard');
});
it('every TTS + whisper row carries an integrity verdict', () => {
  const inv = buildModelInventory(deps);
  for (const id of ['kokoro','qwen-base','coqui','whisper'])
    expect(inv.items.find(i => i.id === id)!.integrity).toBeDefined();
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/routes/models-inventory.test.ts`

- [ ] **Step 3: Implement** — add `installState?: EngineHealthState` + `tier?: EngineTier` to `ModelInventoryItem`. For each TTS row + whisper, build the probe per the composition rule above (sidecar booleans from Task 8, Node weight probe from the existing sizing + the detectors), then set `installState = deriveEngineHealth(engineId, probe).state`, `tier = engineTier(engineId)`, `integrity = engineIntegrity(engineId, repoRoot)`. Keep `present` weights-based. Map row id → `EngineId` (`'qwen-base'`→`'qwen'`, `'qwen-design'` reuses qwen health, `'whisper'`→`'whisper'`).

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/routes/models-inventory.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/models-inventory.ts server/src/routes/models-inventory.test.ts
git commit -m "feat(server): inventory composes health + integrity + tier per engine"
```

### Task 11: Model Manager badge reads health; Repair; tier grouping

> **Repair backends EXIST (verified):** `api.restartSidecar` (`POST /api/sidecar/restart`, `api.ts:6266`) and the `venv-bootstrap` route (`server/src/routes/venv-bootstrap.ts`, with `api`-side caller — confirm the exact `api.*` symbol before coding). A standard-engine Repair = trigger venv re-bootstrap (reinstalls the overlay → the missing package) **then** `api.restartSidecar()` (a mid-process pip install isn't visible to `find_spec` until restart). Surface the inherited fatal-ORT-swap possibility in the error copy ("re-bootstrap also re-runs the GPU runtime swap"). Whisper is `kind: 'asr'` — render it in its existing ASR section, not under the voice-engine tier headings.

**Files:**
- Modify: `src/views/model-manager.tsx`
- Test: `src/views/model-manager.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
it('package-missing row shows Needs repair, disables Load, labels action Repair', () => {
  render(<ModelInventoryRows items={[{ ...qwenBase, installState: 'package-missing', tier: 'standard', present: true }]} />);
  const row = screen.getByTestId('model-row-qwen-base');
  expect(within(row).getByText('Needs repair')).toBeInTheDocument();
  expect(within(row).getByRole('button', { name: /load/i })).toBeDisabled();
  expect(within(row).getByRole('button', { name: /repair/i })).toBeInTheDocument();
});
it('renders an integrity chip (unpinned) for qwen', () => {
  render(<ModelInventoryRows items={[{ ...qwenBase, integrity: 'unpinned', present: true }]} />);
  expect(screen.getByText(/unpinned/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/views/model-manager.test.tsx`

- [ ] **Step 3: Implement** — in `ResidencyBadge`, branch on `item.installState`: `package-missing` → amber "Needs repair"; `weights-missing` → amber "Weights missing"; else the existing present/loaded/installed logic. Gate Load: `hasControl = (item.installState === 'ready' || item.loaded) && (engine !== undefined || isAnalyzer)`. Add a "Repair" button when `installState === 'package-missing'`, handler routes by `repairActionFor(engineId, state)` — `installer` → open the engine's `<Installer>`; `venv-bootstrap` → call the venv-bootstrap api then `api.restartSidecar()`, showing a "Repairing & restarting the sidecar…" status. Add an `IntegrityChip` (emerald verified / red mismatch / neutral-grey unpinned with a tooltip "integrity pinning applies to fixed-file models"). Group the TTS rows under "Standard" / "Optional add-ons" by `tier`; leave the ASR (Whisper) + analyzer rows in their existing sections.

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/views/model-manager.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/views/model-manager.tsx src/views/model-manager.test.tsx
git commit -m "feat(frontend): Model Manager honest health badge + per-engine Repair + tier"
```

### Task 12: E2E — Needs-repair + Repair + integrity chips

**Files:**
- Modify: `e2e/` (add a spec or a case to the Model Manager coverage spec)

- [ ] **Step 1: Write the spec** — with the mock inventory returning `qwen-base` at `installState: 'package-missing'`, assert: "Needs repair" shown, Load disabled, a "Repair" control present, an integrity chip rendered for every TTS + whisper row (qwen → "unpinned", kokoro → "verified"), and Coqui (secondary, not-installed) shows "Install".

- [ ] **Step 2: Run, verify it drives the UI** — `npm run test:e2e -- model-manager`

- [ ] **Step 3: Commit**

```bash
git add e2e/
git commit -m "test(e2e): Model Manager needs-repair + repair + integrity chips"
```

---

## Phase 4 — Readiness gate + docs

### Task 13: Readiness gate is health-aware and fail-open

> **Caller audit (B3):** `anyTtsEnginePresent` is consumed by the fs-21 readiness spine/wizard. Tightening weights-only → `ready` could make a fresh box (Kokoro package present, weights not yet fetched) read "no engine ready" and over-block. Audit every caller (`grep -rn anyTtsEnginePresent server/src`) and add a test that the wizard still reaches "ready" after Kokoro weights install.

**Files:**
- Modify: `server/src/tts/engine-presence.ts` (+ the diagnostics/wizard consumer if it re-derives presence)
- Test: `server/src/tts/engine-presence.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('anyTtsEnginePresent requires ready (package+weights), not weights alone', () => {
  expect(anyTtsEnginePresent(repoKokoroWeightsNoPackage)).toBe(false);
});
it('package-missing warns; hard-blocks only when sidecar-confirmed', () => {
  expect(readinessSeverity({ engine: 'qwen', state: 'package-missing', sidecarConfirmed: false })).toBe('warn');
  expect(readinessSeverity({ engine: 'qwen', state: 'package-missing', sidecarConfirmed: true })).toBe('block');
});
it('a fresh box reaches ready once Kokoro weights are installed', () => {
  expect(anyTtsEnginePresent(repoKokoroReady)).toBe(true);
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/tts/engine-presence.test.ts`

- [ ] **Step 3: Implement** — switch each engine in `anyTtsEnginePresent` to `detect…InstallStateOnDisk(...) === 'ready'` (Kokoro/Coqui were weights-only). Add `readinessSeverity({engine,state,sidecarConfirmed})`: `package-missing` → `'block'` only when `sidecarConfirmed` (the sidecar's `find_spec` said unimportable), else `'warn'`; `not-installed` for a **secondary** engine → `'info'`. Wire `sidecarConfirmed` from the diagnostics aggregator's reachable-sidecar per-engine `packageInstalled === false`. Update any caller that depended on the looser semantics.

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/tts/engine-presence.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/engine-presence.ts server/src/tts/engine-presence.test.ts
git commit -m "feat(server): readiness gate health-aware, fail-open (warn vs sidecar-confirmed block)"
```

### Task 14: Docs — INSTALL, wizard copy, regression plan

**Files:**
- Modify: `INSTALL.md`, the fs-21 wizard copy, `CLAUDE.md` (stale "Whisper needs pip install faster-whisper" note — it's a BASE requirement), `docs/features/INDEX.md`
- Create: `docs/features/<n>-engine-retier-health-honesty.md` (regression plan from TEMPLATE)

- [ ] **Step 1: Write the regression plan** — invariants: standard set (Kokoro+Qwen+Whisper packages on GPU; Kokoro+Whisper on CPU), Coqui opt-in; the badge↔health states table; the warn-vs-block gate; the `base.txt` transformers lockstep; the reqHash fleet-self-heal. **On-box acceptance (B6):** confirm `pip install -r nvidia-cuda.txt` resolves (qwen-tts + `transformers<5.0` + torch 2.8 + the ORT swap) — observed this session: qwen-tts resolved transformers to 4.57.3 (compatible). Manual walkthrough: uninstall `qwen-tts` → Model Manager shows "Needs repair" → Repair → sidecar restart → "Installed".
- [ ] **Step 2: Update INSTALL.md + wizard copy** — standard vs optional engines; Coqui as a legacy alternate; the `-c base.txt` note for manual venv installs.
- [ ] **Step 3: Update `docs/features/INDEX.md`** and fix the stale CLAUDE.md Whisper note.
- [ ] **Step 4: Commit**

```bash
git add INSTALL.md docs/ CLAUDE.md
git commit -m "docs: engine re-tier + health-honesty regression plan + install/wizard copy"
```

### Task 15: Full verify + PR

- [ ] **Step 1:** `npm run verify` (typecheck + all tests + e2e + build). Triage any red per CLAUDE.md (related → fix; pre-existing → surface).
- [ ] **Step 2:** Open the PR from `feat/engine-retier-health-honesty`; title `feat(server,sidecar,frontend): re-tier engines + honest per-engine health`; body links the spec + this plan + the bug/feature issue; note it builds on the merged `fix/sidecar-nvidia-ort-gpu-enforce` (#828).

---

## Self-Review

**Spec coverage:** Decision 1 (re-tier, GPU-only Qwen) → Task 1. Decision 2 (weights on-demand) → Task 3 (no prefetch added). Decision 3 (Kokoro default) → unchanged (no task). Decision 4 (migration) → auto-satisfied by pip non-removal (Prerequisite note) + Task 14 docs. Decision 5 (no constraints file; base.txt pin; Coqui installs against it) → Tasks 1, 2. Decision 6 (integrity for all) → Task 9. Decision 7 (warn vs sidecar-confirmed block) → Task 13. Decision 8 (4 engines incl. Whisper) → Tasks 5, 7, 10. Per-engine repair routing → Task 6 + Task 11. find_spec/disk split → Tasks 7 (booleans), 10 (composition rule). Sidecar-restart-on-repair → Task 11.

**Placeholder scan:** test-helper references made concrete (`read` is the real helper; `makeVenvTree` defined via the `qwen-install-detect.test.ts` pattern, called out in the File-Structure note). Task 11's venv-bootstrap `api.*` symbol is the one item to confirm at code time (the route exists; name the caller before coding).

**Type consistency:** `EngineId`/`EngineHealthState`/`EngineTier`/`RepairAction` (Task 6) reused verbatim in Tasks 9, 10, 11, 13. `installState`/`tier` on `ModelInventoryItem` (Task 10) match the badge read (Task 11). The sidecar per-engine boolean names (`<e>_package_installed`/`<e>_weights_present`/`<e>_install_state`, Task 7) match the proxy camelCase (`<e>PackageInstalled`…, Task 8) and the inventory composition (Task 10).

**Note for implementer:** `spawn-windows-hide.test.ts` lists `install-coqui.mjs` — Task 2 keeps it a `node <script>` spawn, so that test stays green; verify after Task 2.
