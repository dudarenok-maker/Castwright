# ORT acceptance step B — A38 (register calls it A39 in this brief's stale numbering)

**Row:** *ORT marker refuses — not repairs — a clobbered venv* ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../../features/282-ort-pip-consistency-marker.md)). Identified by title, not number — Castwright#2620's brief called this row A39; PR #2626 (wave 5, merged 05:22Z 2026-08-23) renumbered Group A and this row is **A38** on `main` as of this run. Run by: claude (Castwright#2620).

**Date:** 2026-08-23.

**VERDICT: DISCHARGED** — the refuse-and-log branch fires exactly as designed against a real, previously-clean production venv, a manufactured silent-repair check found no repair, and the live sidecar venv is confirmed byte-identical before and after.

## What makes this run different from prior A38 verifications

Every earlier pass at this row (wave-3 step 2, wave-4 §8.4, wave-5 §8.5 in `ort-marker-onbox-acceptance.md`) manufactured the clobbered state in a **fresh throwaway venv** (`python -m venv`). This run instead used a **full copy of the real, currently-in-service sidecar venv** (`C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv`, 6.2 GB, 56,542 files) — a more realistic target, since that is the box `ensureOrtMarker` actually runs against at boot. Per the issue's explicit instruction, the live venv itself was never touched: it was copied, the copy was clobbered and later destroyed, and the original was byte-verified unchanged before and after.

## Dependency check (issue's step 1)

Confirmed on `wt-2623-ort-acceptance` before running anything (the issue's own body records this as already promoted/merged, verified independently here):

```
$ grep -n "extraRuntimeSteps\|nvidia-cudnn-cu12" server/tts-sidecar/scripts/install-ort.mjs
271:const NVIDIA_CUDNN_CONSTRAINT = 'nvidia-cudnn-cu12~=9.0';
348:export function extraRuntimeSteps(ortPackage) {
350:    ? [['install', NVIDIA_CUDNN_CONSTRAINT, NVIDIA_CUBLAS_CONSTRAINT]]
395:    ...extraRuntimeSteps(ortPackage),
```
`preload_dlls` is present in `main.py` (`_preload_ort_cuda_dlls`, referenced in this file's own comments at line 232). Both present — proceeded.

This row's own criteria (design doc §On-box acceptance item 6, the eight-state table, "the clobbered box takes the loud path") are about `ensureOrtMarker`'s refuse behaviour, **not** GPU execution — no CUDA `InferenceSession` construction was needed or attempted here, consistent with the row's own "no GPU needed" tag.

## Procedure actually executed

Full script: `a38-run.ps1` (session scratch), launched detached, polled to completion (~110s wall clock for a full copy + 3 pip installs of a 6.2 GB venv). Commands and real output below are the actual detached-run transcript, not a summary.

### 1. Baseline snapshot of the LIVE venv (before touching anything)

```
PythonExeHash   : 0B471133E110CFB53A061CAD528CE8E517D7B9AC41A0A396C39AD795A487FC14
OrtDirs         : onnxruntime,onnxruntime_gpu-1.27.0.dist-info,onnxruntime-1.27.0.dist-info
MarkerInstaller : castwright-ort-marker
CapiInfoHash    : E86D58939FCCF854E5513BA9F166872F5C8C0F9CD5AE707F1D62B24BB0DD8325
TotalFileCount  : 56542
TotalSizeBytes  : 6483355726
```
The live venv was already clean going in: `onnxruntime-1.27.0.dist-info`'s `INSTALLER` file reads `castwright-ort-marker` — it is our own legitimate marker, not a real plain distribution.

### 2. Copy, never the live venv

`robocopy <live> <scratch>\venv-copy /E /R:1 /W:1 /NFL /NDL /NJH /MT:8` (exit code 1 = files copied, no mismatches — a normal robocopy success code, not an error).

### 3. Manufacture the clobbered state on the COPY

```
pip install onnxruntime==1.28.0
...
Successfully installed onnxruntime-1.27.0        <- pip's own summary line; see note below
```
```
pip install --force-reinstall --no-deps onnxruntime-gpu==1.27.0
...
Successfully installed onnxruntime-gpu-1.27.0
```

**Note on the odd first summary line:** pip printed `Successfully installed onnxruntime-1.27.0` for the `==1.28.0` install (it fetched and used the `1.28.0` wheel — visible in the `Collecting`/`Using cached` lines just above — but its final summary line named the version already recorded in the pre-existing marker dist-info, which pip's uninstall step reported `Can't uninstall 'onnxruntime'. No files were found to uninstall.` for, since the marker's `RECORD` is deliberately empty). This is pip console-output noise, not ground truth. Ground truth was checked programmatically in the next step, using the exact `detectOrtOwner`/`findPlainOrtDistInfos` functions under test, not pip's stdout.

### 4. Confirm the manufactured state (ground truth, not pip's stdout)

```
detectOrtOwner: swap
findPlainOrtDistInfos: ["...\\venv-copy\\Lib\\site-packages\\onnxruntime-1.28.0.dist-info"]
```
Directory listing: `onnxruntime`, `onnxruntime_gpu-1.27.0.dist-info`, `onnxruntime-1.27.0.dist-info` (pre-existing marker, untouched), `onnxruntime-1.28.0.dist-info` (the just-installed **real** plain distribution — discriminable by version from the marker, exactly the property the corrected recipe requires). `pip check`: clean (nothing else in this venv depends on a specific `onnxruntime` version to conflict with).

### 5. The refuse-vs-repair distinction — designed so a silent repair would be visible

Took a directory listing and a SHA-256 of the real plain dist-info's `METADATA` **immediately before and immediately after** calling `ensureOrtMarker` — the exact boundary where a "successful" repair or an unwanted deletion would show up. A repair (writing a legitimate marker) would remove or rename `onnxruntime-1.28.0.dist-info`; a wrong ownership predicate taking the silent `'deleted'` branch (the historical #2535 defect) would remove `onnxruntime-1.27.0.dist-info` (or, on a real box, print no log line at all despite `ensureOrtMarker` running). Neither is exception-shaped, so a bare try/catch around the call would not have caught either — the diff is the discriminating check.

```
=== CALL ensureOrtMarker ===
RETURN_VALUE: clobbered
LOG_LINES_START
[ort-marker] A stray real plain onnxruntime dist-info coexists with the GPU build's files. This corrupts pip's dependency resolution — a landmine for the next pip operation. The GPU build's files currently own the namespace, but the inconsistency must be repaired. Refusing to write a marker that would certify this bad state. Repair with:
  (PowerShell) $env:CASTWRIGHT_ACCELERATOR_PROFILE='<profile>'; node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
  (POSIX) CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
LOG_LINES_END

=== directory listing + METADATA hash, before vs after ===
before: onnxruntime, onnxruntime_gpu-1.27.0.dist-info, onnxruntime-1.27.0.dist-info, onnxruntime-1.28.0.dist-info
after:  onnxruntime, onnxruntime_gpu-1.27.0.dist-info, onnxruntime-1.27.0.dist-info, onnxruntime-1.28.0.dist-info
plain 1.28.0 METADATA hash before: 0DC3C5ECCDB5AE4D121390131D3DB0FF3A077BBDC1E5530B862D85DF14D783B7
plain 1.28.0 METADATA hash after:  0DC3C5ECCDB5AE4D121390131D3DB0FF3A077BBDC1E5530B862D85DF14D783B7
SILENT-REPAIR CHECK: directory listing identical before/after — no marker written, no files removed.
SILENT-REPAIR CHECK: plain dist-info METADATA hash unchanged.
```

**Verdict on the distinction:** `ensureOrtMarker` **refuses** — it returns `'clobbered'`, logs the condition and the exact remedy command, and provably touches nothing on disk (identical directory listing and identical file hash before/after the call). It does not repair, silently or otherwise. `pip check` stayed clean throughout this branch, matching the design doc's own note that a throwaway venv with no other consumer of `onnxruntime` has nothing for a silent "fix" to appear to correct — the discriminating evidence here is the file-level diff, not `pip check`.

### 6. The named remedy command (separate code path, run to confirm it still works)

```
[install-ort] pip uninstall -y onnxruntime onnxruntime-gpu
Successfully uninstalled onnxruntime-1.28.0
Successfully uninstalled onnxruntime-gpu-1.27.0
[install-ort] pip install --force-reinstall --no-deps onnxruntime-gpu>=1.26,<1.27
Successfully installed onnxruntime-gpu-1.26.0
[install-ort] pip install nvidia-cudnn-cu12~=9.0 nvidia-cublas-cu12~=12.8.0
Successfully installed nvidia-cublas-cu12-12.8.5.5 nvidia-cuda-nvrtc-cu12-12.9.86 nvidia-cudnn-cu12-9.24.0.43
[install-ort] onnxruntime-gpu in place.
```
Post-repair: `detectOrtOwner: swap`, `findPlainOrtDistInfos: []` (stale real plain distribution gone, only the GPU build remains), `pip check`: clean. The repair command works correctly, matching every prior verification of this half of the row.

### 7. Delete the copy, byte-verify the live venv

```
Copy removed: True

PythonExeHash   : 0B471133E110CFB53A061CAD528CE8E517D7B9AC41A0A396C39AD795A487FC14
OrtDirs         : onnxruntime,onnxruntime_gpu-1.27.0.dist-info,onnxruntime-1.27.0.dist-info
MarkerInstaller : castwright-ort-marker
CapiInfoHash    : E86D58939FCCF854E5513BA9F166872F5C8C0F9CD5AE707F1D62B24BB0DD8325
TotalFileCount  : 56542
TotalSizeBytes  : 6483355726

LIVE VENV UNCHANGED: True
```
Every field (venv `python.exe` SHA-256, the `onnxruntime*` dist-info directory set, the marker's `INSTALLER` content, a SHA-256 of `onnxruntime/capi/build_and_package_info.py`, and the venv's total file count and total byte size across all 56,542 files) is identical before and after. The live venv was not touched.

## What this run does not claim

This row's own criteria do not require a GPU-provider check (it is tagged "no GPU needed, sidecar venv only" and is about refusal behaviour, not execution). No `InferenceSession` was constructed here and none was needed — that check belongs to A36/A37, both already run in Castwright#2621 (this chain's predecessor).

## Not in scope, not touched

A36, A37, A40 (per the issue's "Not in scope" list) — not touched. No fix was made to anything; nothing was found broken in passing beyond the already-known, already-documented pip-summary-line noise described in step 3 above, which is cosmetic and does not affect `ensureOrtMarker`'s correctness.

**No register edit made**, per the issue's acceptance criteria.
