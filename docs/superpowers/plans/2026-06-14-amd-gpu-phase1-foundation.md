# AMD GPU Support — Phase 1 (Pure Dormant Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the pure, fully-tested decision logic for AMD GPU support — the accelerator-profile resolver and the venv-migration core — as dormant code on `main`, consumed by no shipped path and changing zero user-visible behavior.

**Architecture:** Two new plain-ESM `.mjs` modules under `server/tts-sidecar/scripts/`, each a set of side-effect-guarded pure functions, vitest-tested from sibling `server/src/tts/*.test.ts` files that import the `.mjs` directly (the codebase's established pattern, e.g. `install-qwen3.mjs` ↔ `install-qwen3-helpers.test.ts`). Nothing in a shipped code path imports these yet; Python stays 3.11, CI stays 3.11, install + telemetry + `/health` are untouched.

**Tech Stack:** Node ESM (`.mjs`), Vitest (server project, `node` env), `node:crypto`, `node:fs`. Tests run under `npm run test:server`.

**Spec:** `docs/superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md` (Sections 1, 2; "Cross-runtime hand-off"; "Delivery sequencing" → Phase 1).

**Delivery model:** This branch is **merged to `main` but exposed by no release** until Phase 2. Do not bump any version, do not change `requirements.txt`, do not flip Python, do not touch `apply.ts` runtime flow.

---

## File structure

| File | Responsibility |
|---|---|
| `server/tts-sidecar/scripts/accelerator-profile.mjs` (create) | Pure profile resolver: vendor parsing, profile precedence, per-engine runtime backend, ORT provider list, install recipe |
| `server/src/tts/accelerator-profile.test.ts` (create) | Vitest matrix tests importing the `.mjs` directly |
| `server/tts-sidecar/scripts/venv-migration.mjs` (create) | Pure venv-migration core: reqHash, three-way decision, disk-headroom decision; thin stamp read/write I/O |
| `server/src/tts/venv-migration.test.ts` (create) | Vitest tests for the migration core + stamp I/O (tmp dirs) |
| `docs/superpowers/specs/2026-06-14-amd-gpu-sidecar-support-design.md` (modify) | Append the Task 0 server↔.mjs import-mechanic finding |

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
  it('amd Kokoro on Windows → directml; on Linux → cpu', () => {
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
  it('amd+win → DirectML then CPU', () => {
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
  if (profile === 'nvidia') return isTorch ? 'cuda' : 'cuda';
  if (profile === 'apple') return isTorch ? 'mps' : 'cpu';
  if (profile === 'amd') {
    if (isTorch) return 'rocm';
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

> Note: the AMD `torchSpec` exact wheel URL + version is a **spike output (S0.2)** — Phase 1 returns a clearly-marked `'PENDING_SPIKE'` placeholder for AMD so the shape is testable now without fabricating a URL. NVIDIA/CPU are real and pinned.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { installRecipe } from '../../tts-sidecar/scripts/accelerator-profile.mjs';

describe('installRecipe', () => {
  it('nvidia matches TODAY: cu124 torch index + onnxruntime-gpu (regression fence)', () => {
    const r = installRecipe('nvidia', 'kokoro', 'win32');
    expect(r.torchSpec).toEqual({ version: '2.6.0', source: 'index', url: 'https://download.pytorch.org/whl/cu124' });
    expect(r.ortPackage).toBe('onnxruntime-gpu');
  });
  it('cpu uses the cpu torch index + plain onnxruntime', () => {
    const r = installRecipe('cpu', 'kokoro', 'linux');
    expect(r.torchSpec.url).toBe('https://download.pytorch.org/whl/cpu');
    expect(r.ortPackage).toBe('onnxruntime');
  });
  it('amd torchSpec is a marked spike placeholder (S0.2), ORT is directml on win', () => {
    const r = installRecipe('amd', 'kokoro', 'win32');
    expect(r.torchSpec.source).toBe('PENDING_SPIKE');
    expect(r.ortPackage).toBe('onnxruntime-directml');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- accelerator-profile`
Expected: FAIL — `installRecipe` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```js
/**
 * Install recipe per profile. NVIDIA/CPU are real + pinned (NVIDIA == today, the
 * regression fence). AMD's torchSpec is a marked placeholder until the S0.2 spike
 * pins the repo.radeon.com wheel URL + version — never fabricate it here.
 * @returns {{torchSpec: object, ortPackage: string}}
 */
export function installRecipe(profile, engine, platform) {
  if (profile === 'nvidia') {
    return {
      torchSpec: { version: '2.6.0', source: 'index', url: 'https://download.pytorch.org/whl/cu124' },
      ortPackage: 'onnxruntime-gpu',
    };
  }
  if (profile === 'amd') {
    return {
      torchSpec: { version: 'PENDING_SPIKE', source: 'PENDING_SPIKE', url: 'PENDING_SPIKE' },
      ortPackage: platform === 'win32' ? 'onnxruntime-directml' : 'onnxruntime',
    };
  }
  // cpu / apple
  return {
    torchSpec: { version: '2.6.0', source: 'index', url: 'https://download.pytorch.org/whl/cpu' },
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
    exec: (cmd) => {
      // Lazy import to keep the module import-pure.
      // eslint-disable-next-line no-undef
      return require('node:child_process').execSync(cmd, { encoding: 'utf8' });
    },
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

> If ESLint flags `require` in ESM, replace the CLI's `exec` with `import('node:child_process')` (async) — the guarded block can be `async`. Keep the exported functions synchronous and pure.

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

## Task 9: `decideDiskAction` — 3× headroom pre-flight (A6/N1)

**Files:**
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
import { mkdtempSync, rmSync } from 'node:fs';
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
      require('node:fs').writeFileSync(stampPath(dir), '{not json', 'utf8');
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

> Move the `import` lines to the top of the file with the other imports (ESM requires top-level imports). If ESLint rejects the test's `require`, swap it for a top `import { writeFileSync } from 'node:fs'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- venv-migration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/venv-migration.mjs server/src/tts/venv-migration.test.ts
git commit -m "feat(sidecar): add venv stamp read/write I/O (null on missing/corrupt) (phase 1)"
```

---

## Task 11: Full-suite green + lint + final review

**Files:** none (verification)

- [ ] **Step 1: Run the server suite**

Run: `npm run test:server`
Expected: PASS, including the two new test files.

- [ ] **Step 2: Run lint + typecheck** (the new `.mjs` + `.test.ts` must pass the gate)

Run: `npm run lint && npm run typecheck`
Expected: PASS. Fix any ESLint ESM nits (the `require` → `import` swaps noted in Tasks 6/10).

- [ ] **Step 3: Confirm dormancy — nothing shipped imports the new modules**

Run: `npm run typecheck` is green AND grep shows the new modules are referenced only by their tests + their own CLI guard:
`grep -rn "accelerator-profile.mjs\|venv-migration.mjs" server/src server/tts-sidecar --include=*.ts --include=*.mjs | grep -v ".test.ts"`
Expected: only the `.mjs` self-references / CLI. No production import. (This is the dormancy guarantee.)

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A && git commit -m "chore(sidecar): lint/typecheck fixes for AMD phase-1 modules"
```

---

## Self-review checklist (run before handing off)

- **Spec coverage:** Section 1 resolver (Tasks 1–6) ✓; Section 2 migration core — stamp/three-way/disk (Tasks 7–10) ✓; cross-runtime hand-off mechanic recorded (Task 0) ✓. Deferred-to-Phase-2 items (requirements restructure, Python flip, apply.ts wiring, /health enum, VRAM, AMD wheels, DirectML, messaging) are intentionally absent — correct for a dormant Phase 1.
- **Placeholder scan:** the only `PENDING_SPIKE` is a deliberate, tested AMD `torchSpec` stub (S0.2 fills it in Phase 2) — not a plan placeholder.
- **Type/name consistency:** `parseVendorFromProbe`, `detectVendor`, `resolveProfile`, `runtimeBackend`, `ortProviders`, `installRecipe`, `describeResolved`, `computeReqHash`, `decideVenvAction`, `decideDiskAction`, `readStamp`/`writeStamp`/`stampPath` — used consistently across tasks and tests.
- **Dormancy:** Task 11 Step 3 mechanically proves no shipped path consumes the new code.
