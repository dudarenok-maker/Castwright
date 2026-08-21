# Wave 4 step 8 — A39/A40 re-run after #2534 (Castwright#2568)

Re-run of the A39 third check ("load Kokoro afterward and confirm it still
reports `CUDAExecutionProvider`") and the shared A40 final check, gated on
defect #2534. Filed by wave 4 step 5 (#2554), part of the on-box register
campaign (#2435).

**Run by:** claude. **Date:** 2026-08-21.

## Commit run against

`6e4eac6c0129b68e8ff47db7b1503f31344248ab` — the head of PR #2576
(`fix/sidecar-2534-ort-cuda12-pin`), which re-pinned
`ONNXRUNTIME_GPU_CONSTRAINT` in `server/tts-sidecar/scripts/install-ort.mjs`
to `>=1.26,<1.27`. PR #2576 merged into `main` before this run started
(merge commit `4bb738d2d2b1ddb26c8a0b21b4434abf77231419`); its own fix
branch and worktree no longer exist, so this re-run works on a fresh branch
off `origin/main` at that merge commit instead of the branch named in the
original filing (see "Which branch" below).

## Live venv safety

Baseline recorded before any work: `server/tts-sidecar/.venv`,
`onnxruntime-gpu` 1.27.0, `pip check` clean, dist-info set
`{onnxruntime-1.27.0.dist-info (marker), onnxruntime_gpu-1.27.0.dist-info}`.
Re-checked after all work below: identical version, identical `pip check`
output, identical dist-info set. **Live venv is byte-unchanged.**

Throwaway venv used: a full copy of the live venv (robocopy, not a fresh
bootstrap — this check only needs the fixed onnxruntime-gpu pin in place,
not a from-scratch install; that broader check is A39's first two parts,
already discharged in wave 3). Created under this run's scratch directory
and deleted after evidence was captured — confirmed via directory listing
after `rm -rf`.

## Which branch

The original filing (#2568) named `fix/sidecar-2534-ort-cuda12-pin`
(worktree `C:/Claude/Projects/wt-2534-ort-cuda12-pin`) as the branch to
commit this discharge to, so it would land in the same PR as the fix. By the
time this run executed, that PR (#2576) had already merged and its branch
and worktree were gone (deleted post-merge) — the fix itself is now on
`main`. This run instead opened a new worktree/branch,
`docs/onbox-2568-a39-a40-rerun`, off `origin/main`, and this PR targets
`main` directly rather than amending a merged one.

## Procedure

1. Copied the live sidecar venv to a throwaway path (robocopy).
2. Removed the stale `onnxruntime-1.27.0.dist-info` marker and the
   `onnxruntime_gpu-1.27.0.dist-info` distribution from the throwaway copy.
3. Ran `CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node
   server/tts-sidecar/scripts/install-ort.mjs <throwaway-venv-python>` — the
   real production swap path, not a hand-rolled pip install. It force-
   reinstalled `onnxruntime-gpu>=1.26,<1.27` (resolved to 1.26.0) with
   `--no-deps` and wrote the marker.
4. Confirmed marker + `pip check`:
   - `onnxruntime-1.26.0.dist-info` present, `INSTALLER` =
     `castwright-ort-marker`, `RECORD` 0 bytes — version matches the
     installed `onnxruntime-gpu` (1.26.0).
   - `pip check`: exit 0, `No broken requirements found.`
5. Loaded Kokoro's real model files
   (`server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx` +
   `voices-v1.0.bin`, read-only) from the throwaway venv's interpreter, both
   via a direct `onnxruntime.InferenceSession(..., providers=
   ["CUDAExecutionProvider", "CPUExecutionProvider"])` and via
   `kokoro_onnx.Kokoro(..., providers=[...])` (the same call shape
   `main.py`'s `_ensure_loaded` uses).

## Result — third check (A39) / shared final check (A40)

**FAIL — same symptom family as wave 3, root cause is more specific now.**

- `onnxruntime.get_available_providers()`: still correctly lists
  `CUDAExecutionProvider` (unchanged from wave 3).
- Actual `InferenceSession` construction with
  `providers=["CUDAExecutionProvider", "CPUExecutionProvider"]`: **falls
  back to `CPUExecutionProvider`** — same as `kokoro_onnx.Kokoro`'s own
  session. onnxruntime logs the reason explicitly:

  ```
  Error loading ".../onnxruntime/capi/onnxruntime_providers_cuda.dll"
  which depends on "cudnn64_9.dll" which is missing. (Error 126: "The
  specified module could not be found.")
  Failed to create CUDAExecutionProvider. Require cuDNN 9.* and CUDA 12.*,
  and the latest MSVC runtime.
  ```

- **The #2534/#2576 pin fix does not close this gap.** Re-pinning to
  `onnxruntime-gpu>=1.26,<1.27` swapped which onnxruntime-gpu build is
  installed, but 1.26.0's own wheel metadata still requires cuDNN **9.x**
  (`Requires-Dist: nvidia-cudnn-cu12~=9.0; extra == "cudnn"` in its
  `METADATA` — confirmed by direct read) — the original wave-3 diagnosis
  ("1.27 needs CUDA 13/cuDNN 9, so pin back to the CUDA-12 line") doesn't
  hold: **1.26 needs cuDNN 9 too.** The actual dependency chain: `nvidia-
  cudnn-cu12` is only pulled in via onnxruntime-gpu's optional `[cudnn]`
  extra, which `install-ort.mjs` never requests, and which `--no-deps`
  would skip even if it did. No system-wide `cudnn64_9.dll` exists on this
  box either — the only copies present anywhere are bundled inside other
  packages' own directories (`torch/lib/cudnn64_9.dll`,
  `ctranslate2/cudnn64_9.dll` in the *live* venv), which onnxruntime's CUDA
  provider does not search.
- **Diagnostic (not a fix attempt):** added `torch/lib` to the process DLL
  search path via `os.add_dll_directory` before constructing the session
  (torch's own bundled `cudnn64_9.dll` matches the version onnxruntime asks
  for). This did **not** resolve it — same `Error 126` on the same DLL. The
  proximate `pip install nvidia-cudnn-cu12~=9.0` diagnostic to confirm the
  extra alone would fix it could not be run — this box's pip has no network
  route to PyPI (`getaddrinfo failed` on `files.pythonhosted.org`) — so the
  precise fix (the `[cudnn]` extra, a vendored wheel, or a working DLL
  search path into an existing bundle) is not confirmed here, only the
  failure mode.

## Disposition

**A39 (third check): STILL OWED.** Marker version and `pip check` parts
remain discharged from wave 3; the GPU-provider part still fails, now for a
more specific, confirmed reason (missing `nvidia-cudnn-cu12` / no reachable
cuDNN 9 runtime) rather than the CUDA-13-vs-12 pin mismatch #2534 fixed.

**A40 (final check, shared root cause): STILL OWED.** Its Kokoro-provider
sub-check hits the identical gap; the in-app Qwen3 install-and-click-through
part of A40 is out of scope for this issue (see #2561) and was not
attempted.

**Zero discharges this run** — a legitimate outcome per this issue's own
governing rule: a row comes out only if the acceptance actually ran and
passed.

## Follow-up

The register note below names the residual gap as its own defect, separate
from #2534 (which is closed/merged and did fix the CUDA-13-vs-12 mismatch
it targeted — this is a different dependency omission it happened to
share a symptom with, not a reopening of #2534).
