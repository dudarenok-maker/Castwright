# AMD GPU Support — Phase 1: Python 3.12 + NVIDIA-latest + detect-and-reinstall

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship (in the next beta package) the Python **3.12** transition + **NVIDIA-latest torch** + the layered-requirements structure (NVIDIA/CPU only) + a **detect-and-reinstall** path for the alpha cohort. **Public beta is gated on this.** No AMD code ships here; everything is fully author-verifiable on NVIDIA/CPU/mac with no AMD hardware.

**Strategy (why no in-place migration):** public-beta-gating means only a tiny, coordinated alpha cohort ever *upgrades*; the public-beta majority installs **fresh on 3.12**. So we DROP the highest-risk code (resumable `apply.ts` rebuild, atomic swap, mid-upgrade Python auto-install) and instead **detect a Python mismatch and guide a fresh reinstall** (the v1.6.0 precedent). User data survives because the packaged `WORKSPACE_DIR` is external to the install — a **verified** acceptance gate, not an assumption.

**Architecture:** Two new plain-ESM `.mjs` modules under `server/tts-sidecar/scripts/` (resolver + venv-migration decision core), pure + vitest-tested from sibling `server/src/tts/*.test.ts` (the codebase pattern, e.g. `install-qwen3.mjs` ↔ `install-qwen3-helpers.test.ts`); plus layered `requirements/`, a Python-3.12 bootstrap/acquisition path, and a detect-and-reinstall guard.

**Tech Stack:** Node ESM (`.mjs`) + TS server (Vitest, `node` env), `node:crypto`/`node:fs`, Python 3.12 sidecar (pytest), GitHub Actions YAML. Tests under `npm run test:server` / `npm run test:sidecar`.

**Spec:** `docs/superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md` — Sections 1–3, "Cross-runtime hand-off", "Delivery sequencing (REVISED)" → Phase 1, and the Phase-1 Acceptance.

**Ships:** yes — this is the public-beta gate. AMD (`amd-rocm.txt`, ROCm torch, DirectML, profile-switch, in-place rebuild) is all **Phase 2**.

---

## File structure

| File | Responsibility |
|---|---|
| `server/tts-sidecar/scripts/accelerator-profile.mjs` (create) | Pure profile resolver (vendor parse, precedence, backend, ORT providers, install recipe). NVIDIA/CPU live; AMD branches present-but-unreached. |
| `server/src/tts/accelerator-profile.test.ts` (create) | Vitest matrix tests importing the `.mjs` directly |
| `server/tts-sidecar/scripts/venv-migration.mjs` (create) | Pure venv decision core: `computeReqHash`, `decideVenvAction`, stamp I/O. (Disk pre-flight is **deferred to Phase 2** with the in-place rebuild.) |
| `server/src/tts/venv-migration.test.ts` (create) | Vitest tests for the decision core + stamp I/O |
| `server/tts-sidecar/requirements/{base,nvidia-cuda}.txt` (create) | Layered structure; `nvidia-cuda.txt` == today (regression fence). **`requirements.txt` → `-r requirements/nvidia-cuda.txt` is the SOLE install path** (R1: no profile-based overlay selection in Phase 1; no `cpu.txt`/`amd-rocm.txt` — those + selection are Phase 2). |
| `server/tts-sidecar/scripts/bootstrap-venv.mjs` (modify) | Target Python 3.12; consult `decideVenvAction`; on mismatch → **detect-and-reinstall guidance**, never in-place rebuild. Stamps the **effective install profile (`'nvidia'`)** — Phase 1 does NOT select an overlay by hardware (R1). |
| `server/src/upgrade/apply.ts` (modify) | Upgrade-path guard (R2): classify before `pipInstall`; on `needs-reinstall` (py mismatch) abort + signal reinstall, never pip into a 3.11 venv |
| `server/tts-sidecar/scripts/ensure-python312.mjs` (create) | Discover/auto-install/guide Python 3.12 for **fresh installs** |
| `.github/workflows/*.yml` (modify) | Sidecar Python → 3.12 |
| `docs/features/<N>-amd-gpu-support.md` + INDEX + BACKLOG (create/modify) | Regression plan (`status: active`) + backlog issue |

---

## Task 0: Verify the server-runtime → `.mjs` import mechanic (B1)

**Why first:** the spec leaves one mechanic unverified — whether the *compiled server* can import a sibling `.mjs` at runtime. The answer (direct import vs dynamic `import()` vs spawn) shapes how Phase 2 wires the resolver into `apply.ts`/`spawn-sidecar.ts`. Phase 1 ships no such wiring, but we record the finding now so Phase 2 plans against fact.

**Files:**
- Read: `server/tsconfig.json`, `server/package.json`
- Modify: `docs/superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md` (append finding under the hand-off section)

- [ ] **Step 1: Determine the server module system**

Run: `cat server/tsconfig.json server/package.json`
Capture: the `compilerOptions.module` / `moduleResolution` values and whether `server/package.json` has `"type": "module"`. Note whether the server emits ESM or CJS into `server/dist`.

- [ ] **Step 2: Record the verdict in the spec**

Append a short paragraph to the "Cross-runtime hand-off" section stating one of:
- **ESM server** → server runtime imports the `.mjs` directly (`import { resolveProfile } from '../../tts-sidecar/scripts/accelerator-profile.mjs'`).
- **CJS server** → server runtime uses a dynamic `await import(...)` of the `.mjs` (CJS can `import()` ESM), OR computes the profile by spawning the `.mjs` (existing "server spawns `.mjs`" pattern).
Pick the simplest that the module mode allows. This is documentation only — no code wired in Phase 1.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md
git commit -m "docs(sidecar): record server<->.mjs import mechanic for AMD resolver (Task 0)"
```

---

## Task 1: `parseVendorFromProbe` — pure GPU-vendor parsing

**Files:**
- Create: `server/tts-sidecar/scripts/accelerator-profile.mjs`
- Create: `server/src/tts/accelerator-profile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/tts/accelerator-profile.test.ts`:

```ts
/* accelerator-profile.mjs is side-effect-guarded (runs only when invoked
   directly), so importing it here is inert. */
import { describe, it, expect } from 'vitest';
import { parseVendorFromProbe } from '../../tts-sidecar/scripts/accelerator-profile.mjs';

describe('parseVendorFromProbe', () => {
  it('detects NVIDIA from a Windows controller list', () => {
    expect(parseVendorFromProbe('win32', 'NVIDIA GeForce RTX 4070')).toBe('nvidia');
  });
  it('detects AMD from "Radeon"', () => {
    expect(parseVendorFromProbe('win32', 'AMD Radeon RX 7900 XTX')).toBe('amd');
  });
  it('NVIDIA wins when both an AMD iGPU and an NVIDIA dGPU are present (M1/N6)', () => {
    const probe = 'AMD Radeon(TM) Graphics\nNVIDIA GeForce RTX 4060 Laptop GPU';
    expect(parseVendorFromProbe('win32', probe)).toBe('nvidia');
  });
  it('detects AMD-only (APU, no NVIDIA)', () => {
    expect(parseVendorFromProbe('win32', 'AMD Radeon(TM) Graphics')).toBe('amd');
  });
  it('resolves apple on darwin regardless of probe text', () => {
    expect(parseVendorFromProbe('darwin', '')).toBe('apple');
  });
  it('detects AMD from a Linux lspci VGA line', () => {
    const lspci = '01:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31';
    expect(parseVendorFromProbe('linux', lspci)).toBe('amd');
  });
  it('falls back to cpu on empty/unrecognised probe', () => {
    expect(parseVendorFromProbe('linux', '')).toBe('cpu');
    expect(parseVendorFromProbe('win32', 'Microsoft Basic Display Adapter')).toBe('cpu');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: FAIL — `parseVendorFromProbe` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `server/tts-sidecar/scripts/accelerator-profile.mjs`:

```js
#!/usr/bin/env node
// accelerator-profile.mjs — pure resolver for the GPU accelerator profile.
// Source of truth for: vendor detection parsing, profile precedence, per-engine
// runtime backend, ONNX Runtime provider list, and install recipe. Plain Node
// ESM so both the server runtime and the install scripts can consume it; tested
// from server/src/tts/accelerator-profile.test.ts which imports it directly.
// Side-effect-guarded (see the bottom) so importing it is inert.

import { pathToFileURL } from 'node:url';

/**
 * Parse a GPU-vendor probe into a vendor tag. Pure — no I/O.
 * NVIDIA wins over AMD when both appear (the common iGPU+dGPU case): the proven
 * path is the safe default when ambiguous (M1/N6).
 * @param {string} platform  process.platform ('win32' | 'linux' | 'darwin' | …)
 * @param {string} probeText raw text from Win32_VideoController / lspci
 * @returns {'nvidia'|'amd'|'apple'|'cpu'}
 */
export function parseVendorFromProbe(platform, probeText) {
  const text = String(probeText ?? '');
  if (/nvidia/i.test(text)) return 'nvidia';
  if (/\bamd\b|radeon|\[amd\/ati\]/i.test(text)) return 'amd';
  if (platform === 'darwin') return 'apple';
  return 'cpu';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: PASS (7 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/accelerator-profile.mjs server/src/tts/accelerator-profile.test.ts
git commit -m "feat(sidecar): add parseVendorFromProbe pure GPU-vendor parser (AMD phase 1)"
```

---

## Task 2: `detectVendor` — thin I/O wrapper over the probe

**Files:**
- Modify: `server/tts-sidecar/scripts/accelerator-profile.mjs`
- Modify: `server/src/tts/accelerator-profile.test.ts`

- [ ] **Step 1: Write the failing test** (append to the test file)

```ts
import { detectVendor } from '../../tts-sidecar/scripts/accelerator-profile.mjs';

describe('detectVendor', () => {
  it('uses the injected exec output (Windows)', () => {
    const exec = () => 'NVIDIA GeForce RTX 4070';
    expect(detectVendor({ platform: 'win32', exec })).toBe('nvidia');
  });
  it('returns cpu when exec throws (probe unavailable)', () => {
    const exec = () => { throw new Error('no wmi'); };
    expect(detectVendor({ platform: 'linux', exec })).toBe('cpu');
  });
  it('returns apple on darwin without invoking exec', () => {
    let called = false;
    const exec = () => { called = true; return ''; };
    expect(detectVendor({ platform: 'darwin', exec })).toBe('apple');
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: FAIL — `detectVendor` not exported.

- [ ] **Step 3: Write minimal implementation** (append to the `.mjs`)

```js
/**
 * Detect GPU vendor by running a platform probe via the injected `exec`. The
 * `exec` indirection keeps this testable without real hardware. Any probe
 * failure degrades to 'cpu' (never throws). darwin short-circuits to 'apple'
 * without probing.
 * @param {{platform: string, exec: (cmd: string) => string}} args
 * @returns {'nvidia'|'amd'|'apple'|'cpu'}
 */
export function detectVendor({ platform, exec }) {
  if (platform === 'darwin') return 'apple';
  const cmd =
    platform === 'win32'
      ? 'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name"'
      : 'lspci';
  try {
    return parseVendorFromProbe(platform, exec(cmd));
  } catch {
    return 'cpu';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/accelerator-profile.mjs server/src/tts/accelerator-profile.test.ts
git commit -m "feat(sidecar): add detectVendor probe wrapper with cpu-on-failure (AMD phase 1)"
```

---

## Task 3: `resolveProfile` — precedence (env > wizard > detection > cpu)

**Files:**
- Modify: `server/tts-sidecar/scripts/accelerator-profile.mjs`
- Modify: `server/src/tts/accelerator-profile.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { resolveProfile } from '../../tts-sidecar/scripts/accelerator-profile.mjs';

describe('resolveProfile', () => {
  it('env override beats wizard choice and detection (N7)', () => {
    expect(resolveProfile({ envOverride: 'cpu', wizardChoice: 'amd', detected: 'nvidia' })).toBe('cpu');
  });
  it('wizard choice beats detection when no env override', () => {
    expect(resolveProfile({ envOverride: null, wizardChoice: 'amd', detected: 'nvidia' })).toBe('amd');
  });
  it('falls back to detection when neither override is set', () => {
    expect(resolveProfile({ envOverride: null, wizardChoice: null, detected: 'amd' })).toBe('amd');
  });
  it('maps unknown detection to cpu (never silently tries amd)', () => {
    expect(resolveProfile({ envOverride: null, wizardChoice: null, detected: 'unknown' })).toBe('cpu');
  });
  it('rejects an invalid override and falls through', () => {
    expect(resolveProfile({ envOverride: 'banana', wizardChoice: null, detected: 'nvidia' })).toBe('nvidia');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: FAIL — `resolveProfile` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
/** Valid machine-level profiles. */
export const PROFILES = ['nvidia', 'amd', 'apple', 'cpu'];

/**
 * Resolve the effective profile. Precedence (N7): env override → wizard choice →
 * detection → 'cpu'. An invalid value at any tier is ignored (falls through).
 * 'unknown' detection resolves to 'cpu' — never silently 'amd'.
 * @param {{envOverride: string|null, wizardChoice: string|null, detected: string}} a
 * @returns {'nvidia'|'amd'|'apple'|'cpu'}
 */
export function resolveProfile({ envOverride, wizardChoice, detected }) {
  for (const candidate of [envOverride, wizardChoice, detected]) {
    if (PROFILES.includes(candidate)) return candidate;
  }
  return 'cpu';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/accelerator-profile.mjs server/src/tts/accelerator-profile.test.ts
git commit -m "feat(sidecar): add resolveProfile precedence (env>wizard>detect>cpu) (AMD phase 1)"
```

---

## Task 4: `runtimeBackend` + `ortProviders` — the per-engine matrix

**Files:**
- Modify: `server/tts-sidecar/scripts/accelerator-profile.mjs`
- Modify: `server/src/tts/accelerator-profile.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { runtimeBackend, ortProviders } from '../../tts-sidecar/scripts/accelerator-profile.mjs';

describe('runtimeBackend', () => {
  it('nvidia torch engines → cuda', () => {
    expect(runtimeBackend('nvidia', 'qwen', 'win32')).toBe('cuda');
    expect(runtimeBackend('nvidia', 'coqui', 'linux')).toBe('cuda');
  });
  it('amd torch engines → rocm (HIP aliases cuda at runtime)', () => {
    expect(runtimeBackend('amd', 'qwen', 'win32')).toBe('rocm');
  });
  // PROVISIONAL (P2): 'directml' is the INTENDED value but is what spike S0.1 tests;
  // Phase 2 flips this to 'cpu' if DirectML can't run the Kokoro model. Dormant, so safe.
  it('amd Kokoro on Windows → directml [provisional, S0.1]; on Linux → cpu', () => {
    expect(runtimeBackend('amd', 'kokoro', 'win32')).toBe('directml');
    expect(runtimeBackend('amd', 'kokoro', 'linux')).toBe('cpu');
  });
  it('apple torch → mps, apple kokoro → cpu', () => {
    expect(runtimeBackend('apple', 'qwen', 'darwin')).toBe('mps');
    expect(runtimeBackend('apple', 'kokoro', 'darwin')).toBe('cpu');
  });
  it('cpu profile → cpu everywhere', () => {
    expect(runtimeBackend('cpu', 'qwen', 'linux')).toBe('cpu');
    expect(runtimeBackend('cpu', 'kokoro', 'win32')).toBe('cpu');
  });
});

describe('ortProviders', () => {
  it('nvidia → CUDA then CPU', () => {
    expect(ortProviders('nvidia', 'win32')).toEqual(['CUDAExecutionProvider', 'CPUExecutionProvider']);
  });
  // PROVISIONAL (P2/Q2): same S0.1 gate as runtimeBackend — if DirectML can't run the
  // Kokoro model, Phase 2 flips this to ['CPUExecutionProvider']. Dormant, so safe.
  it('amd+win → DirectML then CPU [provisional, S0.1]', () => {
    expect(ortProviders('amd', 'win32')).toEqual(['DmlExecutionProvider', 'CPUExecutionProvider']);
  });
  it('amd+linux and cpu → CPU only', () => {
    expect(ortProviders('amd', 'linux')).toEqual(['CPUExecutionProvider']);
    expect(ortProviders('cpu', 'win32')).toEqual(['CPUExecutionProvider']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
/**
 * Per-engine runtime backend. `engine` is 'qwen' | 'coqui' (torch) or 'kokoro'
 * (onnxruntime). Note rocm: at runtime HIP aliases the CUDA API, but we REPORT
 * 'rocm' for honesty; the sidecar still uses device="cuda".
 * @returns {'cuda'|'rocm'|'directml'|'cpu'|'mps'}
 */
export function runtimeBackend(profile, engine, platform) {
  const isTorch = engine === 'qwen' || engine === 'coqui';
  if (profile === 'nvidia') return 'cuda';
  if (profile === 'apple') return isTorch ? 'mps' : 'cpu';
  if (profile === 'amd') {
    if (isTorch) return 'rocm';
    // PROVISIONAL (P2): the AMD-Windows Kokoro backend is exactly what spike S0.1
    // tests. We encode the INTENDED 'directml' here, but if S0.1 finds DirectML
    // can't run the Kokoro model (the ConvTranspose issue), Phase 2 flips this — and
    // this test case — to 'cpu'. The value is dormant in Phase 1, so a later flip is
    // a one-line change + one test edit, not a behavior regression.
    return platform === 'win32' ? 'directml' : 'cpu'; // Kokoro: DML only on Windows
  }
  return 'cpu';
}

/**
 * Ordered ONNX Runtime provider list for Kokoro. The first available provider in
 * the list wins; CPU is always the final fallback.
 * @returns {string[]}
 */
export function ortProviders(profile, platform) {
  if (profile === 'nvidia') return ['CUDAExecutionProvider', 'CPUExecutionProvider'];
  // PROVISIONAL (P2/Q2): amd+win DirectML is gated by spike S0.1 — Phase 2 flips this to
  // ['CPUExecutionProvider'] if DirectML can't run the Kokoro model. Dormant in Phase 1.
  if (profile === 'amd' && platform === 'win32')
    return ['DmlExecutionProvider', 'CPUExecutionProvider'];
  return ['CPUExecutionProvider'];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/accelerator-profile.mjs server/src/tts/accelerator-profile.test.ts
git commit -m "feat(sidecar): add runtimeBackend + ortProviders matrix (AMD phase 1)"
```

---

## Task 5: `installRecipe` — wheel/package recipe (incl. NVIDIA-unchanged pin)

**Files:**
- Modify: `server/tts-sidecar/scripts/accelerator-profile.mjs`
- Modify: `server/src/tts/accelerator-profile.test.ts`

> **VERIFIED current install (P1):** torch is **not** installed via any `--index-url` today — it is pulled **transitively from PyPI** (CUDA-bundled default) by `qwen-tts` (`install-qwen3.mjs:230`) and `coqui-tts[codec]` (`requirements.txt`). `onnxruntime-gpu` arrives via `kokoro-onnx[gpu]`. So the honest NVIDIA recipe does **no explicit torch step** (`torchPreinstall: null` = the regression fence). AMD must **pre-install** a ROCm torch wheel *before* the engine packages so they see torch already satisfied — that wheel URL is the S0.2 spike placeholder. The `engine` param is dropped (P10): `ortPackage` depends only on `(profile, platform)`, `torchPreinstall` only on `profile`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { installRecipe } from '../../tts-sidecar/scripts/accelerator-profile.mjs';

describe('installRecipe', () => {
  // Verified against the ACTUAL current install (P1): no cu124 index exists today;
  // torch is transitive from PyPI; onnxruntime-gpu via kokoro-onnx[gpu].
  it('nvidia == TODAY: NO explicit torch preinstall + onnxruntime-gpu (regression fence)', () => {
    const r = installRecipe('nvidia', 'win32');
    expect(r.torchPreinstall).toBeNull(); // engine packages pull torch from PyPI, unchanged
    expect(r.ortPackage).toBe('onnxruntime-gpu');
  });
  it('amd torchPreinstall is a marked spike placeholder (S0.2); ORT directml on win, onnxruntime on linux', () => {
    expect(installRecipe('amd', 'win32').torchPreinstall).toBe('PENDING_SPIKE');
    expect(installRecipe('amd', 'win32').ortPackage).toBe('onnxruntime-directml');
    expect(installRecipe('amd', 'linux').ortPackage).toBe('onnxruntime');
  });
  it('cpu is a Phase-2 IMPROVEMENT (not today): cpu torch preinstall + plain onnxruntime', () => {
    const r = installRecipe('cpu', 'linux');
    expect(r.torchPreinstall).toEqual({ source: 'index', url: 'https://download.pytorch.org/whl/cpu' });
    expect(r.ortPackage).toBe('onnxruntime');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: FAIL — `installRecipe` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
/**
 * Install recipe per (profile, platform). Verified against the CURRENT install
 * (P1): NVIDIA pulls torch transitively from PyPI (CUDA-bundled default) via
 * qwen-tts / coqui-tts — there is NO cu124 index step today — and gets
 * onnxruntime-gpu via kokoro-onnx[gpu]. So `torchPreinstall` is null for NVIDIA
 * (the regression fence: do nothing extra). AMD must install a ROCm torch wheel
 * BEFORE the engine packages so they see torch already satisfied — that wheel URL
 * is a marked S0.2 spike placeholder, never fabricated here. The CPU recipe
 * (cpu-only torch) is a Phase-2 IMPROVEMENT over today (today CPU boxes also get
 * the PyPI torch + onnxruntime-gpu set), shipped only when the requirements
 * restructure lands.
 * @returns {{torchPreinstall: null | 'PENDING_SPIKE' | {source:string,url:string}, ortPackage: string}}
 */
export function installRecipe(profile, platform) {
  if (profile === 'nvidia') return { torchPreinstall: null, ortPackage: 'onnxruntime-gpu' };
  if (profile === 'amd') {
    return {
      torchPreinstall: 'PENDING_SPIKE',
      ortPackage: platform === 'win32' ? 'onnxruntime-directml' : 'onnxruntime',
    };
  }
  // cpu / apple — Phase-2 improvement, not today's behavior
  return {
    torchPreinstall: { source: 'index', url: 'https://download.pytorch.org/whl/cpu' },
    ortPackage: 'onnxruntime',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/accelerator-profile.mjs server/src/tts/accelerator-profile.test.ts
git commit -m "feat(sidecar): add installRecipe with NVIDIA regression fence + AMD spike stub (phase 1)"
```

---

## Task 6: Add the side-effect guard + a no-op CLI to `accelerator-profile.mjs`

**Files:**
- Modify: `server/tts-sidecar/scripts/accelerator-profile.mjs`
- Modify: `server/src/tts/accelerator-profile.test.ts`

**Why:** the codebase's `.mjs` modules are import-safe via the `import.meta.url === pathToFileURL(process.argv[1])` guard. Adding it lets a human run `node accelerator-profile.mjs` to print the resolved profile (useful for debugging) while keeping `import` inert.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { describeResolved } from '../../tts-sidecar/scripts/accelerator-profile.mjs';

describe('describeResolved', () => {
  it('summarises the resolved profile + per-engine backends', () => {
    const out = describeResolved({ envOverride: null, wizardChoice: null, detected: 'nvidia', platform: 'win32' });
    expect(out.profile).toBe('nvidia');
    expect(out.backends.qwen).toBe('cuda');
    expect(out.backends.kokoro).toBe('cuda');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: FAIL — `describeResolved` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
/** Convenience summary used by the CLI + consumers; pure. */
export function describeResolved({ envOverride, wizardChoice, detected, platform }) {
  const profile = resolveProfile({ envOverride, wizardChoice, detected });
  return {
    profile,
    backends: {
      qwen: runtimeBackend(profile, 'qwen', platform),
      coqui: runtimeBackend(profile, 'coqui', platform),
      kokoro: runtimeBackend(profile, 'kokoro', platform),
    },
    kokoroOrtProviders: ortProviders(profile, platform),
  };
}

// Side-effect guard: only runs when invoked directly (`node accelerator-profile.mjs`),
// stays inert on import so tests/consumers don't trigger I/O.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const detected = detectVendor({
    platform: process.platform,
    exec: (cmd) => execSync(cmd, { encoding: 'utf8' }),
  });
  const summary = describeResolved({
    envOverride: process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? null,
    wizardChoice: null,
    detected,
    platform: process.platform,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
```

> **No top-level `await` / no `require` (Q1):** add `import { execSync } from 'node:child_process';` to the **top** of the module alongside `import { pathToFileURL } from 'node:url';` — matching how `install-qwen3.mjs`/`bootstrap-venv.mjs` import their sync node builtins. This keeps `accelerator-profile.mjs` a plain *synchronous* ESM module (no async-module semantics for importers), and the exported functions stay synchronous and pure.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/accelerator-profile.mjs server/src/tts/accelerator-profile.test.ts
git commit -m "feat(sidecar): add describeResolved summary + import-safe CLI guard (phase 1)"
```

---

## Task 7: `computeReqHash` — multi-file requirements hash (H2/A9)

**Files:**
- Create: `server/tts-sidecar/scripts/venv-migration.mjs`
- Create: `server/src/tts/venv-migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/tts/venv-migration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeReqHash } from '../../tts-sidecar/scripts/venv-migration.mjs';

describe('computeReqHash', () => {
  it('is stable for the same concatenated file contents', () => {
    const a = computeReqHash(['-r base.txt\ntorch==2.6.0\n', 'fastapi\n']);
    const b = computeReqHash(['-r base.txt\ntorch==2.6.0\n', 'fastapi\n']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when any file content changes', () => {
    const a = computeReqHash(['torch==2.6.0\n']);
    const b = computeReqHash(['torch==2.8.0\n']);
    expect(a).not.toBe(b);
  });
  it('is order-sensitive (overlay then base is a defined order)', () => {
    expect(computeReqHash(['x\n', 'y\n'])).not.toBe(computeReqHash(['y\n', 'x\n']));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- venv-migration`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `server/tts-sidecar/scripts/venv-migration.mjs`:

```js
#!/usr/bin/env node
// venv-migration.mjs — pure decision core for the venv stamp + rebuild logic.
// Consumed (in Phase 2) by both apply.ts (self-upgrade) and bootstrap-venv.mjs
// (dev/source). Phase 1 ships these pure functions + tests only; nothing wires
// them into a live flow. Tested from server/src/tts/venv-migration.test.ts.

import { createHash } from 'node:crypto';

/**
 * Hash the *text* of the resolved requirements files (overlay then base), in the
 * given order. NOT a pip-resolved dependency tree — same fidelity as today's
 * single-file hash, just multi-file (H2/A9).
 * @param {string[]} fileContents  file texts in a defined order
 * @returns {string} hex sha256
 */
export function computeReqHash(fileContents) {
  const h = createHash('sha256');
  for (const c of fileContents) {
    h.update(String(c));
    h.update('\0'); // separator so ['ab',''] != ['a','b']
  }
  return h.digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- venv-migration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/venv-migration.mjs server/src/tts/venv-migration.test.ts
git commit -m "feat(sidecar): add computeReqHash multi-file requirements hash (phase 1)"
```

---

## Task 8: `decideVenvAction` — the three-way decision (M2 missing-stamp)

**Files:**
- Modify: `server/tts-sidecar/scripts/venv-migration.mjs`
- Modify: `server/src/tts/venv-migration.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { decideVenvAction } from '../../tts-sidecar/scripts/venv-migration.mjs';

const required = { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'aaa' };

describe('decideVenvAction', () => {
  it('no stamp (a v1.7.0 venv) → rebuild (M2)', () => {
    expect(decideVenvAction({ stamp: null, required })).toBe('rebuild');
  });
  it('pythonTag mismatch → rebuild', () => {
    expect(decideVenvAction({ stamp: { pythonTag: 'cp311', profile: 'nvidia', reqHash: 'aaa' }, required })).toBe('rebuild');
  });
  it('profile mismatch → rebuild', () => {
    expect(decideVenvAction({ stamp: { pythonTag: 'cp312', profile: 'amd', reqHash: 'aaa' }, required })).toBe('rebuild');
  });
  it('reqHash changed only → pip-in-place', () => {
    expect(decideVenvAction({ stamp: { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'bbb' }, required })).toBe('pip-in-place');
  });
  it('all match → noop', () => {
    expect(decideVenvAction({ stamp: { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'aaa' }, required })).toBe('noop');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- venv-migration`
Expected: FAIL — `decideVenvAction` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
/**
 * Three-way venv decision. A missing/null stamp is treated as a mismatch →
 * rebuild (M2: v1.7.0 venvs have no stamp). Interpreter/profile changes force a
 * rebuild (a venv is bound to its Python); a requirements-only change is an
 * in-place pip install; otherwise no-op.
 * @param {{stamp: {pythonTag:string,profile:string,reqHash:string}|null,
 *          required: {pythonTag:string,profile:string,reqHash:string}}} a
 * @returns {'rebuild'|'pip-in-place'|'noop'}
 */
export function decideVenvAction({ stamp, required }) {
  if (!stamp) return 'rebuild';
  if (stamp.pythonTag !== required.pythonTag) return 'rebuild';
  if (stamp.profile !== required.profile) return 'rebuild';
  if (stamp.reqHash !== required.reqHash) return 'pip-in-place';
  return 'noop';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- venv-migration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/venv-migration.mjs server/src/tts/venv-migration.test.ts
git commit -m "feat(sidecar): add decideVenvAction three-way migration decision (phase 1)"
```

---

## Task 9: `decideDiskAction` — 3× headroom pre-flight (A6/N1) — **DEFERRED to Phase 2**

> **SKIP in Phase 1.** This is the disk pre-flight for the **in-place rebuild**, which Phase 1
> no longer does (detect-and-reinstall instead). It moves to Phase 2 with the rebuild
> machinery (only if the AMD profile-switch needs it). Left here for traceability; do not
> implement it in this phase.

**Files (Phase 2):**
- Modify: `server/tts-sidecar/scripts/venv-migration.mjs`
- Modify: `server/src/tts/venv-migration.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { decideDiskAction } from '../../tts-sidecar/scripts/venv-migration.mjs';

describe('decideDiskAction', () => {
  const GB = 1024 ** 3;
  it('ok when free space covers the 3x transient peak', () => {
    const r = decideDiskAction({ freeBytes: 10 * GB, estVenvBytes: 2.5 * GB });
    expect(r.action).toBe('ok');
  });
  it('abort (never teardown-then-build) when space is tight (N1)', () => {
    const r = decideDiskAction({ freeBytes: 3 * GB, estVenvBytes: 2.5 * GB });
    expect(r.action).toBe('abort');
    expect(r.neededBytes).toBe(Math.ceil(3 * 2.5 * GB));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- venv-migration`
Expected: FAIL — `decideDiskAction` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
/**
 * Disk pre-flight. The transient peak is THREE venvs (.venv + .venv-next +
 * retained .venv-prev) ≈ 3× est size (A6). If free space can't cover that,
 * ABORT — never teardown-then-build (N1: a mid-download failure would leave the
 * user with no venv, violating the absolute "never destroy a working env" rule).
 * @param {{freeBytes:number, estVenvBytes:number, factor?:number}} a
 * @returns {{action:'ok'|'abort', neededBytes:number}}
 */
export function decideDiskAction({ freeBytes, estVenvBytes, factor = 3 }) {
  const neededBytes = Math.ceil(factor * estVenvBytes);
  return { action: freeBytes >= neededBytes ? 'ok' : 'abort', neededBytes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- venv-migration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/venv-migration.mjs server/src/tts/venv-migration.test.ts
git commit -m "feat(sidecar): add decideDiskAction 3x-headroom abort pre-flight (phase 1)"
```

---

## Task 10: Stamp read/write I/O + guard

**Files:**
- Modify: `server/tts-sidecar/scripts/venv-migration.mjs`
- Modify: `server/src/tts/venv-migration.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { readStamp, writeStamp, stampPath } from '../../tts-sidecar/scripts/venv-migration.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('stamp I/O', () => {
  it('round-trips a stamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'venv-stamp-'));
    try {
      writeStamp(dir, { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'h', builtVersion: '1.8.0' });
      expect(readStamp(dir)).toEqual({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'h', builtVersion: '1.8.0' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns null for a missing stamp (M2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'venv-stamp-'));
    try {
      expect(readStamp(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('returns null for a corrupt stamp rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'venv-stamp-'));
    try {
      writeFileSync(stampPath(dir), '{not json', 'utf8'); // P3: top-level import, no require in ESM
      expect(readStamp(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- venv-migration`
Expected: FAIL — stamp functions not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Path of the stamp file inside a venv dir. */
export function stampPath(venvDir) {
  return join(venvDir, '.venv-stamp.json');
}

/**
 * Read the venv stamp. Returns null on a missing OR corrupt file (M2: both mean
 * "rebuild" downstream) — never throws.
 * @returns {{pythonTag:string,profile:string,reqHash:string,builtVersion?:string}|null}
 */
export function readStamp(venvDir) {
  try {
    return JSON.parse(readFileSync(stampPath(venvDir), 'utf8'));
  } catch {
    return null;
  }
}

/** Write the venv stamp (pretty JSON). */
export function writeStamp(venvDir, stamp) {
  writeFileSync(stampPath(venvDir), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}
```

> Place these `import` lines at the **top** of `venv-migration.mjs` alongside the existing `import { createHash } from 'node:crypto'` (ESM hoists imports; keep them grouped at top for lint cleanliness) — do not leave them mid-file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- venv-migration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/venv-migration.mjs server/src/tts/venv-migration.test.ts
git commit -m "feat(sidecar): add venv stamp read/write I/O (null on missing/corrupt) (phase 1)"
```

---

## Task 11: Layered requirements structure (base + nvidia-cuda ONLY; NVIDIA == today) (R1/R3/R4)

> **R1:** Phase 1 ships ONLY `base.txt` + `nvidia-cuda.txt`, and `requirements.txt` →
> `-r requirements/nvidia-cuda.txt` is the **sole** install path. No `cpu.txt`, no
> `amd-rocm.txt`, **no profile-based overlay selection** — those are Phase 2. This keeps every
> box (NVIDIA/CPU/AMD) on the today-equivalent install + 3.12, and makes it impossible to route
> a fresh AMD-box install to a non-existent overlay. The split is structural groundwork for
> Phase 2; behaviorally it equals today.

**Files:**
- Create: `server/tts-sidecar/requirements/base.txt`, `server/tts-sidecar/requirements/nvidia-cuda.txt`
- Modify: `server/tts-sidecar/requirements.txt` → pointer shim (`-r requirements/nvidia-cuda.txt`)
- Test: `server/src/tts/requirements-layout.test.ts`

- [ ] **Step 1: Write the failing test** (R3: derive the dir from `import.meta.url`, NOT `__dirname` — the latter isn't defined in the server's ESM Vitest context)

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url)); // server/src/tts
const REQ = join(HERE, '..', '..', 'tts-sidecar', 'requirements');

describe('layered requirements (Phase 1: base + nvidia-cuda only)', () => {
  it('nvidia-cuda overlay -r base.txt', () => {
    expect(readFileSync(join(REQ, 'nvidia-cuda.txt'), 'utf8')).toMatch(/^-r base\.txt/m);
  });
  it('base.txt has vendor-neutral deps, no torch/onnxruntime', () => {
    const b = readFileSync(join(REQ, 'base.txt'), 'utf8');
    expect(b).toMatch(/fastapi/); expect(b).toMatch(/faster-whisper/);
    expect(b).not.toMatch(/onnxruntime/); expect(b).not.toMatch(/^torch/m);
  });
  it('nvidia overlay == TODAY: coqui-tts[codec] + kokoro-onnx[gpu] (regression fence)', () => {
    const n = readFileSync(join(REQ, 'nvidia-cuda.txt'), 'utf8');
    expect(n).toMatch(/coqui-tts\[codec\]/); expect(n).toMatch(/kokoro-onnx\[gpu\]/);
  });
  it('requirements.txt shim points at the nvidia-cuda overlay (sole install path)', () => {
    const shim = readFileSync(join(REQ, '..', 'requirements.txt'), 'utf8');
    expect(shim).toMatch(/^-r requirements\/nvidia-cuda\.txt/m);
  });
  it('NO cpu.txt / amd-rocm.txt in Phase 1', () => {
    expect(() => readFileSync(join(REQ, 'cpu.txt'), 'utf8')).toThrow();
    expect(() => readFileSync(join(REQ, 'amd-rocm.txt'), 'utf8')).toThrow();
  });
});
```

- [ ] **Step 2: Run** `npm --prefix server run test -- requirements-layout` → FAIL.

- [ ] **Step 3: Create the files** (R4 — exact contents inline, by moving today's `requirements.txt` lines):

`server/tts-sidecar/requirements/base.txt` (the vendor-neutral lines lifted verbatim from today's `requirements.txt`):
```
fastapi>=0.115,<0.116
uvicorn[standard]>=0.30,<0.32
numpy>=1.26,<3.0
soundfile
psutil>=5.9
faster-whisper>=1.0,<2.0
transformers>=4.45,<5.0
```

`server/tts-sidecar/requirements/nvidia-cuda.txt` (the engine lines — byte-equivalent to today):
```
-r base.txt
coqui-tts[codec]>=0.24.0
kokoro-onnx[gpu]>=0.4.0,<0.5.0
```

Replace the body of `server/tts-sidecar/requirements.txt` with the pointer shim (keep the file's leading explanatory comments if helpful):
```
# Layered requirements. Phase 1 ships base + nvidia-cuda only; this shim is the sole
# install path and preserves today's NVIDIA set. cpu/amd overlays + profile selection = Phase 2.
-r requirements/nvidia-cuda.txt
```

> Cross-check the exact version pins against the current `requirements.txt` before deleting lines from it — `base.txt` + `nvidia-cuda.txt` together must reproduce today's installed set exactly (the regression fence). Note today's `transformers<5` pin + the `[codec]`/torchcodec comment move with the relevant lines.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(sidecar): layered requirements base+nvidia-cuda (sole path == today) (phase 1)`.

---

## Task 12: `ensure-python312.mjs` — discover / auto-install / guide Python 3.12 (fresh install)

**Files:** Create `server/tts-sidecar/scripts/ensure-python312.mjs`; Test `server/src/tts/ensure-python312-helpers.test.ts`.

- [ ] **Step 1: Write the failing test** for the pure decision:

```ts
import { describe, it, expect } from 'vitest';
import { decidePythonAcquisition } from '../../tts-sidecar/scripts/ensure-python312.mjs';

describe('decidePythonAcquisition', () => {
  it('found on PATH → use it', () => {
    expect(decidePythonAcquisition({ found: 'py -3.12', platform: 'win32', wingetAvailable: true }))
      .toEqual({ action: 'use', cmd: 'py -3.12' });
  });
  it('absent + winget (Windows) → auto-install', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'win32', wingetAvailable: true }))
      .toEqual({ action: 'auto-install', method: 'winget' });
  });
  it('absent + no winget → guided fallback', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'win32', wingetAvailable: false }))
      .toEqual({ action: 'guide', method: 'official-installer' });
  });
  it('absent on Linux → guided (never silent sudo)', () => {
    expect(decidePythonAcquisition({ found: null, platform: 'linux', wingetAvailable: false }))
      .toEqual({ action: 'guide', method: 'package-manager' });
  });
});
```

- [ ] **Step 2–4:** run-fail; implement the pure `decidePythonAcquisition` + a guarded CLI (top sync imports, no top-level await — Q1 house-style) that runs `winget install Python.Python.3.12` and, after install, **prints the relaunch instruction** (the new interpreter isn't on the running PATH — H3); run-pass.
- [ ] **Step 5: Commit** `feat(sidecar): Python 3.12 acquisition decision + fresh-install auto-install/guide (phase 1)`.

---

## Task 13: `bootstrap-venv.mjs` — target 3.12 + detect-and-reinstall (NO in-place rebuild)

**Files:** Modify `server/tts-sidecar/scripts/bootstrap-venv.mjs`; extend `server/src/tts/bootstrap-venv-helpers.test.ts`. Add a pure helper `classifyVenvState` exported from `bootstrap-venv.mjs`.

- [ ] **Step 1: Write the failing test** (pure classifier — composes `readStamp`/`decideVenvAction` into the Phase-1 actions):

```ts
import { classifyVenvState } from '../../tts-sidecar/scripts/bootstrap-venv.mjs';

const required = { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'h' };
describe('classifyVenvState (Phase 1: detect-and-reinstall, no rebuild)', () => {
  it('no venv → fresh-bootstrap', () => {
    expect(classifyVenvState({ venvExists: false, stamp: null, required }).action).toBe('fresh-bootstrap');
  });
  it('venv on cp311 (or no stamp) → needs-reinstall (NOT rebuild)', () => {
    expect(classifyVenvState({ venvExists: true, stamp: { pythonTag: 'cp311', profile: 'nvidia', reqHash: 'h' }, required }).action).toBe('needs-reinstall');
    expect(classifyVenvState({ venvExists: true, stamp: null, required }).action).toBe('needs-reinstall');
  });
  it('cp312 + reqHash changed → pip-in-place', () => {
    expect(classifyVenvState({ venvExists: true, stamp: { pythonTag: 'cp312', profile: 'nvidia', reqHash: 'old' }, required }).action).toBe('pip-in-place');
  });
  it('all match → noop', () => {
    expect(classifyVenvState({ venvExists: true, stamp: { ...required }, required }).action).toBe('noop');
  });
});
```

- [ ] **Step 2–4:** run-fail; implement `classifyVenvState` (maps `decideVenvAction`'s `rebuild` → **`needs-reinstall`** in Phase 1, never an in-place teardown). Wire `main()`:
  - **fresh-bootstrap** builds a **3.12** venv (python from `ensure-python312`), `pip install -r requirements.txt` (the nvidia-cuda shim — the SOLE path, R1), then writes `.venv-stamp.json` with `{ pythonTag: 'cp312', profile: 'nvidia', reqHash: computeReqHash([<nvidia-cuda.txt text>, <base.txt text>]), builtVersion }`. **`profile` is the EFFECTIVE install ('nvidia'), not the detected vendor** — Phase 1 does not select an overlay by hardware, so the stamp records what was actually built (keeps `decideVenvAction` predictable; detection lands unit-tested but unconsumed by the install path until Phase 2).
  - **needs-reinstall** → print the reinstall guidance + exit non-zero, **without touching the venv**.
  - **pip-in-place** / **noop** → as today.
  run-pass.
- [ ] **Step 5: Commit** `feat(sidecar): bootstrap targets 3.12 + detect-and-reinstall on python mismatch (phase 1)`.

---

## Task 13B: `apply.ts` upgrade-path detect-and-reinstall guard (R2)

**Why:** the self-upgrade (`apply.ts`) currently `pipInstall`s into the existing shared venv when the reqHash changed (`apply.ts:77`). On the 3.12 release, an alpha box on a 3.11 venv would have it **pip 3.12 deps into the 3.11 interpreter → failure**. This guard is the upgrade-path half of detect-and-reinstall — it must exist and be tested, not just noted.

**Files:** Modify `server/src/upgrade/apply.ts` (+ `createApplySteps`); Modify `server/src/upgrade/apply.test.ts`.

- [ ] **Step 1: Write the failing test** (the `ApplySteps` are injectable — extend the fakes):

```ts
it('aborts with needs-reinstall when the shared venv pythonTag != required (3.11 -> 3.12)', async () => {
  const steps = makeFakeSteps({
    readStamp: () => ({ pythonTag: 'cp311', profile: 'nvidia', reqHash: 'x' }),
    requiredPythonTag: 'cp312',
  });
  const res = await applyUpgrade(ctx, steps);
  expect(res.ok).toBe(false);
  expect(res.phase).toBe('needs-reinstall');
  expect(steps.pipInstall).not.toHaveBeenCalled();   // never pip into a 3.11 venv
  expect(steps.flipPointer).not.toHaveBeenCalled();  // old release stays current
});
it('still pip-installs in place when pythonTag matches and reqHash changed', async () => {
  const steps = makeFakeSteps({
    readStamp: () => ({ pythonTag: 'cp312', profile: 'nvidia', reqHash: 'old' }),
    requiredPythonTag: 'cp312',
  });
  await applyUpgrade(ctx, steps);
  expect(steps.pipInstall).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run** `npm --prefix server run test -- upgrade/apply` → FAIL.

- [ ] **Step 3: Implement** — add a `'needs-reinstall'` value to `ApplyPhase`; in `applyUpgrade`, after `npm-ci` and before `pip-install`, read the shared-venv stamp (via a new injected `readStamp` step) and run `classifyVenvState` (imported from `bootstrap-venv.mjs` per the Task-0 mechanic). On `needs-reinstall`: return `{ ok: false, phase: 'needs-reinstall', … }` **without** `pipInstall` or `flipPointer` (the old release stays current); the caller surfaces the reinstall message (Section 6 UX). Other classifications proceed as today.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(server): apply.ts refuses 3.11->3.12 self-upgrade, signals reinstall (phase 1)`.

---

## Task 14: CI sidecar Python → 3.12

**Files:** `.github/workflows/verify.yml`, `cross-os.yml`, `release.yml` (sidecar setup steps).

- [ ] **Step 1:** set the sidecar Python to 3.12 in each workflow's sidecar setup. **Step 2:** run `npm run test:sidecar` locally on a 3.12 venv to confirm the existing pytest suite is green on 3.12. **Step 3: Commit** `chore(sidecar): CI sidecar Python → 3.12 (phase 1)`.

---

## Task 15: Full-suite green + lint

- [ ] **Step 1:** `npm run test:server` → PASS (incl. all new test files). **Step 2:** `npm run lint && npm run typecheck` → PASS (fix any ESM nits). **Step 3:** commit any fixes.

---

## Task 16: Regression plan + backlog issue (CLAUDE.md convention) — **status: active**

**Files:** Create `docs/features/<next-N>-amd-gpu-support.md` (from TEMPLATE); modify `INDEX.md`, `docs/BACKLOG.md`.

- [ ] **Step 1:** next number via `ls docs/features/ | grep -oE '^[0-9]+' | sort -n | tail -1`.
- [ ] **Step 2:** create the plan, frontmatter **`status: active`** (Phase 1 SHIPS — not scaffolded); link the spec + both plans; document the invariants (resolver matrix incl. NVIDIA fence + dual-GPU priority; three-way decision; **detect-and-reinstall + the external-`WORKSPACE_DIR` data gate**); add the Phase-1 acceptance (Task 17) + the owed Phase-2 AMD matrix.
- [ ] **Step 3:** INDEX entry. **Step 4:** **No GitHub during a release freeze** — if `gh` is unavailable or the user is mid-release, write the exact issue title/body as a `TODO(issue)` block in the plan header + add the `docs/BACKLOG.md` row; a human files it later. Suggested labels `area:server`/`moscow:could`/`type:feature`.
- [ ] **Step 5: Commit** `docs(sidecar): regression plan + backlog row for AMD GPU support (phase 1, active)`.

---

## Task 17: Phase-1 acceptance — the public-beta SHIP GATE (author, no AMD)

**Files:** none (manual acceptance; record results in the regression plan).

> Green unit tests are necessary but NOT sufficient — these are real runs on the author's hardware. This is the gate to ship the public-beta-enabling package.

- [ ] **A. Fresh install on 3.12 — NVIDIA:** clean install builds a 3.12 venv, pulls latest PyPI torch, and synthesises a chapter (Kokoro + a Qwen design). `/health` reports `cuda`.
- [ ] **B. Fresh install on 3.12 — CPU-only box:** installs, synthesises (Kokoro CPU). `/health` reports `cpu`.
- [ ] **C. Fresh install on 3.12 — macOS/Apple-Silicon:** installs, synthesises (Qwen on `mps`, Kokoro CPU). mps path unchanged.
- [ ] **D. Alpha detect-and-reinstall:** point the app at a v1.7.0 (3.11) install → it classifies `needs-reinstall`, shows the guidance, and does **not** pip into the 3.11 venv. Then do a fresh reinstall and **confirm books + `cast.json` + designed voices are all preserved** (the external-`WORKSPACE_DIR` gate). **If any user content is lost, STOP — the packaged `WORKSPACE_DIR` is not external and the strategy must be revisited.**
- [ ] **E. Python-3.12-absent fresh box:** `ensure-python312` auto-installs (or guides + relaunch) and the bootstrap then succeeds on 3.12.
- [ ] **F. Dual-GPU box (AMD iGPU + NVIDIA dGPU):** resolves to `nvidia` (CPU/NVIDIA only — no AMD path shipped).

---

## Self-review checklist (run before handing off)

- **Spec coverage (Phase 1):** Section 1 resolver (Tasks 1–6) ✓; Section 2 stamp + three-way decision + detect-and-reinstall (Tasks 7–8, 10, 13) + the upgrade-path guard (Task 13B, R2) ✓; Section 3 layered structure **base+nvidia-cuda only, sole shim path** (Task 11, R1) + Python 3.12 acquisition (Task 12) ✓; cross-runtime mechanic (Task 0) ✓; CI 3.12 (Task 14) ✓; docs (Task 16) ✓; acceptance gate (Task 17) ✓.
- **R1 — no profile-based overlay selection in Phase 1:** every box installs the `nvidia-cuda` shim (== today + 3.12); `cpu.txt`/`amd-rocm.txt` + selection are Phase 2. A fresh AMD-box install therefore CANNOT route to a missing overlay; the stamp records the **effective** profile (`'nvidia'`), not the detected vendor.
- **Correctly deferred to Phase 2:** `decideDiskAction` (Task 9, skipped), the in-place rebuild / resumable `apply.ts` / atomic swap, `cpu.txt`/`amd-rocm.txt` + overlay selection, ROCm torch, DirectML, `/health` enum live, VRAM change, AMD messaging, profile-switch. Absent by design.
- **No in-place migration:** `classifyVenvState` maps a Python/profile mismatch to **`needs-reinstall`** (both in `bootstrap-venv.mjs` AND `apply.ts`, Task 13B), never a teardown — the H4 risk is gone, and the data gate (Task 17.D) is a hard STOP.
- **Provisional AMD values flagged:** AMD-Kokoro `runtimeBackend`/`ortProviders` = DirectML marked S0.1-pending; AMD `torchPreinstall` = `PENDING_SPIKE`. These ship **unreached** (no `amd-rocm.txt`, no AMD detection path active on shipped HW).
- **P1 fence honesty:** NVIDIA recipe == verified today (no cu124 index; transitive PyPI torch; `nvidia-cuda.txt` byte-equivalent).
- **House-style:** all `.mjs` CLI guards use top-of-module sync imports, no top-level await / no `require` (Q1).
- **Ship gate is real runs, not green CI:** Task 17 A–F on author hardware, with the data-preservation STOP.
