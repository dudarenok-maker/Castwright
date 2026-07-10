# FA2 Conditional Detect + Opt-In Linux Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `install-qwen3.mjs`'s opt-in FlashAttention-2 (FA2) installer detect an already-importable `flash_attn` on any platform/accelerator profile (report only, never reinstall), and attempt an unpinned, `nvcc`-gated `pip install flash-attn` on Linux — without touching the existing Windows pinned-wheel path or the runtime attention-impl default.

**Architecture:** Extend the existing pure decision function `resolveFlashAttnInstall()` with two new boolean inputs (`alreadyImportable`, `nvccAvailable`) and one new platform branch (`linux`); add two new thin I/O probes (`flashAttnImportable`, `hasNvcc`); replace `installFlashAttn()`'s implicit if/fallthrough body with an explicit `switch (plan.action)` dispatching to three focused helper functions (`installFlashAttnPip`, `installFlashAttnWheel`, `reportFlashAttnImportResult`) so the win32 wheel flow, the new Linux pip flow, and the shared post-install check each live in their own function with no shared fallthrough.

**Tech Stack:** Node ESM (`node:child_process`, `node:test`), no new dependencies.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-07-10-fa2-conditional-detect-design.md` — read it in full before starting; this plan implements it verbatim, and it carries the "why" behind decisions this plan states only briefly.
- Windows pinned-wheel path (`resolveFlashAttnInstall`'s `win32` branch, `FLASH_ATTN_WHEEL_URL`, the SHA-pin verify/download/install flow) is **unchanged in behavior** — only its surrounding control-flow shape changes (moves into its own function, reached via explicit dispatch instead of implicit fallthrough).
- `main.py`'s runtime attention-impl selection (`QWEN_ATTN_IMPL` env var, defaults to `"sdpa"`) is **not touched at all** — no task in this plan modifies `main.py`.
- The installer **never sets `QWEN_ATTN_IMPL` itself**, on any platform, in any new code path — activation stays a manual, printed-instruction-only, operator choice, exactly like the existing Windows path.
- No new CLI flag or env var — everything is gated by the existing `--flash-attn` / `QWEN_INSTALL_FLASH_ATTN=1` opt-in.
- All new pip calls that install packages into the venv use `-c <base.txt>` (torch-safety constraint), matching the existing `qwenPipInstallArgs()` convention — no `-U`.
- `installFlashAttn()`'s dispatch on `plan.action` MUST be structured so each action has its own dedicated function/branch with an explicit return — no case may fall through into another's logic. This is the single most load-bearing structural requirement in this plan (see spec Design section — three review rounds each caught a variant of a fallthrough bug here).
- **Every "Replace lines X-Y" header in this plan cites line numbers in the file's state BEFORE Task 1's edit lands.** Task 1's replacement is longer than the code it replaces, so every line number below Task 1's edit point (all of Task 2's `installFlashAttn` region) shifts down once Task 1 is applied. Do not count lines to find the edit target — each step's "old code" block is the literal, current, unique text to match and replace (e.g. via the Edit tool's exact-string replacement), regardless of what line number it's actually sitting at by the time you get there. Task 2 Steps 1-2 (the module header and wheel-URL doc comments) sit above Task 1's edit and are unaffected by this.

---

## Task 1: Extend `resolveFlashAttnInstall()` + add `flashAttnBuildEnv()` (pure functions, TDD)

**Files:**
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs:96-117` (the `resolveFlashAttnInstall` function and its doc comment)
- Modify: `scripts/tests/install-qwen3-flash-attn.test.mjs` (full rewrite — see below)

**Interfaces:**
- Consumes: nothing new — this task only touches pure, already-exported functions.
- Produces:
  - `resolveFlashAttnInstall({ enabled, platform, pyTag, profile, alreadyImportable, nvccAvailable })` → `{ action: 'skip' | 'already-installed' | 'install' | 'install-pip', reason?, url?, package? }` — Task 2's `installFlashAttn()` dispatches on `.action`.
  - `flashAttnBuildEnv(processEnv, baseEnv)` → a new plain object (never mutates `baseEnv`), `{ ...baseEnv, MAX_JOBS: processEnv.MAX_JOBS ?? '4' }` — Task 2's `installFlashAttnPip()` calls this to build the env for the flash-attn pip install specifically.

- [ ] **Step 1: Write the failing/updated test file**

Replace the full contents of `scripts/tests/install-qwen3-flash-attn.test.mjs` with:

```javascript
// Tests for the opt-in FlashAttention-2 install gate in install-qwen3.mjs.
// Run via `npm run test:hooks` (node --test, no extra deps).
//
// The wheel/pip install itself can't be exercised here (needs a real venv,
// and on Linux a real CUDA Toolkit) — the testable seam is the pure
// platform/version/already-installed decision, plus the env-merge helper.
// Importing the installer module also asserts (implicitly) that it stays
// inert on import: if its main() ran here it would findVenvPython() ->
// process.exit(1) and kill this test process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFlashAttnInstall,
  flashAttnBuildEnv,
  FLASH_ATTN_WHEEL_URL,
} from '../../server/tts-sidecar/scripts/install-qwen3.mjs';

test('win32 + cp311 + enabled → installs the pinned wheel', () => {
  const r = resolveFlashAttnInstall({ enabled: true, platform: 'win32', pyTag: 'cp311' });
  assert.equal(r.action, 'install');
  assert.equal(r.url, FLASH_ATTN_WHEEL_URL);
});

test('pinned wheel targets exactly cp311 / torch2.6 / cu124 / win_amd64', () => {
  // Guards against an accidental URL edit drifting off our installed stack.
  assert.match(FLASH_ATTN_WHEEL_URL, /cu124torch2\.6\.0/);
  assert.match(FLASH_ATTN_WHEEL_URL, /cp311-cp311-win_amd64\.whl$/);
});

test('darwin → skip (no known FA2 path), never installs', () => {
  const r = resolveFlashAttnInstall({ enabled: true, platform: 'darwin', pyTag: 'cp311' });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /no pinned wheel/);
  assert.equal(r.url, undefined);
});

test('linux + nvcc available + not already importable → attempts pip install', () => {
  const r = resolveFlashAttnInstall({
    enabled: true,
    platform: 'linux',
    pyTag: 'cp311',
    nvccAvailable: true,
  });
  assert.equal(r.action, 'install-pip');
  assert.equal(r.package, 'flash-attn');
});

test('linux + no nvcc → skip with a CUDA-Toolkit-required reason, never installs', () => {
  const r = resolveFlashAttnInstall({
    enabled: true,
    platform: 'linux',
    pyTag: 'cp311',
    nvccAvailable: false,
  });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /nvcc/);
});

test('already importable → reports and defers to manual activation, on any platform/profile', () => {
  const cases = [
    { platform: 'win32', pyTag: 'cp311' },
    { platform: 'linux', pyTag: 'cp311' },
    { platform: 'darwin', pyTag: 'cp311' },
    { platform: 'linux', pyTag: 'cp311', profile: 'amd' },
  ];
  for (const opts of cases) {
    const r = resolveFlashAttnInstall({ enabled: true, alreadyImportable: true, ...opts });
    assert.equal(r.action, 'already-installed');
    assert.match(r.reason, /QWEN_ATTN_IMPL=flash_attention_2/);
    assert.equal(r.url, undefined);
    assert.equal(r.package, undefined);
  }
});

test('amd profile + not already importable → skip (no ROCm wheel)', () => {
  const r = resolveFlashAttnInstall({
    enabled: true,
    platform: 'linux',
    pyTag: 'cp311',
    profile: 'amd',
    alreadyImportable: false,
  });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /ROCm/);
});

test('wrong Python minor → skip with a cp311-only reason', () => {
  const r = resolveFlashAttnInstall({ enabled: true, platform: 'win32', pyTag: 'cp312' });
  assert.equal(r.action, 'skip');
  assert.match(r.reason, /cp311-only/);
  assert.match(r.reason, /cp312/);
});

test('not opted in → silent skip, no install', () => {
  const r = resolveFlashAttnInstall({ enabled: false, platform: 'win32', pyTag: 'cp311' });
  assert.equal(r.action, 'skip');
  assert.equal(r.reason, 'not requested');
});

test('flashAttnBuildEnv defaults MAX_JOBS to 4 when the operator has not set one', () => {
  const result = flashAttnBuildEnv({}, { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' });
  assert.equal(result.MAX_JOBS, '4');
  assert.equal(result.HF_HUB_DISABLE_SYMLINKS_WARNING, '1');
});

test('flashAttnBuildEnv honors an operator-set MAX_JOBS instead of overwriting it', () => {
  const result = flashAttnBuildEnv({ MAX_JOBS: '16' }, {});
  assert.equal(result.MAX_JOBS, '16');
});

test('flashAttnBuildEnv does not mutate the shared baseEnv object', () => {
  const baseEnv = { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' };
  flashAttnBuildEnv({}, baseEnv);
  assert.deepEqual(baseEnv, { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:hooks`
Expected: FAIL — `flashAttnBuildEnv` is not an exported member of `install-qwen3.mjs` yet (import error), and/or the `linux`/`already-installed`/`amd`-profile assertions fail against the current `resolveFlashAttnInstall` behavior (today `linux` always returns the generic `no pinned wheel` skip, there is no `already-installed` action, and `alreadyImportable`/`nvccAvailable` inputs are silently ignored).

- [ ] **Step 3: Implement the extended decision table + the new pure helper**

In `server/tts-sidecar/scripts/install-qwen3.mjs`, replace the doc comment + function currently at lines 96-117:

```javascript
// Pure decision fn (no I/O) so the platform/version gate is unit-testable without
// a venv. enabled=false short-circuits to a silent skip; the caller only invokes
// this once --flash-attn / QWEN_INSTALL_FLASH_ATTN has opted in. FA2 is an
// NVIDIA-only accelerator (the pinned wheel is a CUDA build); the AMD skip is
// checked first so an AMD box never tries to install it. SDPA is the default
// attention impl wherever FA2 isn't installed.
export function resolveFlashAttnInstall({ enabled, platform, pyTag, profile }) {
  if (!enabled) return { action: 'skip', reason: 'not requested' };
  if (profile === 'amd')
    return {
      action: 'skip',
      reason: 'no ROCm FlashAttention-2 wheel; SDPA remains the default on AMD',
    };
  if (platform !== 'win32')
    return {
      action: 'skip',
      reason: `no pinned wheel for ${platform}; SDPA remains the default`,
    };
  if (pyTag !== 'cp311')
    return { action: 'skip', reason: `pinned wheel is cp311-only; venv is ${pyTag}` };
  return { action: 'install', url: FLASH_ATTN_WHEEL_URL };
}
```

with:

```javascript
// Pure decision fn (no I/O) so the platform/version/already-installed gate is
// unit-testable without a venv or real subprocess calls. enabled=false
// short-circuits to a silent skip; the caller only invokes this once
// --flash-attn / QWEN_INSTALL_FLASH_ATTN has opted in. alreadyImportable is
// checked before every other branch — including AMD — so an already-working
// flash_attn (any platform/profile, e.g. a ROCm build) is reported rather than
// hidden behind a skip reason for a wheel it doesn't need. FA2 is otherwise an
// NVIDIA-only accelerator (the pinned Windows wheel and the Linux pip build
// are both CUDA-only), so AMD still skips when nothing's already installed.
// SDPA is the default attention impl wherever FA2 isn't installed/activated —
// this function never sets it; it only ever recommends activation.
export function resolveFlashAttnInstall({
  enabled,
  platform,
  pyTag,
  profile,
  alreadyImportable,
  nvccAvailable,
}) {
  if (!enabled) return { action: 'skip', reason: 'not requested' };
  if (alreadyImportable)
    return {
      action: 'already-installed',
      reason:
        'flash_attn is already importable in this venv — set QWEN_ATTN_IMPL=flash_attention_2 to use it (SDPA stays the default until you opt in)',
    };
  if (profile === 'amd')
    return {
      action: 'skip',
      reason: 'no ROCm FlashAttention-2 wheel; SDPA remains the default on AMD',
    };
  if (platform === 'win32') {
    if (pyTag !== 'cp311')
      return { action: 'skip', reason: `pinned wheel is cp311-only; venv is ${pyTag}` };
    return { action: 'install', url: FLASH_ATTN_WHEEL_URL };
  }
  if (platform === 'linux') {
    if (!nvccAvailable)
      return {
        action: 'skip',
        reason:
          'no CUDA Toolkit (nvcc) on PATH — flash-attn cannot compile without it; see https://developer.nvidia.com/cuda-downloads. SDPA remains the default.',
      };
    return { action: 'install-pip', package: 'flash-attn' };
  }
  return { action: 'skip', reason: `no pinned wheel for ${platform}; SDPA remains the default` };
}

/** Pure helper: builds the env for the flash-attn pip install call without
 *  mutating baseEnv (the shared object main() reuses for later pip calls —
 *  mutating it in place would leak MAX_JOBS into calls that don't need it).
 *  Reads MAX_JOBS from processEnv (not baseEnv, which never carries an
 *  operator's value) so an operator's own setting is honored instead of
 *  always being overwritten to the default cap. */
export function flashAttnBuildEnv(processEnv, baseEnv) {
  return { ...baseEnv, MAX_JOBS: processEnv.MAX_JOBS ?? '4' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:hooks`
Expected: PASS — all tests in `install-qwen3-flash-attn.test.mjs` green, plus the rest of the `scripts/tests/*.test.mjs` suite unaffected.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/install-qwen3.mjs scripts/tests/install-qwen3-flash-attn.test.mjs
git commit -m "feat(sidecar): extend FA2 install decision table for detect + Linux path"
```

---

## Task 2: Add I/O probes + restructure `installFlashAttn()` into an explicit dispatch

**Files:**
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs:9-23` (module header comment)
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs:81-85` (`FLASH_ATTN_WHEEL_URL` doc comment — the comment only; the `export const` declaration on the following lines is untouched)
- Modify: `server/tts-sidecar/scripts/install-qwen3.mjs:158-224` (replace `installFlashAttn` with the dispatcher + three helper functions + two new probes)

**Interfaces:**
- Consumes: `resolveFlashAttnInstall`, `flashAttnBuildEnv` (Task 1), `flashAttnWheelPin`, `sha256File`, `FLASH_ATTN_WHEEL_URL`, `run`, `step`, `venvPyTag`, `SIDECAR_DIR` (all pre-existing in this file).
- Produces: `installFlashAttn(python, env)` — same call signature as today; `main()` at line 266 (`if (INSTALL_FLASH_ATTN) installFlashAttn(python, env);`) needs no change.

No automated test for this task — it is real subprocess I/O (matching the existing precedent that `venvPyTag()` and the Windows wheel download/install flow are also untested beyond the pure decision function; see spec Testing section). Verification is: the full existing test suite stays green (nothing in this task should change `resolveFlashAttnInstall`/`flashAttnBuildEnv` behavior), plus a syntax check.

- [ ] **Step 1: Update the module header comment**

Replace lines 9-23 of `server/tts-sidecar/scripts/install-qwen3.mjs`:

```javascript
// What it does:
//   1. Locate the sidecar venv's python (.venv/Scripts/python.exe on Windows,
//      .venv/bin/python elsewhere). Fail with a clear bootstrap hint if absent.
//   2. `python -m pip install qwen-tts -c requirements/base.txt` (torch-safe:
//      no -U, pinned via base.txt — the package now ships in the GPU overlays,
//      so this is mainly weights-prefetch + repair).
//   3. Pre-fetch the Base (resident synth) model and, unless --skip-design,
//      the VoiceDesign model via Qwen3TTSModel.from_pretrained, with the HF
//      cache pointed at server/tts-sidecar/voices/qwen/hf so the weights live
//      with the sidecar (and stay out of the release zip per its exclude list).
//   4. With --flash-attn (opt-in): pip-install the pinned FlashAttention-2
//      prebuilt wheel. Win_amd64 + cp311 + torch 2.6/cu124 only; any other
//      platform/Python skips. Non-fatal — SDPA stays the default attention
//      impl (see main.py QWEN_ATTN_IMPL); activate FA2 with
//      QWEN_ATTN_IMPL=flash_attention_2 once installed.
```

with:

```javascript
// What it does:
//   1. Locate the sidecar venv's python (.venv/Scripts/python.exe on Windows,
//      .venv/bin/python elsewhere). Fail with a clear bootstrap hint if absent.
//   2. `python -m pip install qwen-tts -c requirements/base.txt` (torch-safe:
//      no -U, pinned via base.txt — the package now ships in the GPU overlays,
//      so this is mainly weights-prefetch + repair).
//   3. Pre-fetch the Base (resident synth) model and, unless --skip-design,
//      the VoiceDesign model via Qwen3TTSModel.from_pretrained, with the HF
//      cache pointed at server/tts-sidecar/voices/qwen/hf so the weights live
//      with the sidecar (and stay out of the release zip per its exclude list).
//   4. With --flash-attn (opt-in): if flash_attn is already importable in the
//      venv (any platform/profile), reports it and stops — no reinstall. On
//      Windows, pip-installs the pinned FlashAttention-2 prebuilt wheel
//      (cp311 + torch 2.6/cu124 only). On Linux, if the standalone CUDA
//      Toolkit (nvcc) is present, attempts an unpinned `pip install
//      flash-attn --no-build-isolation` (can be a long compile). AMD and any
//      other platform/Python combo skips. Always non-fatal — SDPA stays the
//      default attention impl (see main.py QWEN_ATTN_IMPL); activate FA2
//      with QWEN_ATTN_IMPL=flash_attention_2 once installed, on any path.
```

- [ ] **Step 2: Update the `FLASH_ATTN_WHEEL_URL` doc comment**

Replace lines 81-85 of `server/tts-sidecar/scripts/install-qwen3.mjs`:

```javascript
// Pinned FlashAttention-2 prebuilt wheel. Published only for the exact stack the
// sidecar runs (Windows AMD64 + CPython 3.11 + torch 2.6.0/cu124), so the gate
// below refuses any other platform/Python rather than install a wheel that can't
// load. lldacing/flash-attention-windows-wheel is the community source for
// Windows FA2 builds (upstream flash-attn ships no Windows wheel on PyPI).
```

with:

```javascript
// Pinned FlashAttention-2 prebuilt wheel for Windows. Published only for the
// exact stack the sidecar runs (Windows AMD64 + CPython 3.11 + torch
// 2.6.0/cu124), so the gate below refuses any other Python minor rather than
// install a wheel that can't load. lldacing/flash-attention-windows-wheel is
// the community source for Windows FA2 builds (upstream flash-attn ships no
// Windows wheel on PyPI). Linux has no pinned-wheel equivalent — see
// resolveFlashAttnInstall()'s `install-pip` branch instead.
```

- [ ] **Step 3: Replace `installFlashAttn()` with the dispatcher, helpers, and new probes**

Replace lines 158-224 of `server/tts-sidecar/scripts/install-qwen3.mjs` (the comment above `installFlashAttn` through its closing brace):

```javascript
// Opt-in FlashAttention-2 install. Platform/version-gated and fully non-fatal:
// flash-attn is an optional accelerator, so every failure path warns and returns
// rather than aborting the (already-succeeded) qwen-tts install.
function installFlashAttn(python, env) {
  const plan = resolveFlashAttnInstall({
    enabled: true,
    platform: process.platform,
    pyTag: venvPyTag(python),
    profile: process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? 'nvidia',
  });
  if (plan.action === 'skip') {
    step(`FlashAttention-2: skipped — ${plan.reason}.`);
    return;
  }
  step('FlashAttention-2: installing pinned prebuilt wheel (opt-in)...');
  step(`  ${plan.url}`);
  const pin = flashAttnWheelPin();
  let installTarget = plan.url;
  if (pin) {
    /* ops-7 — download the wheel WITHOUT installing, verify its SHA256, then
       install the verified local file. Refuse + delete on a mismatch so a
       tampered/corrupted wheel never executes its setup with the user's
       privileges. */
    const dlDir = mkdtempSync(join(tmpdir(), 'fa2-wheel-'));
    if (run(python, ['-m', 'pip', 'download', '--no-deps', '-d', dlDir, plan.url], env) !== 0) {
      step('FlashAttention-2: WARN wheel download failed — continuing on SDPA.');
      return;
    }
    const wheel = readdirSync(dlDir).find((f) => f.endsWith('.whl'));
    if (!wheel) {
      step('FlashAttention-2: WARN no .whl downloaded — continuing on SDPA.');
      return;
    }
    const wheelPath = join(dlDir, wheel);
    const actual = sha256File(wheelPath);
    if (actual !== pin) {
      step('FlashAttention-2: FAIL integrity check — refusing to install.');
      step(`  expected SHA256 ${pin}`);
      step(`  got      SHA256 ${actual}`);
      step('  The wheel does not match the pinned hash. Continuing on SDPA;');
      step('  re-bless model-hashes.json if the upstream wheel legitimately changed.');
      return;
    }
    step('FlashAttention-2: wheel SHA256 verified.');
    installTarget = wheelPath;
  } else {
    step('FlashAttention-2: WARN wheel is UNPINNED in model-hashes.json — installing');
    step('  without hash verification. Bless the wheel to enable the integrity gate.');
  }
  if (run(python, ['-m', 'pip', 'install', installTarget], env) !== 0) {
    step('FlashAttention-2: WARN install failed — continuing on SDPA. Retry the');
    step('  wheel URL above, or just leave QWEN_ATTN_IMPL=sdpa (the default).');
    return;
  }
  const imported = run(
    python,
    ['-c', 'import flash_attn;print("[install-qwen3] flash_attn",flash_attn.__version__)'],
    env,
  );
  if (imported === 0) {
    step('FlashAttention-2: installed. Activate with QWEN_ATTN_IMPL=flash_attention_2');
    step('  in the sidecar env (SDPA stays the default until benchmarked).');
  } else {
    step('FlashAttention-2: WARN wheel installed but `import flash_attn` failed —');
    step('  it may not match torch/CUDA. SDPA remains the default; safe to ignore.');
  }
}
```

with:

```javascript
// Ask the venv python whether flash_attn is already importable — if so, FA2 is
// already usable and no install should be attempted, on any platform/profile.
function flashAttnImportable(python) {
  const res = spawnSync(python, ['-c', 'import flash_attn'], {
    cwd: SIDECAR_DIR,
    windowsHide: true,
  });
  return res.status === 0;
}

// Preflight for the Linux pip-install path: flash-attn's source build needs the
// standalone NVIDIA CUDA Toolkit (nvcc), not just the CUDA runtime bundled in
// the PyTorch wheel — see the DeepSpeed note in requirements/nvidia-cuda.txt
// for the identical requirement on a sibling package. Without this gate, every
// install attempt on a box without the toolkit (the common case) would burn a
// doomed compile before falling back to SDPA. Presence alone doesn't guarantee
// a successful build (a CUDA-version/torch mismatch or insufficient GPU
// compute capability can still fail non-fatally after a real compile) — it
// only rules out the no-toolkit-at-all case.
function hasNvcc() {
  const res = spawnSync('nvcc', ['--version'], { windowsHide: true });
  return res.status === 0;
}

// Opt-in FlashAttention-2 install. Platform/version-gated and fully non-fatal:
// flash-attn is an optional accelerator, so every failure path warns and
// returns rather than aborting the (already-succeeded) qwen-tts install.
// Each plan.action gets its own dedicated function below with an explicit
// return — no case may fall through into another's logic.
function installFlashAttn(python, env) {
  const platform = process.platform;
  const plan = resolveFlashAttnInstall({
    enabled: true,
    platform,
    pyTag: venvPyTag(python),
    profile: process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? 'nvidia',
    alreadyImportable: flashAttnImportable(python),
    nvccAvailable: platform === 'linux' ? hasNvcc() : undefined,
  });

  switch (plan.action) {
    case 'skip':
      step(`FlashAttention-2: skipped — ${plan.reason}.`);
      return;
    case 'already-installed':
      step(`FlashAttention-2: ${plan.reason}.`);
      return;
    case 'install-pip':
      installFlashAttnPip(python, env);
      return;
    case 'install':
      installFlashAttnWheel(python, env, plan.url);
      return;
  }
}

// Linux path: attempt an unpinned `pip install flash-attn` build. The caller's
// nvcc preflight has already confirmed the standalone CUDA Toolkit is present.
// Needs ninja (genuinely missing from every requirements/*.txt) and
// setuptools/wheel (not seeded by `python -m venv` on 3.12+) before the build.
// --no-build-isolation is required, not optional: flash-attn's setup.py
// imports torch at build time, and default build isolation would hide this
// venv's torch from it, reliably failing with "No module named 'torch'"
// before ever reaching a real compile.
function installFlashAttnPip(python, env) {
  step('FlashAttention-2: attempting an unpinned pip install (opt-in)...');
  step('  Requires the standalone NVIDIA CUDA Toolkit; this can be a long compile.');
  const baseTxtPath = join(SIDECAR_DIR, 'requirements', 'base.txt');
  if (
    run(
      python,
      ['-m', 'pip', 'install', 'ninja', 'packaging', 'setuptools', 'wheel', '-c', baseTxtPath],
      env,
    ) !== 0
  ) {
    step('FlashAttention-2: WARN build-dependency install failed — continuing on SDPA.');
    return;
  }
  const buildEnv = flashAttnBuildEnv(process.env, env);
  if (
    run(
      python,
      ['-m', 'pip', 'install', 'flash-attn', '--no-build-isolation', '-c', baseTxtPath],
      buildEnv,
    ) !== 0
  ) {
    step('FlashAttention-2: WARN pip install failed — continuing on SDPA.');
    return;
  }
  reportFlashAttnImportResult(python, env);
}

// Windows path: download the pinned community wheel, SHA-verify it, install
// it. Behavior identical to before this change — only its call shape (now a
// dedicated function reached via explicit dispatch) changed.
function installFlashAttnWheel(python, env, url) {
  step('FlashAttention-2: installing pinned prebuilt wheel (opt-in)...');
  step(`  ${url}`);
  const pin = flashAttnWheelPin();
  let installTarget = url;
  if (pin) {
    /* ops-7 — download the wheel WITHOUT installing, verify its SHA256, then
       install the verified local file. Refuse + delete on a mismatch so a
       tampered/corrupted wheel never executes its setup with the user's
       privileges. */
    const dlDir = mkdtempSync(join(tmpdir(), 'fa2-wheel-'));
    if (run(python, ['-m', 'pip', 'download', '--no-deps', '-d', dlDir, url], env) !== 0) {
      step('FlashAttention-2: WARN wheel download failed — continuing on SDPA.');
      return;
    }
    const wheel = readdirSync(dlDir).find((f) => f.endsWith('.whl'));
    if (!wheel) {
      step('FlashAttention-2: WARN no .whl downloaded — continuing on SDPA.');
      return;
    }
    const wheelPath = join(dlDir, wheel);
    const actual = sha256File(wheelPath);
    if (actual !== pin) {
      step('FlashAttention-2: FAIL integrity check — refusing to install.');
      step(`  expected SHA256 ${pin}`);
      step(`  got      SHA256 ${actual}`);
      step('  The wheel does not match the pinned hash. Continuing on SDPA;');
      step('  re-bless model-hashes.json if the upstream wheel legitimately changed.');
      return;
    }
    step('FlashAttention-2: wheel SHA256 verified.');
    installTarget = wheelPath;
  } else {
    step('FlashAttention-2: WARN wheel is UNPINNED in model-hashes.json — installing');
    step('  without hash verification. Bless the wheel to enable the integrity gate.');
  }
  if (run(python, ['-m', 'pip', 'install', installTarget], env) !== 0) {
    step('FlashAttention-2: WARN install failed — continuing on SDPA. Retry the');
    step('  wheel URL above, or just leave QWEN_ATTN_IMPL=sdpa (the default).');
    return;
  }
  reportFlashAttnImportResult(python, env);
}

// Shared post-install verification + activation instructions for both the
// Windows and Linux paths. Never sets QWEN_ATTN_IMPL itself — activation
// stays a manual operator choice on every path.
function reportFlashAttnImportResult(python, env) {
  const imported = run(
    python,
    ['-c', 'import flash_attn;print("[install-qwen3] flash_attn",flash_attn.__version__)'],
    env,
  );
  if (imported === 0) {
    step('FlashAttention-2: installed. Activate with QWEN_ATTN_IMPL=flash_attention_2');
    step('  in the sidecar env (SDPA stays the default until benchmarked).');
  } else {
    step('FlashAttention-2: WARN installed but `import flash_attn` failed — it may not');
    step('  match torch/CUDA. SDPA remains the default; safe to ignore.');
  }
}
```

- [ ] **Step 4: Syntax-check the file**

Run: `node --check server/tts-sidecar/scripts/install-qwen3.mjs`
Expected: no output, exit code 0.

- [ ] **Step 5: Run the full test:hooks suite to confirm no regression**

Run: `npm run test:hooks`
Expected: PASS — every test from Task 1 still green (this task doesn't change `resolveFlashAttnInstall`/`flashAttnBuildEnv` behavior, only the untested orchestration around them), and the rest of `scripts/tests/*.test.mjs` unaffected.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/scripts/install-qwen3.mjs
git commit -m "feat(sidecar): detect FA2 + attempt opt-in Linux pip install"
```

---

## Task 3: Release notes + final verification

**Files:**
- Modify: `docs/release-notes-next.md` (add one bullet under `## 🏗️ Under the hood`)
- Modify: `RELEASE_NOTES.md` (add one brand-voice bullet under the in-progress `# Castwright 1.12.0` section, at the end of the existing bullet list)

**Interfaces:**
- Consumes: nothing (docs-only).
- Produces: nothing consumed by other tasks — this is the final task.

- [ ] **Step 1: Add the technical release-notes entry**

In `docs/release-notes-next.md`, under the `## 🏗️ Under the hood` heading (after its existing two bullets), add:

```markdown
- **FlashAttention-2 detection is no longer Windows-only, and the stale
  Windows pin is no longer the only path.** `install-qwen3.mjs --flash-attn`
  now checks whether `flash_attn` is already importable in the sidecar venv
  on ANY platform/accelerator profile first — if so, it just reports how to
  activate it (`QWEN_ATTN_IMPL=flash_attention_2`) rather than attempting a
  reinstall. On Linux, when it isn't already present and the standalone
  NVIDIA CUDA Toolkit (`nvcc`) is on PATH, the installer now attempts an
  unpinned `pip install flash-attn --no-build-isolation` build; without the
  toolkit it skips cleanly instead of burning a doomed compile. The Windows
  pinned-wheel path (still cp311-only; the cp312/torch2.11/cu128 real-stack
  fix is tracked on side-22, #1001) is unchanged. (side-21, #1000)
```

- [ ] **Step 2: Add the brand-voice release-notes entry**

In `RELEASE_NOTES.md`, under the `# Castwright 1.12.0` heading, append this bullet at the end of the existing list for that version:

```markdown
- **If you've already got FlashAttention-2 set up on Linux, Castwright now notices.** The sidecar installer's optional speed-accelerator step used to only know about a Windows-specific package — everywhere else, it just gave up. It now checks whether you already have FlashAttention-2 available and tells you how to switch it on, and if you don't have it yet, opting in now tries installing it for you (when your system has the NVIDIA CUDA developer toolkit). Nothing changes unless you ask for it — it's still off by default.
```

- [ ] **Step 3: Run the full verification battery**

Run: `npm run verify:fast:branch`
Expected: PASS (or `[skip] ... (out of scope)` for legs the diff doesn't touch — this branch only touches `server/tts-sidecar/scripts/**`, `scripts/tests/**`, and docs, so most legs beyond `test:hooks`/lint/typecheck will scope-skip).

- [ ] **Step 4: Commit**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs: release notes for FA2 conditional detect + Linux install"
```

- [ ] **Step 5: Note the owed on-box acceptance**

No step needed beyond noting it for the PR description: this change's real subprocess paths (`flashAttnImportable`, `hasNvcc`, the Linux pip-install flow, the Windows wheel flow) have no automated coverage (see Task 2's rationale) and are owed manual on-box verification — ideally on a real Linux box both with and without `flash_attn`/`nvcc` present, and on the existing Windows dev box to confirm the win32 path is genuinely unchanged. Say this explicitly in the PR body's test plan.
