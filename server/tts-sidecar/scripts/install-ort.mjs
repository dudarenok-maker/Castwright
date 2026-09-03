#!/usr/bin/env node
// install-ort.mjs — the ONNX-runtime swap that puts the RIGHT Kokoro runtime in
// place after the requirements overlay. The overlay always installs plain
// `onnxruntime` (kokoro-onnx's core dependency — see requirements/nvidia-cuda.txt),
// so any profile whose Kokoro must run on a GPU runtime has to REPLACE that module
// with the accelerator-specific one (they all share the `onnxruntime` import name
// and can't co-exist reliably):
//   - nvidia  → onnxruntime-gpu      (CUDAExecutionProvider)
//   - amd-win → onnxruntime-directml (disabled after S0.1 — Kokoro stays CPU)
//   - cpu/apple → no swap (plain onnxruntime is correct)
// This is the SINGLE enforcement point for GPU Kokoro: we deliberately do NOT lean
// on `kokoro-onnx[gpu]`, because that extra coexists with the core `onnxruntime`
// dep and pip's resolution order can leave the CPU build owning the namespace — a
// silent CPU-only Kokoro on a GPU box (the 2026-06-16 regression). Runs AFTER the
// overlay install (bootstrap-venv.mjs wires it into every profile's flow).
// Pure planner (planOrtSwap) + guarded CLI, mirroring install-torch.mjs.
//
// Usage (the bootstrap wires this; manual form for testing):
//   PowerShell: $env:CASTWRIGHT_ACCELERATOR_PROFILE='nvidia'; node install-ort.mjs <venv-python>
//   POSIX:      CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node install-ort.mjs <venv-python>
//
// NOTE: the minimum working onnxruntime-directml version (the release carrying
// the Kokoro ConvTranspose fix) is OWED on real AMD hardware (Wave H1). Until
// pinned there, we install the latest.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { isDirectlyInvoked } from '../../../scripts/lib/is-main-module.mjs';
import { dirname, join, resolve } from 'node:path';
import { installRecipe, PROFILES } from './accelerator-profile.mjs';

/** Distribution names that OWN the onnxruntime namespace on some profile.
 *  DERIVED from installRecipe, never hand-typed — a hand-typed list is a second
 *  source of truth for a set installRecipe already determines, and would miss a
 *  future onnxruntime-directml re-enable. */
export const SWAP_ORT_PACKAGES = [
  ...new Set(
    PROFILES.flatMap((p) =>
      ['win32', 'linux', 'darwin'].map((plat) => installRecipe(p, plat).ortPackage),
    ).filter((pkg) => pkg !== 'onnxruntime'),
  ),
];

/** PEP 427 escaping: pip writes `onnxruntime-gpu` to disk as `onnxruntime_gpu`.
 *  Globbing the UNESCAPED name matches zero directories — which, combined with
 *  the fail-loudly rule, would break every NVIDIA bootstrap. */
export function escapeDistName(name) {
  return name.replace(/[-_.]+/g, '_');
}

/** Resolve site-packages inside a venv dir. Pure fs — no interpreter spawn.
 *  Returns null when absent or ambiguous; callers treat null as "do nothing". */
export function sitePackagesDir(venvDir) {
  const win = join(venvDir, 'Lib', 'site-packages');
  if (existsSync(win)) return win;
  const libDir = join(venvDir, 'lib');
  if (!existsSync(libDir)) return null;
  const hits = readdirSync(libDir)
    .filter((d) => d.startsWith('python'))
    .map((d) => join(libDir, d, 'site-packages'))
    .filter((p) => existsSync(p));
  return hits.length === 1 ? hits[0] : null;
}

export const MARKER_INSTALLER = 'castwright-ort-marker';

/** Every `onnxruntime-<version>.dist-info` in site-packages — ours AND real ones.
 *  The trailing `-\d` is what excludes `onnxruntime_gpu-…` (underscore at index 11). */
function ortDistInfoDirs(sitePackages) {
  if (!existsSync(sitePackages)) return [];
  return readdirSync(sitePackages)
    .filter((d) => /^onnxruntime-\d.*\.dist-info$/.test(d))
    .map((d) => join(sitePackages, d));
}

/** Ours ONLY if the INSTALLER is our sentinel AND the RECORD is empty.
 *  Name is never sufficient: the real plain distribution's directory name is
 *  byte-identical to ours. */
export function isOurMarker(distInfoDir) {
  try {
    const installer = readFileSync(join(distInfoDir, 'INSTALLER'), 'utf8').trim();
    if (installer !== MARKER_INSTALLER) return false;
    return readFileSync(join(distInfoDir, 'RECORD'), 'utf8').trim() === '';
  } catch {
    return false;
  }
}

/** Real (non-marker) plain onnxruntime distributions. Tests EVERY match — ours
 *  and a real one can coexist, so answering from the first is a false negative. */
export function findPlainOrtDistInfos(sitePackages) {
  return ortDistInfoDirs(sitePackages).filter((d) => !isOurMarker(d));
}

/** Who owns site-packages/onnxruntime/ — decided from FILES the wheel ships.
 *  'swap'  → a swap distribution (onnxruntime-gpu / -directml)
 *  'plain' → the CPU build
 *  'none'  → absent or gutted (nothing importable)
 *  NEVER uses import/get_available_providers(): __version__ is identical across
 *  builds, and a GPU install with unloadable CUDA DLLs reports CPU providers. */
export function detectOrtOwner(sitePackages) {
  const capi = join(sitePackages, 'onnxruntime', 'capi');
  if (!existsSync(capi)) return 'none';
  let entries;
  try {
    entries = readdirSync(capi);
  } catch {
    return 'none';
  }
  if (entries.length === 0) return 'none';

  const infoPath = join(capi, 'build_and_package_info.py');
  if (existsSync(infoPath)) {
    try {
      const m = readFileSync(infoPath, 'utf8').match(/package_name\s*=\s*['"]([^'"]+)['"]/);
      if (m) return SWAP_ORT_PACKAGES.includes(m[1]) ? 'swap' : 'plain';
    } catch {
      /* fall through to the DLL signal */
    }
  }
  if (entries.some((e) => /^onnxruntime_providers_(cuda|rocm)\./.test(e))) return 'swap';
  return 'plain';
}

/** Name for the in-progress marker build. Deliberately matches neither pip's
 *  dist-info discovery (no `.dist-info` suffix) nor this file's own
 *  `^onnxruntime-\d.*\.dist-info$` regex — a kill mid-build must stay
 *  invisible to both, never surface as a partial `onnxruntime-*.dist-info`. */
const MARKER_TMP_DIRNAME = '.castwright-ort-marker.tmp';

/** Write (or overwrite) the marker. Removes any stale marker first so the
 *  version can never lag the installed runtime.
 *
 *  Builds the marker in a temp dir and `renameSync`s it into place LAST, so a
 *  crash/kill between the individual file writes below can never leave a
 *  partial dist-info under the real `onnxruntime-<version>.dist-info` name —
 *  `isOurMarker()` rejects a partial one (missing INSTALLER or a non-empty/
 *  missing RECORD), so `findPlainOrtDistInfos()` would then count it as a
 *  REAL plain distribution and nothing would ever self-correct that. */
export function writeOrtMarker(sitePackages, version) {
  deleteOrtMarkerIfOurs(sitePackages);
  const dir = join(sitePackages, `onnxruntime-${version}.dist-info`);
  const tmpDir = join(sitePackages, MARKER_TMP_DIRNAME);
  rmSync(tmpDir, { recursive: true, force: true }); // clear a stale temp from a prior crash
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(
    join(tmpDir, 'METADATA'),
    `Metadata-Version: 2.1\nName: onnxruntime\nVersion: ${version}\n` +
      `Summary: Provided by ${SWAP_ORT_PACKAGES.join('/')} (same namespace, same API).\n`,
  );
  writeFileSync(join(tmpDir, 'INSTALLER'), `${MARKER_INSTALLER}\n`);
  writeFileSync(join(tmpDir, 'RECORD'), ''); // MUST stay empty — see the spec's Spike 2
  // renameSync fails if `dir` already exists — clear a stale/partial marker
  // at the destination first (deleteOrtMarkerIfOurs above only removes a
  // COMPLETE marker that passes isOurMarker, so a partial one from a prior
  // crash at this exact version would otherwise survive and block the rename).
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmpDir, dir);
}

/** Delete the marker if (and only if) we wrote it. Returns whether it removed one. */
export function deleteOrtMarkerIfOurs(sitePackages) {
  let removed = false;
  for (const dir of ortDistInfoDirs(sitePackages)) {
    if (!isOurMarker(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

/** Version of the installed swap distribution, read from its dist-info METADATA.
 *  null when absent OR ambiguous — the caller treats null as fatal for a swap
 *  (better a loud install failure than a marker whose version is a guess). */
export function readInstalledOrtVersion(sitePackages, ortPackage) {
  if (!existsSync(sitePackages)) return null;
  const prefix = `${escapeDistName(ortPackage)}-`;
  const hits = readdirSync(sitePackages).filter(
    (d) => d.startsWith(prefix) && d.endsWith('.dist-info'),
  );
  if (hits.length !== 1) return null;
  try {
    const meta = readFileSync(join(sitePackages, hits[0], 'METADATA'), 'utf8');
    const m = meta.match(/^Version:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// onnxruntime-gpu version constraint (side-28): without one, the runtime a user
// actually runs Kokoro on is whatever happened to be latest on PyPI on their
// install date. Re-pinned 2026-08-21 (#2534 side-chain) to the newest
// CUDA-12-built line. NOTE (#2600, corrected 2026-08-23): the version itself was
// desk-validated (1.26.0/1.27.0 constructs a CUDAExecutionProvider
// InferenceSession against CUDA 12.4 without erroring), but "computes
// correctly" was never true end to end — cuDNN does NOT ship in the runtime
// venv via torch; #2600's wave-4 on-box run found no cuDNN 9 DLL anywhere
// onnxruntime's CUDA provider searches, so the session silently falls back to
// CPU. See the NVIDIA_CUDNN_CONSTRAINT comment below for the fix this
// motivated, and main.py's `_preload_ort_cuda_dlls` for the still-unproven
// (no on-box confirmation as of this note) attempt to make the installed
// cuDNN findable. onnxruntime-gpu 1.27+ moved its default build to CUDA 13.x
// (cublasLt64_13.dll), incompatible
// with the shipped torch/torchaudio cu128 pin. The pin deliberately holds the
// runtime on the last CUDA-12 line to keep the stack CUDA-12-compatible.
// Floor-plus-cap on the MINOR line rather than an exact `==` so a same-line
// patch release (a security fix) still flows without a code change; only
// crossing the minor boundary needs a deliberate bump of this constant. Bump
// the runtime and this pin together: the constraint can only move to a
// CUDA-13-built onnxruntime-gpu line once the shipped torch/torchaudio pins in
// requirements/nvidia-cuda.txt move to a CUDA-13 wheel (e.g., a future cu13x
// index). Until then, the shipped venv remains CUDA-12-by-construction regardless
// of what CUDA toolkit is installed system-wide — never bump one without the other.
// This is the ONLY place the constraint can live: it must NOT move into
// requirements/*.txt, because onnxruntime-gpu can never appear there AT ALL —
// those overlays are also read on macOS (no onnxruntime-gpu wheel exists for
// Apple Silicon), and test_no_bare_unmarked_onnxruntime_gpu
// (tests/test_requirements.py) enforces that a bare, unmarked
// `onnxruntime-gpu` line never lands there and aborts `pip install` on that
// platform. The swap in this file is reached only for the nvidia profile
// (win/linux), so pinning it here never touches the mac path.
//
// ALSO check main.py's `_preload_ort_cuda_dlls` when bumping this (pass-4
// review finding P4, PR #2617): its output guard string-matches two of
// onnxruntime's OWN prose lines — "Failed to load" and "Skip loading" — to
// decide whether preload_dlls() actually did anything. Those strings are not
// pinned to this constant anywhere and a onnxruntime release that rewords its
// per-DLL failure message would make the guard fall through to a false
// "preloaded" again (the exact #2600 symptom, reopened inside the guard
// written to close it) with nothing here to catch it. Not fixed now because
// it's unreachable at the pinned version -- but re-check it by hand on any
// bump of this constant.
const ONNXRUNTIME_GPU_CONSTRAINT = '>=1.26,<1.27';

/**
 * Apply the onnxruntime-gpu version constraint to an ortPackage name for the
 * INSTALL step only — the uninstall step takes bare package names (a version
 * spec there is meaningless to `pip uninstall` and would be a silent no-op).
 * Any other ortPackage (e.g. a future onnxruntime-directml re-enable) installs
 * unconstrained until it has its own desk-validated line. Pure — no I/O.
 * @returns {string}
 */
function constrainForInstall(ortPackage) {
  return ortPackage === 'onnxruntime-gpu'
    ? `onnxruntime-gpu${ONNXRUNTIME_GPU_CONSTRAINT}`
    : ortPackage;
}

// cuDNN 12 runtime onnxruntime-gpu needs to actually RUN on the GPU EP, not
// merely report it (#2600). onnxruntime-gpu 1.26.x declares nvidia-cudnn-cu12
// only in its OPTIONAL `[cudnn]` extra — and the swap's install step above is
// `--no-deps` (kept, see the comment on `steps` below), which suppresses
// extras entirely. So nothing in the swap ever landed cuDNN: onnxruntime
// still reports CUDAExecutionProvider as available (the python binding
// doesn't probe cuDNN at import time), but constructing an InferenceSession
// with it silently falls back to CPU — no error, no warning. Kokoro then
// "works" and runs on CPU.
//
// TIGHTENED 2026-08-31 (register row A28, discharged/on-box, real regression confirmed):
// the original `~=9.0` (any 9.x) let pip resolve to whatever was latest —
// 9.25.1.1 as of this writing — which is NOT ABI-compatible with the cuDNN
// build torch 2.11.0+cu128 bundles (`torch.backends.cudnn.version()` reports
// `91900`, i.e. 9.19.0). `onnxruntime.preload_dlls()` (main.py's
// `_preload_ort_cuda_dlls`, called unconditionally at sidecar startup on the
// nvidia profile) loads nvidia-cudnn-cu12's `cudnn64_9.dll` into the process
// BEFORE anything imports torch — Windows resolves a later `LoadLibrary` for
// the same DLL basename to whichever copy is ALREADY loaded, so torch's own
// subsequent `import torch` (its `_load_dll_libraries()`) picked up the
// pip package's 9.25.1.1 build instead of its own bundled 9.19.x one and
// failed outright: `OSError: [WinError 127] The specified procedure could
// not be found. Error loading "...\torch\lib\cudnn_cnn64_9.dll"` — a
// same-line-name, cross-minor-version export mismatch. Confirmed on real
// hardware that breaks torch entirely (Coqui/Qwen/Whisper device probe and
// every torch-backed engine), not just a cosmetic warning — this is exactly
// the risk discharged register row A28's own "N11" note flagged as unverified. Floor-
// AND-cap to the exact minor line torch bundles, same reasoning as
// NVIDIA_CUBLAS_CONSTRAINT below: this MUST move together with whatever
// torch version this venv's requirements pin, not just with
// ONNXRUNTIME_GPU_CONSTRAINT — re-check `torch.backends.cudnn.version()`
// against this pin whenever torch is bumped.
const NVIDIA_CUDNN_CONSTRAINT = 'nvidia-cudnn-cu12~=9.19.0';

// cuDNN's own dependency tree pulls in nvidia-cublas-cu12 (for nvidia-cudnn-cu12,
// unpinned). Left alone, that is exactly the exposure ONNXRUNTIME_GPU_CONSTRAINT's
// own comment above says is unacceptable: whatever happens to be latest on PyPI
// on install date, decided by a THIRD PARTY's unpinned transitive dep rather
// than by us. It is also a real collision, not a theoretical one: torch/
// torchaudio (cu128) ship their OWN bundled `cublas64_12.dll` in torch/lib — the
// live sidecar venv's copy reports (Windows file version info) "NVIDIA CUDA BLAS
// Library, Version 12.8.4" — so an unpinned nvidia-cublas-cu12 install lands a
// second, differently-versioned build of the same DLL base name in one process,
// and load order decides which one a given import gets.
//
// PASS 2 REVIEW FIX (N4, PR #2617): the prior `~=12.9` pin was wrong in BOTH
// directions. `~=V.N` (two segments) means `>=V.N, ==V.*` — since the package
// name already encodes the cu12 major line, that cap is vacuous (a bare floor
// admitting 12.10, 12.99, …), and worse, a floor of 12.9 EXCLUDES the very
// 12.8.4.x line torch bundles, mandating the exact cublas64_12.dll build
// mismatch this comment warns about. `~=12.8.0` (three segments) is
// `>=12.8.0, ==12.8.*` — a real floor-plus-cap on the resolved MINOR line,
// mirroring NVIDIA_CUDNN_CONSTRAINT's own `~=9.0` shape, and it does not
// exclude 12.8.4.1 (>=12.8.0 is satisfied by any 12.8.x patch). Only a genuine
// minor bump (torch moving off cu128) needs bumping this alongside
// NVIDIA_CUDNN_CONSTRAINT and ONNXRUNTIME_GPU_CONSTRAINT.
//
// PASS 3 REVIEW FIX (N14, PR #2617): admitting 12.8.4.1 is NOT the same as
// resolving to it. pip picks the HIGHEST version this constraint admits
// (12.8.5.5 as of this writing), not torch's own bundled 12.8.4 — so the
// cross-minor collision this comment set out to prevent narrows to an
// intra-minor one (12.8.5.5 vs. 12.8.4.x), not zero. Almost certainly
// ABI-safe within one minor line, but it is a narrowing, not a resolution.
const NVIDIA_CUBLAS_CONSTRAINT = 'nvidia-cublas-cu12~=12.8.0';

// PASS 2 REVIEW FIX (N6, PR #2617): nvrtc DROPPED from this step entirely.
// onnxruntime's own `preload_dlls()` (`_get_nvidia_dll_paths`, read against the
// live sidecar venv) never looks for an nvrtc DLL on the Windows branch at all —
// only cublas/cublasLt/cufft/cudart + the cudnn_* set — nvrtc only appears in
// its Linux branch (alongside curand, which this step has never pinned either).
// So a `nvidia-cuda-nvrtc-cu12` top-level pin bought nothing on Windows: onnxruntime
// never reads it, and cuDNN's own dependency tree already pulls SOME nvrtc build
// in transitively regardless of whether we pin it here, at whatever version pip's
// resolver picks — harmless dead weight on Windows since nothing in this process
// ever loads it. Re-introduce a pin here only alongside real Linux nvidia-profile
// support (curand would need one too, and this step would need to become
// platform-aware — a design question, not this fix's).
//
// CONFIRMED on-box (register row A28, discharged 2026-08-31): onnxruntime's Windows DLL
// list ALSO wants `nvidia/cufft/bin/cufft64_11.dll` and
// `nvidia/cuda_runtime/bin/cudart64_12.dll`, neither of which any pip step
// here installed — the "system CUDA 12.4 toolkit supplies both via PATH"
// working assumption above was FALSE on the real GPU box: a from-scratch
// venv with only cuDNN+cublas installed left onnxruntime's own
// `preload_dlls()` reporting "Failed to load" for both, and real
// `InferenceSession` construction with `CUDAExecutionProvider` silently fell
// back to CPU. Installing these two packages (curand was tried too and
// confirmed NOT needed — dropped, same N6 reasoning as nvrtc above; nvjitlink
// is pulled in transitively by cufft's own dependency tree regardless, so
// it is never pinned directly here either way) fixes it: `preload_dlls()`
// then reports all expected files resolved under `nvidia/<pkg>/bin`, and a
// real `InferenceSession` lands `CUDAExecutionProvider` in
// `get_providers()`.
//
// PASS-1 REVIEW FIX (2026-08-31): the first cut of these two pins
// (`cufft~=11.4.0`, `cuda-runtime~=12.8.0`) was wrong on both counts —
// `~=11.4.0` was pip-latest-on-install-day, not torch's line, and
// `~=12.8.0`, while correctly matching torch's cudart build line, EXCLUDED
// the 12.9.79 version this box's on-box run had actually installed and
// tested against (a floor-plus-cap pin that admits a version different from
// the one the "verified end-to-end" claim was measured on is worse than no
// pin — it looks precise while proving nothing). Re-measured `FileVersion`
// directly against the live venv's `torch/lib` copies: `cufft64_11.dll`
// reports **11.3.3** (`...,1133`), not 11.4.x; `cudart64_12.dll` reports
// **12.8.0** (`...,12080`), confirming that half was already right, just
// untested at the pinned value. Re-pinned both to torch's actual measured
// line (`~=11.3.3`, `~=12.8.0`) and re-verified on real hardware at THESE
// exact resolved versions (`nvidia-cufft-cu12==11.3.3.83`,
// `nvidia-cuda-runtime-cu12==12.8.90`) — same real Kokoro CUDA
// session-construction + real-synth check as the cuDNN/cublas pins above,
// not just a version-string match. Same floor-plus-cap reasoning as cublas's
// own pin (N4): an unpinned/latest install here would risk the same
// intra-process DLL-version mismatch cublas's own pin exists to avoid.
//
// PASS-2 REVIEW NOTE (2026-08-31): the shadowing risk above is scoped to
// mechanism A only — `onnxruntime.preload_dlls()`'s own fixed DLL list,
// which is what every comment on this page has described so far. Since this
// same fix, a SECOND, broader mechanism is also in force:
// `main._add_nvidia_dll_dirs_to_path()` puts every `nvidia/<pkg>/bin`
// directory ahead of torch on the process `PATH`, so ANY bare-name load —
// not just the ones `preload_dlls()` itself makes — now resolves to this
// installer's copy first. That covers several DLL basenames this file does
// NOT pin here, including from `nvidia-cuda-nvrtc-cu12` and
// `nvidia-nvjitlink-cu12` (both pulled in only transitively, by cufft's own
// dependency tree — see the N6 note above for why they're deliberately not
// pinned directly). Re-check this comment, not just the four constants
// below, on any future torch bump.
//
// PASS-3 REVIEW NOTE (2026-09-01): the prior version of this note checked
// only ONE basename pair and generalised from it. Re-measured `FileVersion`
// directly, on the live venv, for THREE basenames mechanism B can shadow:
//   - `nvrtc64_120_0.dll` / `nvJitLink_120_0.dll` (from
//     `nvidia-cuda-nvrtc-cu12`/`nvidia-nvjitlink-cu12`): torch's own
//     `torch/lib` copies and the `nvidia/*/bin` copies both report
//     `FileVersion` 6.14.11.9000 — these two agree, so mechanism B is not
//     currently exposed for them.
//   - `cublas64_12.dll` / `cublasLt64_12.dll` (from
//     `NVIDIA_CUBLAS_CONSTRAINT` above, `~=12.8.0`): torch's `torch/lib`
//     copies report `6,14,11,1284` (12.8.4); the `nvidia/cublas/bin` copies
//     this file installs report `6,14,11,1285` (12.8.5). These DO differ —
//     same-minor, so low practical risk, but the `~=12.8.0` pin permits any
//     12.8.x and does not itself guarantee agreement with torch's specific
//     build the way `NVIDIA_CUDNN_CONSTRAINT`'s tighter `~=9.19.0` does.
//   - `cudnn64_9.dll` from `ctranslate2` (faster-whisper's own bundled
//     copy, `server/tts-sidecar/.venv/Lib/site-packages/ctranslate2/`):
//     reports `9.10.2.21`. The `nvidia/cudnn/bin/cudnn64_9.dll` this file
//     installs (per `NVIDIA_CUDNN_CONSTRAINT`, `~=9.19.0`) reports
//     `9.19.0.56` — a CROSS-MINOR gap (9.10 → 9.19) WIDER than the 9.25→9.19
//     gap this PR exists to fix. Whisper/ASR is the one engine the on-box
//     `Device probe complete: {'kokoro': 'cuda', 'coqui': 'cuda', 'qwen':
//     'cuda'}` run backing this PR did NOT exercise (ASR is off unless
//     `SEG_ASR_ENABLED`), so this shadow is unconfirmed either way in
//     practice — filed as #2845 rather than assumed benign.
// All three shadows pre-date this PR (this PR only widens which of them
// `_add_nvidia_dll_dirs_to_path()`'s PATH prepend can newly reach); nothing
// here pins cross-mechanism agreement the way `NVIDIA_CUDNN_CONSTRAINT` etc.
// pin the packages this file DOES own.
const NVIDIA_CUFFT_CONSTRAINT = 'nvidia-cufft-cu12~=11.3.3';
const NVIDIA_CUDA_RUNTIME_CONSTRAINT = 'nvidia-cuda-runtime-cu12~=12.8.0';

/**
 * Extra pip step(s), if any, needed alongside an ortPackage swap so the
 * installed runtime can actually USE its accelerator, not just report it as
 * available. Gated on ortPackage itself — same gating shape as
 * constrainForInstall — so a future onnxruntime-directml re-enable can never
 * inherit a CUDA-only package. Deliberately NOT `--no-deps`: cuDNN's own
 * dependency tree (cublas) doesn't intersect the overlay's
 * numpy/protobuf/flatbuffers pins, so installing it in full here is safe in a
 * way dropping `--no-deps` on the onnxruntime-gpu step itself is not. Both
 * packages are named in ONE pip step (not `--no-deps`, so this is belt-and-
 * suspenders rather than load-bearing) so pip's resolver treats the pin on
 * the transitive package as a top-level constraint instead of letting an
 * unpinned transitive requirement from cuDNN win the resolution. Pure — no I/O.
 * @returns {string[][]}
 */
export function extraRuntimeSteps(ortPackage) {
  return ortPackage === 'onnxruntime-gpu'
    ? [
        [
          'install',
          NVIDIA_CUDNN_CONSTRAINT,
          NVIDIA_CUBLAS_CONSTRAINT,
          NVIDIA_CUFFT_CONSTRAINT,
          NVIDIA_CUDA_RUNTIME_CONSTRAINT,
        ],
      ]
    : [];
}

/**
 * Decide the ordered pip steps to put the correct ONNX runtime in place after the
 * overlay install. The overlay always lands plain `onnxruntime` (kokoro-onnx's
 * core dep), so any profile whose recipe needs a different ortPackage (nvidia →
 * onnxruntime-gpu; a future DirectML re-enable → onnxruntime-directml) is a swap;
 * a recipe that already wants plain `onnxruntime` (cpu/amd/apple) is a no-op. Pure
 * — no I/O. `steps` are pip sub-command arg arrays, run in order with the venv
 * python. `ortPackage` on the swap variant lets the CLI report which package it
 * actually put in place without re-deriving it (#1844) — a second source of
 * truth there is exactly how the CLI drifted into naming the wrong package.
 * @returns {{action:'skip', reason:string, marker:{action:'delete'}} | {action:'swap', steps:string[][], ortPackage:string, marker:{action:'write'}}}
 */
export function planOrtSwap(profile, platform) {
  const { ortPackage } = installRecipe(profile, platform);
  if (ortPackage === 'onnxruntime') {
    return {
      action: 'skip',
      reason: 'plain onnxruntime from the overlay is correct; no swap',
      marker: { action: 'delete' },
    };
  }
  return {
    action: 'swap',
    ortPackage,
    marker: { action: 'write' },
    steps: [
      // Uninstall BOTH the plain `onnxruntime` the overlay landed AND any cached
      // `ortPackage` first, so the shared `onnxruntime/` namespace directory is
      // fully cleared — then `--force-reinstall` lays ortPackage's files fresh.
      // A plain `install ortPackage` is a NO-OP when ortPackage is already cached
      // (at a skewed version — e.g. the overlay pulls onnxruntime 1.27.0 but
      // onnxruntime-gpu 1.26.0 is in pip's cache): pip reports "already
      // satisfied" and skips, leaving the namespace half-overwritten by the
      // just-uninstalled onnxruntime → `import onnxruntime` breaks (no
      // __version__/get_available_providers) and Kokoro silently fails to load.
      // `--no-deps` keeps the overlay's numpy/protobuf/etc. pins untouched.
      ['uninstall', '-y', 'onnxruntime', ortPackage],
      ['install', '--force-reinstall', '--no-deps', constrainForInstall(ortPackage)],
      // #2600: land the GPU runtime's own cuDNN dependency, which --no-deps
      // above deliberately never installs (see extraRuntimeSteps). A no-op for
      // any ortPackage other than onnxruntime-gpu.
      ...extraRuntimeSteps(ortPackage),
    ],
  };
}

/** Delete our marker. Safe on every plan and every venv shape — the failure
 *  path calls it with a SWAP plan before re-throwing. */
export function applyOrtMarkerDelete(venvDir, _plan) {
  const sp = sitePackagesDir(venvDir);
  if (!sp) return;
  deleteOrtMarkerIfOurs(sp);
}

/** Write the marker. NO-OP unless the plan says write — the skip variant has no
 *  ortPackage, so a write there would glob `undefined-*` and either resolve
 *  nothing or overwrite the REAL plain distribution. */
export function applyOrtMarkerWrite(venvDir, plan) {
  if (plan?.marker?.action !== 'write') return;
  const sp = sitePackagesDir(venvDir);
  if (!sp) throw new Error(`ORT marker: no site-packages under ${venvDir}`);
  const version = readInstalledOrtVersion(sp, plan.ortPackage);
  if (!version) {
    throw new Error(
      `ORT marker: could not read the installed ${plan.ortPackage} version (absent or ambiguous)`,
    );
  }
  writeOrtMarker(sp, version);
}

/** Boot-time self-heal for venvs bootstrapped before the marker existed.
 *  Pure fs: no pip, no network, no subprocess, no `import onnxruntime`.
 *  NEVER throws — its caller runs during server startup. */
export function ensureOrtMarker(venvDir, log = () => {}) {
  // `log` is caller-supplied (index.ts passes console.log by default, but any
  // caller can pass anything). Every call site below goes through this wrapper
  // so a THROWING log can never escape ensureOrtMarker — including from inside
  // the catch block that exists to guarantee this function never throws.
  const safeLog = (msg) => {
    try {
      log(msg);
    } catch {
      /* never let a caller-supplied log defeat the never-throws guarantee */
    }
  };
  try {
    const sp = sitePackagesDir(venvDir);
    if (!sp) return 'noop';
    const owner = detectOrtOwner(sp);
    const realPlain = findPlainOrtDistInfos(sp);

    if (owner === 'swap' && realPlain.length > 0) {
      safeLog(
        '[ort-marker] A stray real plain onnxruntime dist-info coexists with the GPU build\'s files. ' +
          'This corrupts pip\'s dependency resolution — a landmine for the next ' +
          'pip operation. The GPU build\'s files currently own the namespace, but the inconsistency must be repaired. ' +
          'Refusing to write a marker that would certify this bad state. Repair with:\n' +
          '  (PowerShell) $env:CASTWRIGHT_ACCELERATOR_PROFILE=\'<profile>\'; node server/tts-sidecar/scripts/install-ort.mjs <venv-python>\n' +
          '  (POSIX) CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>',
      );
      return 'clobbered';
    }
    if (owner === 'swap') {
      const existing = ortMarkerVersion(sp);
      if (existing !== null) return 'noop';
      const pkg = SWAP_ORT_PACKAGES.find((p) => readInstalledOrtVersion(sp, p) !== null);
      const version = pkg ? readInstalledOrtVersion(sp, pkg) : null;
      if (!version) return 'noop';
      writeOrtMarker(sp, version);
      safeLog(`[ort-marker] recorded onnxruntime ${version} as provided by ${pkg}.`);
      return 'wrote';
    }
    // owner is 'plain' or 'none' — any marker of ours is a lie.
    if (deleteOrtMarkerIfOurs(sp)) {
      if (owner === 'none') {
        safeLog(
          '[ort-marker] No onnxruntime runtime is installed. ' +
            'The recorded swap marker has been removed. Kokoro cannot load at all in this state. ' +
            'Repair with:\n' +
            '  (PowerShell) $env:CASTWRIGHT_ACCELERATOR_PROFILE=\'<profile>\'; node server/tts-sidecar/scripts/install-ort.mjs <venv-python>\n' +
            '  (POSIX) CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>',
        );
      } else {
        // owner === 'plain'
        safeLog(
          '[ort-marker] This venv now uses only plain onnxruntime (CPU build). The recorded swap marker ' +
            'has been removed. Kokoro will run without GPU acceleration.',
        );
      }
      return 'deleted';
    }
    return 'noop';
  } catch (err) {
    safeLog(`[ort-marker] skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 'noop';
  }
}

/** Version recorded by OUR marker, or null when we have not written one. */
function ortMarkerVersion(sitePackages) {
  for (const dir of ortDistInfoDirs(sitePackages)) {
    if (!isOurMarker(dir)) continue;
    const m = /onnxruntime-(.+)\.dist-info$/.exec(dir.replace(/\\/g, '/').split('/').pop());
    if (m) return m[1];
  }
  return null;
}

// See scripts/lib/is-main-module.mjs — an un-realpathed comparison misses
// whenever the invocation path crosses a symlink/junction (#2291).
if (isDirectlyInvoked(import.meta.url)) {
  // Read + validate the venv python path FIRST — both the skip and the swap
  // branch below need venvDir (derived from it) to maintain the #2192 marker,
  // so it can no longer wait until after the skip branch has already exited.
  const python = process.argv[2]; // venv python path
  if (!python) {
    process.stderr.write('[install-ort] FAIL: pass the venv python path as the first arg.\n');
    process.exit(1);
  }
  const venvDir = resolve(join(dirname(python), '..'));

  const profile = process.env.CASTWRIGHT_ACCELERATOR_PROFILE ?? 'nvidia';
  const plan = planOrtSwap(profile, process.platform);
  if (plan.action === 'skip') {
    process.stdout.write(`[install-ort] skip — ${plan.reason}.\n`);
    applyOrtMarkerDelete(venvDir, plan);
    process.exit(0);
  }
  // Delete FIRST, before the first pip call: a stale marker present when the
  // uninstall step below runs would make pip resolve `onnxruntime` against
  // TWO same-name dist-infos (ours + the real one) and can no-op the
  // uninstall, leaving the real plain distribution in place. Mirrors
  // bootstrap-venv.mjs's installForProfile and apply.ts's pipInstall.
  applyOrtMarkerDelete(venvDir, plan);
  for (const step of plan.steps) {
    process.stdout.write(`[install-ort] pip ${step.join(' ')}\n`);
    const code =
      spawnSync(python, ['-m', 'pip', ...step], { stdio: 'inherit', windowsHide: true }).status ?? 1;
    if (code !== 0) {
      process.stderr.write(`[install-ort] FAIL: pip ${step.join(' ')} exited ${code}.\n`);
      applyOrtMarkerDelete(venvDir, plan);
      process.exit(code);
    }
  }
  applyOrtMarkerWrite(venvDir, plan);
  process.stdout.write(`[install-ort] ${plan.ortPackage} in place.\n`);
  process.exit(0);
}
