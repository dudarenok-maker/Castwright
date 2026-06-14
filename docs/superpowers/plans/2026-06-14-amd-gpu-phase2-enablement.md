# AMD GPU Support — Phase 2 (AMD Cohort Enablement) Implementation Plan

> **⚠️ RE-SCOPED (2026-06-14) — read before using.** The phasing changed (public beta is now gated on Phase 1). **The Python-3.12 flip, the NVIDIA/CPU requirements (`base`/`nvidia-cuda`/`cpu`), the Python-3.12 acquisition, and CI→3.12 all MOVED TO PHASE 1** (which now ships them, with **detect-and-reinstall** instead of an in-place migration). **This plan is now AMD-ONLY.** Concretely from the waves below: **drop A1 (nvidia/cpu overlays — done in P1), A4 (py3.12 acquisition — done in P1), B1/B2/B3/B4 (migration wiring + 3.12 flip — P1 ships 3.12 via detect-and-reinstall, NOT the resumable rebuild), G1 (CI 3.12 — done in P1).** What this plan KEEPS: the `amd-rocm.txt` overlay, A2/A3 (ROCm torch + ORT ordering + flash-attn), Wave C (sidecar AMD runtime), Wave D (health/VRAM), Wave E (AMD UX), Wave F (profile-switch — **this is the ONLY place the in-place build-new-then-swap rebuild + `decideDiskAction` are needed, and even then only if a seamless switch is wanted over "switching profiles needs a re-setup"**), Wave H (on-AMD acceptance). **Existing users get NO forced migration on the AMD release** (`pythonTag`/`profile` unchanged → `decideVenvAction` = `noop`/`pip-in-place`).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. Gated on Phase 1 shipped + the Section-0 spike; **must not be RELEASED** until the 🔴 on-AMD acceptance (Wave H) passes.

**Goal:** Turn on AMD GPU support end-to-end — ROCm PyTorch (Coqui/Qwen) + DirectML (Kokoro) on Windows, ROCm on Linux — by wiring the dormant Phase-1 resolver/migration core into the install layer, the venv migration, the Python sidecar, `/health`, telemetry, and the UI; and flip the sidecar to Python 3.12 (which triggers the migration).

**Architecture:** Phase-1 gave us pure, tested decision logic (`accelerator-profile.mjs`, `venv-migration.mjs`). Phase 2 *consumes* it: installers ask `installRecipe`; `bootstrap-venv.mjs` + `apply.ts` ask `decideVenvAction`/`computeReqHash`/`decideDiskAction`; `spawn-sidecar.ts` injects the resolved profile + ORT providers into the Python sidecar via env; the sidecar consumes them (never re-derives). The Python 3.12 flip triggers the build-new-then-swap migration with an atomic, resumable upgrade.

**Tech Stack:** Node ESM `.mjs` + TS (server, Vitest/node env), Python 3.12 sidecar (pytest), React/RTK frontend (Vitest+jsdom, Playwright e2e), GitHub Actions YAML.

**Spec:** `docs/superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md` — esp. "Spike findings — desk pass (2026-06-14)", Sections 2–6, "Delivery sequencing → Phase 2".

**Verified mechanics from the spike (build against these):**
- AMD-Windows torch (cp312): `https://repo.radeon.com/rocm/windows/rocm-rel-6.4.4/torch-2.8.0a0+gitfc14c65-cp312-cp312-win_amd64.whl` + `torchaudio-2.6.0a0+1a8f621-cp312-cp312-win_amd64.whl` (ROCm 6.4.4, alpha preview).
- AMD profile installs `coqui-tts` **without `[codec]`** (torch 2.8 < 2.9 → torchcodec not required; in-core `torchaudio` I/O).
- Kokoro DirectML: pin `onnxruntime-directml` ≥ the release with the ConvTranspose bias fix (latest, ~2026-03-17); enable via the cached self-test.
- ORT recipe: install `kokoro-onnx`, `pip uninstall -y onnxruntime`, `pip install onnxruntime-directml`.
- Profile→Python: server injects `CASTWRIGHT_ACCELERATOR_PROFILE` + `KOKORO_ORT_PROVIDERS`; missing → Python auto-detects (today's behavior).

> **⚠️ Values still OWED on-AMD (Wave H):** the exact `onnxruntime-directml` min version, whether the ROCm-Win wheel imports on a non-AMD box, and the final `ortInstallSteps` are confirmed in Wave H before release. Where a task depends on one, it says so.

---

## Wave A — Install layer (requirements restructure + resolver-driven installers)

### Task A1: Layered requirements files (NVIDIA == today; cpu + amd added)

**Files:**
- Create: `server/tts-sidecar/requirements/base.txt`, `nvidia-cuda.txt`, `cpu.txt`, `amd-rocm.txt`
- Modify: `server/tts-sidecar/requirements.txt` (becomes a pointer/compat shim)
- Test: `server/src/tts/requirements-layout.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REQ = join(__dirname, '../../tts-sidecar/requirements');

describe('layered requirements', () => {
  it('every profile overlay -r includes base.txt', () => {
    for (const f of ['nvidia-cuda.txt', 'cpu.txt', 'amd-rocm.txt']) {
      expect(readFileSync(join(REQ, f), 'utf8')).toMatch(/^-r base\.txt/m);
    }
  });
  it('base.txt holds the vendor-neutral deps, no torch/onnxruntime', () => {
    const base = readFileSync(join(REQ, 'base.txt'), 'utf8');
    expect(base).toMatch(/fastapi/);
    expect(base).toMatch(/faster-whisper/);
    expect(base).not.toMatch(/onnxruntime/);
    expect(base).not.toMatch(/^torch/m);
  });
  it('nvidia overlay == TODAY: coqui-tts[codec] + kokoro-onnx[gpu] (regression fence)', () => {
    const n = readFileSync(join(REQ, 'nvidia-cuda.txt'), 'utf8');
    expect(n).toMatch(/coqui-tts\[codec\]/);
    expect(n).toMatch(/kokoro-onnx\[gpu\]/);
  });
  it('amd overlay drops [codec] (torch 2.8 < 2.9) and uses plain kokoro-onnx', () => {
    const a = readFileSync(join(REQ, 'amd-rocm.txt'), 'utf8');
    expect(a).toMatch(/coqui-tts(?!\[codec\])/); // no [codec]
    expect(a).not.toMatch(/kokoro-onnx\[gpu\]/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- requirements-layout`
Expected: FAIL — files don't exist.

- [ ] **Step 3: Create the files**

`base.txt` (move the vendor-neutral lines out of today's `requirements.txt`):
```
fastapi>=0.115,<0.116
uvicorn[standard]>=0.30,<0.32
numpy>=1.26,<3.0
soundfile
psutil>=5.9
faster-whisper>=1.0,<2.0
transformers>=4.45,<5.0
```

`nvidia-cuda.txt` (byte-equivalent to TODAY — the regression fence; torch arrives transitively via these):
```
-r base.txt
coqui-tts[codec]>=0.24.0
kokoro-onnx[gpu]>=0.4.0,<0.5.0
```

`cpu.txt`:
```
-r base.txt
coqui-tts[codec]>=0.24.0
kokoro-onnx>=0.4.0,<0.5.0
onnxruntime
```

`amd-rocm.txt` (torch pre-installed separately by the installer per A3 — NOT here; drop [codec]; plain kokoro-onnx, DirectML installed by the ORT-ordering step):
```
-r base.txt
coqui-tts>=0.24.0
kokoro-onnx>=0.4.0,<0.5.0
# torch (ROCm wheel) + onnxruntime-directml are installed by install scripts per the
# resolver recipe (manual wheel + ORT uninstall/reinstall ordering) — see Task A3.
```

Replace `server/tts-sidecar/requirements.txt` body with a pointer comment + `-r requirements/nvidia-cuda.txt` so any legacy bare `pip install -r requirements.txt` still reproduces today's NVIDIA set:
```
# Layered requirements (AMD GPU support). The active overlay is selected by the
# accelerator profile resolver; this shim preserves the legacy NVIDIA default for
# any caller that still runs `pip install -r requirements.txt` directly.
-r requirements/nvidia-cuda.txt
```

- [ ] **Step 4: Run test to verify it passes** — `npm --prefix server run test -- requirements-layout` → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/tts-sidecar/requirements* server/src/tts/requirements-layout.test.ts
git commit -m "feat(sidecar): layered requirements (base + nvidia/cpu/amd overlays) (AMD phase 2)"
```

### Task A2: Fill the resolver's AMD `torchPreinstall` with the verified wheels

**Files:**
- Modify: `server/tts-sidecar/scripts/accelerator-profile.mjs`
- Modify: `server/src/tts/accelerator-profile.test.ts`
- Modify: `server/tts-sidecar/scripts/model-hashes.json` (add torch wheel sha256 pins — Wave H confirms hashes)

- [ ] **Step 1: Write the failing test** (replace the AMD `PENDING_SPIKE` assertion)

```ts
it('amd torchPreinstall = the pinned ROCm 6.4.4 cp312 wheels (S0.2)', () => {
  const r = installRecipe('amd', 'win32');
  expect(r.torchPreinstall.wheels).toEqual([
    'https://repo.radeon.com/rocm/windows/rocm-rel-6.4.4/torch-2.8.0a0+gitfc14c65-cp312-cp312-win_amd64.whl',
    'https://repo.radeon.com/rocm/windows/rocm-rel-6.4.4/torchaudio-2.6.0a0+1a8f621-cp312-cp312-win_amd64.whl',
  ]);
  expect(r.ortPackage).toBe('onnxruntime-directml');
});
```

- [ ] **Step 2: Run** `npm --prefix server run test -- accelerator-profile` → FAIL (still `'PENDING_SPIKE'`).

- [ ] **Step 3: Replace the AMD branch of `installRecipe`**

```js
if (profile === 'amd') {
  // S0.2-verified ROCm-Windows preview wheels (alpha; ROCm 6.4.4). torch 2.8 < 2.9
  // means torchcodec is not needed → amd overlay uses coqui-tts WITHOUT [codec].
  const ROCM = 'https://repo.radeon.com/rocm/windows/rocm-rel-6.4.4/';
  return {
    torchPreinstall: {
      wheels: platform === 'win32'
        ? [`${ROCM}torch-2.8.0a0+gitfc14c65-cp312-cp312-win_amd64.whl`,
           `${ROCM}torchaudio-2.6.0a0+1a8f621-cp312-cp312-win_amd64.whl`]
        : [], // Linux ROCm wheels resolved in Wave H if/when Linux AMD is validated
    },
    ortPackage: platform === 'win32' ? 'onnxruntime-directml' : 'onnxruntime',
  };
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**
```bash
git add server/tts-sidecar/scripts/accelerator-profile.mjs server/src/tts/accelerator-profile.test.ts
git commit -m "feat(sidecar): fill AMD torchPreinstall with verified ROCm wheels (AMD phase 2)"
```

### Task A3: Resolver-driven installers (torch pre-install + ORT ordering + cp312 flash-attn)

**Files:**
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs` (flash-attn cp311→cp312; skip on AMD; torch pre-install)
- Modify: `server/tts-sidecar/scripts/install-coqui.mjs`, `install-kokoro.mjs`
- Add: `server/tts-sidecar/scripts/install-torch.mjs` (new — pre-installs the ROCm torch wheels for AMD; no-op for nvidia/cpu where torch is transitive)
- Test: `server/src/tts/install-torch-helpers.test.ts`, extend `install-qwen3-helpers.test.ts`

- [ ] **Step 1: Write the failing test** for the new torch pre-install planner (pure)

```ts
import { describe, it, expect } from 'vitest';
import { planTorchPreinstall } from '../../tts-sidecar/scripts/install-torch.mjs';

describe('planTorchPreinstall', () => {
  it('nvidia/cpu → no-op (torch is transitive)', () => {
    expect(planTorchPreinstall('nvidia', 'win32').action).toBe('skip');
    expect(planTorchPreinstall('cpu', 'linux').action).toBe('skip');
  });
  it('amd+win → pip install the two ROCm wheels before engine packages', () => {
    const p = planTorchPreinstall('amd', 'win32');
    expect(p.action).toBe('install');
    expect(p.wheels.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run** `npm --prefix server run test -- install-torch` → FAIL.

- [ ] **Step 3: Implement `install-torch.mjs`** (pure planner + guarded CLI, mirroring `install-qwen3.mjs`)

```js
#!/usr/bin/env node
// install-torch.mjs — pre-install the ROCm torch wheels for the AMD profile BEFORE
// the engine packages, so coqui-tts/qwen-tts see torch already satisfied. No-op for
// nvidia/cpu (torch is pulled transitively from PyPI). Pure planner + guarded CLI.
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installRecipe } from './accelerator-profile.mjs';

export function planTorchPreinstall(profile, platform) {
  const r = installRecipe(profile, platform);
  const wheels = r.torchPreinstall && r.torchPreinstall.wheels;
  if (!wheels || wheels.length === 0) return { action: 'skip', reason: 'torch is transitive for this profile' };
  return { action: 'install', wheels };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const profile = process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? 'nvidia';
  const plan = planTorchPreinstall(profile, process.platform);
  if (plan.action === 'skip') { process.stdout.write(`[install-torch] skip — ${plan.reason}\n`); process.exit(0); }
  const py = process.argv[2]; // venv python path
  const code = spawnSync(py, ['-m', 'pip', 'install', '--no-cache-dir', ...plan.wheels], { stdio: 'inherit', windowsHide: true }).status ?? 1;
  process.exit(code);
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Update `install-qwen3.mjs` flash-attn pin (cp311→cp312) + AMD skip**

In `resolveFlashAttnInstall` and `FLASH_ATTN_WHEEL_URL`: change `cp311` → `cp312` (the verified cp312 wheel) and add a profile gate so AMD skips flash-attn entirely (no ROCm flash-attn wheel; SDPA default). Update `install-qwen3-helpers.test.ts` to assert: `pyTag: 'cp312'` installs; `profile: 'amd'` skips.

- [ ] **Step 6: Wire ORT ordering (S0.3) into `install-kokoro.mjs`**

For `profile==='amd' && platform==='win32'`, after the normal kokoro-onnx install: `pip uninstall -y onnxruntime` then `pip install onnxruntime-directml>=<min-fixed-version>` (the min version is confirmed in Wave H; until then use the latest). Gate behind `CASTWRIGHT_ACCELERATOR_PROFILE`. Add a helper test asserting the ordered command list per profile.

- [ ] **Step 7: Run the suite + commit**
```bash
npm --prefix server run test -- "install-"
git add server/tts-sidecar/scripts/install-*.mjs server/src/tts/install-*.test.ts
git commit -m "feat(sidecar): resolver-driven installers (ROCm torch pre-install, ORT ordering, cp312 flash-attn) (AMD phase 2)"
```

### Task A4: Python 3.12 acquisition (auto-install + guided fallback, H3 relaunch caveat)

**Files:**
- Add: `server/tts-sidecar/scripts/ensure-python312.mjs` (discover py3.12; attempt winget/official-installer; guided fallback)
- Test: `server/src/tts/ensure-python312-helpers.test.ts`
- Modify: the Python-discovery feeding `bootstrap-venv.mjs`

- [ ] **Step 1: Write the failing test** for the pure decision (`decidePythonAcquisition`)

```ts
import { decidePythonAcquisition } from '../../tts-sidecar/scripts/ensure-python312.mjs';

describe('decidePythonAcquisition', () => {
  it('found on PATH → use it', () => {
    expect(decidePythonAcquisition({ found: 'py -3.12', platform: 'win32', wingetAvailable: true }))
      .toEqual({ action: 'use', cmd: 'py -3.12' });
  });
  it('absent + winget (Windows) → auto-install then relaunch (H3)', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'win32', wingetAvailable: true }))
      .toEqual({ action: 'auto-install', method: 'winget', needsRelaunch: true });
  });
  it('absent + no winget (Server/LTSC) → guided fallback', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'win32', wingetAvailable: false }))
      .toEqual({ action: 'guide', method: 'official-installer' });
  });
  it('absent on Linux → guided (never silent sudo)', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'linux', wingetAvailable: false }))
      .toEqual({ action: 'guide', method: 'package-manager' });
  });
});
```

- [ ] **Step 2–4:** run-fail, implement the pure `decidePythonAcquisition` + a guarded CLI that runs `winget install Python.Python.3.12` and on success **prints the relaunch instruction and exits with a distinct code** (the running process can't see the new PATH — H3), run-pass.

- [ ] **Step 5: Commit**
```bash
git add server/tts-sidecar/scripts/ensure-python312.mjs server/src/tts/ensure-python312-helpers.test.ts
git commit -m "feat(sidecar): Python 3.12 acquisition decision + auto-install/guided fallback (AMD phase 2)"
```

---

## Wave B — Venv migration wiring + the Python 3.12 flip (the trigger)

### Task B1: Wire the three-way decision into `bootstrap-venv.mjs` (dev/source path)

**Files:**
- Modify: `server/tts-sidecar/scripts/bootstrap-venv.mjs`
- Modify/extend: `server/src/tts/bootstrap-venv-helpers.test.ts`

- [ ] **Step 1: Write the failing test** — assert `bootstrap-venv` now consults `decideVenvAction(readStamp(...), required)` and, on `'rebuild'`, removes + recreates the venv then writes the stamp; on `'noop'`, exits early. (Use injected fakes for fs/spawn as the existing test does.)

- [ ] **Step 2–4:** run-fail; implement — replace the bare `venvAlreadyBootstrapped` existence check with: compute `requiredPythonTag` (from the chosen python — now 3.12 → `cp312`), `requiredProfile` (from `resolveProfile`/env), `requiredReqHash` (`computeReqHash` over the resolved overlay + base text); call `decideVenvAction`; branch rebuild/pip-in-place/noop; write `.venv-stamp.json` on success; run-pass.

- [ ] **Step 5: Commit** `feat(sidecar): bootstrap-venv consumes three-way migration decision + stamp (AMD phase 2)`

### Task B2: Wire the resumable rebuild into `apply.ts` (self-upgrade)

**Files:**
- Modify: `server/src/upgrade/apply.ts` (insert a rebuild stage before `flip`)
- Modify: `server/src/upgrade/apply.test.ts`

- [ ] **Step 1: Write failing tests** (the `ApplySteps` are already injectable — extend the fakes):
  - `pythonTag`/`profile` mismatch → a `rebuildVenv` step runs **before** `flipPointer`; on rebuild failure, `flipPointer` is **never called** (old release stays current).
  - disk pre-flight `abort` (via `decideDiskAction`) → upgrade aborts pre-rebuild, `rmDir(venv)` never called.
  - Python-3.12 missing + auto-install needs relaunch → writes a `migration-in-progress` marker and returns a `paused` result **without** flipping.
  - `reqHash`-only change → existing in-place `pipInstall` path (unchanged).

- [ ] **Step 2–4:** run-fail; implement — add `rebuildVenv`, `writeMigrationMarker`, `readMigrationMarker`, `diskFree` to the `ApplySteps` interface + `createApplySteps`; in `applyUpgrade`, after `npm-ci`, compute the decision and run the **build-`.venv-next`-then-swap** sequence (Phase-1 ordering), smoke-check with a timeout, swap, keep `.venv-prev`; only then `flip`. Honor `decideDiskAction` abort and the resumable pause. run-pass.

- [ ] **Step 5: Commit** `feat(server): resumable venv rebuild stage in apply.ts upgrade (AMD phase 2)`

### Task B3: Resume-on-boot hook for a paused migration

**Files:**
- Modify: `scripts/restart-after-upgrade.mjs` / `launch.mjs` (or server startup) — on boot, if a `migration-in-progress` marker exists, resume the rebuild before normal startup; if Python 3.12 still absent, stay paused (old release remains current — safe, B8).
- Test: a unit test for the marker-detection + resume decision (pure where possible).

- [ ] **Steps:** TDD the pure "should-resume / still-blocked / clear-marker" decision; wire it into startup; commit `feat(server): resume paused venv migration on boot (AMD phase 2)`.

### Task B4: Flip the sidecar to Python 3.12 (the trigger)

**Files:**
- Modify: the Python-discovery in the dev path + `ensure-python312.mjs` wiring to **require** 3.12 (`cp312`).
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs` gate (already cp312 from A3).
- Modify: `.github/workflows/verify.yml`, `cross-os.yml`, `release.yml` — sidecar Python → 3.12.

- [ ] **Step 1:** update the version gate + CI matrices to Python 3.12; **Step 2:** run `npm run test:sidecar` locally on a 3.12 venv to confirm the existing pytest suite passes on 3.12; **Step 3:** commit `chore(sidecar): require Python 3.12 + bump CI matrices (AMD phase 2 trigger)`.

> This is the commit that makes every upgrade rebuild the venv. Land it only after B1–B3 are green.

---

## Wave C — Python sidecar runtime (consume the injected profile)

### Task C1: `spawn-sidecar.ts` injects the resolved profile + ORT providers

**Files:**
- Modify: `server/src/tts/spawn-sidecar.ts`
- Modify: `server/src/tts/spawn-sidecar.test.ts`

- [ ] **Step 1: Write failing test** — the spawned env includes `CASTWRIGHT_ACCELERATOR_PROFILE` (from `resolveProfile`/env) and `KOKORO_ORT_PROVIDERS` (JSON from `ortProviders`). For an unknown/no-GPU box it injects `cpu` + `["CPUExecutionProvider"]`.

- [ ] **Step 2–4:** run-fail; import the resolver (per Phase-1 Task 0's recorded mechanic), compute the values, add them to the spawn env; run-pass.

- [ ] **Step 5: Commit** `feat(server): inject accelerator profile + ORT providers into sidecar spawn (AMD phase 2)`

### Task C2: Sidecar reads the env (Kokoro providers + missing-env auto-detect, B3 default)

**Files:**
- Modify: `server/tts-sidecar/main.py` (Kokoro `_ensure_loaded`, `main.py:787`)
- Test: `server/tts-sidecar/tests/test_kokoro.py` (extend)

- [ ] **Step 1: Write failing pytest** — when `KOKORO_ORT_PROVIDERS` is set, `Kokoro(...)` is called with `providers=` that list; a stub `Kokoro` rejecting the `providers=` kwarg falls back to the no-arg constructor (`try/except TypeError`). When the env is **absent**, no `providers=` is passed (today's auto-detect behavior preserved).

- [ ] **Step 2–4:** run-fail; implement the env read + guarded `providers=` pass + fallback; run-pass via `npm run test:sidecar`.

- [ ] **Step 5: Commit** `feat(sidecar): Kokoro honors injected ORT providers with auto-detect fallback (AMD phase 2)`

### Task C3: Device-family introspection (`torch.version.hip` → rocm) for `/health`

**Files:**
- Modify: `server/tts-sidecar/main.py` (`_normalize_device_family` / `_compute_device_predictions`)
- Test: `server/tts-sidecar/tests/test_device_probe.py` (extend — `_StubTorch` gains `version.hip`/`version.cuda`)

- [ ] **Step 1–4:** TDD: a HIP build (`torch.version.hip` truthy) reports family `'rocm'` not `'cuda'`; a CUDA build reports `'cuda'`; Kokoro session providers `DmlExecutionProvider`→`'directml'`, `CUDAExecutionProvider`→`'cuda'`, `ROCMExecutionProvider`→`'rocm'`, else `'cpu'`. Implement; run-pass.
- [ ] **Step 5: Commit** `feat(sidecar): /health reports rocm/directml device families (AMD phase 2)`

### Task C4: Kokoro DirectML cached + engine-conditional self-test (N3)

**Files:**
- Modify: `server/tts-sidecar/main.py` (KokoroEngine)
- Test: `server/tts-sidecar/tests/test_kokoro.py`

- [ ] **Step 1: Write failing pytest** — when profile is amd-win and the configured engine is Kokoro: a **one-time** synth self-test runs on first DML load; a **failure falls back to CPU** and is reported in `/health`; a cached PASS result (marker) means **no** re-run on the next load; if the active engine is Qwen, **no** Kokoro DML self-test runs at all.

- [ ] **Step 2–4:** implement the cached, engine-conditional self-test (write the result to a sidecar-side marker or `.venv-stamp.json` sibling); run-pass.
- [ ] **Step 5: Commit** `feat(sidecar): cached engine-conditional Kokoro DirectML self-test with CPU fallback (AMD phase 2)`

### Task C5 + C6: HIP poison regex + profile-aware ImportError text

**Files:** `server/tts-sidecar/main.py` (`_CUDA_POISON_RE` ~`:166`; Kokoro ImportError ~`:765`), tests in `test_smoke.py`/`test_runtime_wiring.py`.

- [ ] **C5:** TDD — `_CUDA_POISON_RE` matches `HIP error` / `rocBLAS` / `hipBLAS` (so a poisoned ROCm context triggers the supervised restart). Implement (extend the regex). Commit.
- [ ] **C6:** make the Kokoro ImportError remediation text profile-aware (don't hard-code "needs an NVIDIA GPU"; mention DirectML for AMD-Windows). Commit.

---

## Wave D — `/health` enum + VRAM telemetry (A10)

### Task D1: `/health` family enum surfaced end-to-end

**Files:** `server/src/routes/sidecar-health.ts` + `.test.ts`; the `/about` device-panel label map (frontend). (The Python side is C3.)

- [ ] **Steps:** TDD the server passthrough of the new `rocm`/`directml` families and the frontend label map (`directml` → "DirectML (DX12)", `rocm` → "ROCm"). Commit `feat: surface rocm/directml device families in /health + /about (AMD phase 2)`.

### Task D2: Torch-first VRAM telemetry + unknown fail-safe

**Files:** `server/src/tts/resource-telemetry.ts`, the VRAM-reading path, the recycle/ceiling logic; `engine-vram-cost*.ts`; tests.

- [ ] **Step 1: Write failing tests** — VRAM source prefers `torch.cuda.mem_get_info` (works under ROCm/HIP, vendor-neutral); DirectML reports `vramReservedMb: null` (**unknown, never 0**); **when VRAM is unknown the committed-ceiling recycle trigger + VRAM-based eviction are DISABLED** and the host-RAM watchdog + configured budgets govern instead.
- [ ] **Step 2–4:** implement carefully (this touches the recycle/ceiling machinery — keep NVIDIA behavior identical, only add the rocm/unknown branches); run-pass incl. the existing recycle/ceiling tests staying green.
- [ ] **Step 5: Commit** `feat(server): torch-first VRAM telemetry + unknown-VRAM fail-safe for AMD (phase 2)`

---

## Wave E — Wizard / UX / messaging

### Task E1: Accelerator profile control in the setup wizard

**Files:** the fs-21 wizard component(s), `user-settings.ts` (persist `acceleratorOverride`), tests + one Playwright e2e.
- [ ] TDD a profile step: shows detected vendor in plain language + override select (Auto / NVIDIA / AMD / CPU); persists to user-settings (feeds `resolveProfile`'s `wizardChoice`). Commit.

### Task E2: Upgrade migration prompt + progress

**Files:** the upgrade UI (ties to `apply.ts` phases), tests.
- [ ] TDD the one-prompt modal + progress states (Checking Python → Installing 3.12 → Rebuilding → Verifying), the relaunch prompt path (H3), and the "books + voices safe" copy. Commit.

### Task E3: `/about` per-engine backend display

**Files:** the fs-43 /about device panel.
- [ ] Render per-engine backends (Kokoro: DirectML/CPU · Qwen: ROCm · Coqui: ROCm · Whisper: CPU) + the "experimental" note. Commit.

### Task E4: `#/advanced` `ACCELERATOR` knob (rebuild-on-change, A15)

**Files:** the config registry (`server/src/config/registry.ts`) + #/advanced UI.
- [ ] Add `ACCELERATOR` with locked-by-`.env`; mark it **rebuild-on-change** (not just restart) and surface a "not instant — rebuilds the Python environment" warning. Wire the change to the Wave-F runtime rebuild action. Commit.

### Task E5: Failure remediation (FailureCode lockstep)

**Files:** `failure-taxonomy.ts`, `failure-remediations.ts`, `openapi.yaml` (+ `openapi:types`), the Help-view titles, the key-parity test.
- [ ] Add `analyzer`/`tts` failure code `gpu-acceleration-unavailable` ("running on CPU") with remediation (driver/Adrenalin version, unsupported gfx, preview-wheel, DML-op fallback). Move ALL lockstep pieces together (taxonomy + remediations + openapi + help titles + parity test). Commit.

---

## Wave F — Runtime profile-switch flow (A7/A8)

### Task F1: Server action — rebuild venv on profile change, coordinated with jobs

**Files:** a new server route/action (`server/src/routes/accelerator-profile.ts`), reusing the migration machinery; integrate the existing `design-lock`/busy registry.
- [ ] **Step 1: Write failing tests** — a profile-change request: (a) **refuses/queues** if a generation or voice-design job is in the busy registry; (b) when idle, runs the build-new-then-swap rebuild and restarts the sidecar with the new venv; (c) surfaces progress like the upgrade flow.
- [ ] **Step 2–5:** implement + commit `feat(server): runtime accelerator-profile switch with job-coordinated venv rebuild (AMD phase 2)`

---

## Wave G — CI + docs

### Task G1: CI matrices to Python 3.12 (folded into B4) — verify green
- [ ] Confirm `verify.yml` / `cross-os.yml` / `release.yml` sidecar steps run Python 3.12 and the sidecar pytest tier is green on 3.12 across Ubuntu/macOS/Windows runners (catches any cp312 surprise). Commit any fixes.

### Task G2: Regression plan + INDEX + BACKLOG update
- [ ] Advance the `docs/features/<N>-amd-gpu-support.md` plan from Phase 1: `status: active` → fill invariants for the AMD path + the manual acceptance matrix; update `INDEX.md`; keep the `docs/BACKLOG.md` row linked. Commit `docs(sidecar): advance AMD GPU regression plan for Phase 2`.

---

## Wave H — On-AMD acceptance (🔴 OWED — gates RELEASE, not build)

> Per the spec delivery model, Waves A–G can be **built + merged to `main`** but the combined 3.12-flip + AMD release **must not publish** until this wave passes on real AMD hardware (a tester or cloud AMD instance). No code here — these are acceptance runs that confirm/correct the desk-pass assumptions and fill the last OWED values.

- [ ] **H1 (S0.1 confirm):** AMD-Windows box — pinned `onnxruntime-directml` runs `kokoro-v1.0.onnx` on DML; `session.get_providers()` shows `DmlExecutionProvider`; one chapter synthesizes. Record the **minimum working `onnxruntime-directml` version** and pin it in A3/A1. If it FAILS: flip the provisional `directml` values to `cpu` (one line each in `accelerator-profile.mjs` + their tests) and update the matrix.
- [ ] **H2 (S0.2 confirm):** install the ROCm wheels in a Python 3.12 venv; `import torch` (`cuda.is_available()` True on AMD), `coqui-tts` (no `[codec]`), `qwen-tts` import + each synthesizes one line. If Coqui/Qwen fail on torch 2.8: apply the N8 drop-priority (Coqui first) and update the matrix + `installRecipe`. Record the torch-wheel sha256 hashes into `model-hashes.json`.
- [ ] **H3 (S0.3 confirm):** confirm the exact `ortInstallSteps` recipe yields a single non-conflicting `onnxruntime` providing `DmlExecutionProvider`; pin the ordered commands in `install-kokoro.mjs`.
- [ ] **H4 (full pipeline):** on AMD-Windows, fresh install + upgrade-from-v1.7.0 (atomic rebuild, books/voices intact, ends on 3.12); `/about` shows the expected per-engine backends; generate a full short book. On AMD-Linux (if validated): Qwen/Coqui=ROCm, Kokoro=CPU.
- [ ] **H5:** dual-GPU box resolves to NVIDIA; `ACCELERATOR=cpu` override triggers a rebuild and reports CPU, refusing while a job runs.
- [ ] **Release gate:** only after H1–H5 (Windows minimum) green, cut the release that carries the 3.12 flip + AMD enablement.

---

## Self-review checklist (run before handing off)

- **Spec coverage:** Section 3 install (Wave A) ✓; Section 2 migration wiring + 3.12 flip (Wave B) ✓; Section 4 runtime (Wave C) ✓; Section 5 health+VRAM (Wave D) ✓; Section 6 UX (Wave E) ✓; A7/A8 profile-switch (Wave F) ✓; CI+docs (Wave G) ✓; owed AMD acceptance (Wave H) ✓.
- **Spike-verified values used, OWED ones flagged:** ROCm wheel URLs + drop-`[codec]` + ORT recipe come from the desk pass; the `onnxruntime-directml` min version, ROCm-wheel hashes, and import-ability are explicitly deferred to Wave H.
- **Regression fences:** A1 nvidia overlay == today; D2 keeps NVIDIA VRAM behavior identical (only adds rocm/unknown branches); C2 missing-env preserves today's auto-detect.
- **Provisional values:** the Phase-1 `directml` runtimeBackend/ortProviders are confirmed-or-flipped in H1, not silently shipped.
- **Delivery model:** Wave H gates RELEASE; A–G may merge to `main` dormant-until-released (no version bump until H green).
- **No placeholders:** integration/UI tasks reference exact files + existing patterns; the only deferred specifics are the explicitly-OWED on-AMD values in Wave H.
