# Engine re-tiering + honest per-engine health — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Qwen into the GPU requirements (standard) and Coqui to an opt-in secondary installer, then make the Model Manager + readiness gate report honest per-engine health (package vs weights vs integrity) across Kokoro/Qwen/Coqui/Whisper.

**Architecture:** A new `engine-health.ts` derives a 4-state health (`ready` / `package-missing` / `weights-missing` / `not-installed`) + `tier` per engine, sourcing package-importability from the sidecar `/health` (`find_spec`, authoritative when reachable) and weight-presence from Node disk probes (authoritative for files). Inventory, the badge, and the readiness gate all read it. Repair is routed by tier: standard engines → venv re-bootstrap; Coqui → its own installer (now pip-installs the package).

**Tech Stack:** Node/Express + TypeScript (server), Python/FastAPI (sidecar), React + Redux + Vitest (frontend), Playwright (e2e), pytest (sidecar), pip requirements overlays.

**Spec:** `docs/superpowers/specs/2026-06-16-engine-retier-and-health-honesty-design.md`

---

## ⚠️ Prerequisite — reconcile the concurrent ORT branch FIRST

A concurrent session's branch `fix/sidecar-nvidia-ort-gpu-enforce` is editing the **same files** Phase 1 touches: `requirements/nvidia-cuda.txt`, `requirements-layout.test.ts`, `test_requirements.py`, `bootstrap-venv.mjs`, `install-ort.mjs`. **Do not start Task 1 until that branch is merged to `main`**, then rebase `feat/engine-retier-health-honesty` onto the updated `main`. All requirements edits below are described **semantically** ("uncomment the `qwen-tts` line", "delete the `coqui-tts` line") rather than by line number, because their merge will shift line numbers.

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
| `server/src/tts/coqui-install-bootstrap.ts` | Coqui job machine | update line-138 message |
| `server/src/tts/kokoro-install-detect.ts` | Kokoro probe | + `kokoroPackageInstalled` + 4-state |
| `server/src/tts/whisper-install-detect.ts` | Whisper probe | **NEW** |
| `server/src/tts/engine-health.ts` | unified health + tier | **NEW** |
| `server/src/tts/model-integrity.ts` | integrity verdict | generalize to all engines |
| `server/tts-sidecar/main.py` | `/health` | + coqui/kokoro/whisper `_install_state` |
| `server/src/routes/sidecar-health.ts` | health proxy | forward 3 new install states |
| `server/src/routes/models-inventory.ts` | inventory API | health + integrity + tier per row |
| `src/views/model-manager.tsx` | Model Manager UI | badge reads health; Repair; tier |
| `server/src/tts/engine-presence.ts` | readiness gate | health-aware, warn-not-block |
| `e2e/` | browser regression | Needs-repair + Repair affordance |
| `docs/...` | docs | INSTALL + wizard + regression plan |

---

## Phase 1 — Re-tier the engines

### Task 1: Re-tier requirements overlays

**Files:**
- Modify: `server/tts-sidecar/requirements/nvidia-cuda.txt`, `amd-rocm.txt`, `cpu.txt`, `base.txt`
- Test: `server/src/tts/requirements-layout.test.ts`, `server/src/upgrade/zip-validate.test.ts`, `server/tts-sidecar/tests/test_requirements.py`

- [ ] **Step 1: Update the layout test to the new invariants (write the failing assertions first)**

In `requirements-layout.test.ts`, change the NVIDIA/AMD overlay assertions so they require `qwen-tts` present (uncommented) and `coqui-tts` absent; CPU overlay requires `coqui-tts` absent. Example shape (adapt to the file's existing helper that reads each overlay):

```ts
it('nvidia overlay ships qwen-tts as standard and not coqui-tts', () => {
  const txt = readOverlay('nvidia-cuda.txt');
  expect(txt).toMatch(/^\s*qwen-tts\b/m);        // uncommented, active
  expect(txt).not.toMatch(/^\s*coqui-tts\b/m);   // demoted to secondary
});
it('cpu overlay drops coqui-tts and keeps qwen GPU-only', () => {
  const txt = readOverlay('cpu.txt');
  expect(txt).not.toMatch(/^\s*coqui-tts\b/m);
  expect(txt).not.toMatch(/^\s*qwen-tts\b/m);     // qwen is GPU-only
});
```

- [ ] **Step 2: Run the tests, verify they FAIL**

Run: `cd server && npx vitest run src/tts/requirements-layout.test.ts`
Expected: FAIL (qwen-tts still commented, coqui-tts still present).

- [ ] **Step 3: Edit the overlays**

- `nvidia-cuda.txt`: delete the `coqui-tts>=0.24.0` line (and tighten the now-stale `[codec]`/coqui comment to a one-line pointer to the opt-in installer). Uncomment the `# qwen-tts` line → `qwen-tts` (keep the surrounding comment, drop the "if pip reports a conflict" hedge since Coqui is no longer co-resident in base).
- `amd-rocm.txt`: same (delete `coqui-tts`, uncomment/add `qwen-tts`).
- `cpu.txt`: delete `coqui-tts`; leave qwen absent; add a one-line comment `# Qwen is GPU-only standard — install Coqui or Qwen via the in-app Model Manager on CPU boxes.`
- `base.txt`: keep `transformers>=4.45,<5.0`; replace its comment with: `# Shared transformers lockstep. Qwen + Kokoro resolve under <5.0; this pin also keeps the OPT-IN Coqui (installed later via the Model Manager) on a compatible transformers — coqui-tts imports a 4.x-only private util.`

- [ ] **Step 4: Update `zip-validate.test.ts` and `test_requirements.py`**

In `zip-validate.test.ts:~118`, change the `OVERLAY` fixture string from `'-r base.txt\ncoqui-tts[codec]>=0.24.0\nkokoro-onnx[gpu]>=0.4.0,<0.5.0\n'` to the new shape (`qwen-tts` present, `coqui-tts` absent). In `test_requirements.py`, mirror: assert `qwen-tts` active in GPU overlays, `coqui-tts` absent.

- [ ] **Step 5: Run all three test files, verify PASS**

Run: `cd server && npx vitest run src/tts/requirements-layout.test.ts src/upgrade/zip-validate.test.ts`
Run: `npm run test:sidecar -- -k requirements` (or `pytest server/tts-sidecar/tests/test_requirements.py`)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/requirements/ server/src/tts/requirements-layout.test.ts server/src/upgrade/zip-validate.test.ts server/tts-sidecar/tests/test_requirements.py
git commit -m "feat(sidecar): re-tier engines — qwen-tts standard (GPU), coqui-tts opt-in"
```

### Task 2: Coqui opt-in installer pip-installs the package

**Files:**
- Modify: `server/tts-sidecar/scripts/install-coqui.mjs` (add pip step), `server/src/tts/coqui-install-bootstrap.ts:138`
- Test: `server/src/tts/coqui-install-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test for the not-installed → installed path**

In `coqui-install-bootstrap.test.ts`, add a test where `detectFn` returns `'not-installed'` first, the spawned installer succeeds, and a follow-up `detectFn` returns `'ready'`; assert the job ends `installed` (today the code can reach this, but the install-coqui.mjs spawn must now perform the pip step — the unit covers the bootstrap contract; the pip step itself is covered by the script's own helper test if present, else by the spawn args).

```ts
it('installs the coqui-tts package then weights when starting from not-installed', async () => {
  const states: CoquiInstallState[] = ['not-installed', 'ready'];
  const boot = new CoquiInstallBootstrap({
    repoRoot: '/repo',
    detectFn: () => states.shift() ?? 'ready',
    spawnFn: () => makeFakeChild(0, { stdout: '[install-coqui] pip install coqui-tts\n' }),
  });
  const job = boot.start();
  await vi.waitFor(() => expect(boot.getJob(job.id)?.status).toBe('installed'));
});
```

- [ ] **Step 2: Run it, verify FAIL** (or that the message assertion below fails)

Run: `cd server && npx vitest run src/tts/coqui-install-bootstrap.test.ts`

- [ ] **Step 3: Add the pip step to `install-coqui.mjs`**

Before the weights auto-download, run (mirroring `install-qwen3.mjs`'s `run()` helper): locate the venv python, then
`python -m pip install coqui-tts -c <repoRoot>/server/tts-sidecar/requirements/base.txt`, streaming a `[install-coqui] Installing coqui-tts (opt-in)…` step line. Fail the script (exit 1) with a clear `[install-coqui] FAIL: pip install coqui-tts failed.` if it returns non-zero.

- [ ] **Step 4: Update the stale assumption message in `coqui-install-bootstrap.ts:138`**

Change `'Installer finished but the coqui-tts (TTS) package is not importable in the sidecar venv. Check the sidecar venv bootstrap.'` → `'Installer finished but the coqui-tts (TTS) package is still not importable. Retry the install, or repair the sidecar venv.'`

- [ ] **Step 5: Run tests, verify PASS**

Run: `cd server && npx vitest run src/tts/coqui-install-bootstrap.test.ts`

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-coqui.mjs server/src/tts/coqui-install-bootstrap.ts server/src/tts/coqui-install-bootstrap.test.ts
git commit -m "feat(sidecar): coqui opt-in installer pip-installs coqui-tts under base constraints"
```

### Task 3: Make Qwen reinstall/prefetch torch-safe

**Files:**
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs`
- Test: `server/src/tts/install-qwen3-helpers.test.ts`

- [ ] **Step 1: Write/extend a helper test asserting the pip args are torch-safe**

Add a pure helper `qwenPipInstallArgs(baseTxtPath)` returning `['-m','pip','install','qwen-tts','-c',baseTxtPath]` (no `-U`). Test it:

```ts
it('installs qwen-tts without -U and under base constraints', () => {
  const args = qwenPipInstallArgs('/repo/server/tts-sidecar/requirements/base.txt');
  expect(args).not.toContain('-U');
  expect(args).toContain('-c');
  expect(args).toContain('/repo/server/tts-sidecar/requirements/base.txt');
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd server && npx vitest run src/tts/install-qwen3-helpers.test.ts`

- [ ] **Step 3: Implement `qwenPipInstallArgs` and use it in `install-qwen3.mjs`**

Replace the `['-m', 'pip', 'install', '-U', 'qwen-tts']` call with `qwenPipInstallArgs(join(SIDECAR_DIR,'requirements','base.txt'))`. Update the step log to note it's idempotent (package now ships in the GPU overlay; this path is primarily weights prefetch + repair).

- [ ] **Step 4: Run, verify PASS**

Run: `cd server && npx vitest run src/tts/install-qwen3-helpers.test.ts`

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

- [ ] **Step 1: Write failing tests**

```ts
it('kokoroPackageInstalled true when kokoro_onnx dir present', () => {
  const root = makeTempVenv({ 'Lib/site-packages/kokoro_onnx': {} });
  expect(kokoroPackageInstalled(root)).toBe(true);
});
it('detectKokoroInstallStateOnDisk: package present, weights absent → weights-missing', () => {
  const root = makeTempVenv({ 'Lib/site-packages/kokoro_onnx': {} }); // no weights
  expect(detectKokoroInstallStateOnDisk(root)).toBe('weights-missing');
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd server && npx vitest run src/tts/kokoro-install-detect.test.ts`

- [ ] **Step 3: Implement `kokoroPackageInstalled` + richer state**

Add `kokoroPackageInstalled(repoRoot)` mirroring `coquiPackageInstalled` (probe `Lib/site-packages/kokoro_onnx` + posix `lib/*/site-packages/kokoro_onnx`). Add `detectKokoroInstallStateOnDisk(repoRoot): 'not-installed' | 'weights-missing' | 'ready'` (package first, then `detectKokoroInstalledOnDisk` for weights). Keep the existing weights-only `detectKokoroInstalledOnDisk` (other callers depend on it).

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
  const root = makeTempVenv({ 'Lib/site-packages/faster_whisper': {} });
  expect(whisperPackageInstalled(root)).toBe(true);
});
it('detectWhisperInstallStateOnDisk: no package → not-installed', () => {
  expect(detectWhisperInstallStateOnDisk(makeTempVenv({}))).toBe('not-installed');
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/tts/whisper-install-detect.test.ts`

- [ ] **Step 3: Implement** mirroring `coqui-install-detect.ts`: `whisperPackageInstalled(repoRoot)` (probe `faster_whisper`), `whisperWeightsPresent()` (model dir under `whisperRepoDir()` from `model-paths.ts` holds a real model blob), `detectWhisperInstallStateOnDisk(repoRoot)` (package → weights → ready).

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

- [ ] **Step 1: Write failing tests for the 4-state derivation + tier**

The crux: `package-missing` = weights present but package absent (must NOT collapse to `not-installed`). Package-importability prefers the sidecar's per-engine boolean when provided; weights come from Node disk probes.

```ts
it('package absent + weights present → package-missing (not not-installed)', () => {
  const h = deriveEngineHealth('qwen', { packageInstalled: false, weightsPresent: true, loaded: false });
  expect(h.state).toBe('package-missing');
});
it('both present → ready; tier(qwen)=standard, tier(coqui)=secondary', () => {
  expect(deriveEngineHealth('qwen', { packageInstalled: true, weightsPresent: true, loaded: false }).state).toBe('ready');
  expect(engineTier('qwen')).toBe('standard');
  expect(engineTier('coqui')).toBe('secondary');
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

### Task 7: Sidecar `/health` — per-engine install states via find_spec

**Files:**
- Modify: `server/tts-sidecar/main.py`
- Test: `server/tts-sidecar/tests/test_runtime_wiring.py` (or a new `test_install_state.py`)

- [ ] **Step 1: Write failing pytest**

```python
def test_health_reports_per_engine_install_state(monkeypatch, health_body):
    # coqui_tts package present, weights absent → 'weights-missing'
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: True)
    monkeypatch.setattr(main, "_coqui_weights_present", lambda: False)
    body = health_body()
    assert body["coqui_install_state"] == "weights-missing"
    assert "kokoro_install_state" in body and "whisper_install_state" in body
```

- [ ] **Step 2: Run, verify FAIL** — `npm run test:sidecar -- -k install_state`

- [ ] **Step 3: Implement**

Add `_coqui_package_installed()` / `_kokoro_package_installed()` / `_whisper_package_installed()` (each `importlib.util.find_spec("TTS" | "kokoro_onnx" | "faster_whisper") is not None`, guarded like `_qwen_package_installed`). Add matching `_coqui_weights_present()` etc. (or reuse the engines' existing on-disk checks). Add `_coqui_install_state(loaded)` / `_kokoro_install_state(loaded)` / `_whisper_install_state(loaded)` mirroring `_qwen_install_state`. In the `/health` dict (near `qwen_install_state`), add `coqui_install_state`, `kokoro_install_state`, `whisper_install_state`.
**Also fix the weights short-circuit:** report each engine's `*_weights_present` **independently of** its package boolean (today `qwen_weights_present = _qwen_weights_present() if qwen_package_installed else False` hides weights-present-package-missing — set it unconditionally so Node can derive `package-missing`).

- [ ] **Step 4: Run, verify PASS** — `npm run test:sidecar -- -k install_state`

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/
git commit -m "feat(sidecar): /health reports coqui/kokoro/whisper install-state via find_spec"
```

### Task 8: Forward the new install states through `sidecar-health.ts`

**Files:**
- Modify: `server/src/routes/sidecar-health.ts`
- Test: `server/src/routes/sidecar-health.test.ts`

- [ ] **Step 1: Write failing test** asserting `probeSidecarHealth` forwards `coquiInstallState`/`kokoroInstallState`/`whisperInstallState` from a stub body, defaulting an old sidecar (field absent) to `'not-installed'`.

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/routes/sidecar-health.test.ts`

- [ ] **Step 3: Implement** — add `coquiInstallState?`, `kokoroInstallState?`, `whisperInstallState?` to `SidecarHealthResult`; add a generic `normaliseInstallState(raw)` (reuse the `QWEN_INSTALL_STATES` list) and forward each from `body.coqui_install_state` etc. on the reachable path.

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/routes/sidecar-health.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/sidecar-health.ts server/src/routes/sidecar-health.test.ts
git commit -m "feat(server): forward per-engine install-state from sidecar /health"
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

- [ ] **Step 3: Implement** — add `export type IntegrityVerdict = 'verified' | 'unpinned' | 'mismatch' | undefined;` and `export function engineIntegrity(engine: EngineId, repoRoot: string): IntegrityVerdict`. For `kokoro` delegate to the existing size-check but return `'unpinned'` (not `undefined`) when the manifest has no `kokoro` entry. For `qwen`/`coqui`/`whisper` (no manifest pins) return `'unpinned'`. Keep `kokoroIntegrity` as a thin wrapper so existing callers compile.

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/tts/model-integrity.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/model-integrity.ts server/src/tts/model-integrity.test.ts
git commit -m "feat(server): integrity verdict for every engine (verified/unpinned/mismatch)"
```

### Task 10: Inventory sets health + integrity + tier for every row

**Files:**
- Modify: `server/src/routes/models-inventory.ts`
- Test: `server/src/routes/models-inventory.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('qwen-base row: weights present + sidecar says package missing → installState package-missing', () => {
  const inv = buildModelInventory({ ...deps, sidecar: { ...up, qwenInstallState: 'not-installed', qwenPackageInstalled: false, qwenWeightsPresent: true } });
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

- [ ] **Step 3: Implement**

Add `installState?: EngineHealthState` and `tier?: EngineTier` to `ModelInventoryItem`. For each TTS row + whisper, compute `installState` via `deriveEngineHealth(engineId, { packageInstalled, weightsPresent, loaded })` where `packageInstalled` prefers the sidecar field (`sidecar.<engine>InstallState !== 'not-installed'` / explicit boolean) and falls back to the Node disk package probe, and `weightsPresent` comes from the existing Node weight sizing. Set `tier = engineTier(...)`, `integrity = engineIntegrity(...)` for all four. Keep `present` weights-based.

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/routes/models-inventory.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/models-inventory.ts server/src/routes/models-inventory.test.ts
git commit -m "feat(server): inventory carries health + integrity + tier per engine"
```

### Task 11: Model Manager badge reads health; Repair; tier grouping

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

- [ ] **Step 3: Implement**

In `ResidencyBadge`, branch on `item.installState`: `package-missing` → amber "Needs repair"; `weights-missing` → amber "Weights missing"; else fall through to the existing present/loaded/installed logic. Gate the Load pill: `hasControl = item.installState === 'ready' || item.loaded` (was `item.present && …`). Add the action label: when `installState === 'package-missing'`, render a **"Repair"** button whose handler routes by `repairActionFor(engineId, state)` — `installer` → open the engine's `<Installer>` (Coqui); `venv-bootstrap` → trigger the venv-bootstrap flow (`api.bootstrapVenv()` / the fs-21 route) — and surface a "restarting the sidecar…" note. Add an `IntegrityChip` (emerald verified / red mismatch / neutral-grey unpinned w/ tooltip). Group rows by `tier` under "Standard" / "Optional add-ons" sub-headings.

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/views/model-manager.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/views/model-manager.tsx src/views/model-manager.test.tsx
git commit -m "feat(frontend): Model Manager honest health badge + per-engine Repair + tier"
```

### Task 12: E2E — Needs-repair + Repair affordance

**Files:**
- Modify: `e2e/` (add a spec or a case to the Model Manager coverage spec)

- [ ] **Step 1: Write the spec** — with the mock inventory returning a `qwen-base` row at `installState: 'package-missing'`, assert the Model Manager shows "Needs repair", the Load control is disabled, a "Repair" control is present, and Coqui (secondary, not-installed) shows "Install".

- [ ] **Step 2: Run, verify it drives the UI** — `npm run test:e2e -- model-manager`

- [ ] **Step 3: Commit**

```bash
git add e2e/
git commit -m "test(e2e): Model Manager needs-repair + repair affordance"
```

---

## Phase 4 — Readiness gate + docs

### Task 13: Readiness gate is health-aware and fail-open

**Files:**
- Modify: `server/src/tts/engine-presence.ts` (+ the diagnostics consumer if it re-derives presence)
- Test: `server/src/tts/engine-presence.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it('anyTtsEnginePresent requires ready (package+weights), not weights alone', () => {
  // kokoro weights present but package missing → not "present"
  expect(anyTtsEnginePresent(repoKokoroWeightsNoPackage)).toBe(false);
});
it('package-missing warns but does not hard-block unless sidecar-confirmed', () => {
  expect(readinessSeverity({ engine: 'qwen', state: 'package-missing', sidecarConfirmed: false })).toBe('warn');
  expect(readinessSeverity({ engine: 'qwen', state: 'package-missing', sidecarConfirmed: true })).toBe('block');
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd server && npx vitest run src/tts/engine-presence.test.ts`

- [ ] **Step 3: Implement** — switch each engine in `anyTtsEnginePresent` to `detect…InstallStateOnDisk(...) === 'ready'` (Kokoro/Coqui were weights-only). Add `readinessSeverity({engine,state,sidecarConfirmed})`: `package-missing` → `'block'` only when `sidecarConfirmed` (the sidecar's `find_spec` said unimportable), else `'warn'`; `not-installed` for a **secondary** engine → `'info'`. Wire the diagnostics surface to use it.

- [ ] **Step 4: Run, verify PASS** — `cd server && npx vitest run src/tts/engine-presence.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/engine-presence.ts server/src/tts/engine-presence.test.ts
git commit -m "feat(server): readiness gate health-aware, fail-open (warn vs sidecar-confirmed block)"
```

### Task 14: Docs — INSTALL, wizard copy, regression plan

**Files:**
- Modify: `INSTALL.md`, the fs-21 wizard copy, `CLAUDE.md` (Whisper "needs pip install" note is stale — it's base), `docs/features/INDEX.md`
- Create: `docs/features/<n>-engine-retier-health-honesty.md` (regression plan from TEMPLATE)

- [ ] **Step 1: Write the regression plan** — invariants: standard set (Kokoro+Qwen+Whisper packages on GPU; Kokoro+Whisper on CPU), Coqui opt-in, the badge↔health states table, the warn-vs-block gate, the `base.txt` transformers lockstep. Manual acceptance: simulate package-missing (uninstall qwen-tts) → Model Manager shows "Needs repair" → Repair → sidecar restart → "Installed".
- [ ] **Step 2: Update INSTALL.md + wizard copy** — standard vs optional engines; Coqui as legacy alternate; `-c base.txt` note for manual venv installs.
- [ ] **Step 3: Update `docs/features/INDEX.md`** and fix the stale CLAUDE.md Whisper note.
- [ ] **Step 4: Commit**

```bash
git add INSTALL.md docs/ CLAUDE.md
git commit -m "docs: engine re-tier + health-honesty regression plan + install/wizard copy"
```

### Task 15: Full verify + PR

- [ ] **Step 1:** `npm run verify` (typecheck + all tests + e2e + build). Triage any red per CLAUDE.md (related → fix; pre-existing → surface).
- [ ] **Step 2:** Open the PR from `feat/engine-retier-health-honesty`; title `feat(server,sidecar,frontend): re-tier engines + honest per-engine health`; body links the spec + this plan + the bug/feature issue; note the dependency on the merged `fix/sidecar-nvidia-ort-gpu-enforce`.

---

## Self-Review

**Spec coverage:** Decision 1 (re-tier, GPU-only Qwen) → Task 1. Decision 2 (weights on-demand) → Task 3 (no prefetch added). Decision 3 (Kokoro default) → unchanged, asserted nowhere new (no task needed). Decision 4 (migration) → Task 14 docs. Decision 5 (no constraints file; base.txt pin; Coqui installs against it) → Tasks 1, 2. Decision 6 (integrity for all) → Task 9. Decision 7 (warn vs sidecar-confirmed block) → Task 13. Decision 8 (4 engines incl. Whisper) → Tasks 5, 7, 10. Per-engine repair routing → Task 6 (`repairActionFor`) + Task 11. find_spec/disk split → Tasks 7, 10. Sidecar-restart-on-repair → Task 11. Test touchpoints (zip-validate, test_requirements, spawn-windows-hide) → Task 1 (spawn-windows-hide references `install-coqui.mjs`; if Task 2 changes its arg surface, update that test there).

**Placeholder scan:** repair-button handler in Task 11 references `api.bootstrapVenv()` / the fs-21 route — confirm the exact symbol when implementing (the venv-bootstrap route exists per fs-21; name it precisely in the task before coding). No "TBD"/"handle edge cases" left.

**Type consistency:** `EngineId`/`EngineHealthState`/`EngineTier` defined in Task 6 are reused verbatim in Tasks 9, 10, 11, 13. `installState` on `ModelInventoryItem` (Task 10) matches the badge read (Task 11). `engineIntegrity(engine, repoRoot)` signature (Task 9) matches the inventory call (Task 10).

**Note for implementer:** `spawn-windows-hide.test.ts` lists `install-coqui.mjs` — Task 2 keeps it a `node <script>` spawn, so that test stays green; verify after Task 2.
