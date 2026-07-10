---
status: draft
---

# FA2: conditional detect + opt-in Linux install (side-21 rescope)

## Context

`server/tts-sidecar/scripts/install-qwen3.mjs` has an opt-in FlashAttention-2
installer (`--flash-attn` / `QWEN_INSTALL_FLASH_ATTN=1`). Today it only knows
one path: a pinned community wheel for Windows AMD64 + CPython 3.11 +
torch 2.6.0/cu124. Any other platform — including Linux, where FA2 is far
more commonly already present (built by the user, baked into a base image,
or installable straight from PyPI) — hits an unconditional skip:
`no pinned wheel for ${platform}; SDPA remains the default`.

Issue #1000 (side-21) originally scoped this as "fix the stale Windows pin
(cp311 → the real cp312/torch2.11/cu128 stack) + conditional auto-enable."
That Windows-specific pin fix is deferred to a future companion ticket. This
spec rescopes #1000 to the piece that matters now: **detect an
already-present FA2 on any platform, and add an opt-in Linux install
attempt** — without touching the Windows path or runtime attention-impl
selection at all.

**Precedent already in this repo for the same class of problem:** DeepSpeed
is deliberately *not* auto-installed anywhere, because "its setup.py needs
the standalone NVIDIA CUDA Toolkit (with nvcc) at install time — the CUDA
runtime libraries that ship inside the PyTorch wheel aren't enough"
(`server/tts-sidecar/requirements/nvidia-cuda.txt:25-34`). flash-attn's
source build has the exact same `nvcc` requirement. Unlike DeepSpeed (purely
a documented manual recipe, never scripted), this spec still attempts an
automated install — but it must gate that attempt on an `nvcc` preflight
check, or every install attempt on a box without the standalone CUDA
Toolkit (the common case) silently fails and the feature ships dead. See
Design.

## Goals

- If `flash_attn` is already importable in the sidecar venv — **on any
  platform, including AMD/ROCm** — report it and how to activate it. Never
  attempt to (re)install over it.
- On Linux, when not already importable and the installer is opted in, try
  installing flash-attn (unpinned — straight from PyPI, no community
  wheel/supply-chain concern like the Windows wheel). Non-fatal on failure.
- Preserve today's Windows behavior and today's runtime default (SDPA)
  exactly. Activation is always a manual, separate step via the existing
  `QWEN_ATTN_IMPL` env var — the installer never sets it, on any platform.
- No change to `main.py` runtime attention-impl selection (already correct:
  `QWEN_ATTN_IMPL` defaults to `"sdpa"`, `server/tts-sidecar/main.py:2022`).

## Non-goals

- The Windows stale cp311 pin / cp312-real-stack fix — separate future issue.
- macOS support — no CUDA, an install attempt there is pure busywork
  (guaranteed to fail); leave it on the existing generic skip path. (The
  already-importable detection still runs first and covers darwin too — see
  Design.)
- Any new CLI flag or env var. The existing `--flash-attn` /
  `QWEN_INSTALL_FLASH_ATTN=1` opt-in gates everything in this spec.
- Auto-activating FA2 at runtime once installed/detected — stays manual.
- A kernel-invoking smoke test (actually running a synth call to catch an
  ABI-mismatched flash_attn that imports cleanly but faults at inference).
  The bar stays "does `import flash_attn` succeed," matching the existing
  Windows-path precedent, which has the same limitation today.
- Hard version-pinning flash-attn against the venv's exact `torch==2.11.0`/
  cu128 stack. Left to pip's resolver; re-pinning on every torch bump isn't
  worth the maintenance cost for an opt-in accelerator with a non-fatal
  failure path.
- A SHA-pin/integrity gate on the Linux install path (unlike the Windows
  wheel's `flashAttnWheelPin()` check). Accepted trade-off: it's the
  official upstream PyPI package under pip's own resolver, not a
  single-maintainer community-hosted binary — a compromised release would
  be a supply-chain concern for every flash-attn consumer, not one specific
  to this installer.

## Design

### New I/O probes

Two new thin subprocess wrappers in `install-qwen3.mjs`, sibling to the
existing `venvPyTag(python)` helper:

- `flashAttnImportable(python)` — `spawnSync(python, ['-c', 'import
  flash_attn'])`, returns `true` on exit code 0, else `false`.
- `nvccAvailable()` — `spawnSync('nvcc', ['--version'])`, returns `true` on
  exit code 0, else `false`. This is the preflight the Context section's
  DeepSpeed precedent motivates: without it, `install-pip` below would
  attempt (and fail) a source compile on every box lacking the standalone
  CUDA Toolkit — the common case for a box provisioned only via `pip
  install torch`.

### `resolveFlashAttnInstall()` — extended decision table

The function stays pure (no I/O) and testable without a venv — both probes
above are I/O and run separately in `installFlashAttn()`, feeding their
boolean results in as inputs, the same pattern `alreadyImportable` already
uses. It gains two new inputs (`alreadyImportable`, `nvccAvailable`) and one
new platform branch:

```
resolveFlashAttnInstall({ enabled, platform, pyTag, profile, alreadyImportable, nvccAvailable })
```

Decision order (note: `alreadyImportable` sits at the **top**, ahead of the
AMD check — reordered from an earlier draft that put it after AMD, which
would have hidden an already-working ROCm-built flash_attn behind the
"no ROCm wheel" skip message, contradicting the "any platform" goal):

1. `!enabled` → `{ action: 'skip', reason: 'not requested' }` (unchanged)
2. `alreadyImportable` → **new**: `{ action: 'already-installed', reason:
   'flash_attn is already importable in this venv — set
   QWEN_ATTN_IMPL=flash_attention_2 to use it (SDPA stays the default until
   you opt in)' }`. Checked before the AMD/platform branches — on any OS or
   accelerator profile, if it's already there, nothing else runs.
3. `profile === 'amd'` → `{ action: 'skip', reason: '...no ROCm wheel...' }` (unchanged)
4. `platform === 'win32'` → unchanged cp311-pin logic (`pyTag !== 'cp311'` →
   skip; else `{ action: 'install', url: FLASH_ATTN_WHEEL_URL }`)
5. `platform === 'linux'`:
   - `!nvccAvailable` → **new**: `{ action: 'skip', reason: 'no CUDA
     Toolkit (nvcc) on PATH — flash-attn cannot compile without it; see
     https://developer.nvidia.com/cuda-downloads. SDPA remains the
     default.' }`
   - else → **new**: `{ action: 'install-pip', package: 'flash-attn' }`
6. else (e.g. `darwin`) → unchanged: `{ action: 'skip', reason: 'no pinned
   wheel for ${platform}; SDPA remains the default' }`

**Known, accepted limitation (not fixed by this spec):** the `linux` branch
above is reached whenever `profile !== 'amd'` — which is the default when
`CASTWRIGHT_ACCELERATOR_PROFILE` is unset. A ROCm Linux box that hasn't
explicitly exported `CASTWRIGHT_ACCELERATOR_PROFILE=amd` would hit
`install-pip` and attempt (and fail, non-fatally) a CUDA build. This is an
existing profile-detection gap this spec inherits rather than introduces,
and AMD/ROCm support elsewhere in this codebase is itself still dormant
(no ROCm card yet available to develop against) — not worth solving here.

### `installFlashAttn()` — orchestration changes

Today `installFlashAttn()` is linear, not a dispatch: after the one
`plan.action === 'skip'` early-return it falls straight into the win32
wheel-download/SHA-verify/install block, implicitly assuming `action ===
'install'` is the only remaining case. Adding `already-installed` and
`install-pip` requires turning this into an explicit dispatch — inserting
their branches *before* that block, not appending after it — otherwise
`install-pip` falls through into code that does `step(\`  ${plan.url}\`)`
and tries to SHA-verify-download an `undefined` URL.

- Compute `alreadyImportable = flashAttnImportable(python)` before calling
  `resolveFlashAttnInstall()`. Compute `nvccAvailable = nvccAvailable()`
  only when `platform === 'linux'` (no need to spawn it otherwise).
- `action: 'skip'` → log the reason, return (unchanged).
- `action: 'already-installed'` → **new branch**: log the reason, return.
  No pip call.
- `action: 'install-pip'` → **new branch**: log a heads-up that this is an
  unpinned PyPI install requiring the standalone CUDA Toolkit (not just the
  torch-bundled runtime — see Context) and that it can be a long compile.
  Then, via the existing `run()` helper:
  1. `pip install ninja packaging setuptools wheel -c <base.txt>` —
     flash-attn's build needs `ninja` (genuinely absent from every
     `requirements/*.txt`) and `setuptools`/`wheel` (not seeded by `python
     -m venv` on 3.12+, which this venv may already be — the deferred
     Windows companion ticket's whole premise is that the real stack is
     cp312). `packaging` is likely already present transitively via
     transformers/huggingface_hub; listing it is a harmless no-op
     safety net, not evidence it's missing. The `-c <base.txt>` constraint
     matches the qwen-tts install's existing torch-safety discipline
     (`qwenPipInstallArgs()`, "no `-U`, pinned via base.txt") — these new
     packages shouldn't be exempt from that same discipline.
  2. Build a **local, non-mutating** env for just this next call:
     `{ ...env, MAX_JOBS: process.env.MAX_JOBS ?? '4' }`. This must NOT
     mutate the shared `env` object `main()` passes around (that object is
     reused for the qwen-tts install and model-prefetch calls later in
     `main()` — mutating it would leak `MAX_JOBS` into unrelated calls that
     don't need it), and must check `process.env.MAX_JOBS` specifically
     (not the local `env`, which never carries an operator's value) so an
     operator's own `MAX_JOBS` is honored instead of always being
     overwritten to `'4'`. `4` itself is an uncalibrated default carried
     over from general flash-attn guidance (compiling CUDA translation
     units in parallel is RAM-hungry) — not tuned to any known build box in
     this repo, but always operator-overridable now that the bug above is
     fixed.
  3. `pip install flash-attn --no-build-isolation -c <base.txt>`, using
     that local env. **`--no-build-isolation` is required, not optional**:
     flash-attn's `setup.py` imports `torch` at build time, and default PEP
     517 build isolation gives the build a fresh env where the venv's torch
     is invisible, so a bare `pip install flash-attn` reliably fails with
     `ModuleNotFoundError: No module named 'torch'` before ever reaching a
     real compile. This is documented upstream flash-attn install guidance,
     not project-specific; `--no-build-isolation` works here specifically
     because it's the *same* venv torch already lives in.

  On non-zero exit from any pip call: warn and continue on SDPA (same
  pattern as the Windows wheel-download-failure path). On success: verify
  with `import flash_attn` (same as Windows — this catches an ABI mismatch
  that fails at import, not one that only faults when a kernel actually
  runs; see Non-goals), then print the same manual-activation instruction
  as Windows — never set `QWEN_ATTN_IMPL` itself.
- `action: 'install'` (win32): existing wheel-download/SHA-verify/install
  body unchanged, now reached via an explicit branch instead of implicit
  fallthrough.

### Comment/docstring updates

Update the module-level comment (lines ~19–23) and the `FLASH_ATTN_WHEEL_URL`
doc comment (lines ~81–88) to reflect that Windows is one of now two install
paths, not the only one.

## Testing

`scripts/tests/install-qwen3-flash-attn.test.mjs`:

- Split the existing combined `darwin`+`linux` "non-Windows → skip" test:
  `darwin` keeps the skip assertion; `linux` moves to new cases.
- New: `linux`, `alreadyImportable: true` → `action: 'already-installed'`,
  no `package`/`url` on the result (checked before `nvccAvailable` even
  matters — pass either value, result is the same).
- New: `linux`, `alreadyImportable: false`, `nvccAvailable: true` →
  `action: 'install-pip'`, `package: 'flash-attn'`.
- New: `linux`, `alreadyImportable: false`, `nvccAvailable: false` →
  `action: 'skip'`, reason matching `/nvcc/`.
- New: any platform *and any profile*, `alreadyImportable: true` →
  `already-installed` — including `win32` (short-circuits before the
  pin-check branch) **and `profile: 'amd'`** (short-circuits before the
  ROCm skip — this is the case the reordering above exists for).
- Existing win32/cp311, win32/cp312, not-opted-in, wheel-URL-shape tests:
  unchanged, still pass (all pass `alreadyImportable: false` implicitly or
  explicitly).

No venv/CUDA-dependent test is added or needed — `flashAttnImportable()`
and `nvccAvailable()` themselves (the I/O halves) aren't unit-tested
directly, matching the existing precedent (`venvPyTag()` also isn't
unit-tested — thin venv/host subprocess wrappers exercised only by
hand/on-box, not in CI).

## Acceptance

- On the current dev stack (Windows, no FA2 wheel available for the actual
  cp312/torch2.11/cu128 combo): unchanged — installer reports the existing
  cp311-only skip reason, stays on SDPA.
- On a Linux box with `flash_attn` already importable: installer reports it,
  attempts no install, SDPA remains the runtime default until the operator
  sets `QWEN_ATTN_IMPL=flash_attention_2` by hand.
- On a Linux box without `flash_attn` and without `nvcc` on PATH, opted in:
  installer skips with a clear CUDA-Toolkit-required message, stays on
  SDPA — never attempts a doomed compile.
- On a Linux box without `flash_attn` but with `nvcc` available, opted in:
  installer installs `ninja`/`packaging`/`setuptools`/`wheel`, attempts
  `pip install flash-attn --no-build-isolation -c base.txt` with an
  operator-overridable `MAX_JOBS` cap, warns about compile time, succeeds
  or fails non-fatally, never sets the runtime knob itself.
- On an AMD/ROCm box with `flash_attn` already importable: installer
  reports it (the already-importable check now runs before the ROCm skip),
  same as any other platform.
- An operator-set `MAX_JOBS` env var is honored, not silently overwritten.
- `npm run test:hooks` (or the equivalent script test runner) green with the
  updated + new cases.

## Handoff

Single-scope `chore(sidecar)` change. Next step is `writing-plans`, which
produces the implementation plan and the issue-handoff comment. As part of
that handoff: repurpose #1000's title/body to this scope, and file a new
companion issue for the deferred Windows cp311→cp312 pin fix.
