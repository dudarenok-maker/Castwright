# Wave 3 step 2 — ORT marker rows (A39–A42)

Run against Castwright#2506. Rows per
`docs/testing/onbox-wave3-plan.md`'s Step 2 assignment: A39, A40, A41, A42.
Detailed run-sheet entries live in
`docs/testing/ort-marker-onbox-acceptance.md` §3.3 (A39) and §8.3 (A41); this
file is the summary + defect record the issue asks for.

**Run by:** claude. **Date:** 2026-08-20.

## Live venv safety

Baseline recorded before any work: `server/tts-sidecar/.venv`,
`onnxruntime-gpu` 1.27.0, `pip check` clean, dist-info set
`{onnxruntime-1.27.0.dist-info (marker), onnxruntime_gpu-1.27.0.dist-info}`.

Re-checked after every destructive step below (never run against the live
venv itself — always a throwaway copy at a scratch path): identical version,
identical `pip check` output, identical dist-info set. **Live venv is
byte-unchanged.**

Throwaway venvs used: `a39-venv` (fresh bootstrap via `bootstrap-venv.mjs`)
and `a41-venv` (robocopy of the live venv, then clobbered and repaired). Both
created under this run's scratch directory and **deleted** after their
evidence was captured — confirmed via directory listing after each `rm -rf`.

## Re-resolution note (2026-08-20)

Re-read all four rows in `docs/testing/onbox-acceptance-register.md` against
the live tree before running anything. Nothing excluded — all four rows'
citations (file paths, the `ONNXRUNTIME_GPU_CONSTRAINT` pin at
`server/tts-sidecar/scripts/install-ort.mjs:214`, the `ensureOrtMarker`
branches at `install-ort.mjs:299-336`) still match current code. No prior
step's plan moved any of these four rows.

## A39 — fresh NVIDIA bootstrap

**Verdict: STILL OWED.**

Ran a genuine from-scratch `node scripts/bootstrap-venv.mjs py -3.12` with
`SIDECAR_VENV_DIR` pointed at a throwaway path and `ACCELERATOR=nvidia`
(`server/tts-sidecar/scripts/bootstrap-venv.mjs:243-244` resolves
`SIDECAR_VENV_DIR` before falling back to the canonical path — confirmed by
reading the source before relying on it). Full pip install from empty venv,
including the CUDA 12.8 torch preinstall and the `onnxruntime` → `onnxruntime-gpu`
swap.

- **Marker:** `onnxruntime-1.27.0.dist-info` present, `INSTALLER` =
  `castwright-ort-marker`, `RECORD` 0 bytes — correct version, direct product
  of `installForProfile`'s `applyOrtMarkerWrite`, not the boot-time self-heal
  (no server boot happened in this row). DISCHARGED for this part.
- **`pip check`:** exit 0, `No broken requirements found.` DISCHARGED for
  this part.
- **Kokoro execution provider:** loaded `kokoro_onnx.Kokoro` against the real
  model files (`server/tts-sidecar/voices/kokoro/*`, read-only) from the a39
  venv's interpreter. `onnxruntime.get_available_providers()` correctly lists
  `CUDAExecutionProvider`, but actually creating an inference session with it
  (`ONNX_PROVIDER=CUDAExecutionProvider`) fails and falls back to CPU. **NOT
  DISCHARGED** — see the defect below. This is why the row is STILL OWED
  overall: two of three checks pass, the GPU check does not.

## A40 — the reported bug: in-app Qwen3 install

**Verdict: STILL OWED — not run.**

This row needs the actual app running (`npm start`, NVIDIA profile) and a
real click-through of Model Manager → Qwen engine → Install, against a
throwaway copy of the sidecar venv (the box-safety rule forces a copy even
though the row's own register text doesn't call it out, since the install
writes to the venv). That is full end-to-end UI-driven work — launching the
Electron/web app, driving Model Manager, watching for `WinError 5` — on top
of everything already run for A39/A41 in this heartbeat. Did not attempt it
this run rather than rush a shallow pass; scoping it as its own step is the
honest call, not a shortcut.

Independent of scheduling, this row's final check ("load Kokoro afterward
and confirm it still reports `CUDAExecutionProvider`") would hit the same
CUDA13/cuDNN9 gap documented below, so even a full run today could not fully
discharge it without that dependency gap closed first.

## A41 — ORT marker refuses a clobbered venv

**Verdict: STILL OWED — real defect found; not the one the row expected.**

Manufactured the state on a throwaway copy of the live venv (robocopy, not a
fresh bootstrap — faster and starts from the exact live baseline):

```
python -m pip install --force-reinstall onnxruntime
```

Confirmed the manufactured state exactly as the row's own recipe describes:
`onnxruntime_gpu-1.27.0.dist-info` survives, a **real** plain
`onnxruntime-1.29.0.dist-info` now exists (`INSTALLER pip`, non-empty
RECORD — pip resolved unpinned `onnxruntime` to the current latest, 1.29.0,
not 1.27.0; the row doesn't require version parity here), and
`site-packages/onnxruntime/` genuinely holds the CPU build's files
(`ort.get_available_providers()` → `['AzureExecutionProvider',
'CPUExecutionProvider']`, no CUDA).

Then booted the real worktree server (`npm run dev` equivalent —
`npx tsx watch --include=.env src/index.ts` in `server/`, via `env -C` to set
cwd without a shell `cd`) with `SIDECAR_VENV_DIR` pointed at the clobbered
copy. **Result: no `[ort-marker]` log line at all.** The server booted
normally and listened on its usual port with zero indication anything was
wrong.

### Root cause (real defect, not a test artifact)

`ensureOrtMarker` (`server/tts-sidecar/scripts/install-ort.mjs:299`) decides
the `'clobbered'` branch on `owner === 'swap' && realPlain.length > 0`.
`detectOrtOwner` (`install-ort.mjs:108-127`) determines `owner` by reading
`site-packages/onnxruntime/capi/build_and_package_info.py`'s `package_name`
field *first*, and only falls back to a DLL-presence check
(`onnxruntime_providers_(cuda|rocm)`) when that file is absent or unparsed.
After `pip install --force-reinstall onnxruntime`, that file genuinely reads
`package_name = 'onnxruntime'` (confirmed by direct read) — not in
`SWAP_ORT_PACKAGES` — so `detectOrtOwner` correctly returns `'plain'`, not
`'swap'`.

With `owner === 'plain'`, `ensureOrtMarker` falls through to:

```js
// owner is 'plain' or 'none' — any marker of ours is a lie.
return deleteOrtMarkerIfOurs(sp) ? 'deleted' : 'noop';
```

`'deleted'` is **not** logged anywhere (only `'wrote'` and `'clobbered'` call
`safeLog`). Confirmed on disk: `onnxruntime-1.27.0.dist-info` (the stale
marker) was gone after boot, `onnxruntime_gpu-1.27.0.dist-info` and
`onnxruntime-1.29.0.dist-info` remained — matching the `'deleted'` code path
exactly.

**Why this matters:** the design doc's own words are "the clobbered box
takes the loud path," and #2192 names this population as the largest
affected group. On the state manufactured by this row's own documented
recipe, the box takes the **silent** path instead: no warning, no remedy
command surfaced, and the operator is left running GPU-less inference with
no signal anything changed. That is the exact failure mode #2192 was filed
to prevent, reproduced for real, in the one place that was supposed to catch
it. Fix has more than one defensible outcome, named per the campaign rule
below.

### Repair path (independently verified, works correctly)

Ran the named remedy command directly against the clobbered copy:

```
CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
```

Output: uninstalled both `onnxruntime` 1.29.0 and `onnxruntime-gpu` 1.27.0,
reinstalled `onnxruntime-gpu==1.27.0` (`--no-deps`), wrote the marker —
`[install-ort] onnxruntime-gpu in place.` Post-repair: both dist-infos
correct, marker present at 1.27.0 with the right `INSTALLER`/empty `RECORD`.
`pip check` showed one pre-existing, unrelated `numba`/`numpy` version
warning introduced by this test's own earlier force-reinstall step (pulled a
newer `numpy`) — not a repair defect. Did not re-check Kokoro's provider
after repair: blocked by the same CUDA13/cuDNN9 gap regardless of marker
correctness.

**So:** the remedy command itself is correct and was exercised for real. The
part of A41 that fails is entirely upstream of it — the refuse-and-log
detection never fires for the state the row itself says to manufacture.

### Box hygiene during A41

The server boot spawned a sidecar child process and left one orphaned `node`
process listening on the worktree's own port 8190 after the background task
was stopped (a `tsx watch` child that didn't die with its parent). Found via
`Get-NetTCPConnection -LocalPort 8190` and killed
(`Stop-Process -Id 8964 -Force`) — port 8190 is this worktree's own isolated
slot-11 port per its `.env`, not shared with another lane, so this was safe
cleanup of this run's own leftover, not an intrusion on another agent's
process.

## A42 — in-app upgrade path applies the marker on a real release

**Verdict: STILL OWED — not run.**

Needs a real installed Castwright release (`release/` layout, not this dev
checkout or the sidecar venv) and a way to trigger its upgrade path — building
and installing a packaged release is a substantial task on its own, not
something to fit alongside A39/A41 in one heartbeat. Not attempted this run
rather than produce a shallow, unconvincing pass.

## Defect — CUDA 13 / cuDNN 9 runtime gap blocked every CUDAExecutionProvider check (NOW FIXED)

**Mechanism (as recorded during wave-3 step 2):** `onnxruntime-gpu` was pinned
to `>=1.27,<1.28` (`server/tts-sidecar/scripts/install-ort.mjs:214`,
`ONNXRUNTIME_GPU_CONSTRAINT`). `onnxruntime-gpu` 1.27.0 required CUDA 13.x
and cuDNN 9.x runtime libraries (its own error names them:
`onnxruntime_providers_cuda.dll` depends on `cublasLt64_13.dll`). This box
has only CUDA 12.4 installed system-wide (`C:\Program Files\NVIDIA GPU
Computing Toolkit\CUDA\v12.4`, providing `cublasLt64_12.dll`, not `_13`), and
no pip-vendored CUDA 13 runtime packages appeared in
`server/tts-sidecar/requirements/`. The driver itself (610.88) did support
CUDA 13 — this was a missing-runtime-library gap, not a driver/hardware
limit.

**Observed:** `import onnxruntime as ort; ort.get_available_providers()`
correctly listed `CUDAExecutionProvider` (provider *libraries* were present),
but actually constructing a session with it
(`onnxruntime.InferenceSession(..., providers=['CUDAExecutionProvider', ...])`,
or `kokoro_onnx.Kokoro(...)` with `ONNX_PROVIDER=CUDAExecutionProvider`)
failed with `Error 126: The specified module could not be found` and silently
fell back to `CPUExecutionProvider`. **Reproduced identically against the
live sidecar venv, read-only** (no modification) — not specific to
the throwaway A39/A41 venvs.

**Blast radius:** blocked the "Kokoro reports `CUDAExecutionProvider`" success
criterion for A39, A40, and (indirectly, on re-check) A41 — every row in
this step whose final check is "the app actually renders on GPU."

**Resolution:** PR #2576 fixed this by re-pinning `ONNXRUNTIME_GPU_CONSTRAINT`
to `>=1.26,<1.27` (option 2: CUDA-12 line instead of CUDA-13). The decision
was made and committed 2026-08-21; A39, A40 rows remain STILL OWED (actual
acceptance runs against the fixed pin have not yet been performed), but they
are no longer blocked on an undecided constraint.

## Second defect to route — A41's manufacture recipe doesn't exercise the code path it names

Detailed above under A41. Summary for the fix-routing agent: the register's
own manufacture instructions for A41 (`pip install --force-reinstall
onnxruntime`) produce a state `detectOrtOwner` correctly classifies as
`'plain'`, not `'swap'`, so `ensureOrtMarker` takes the silent `'deleted'`
path instead of the loud `'clobbered'` path the row expects and the design
doc promises. Two separate things are true at once and both are real:

- **The manufacture recipe is not exercising the state the design doc's
  eight-state table means by "clobbered."** A genuinely different sequence
  (one that leaves `site-packages/onnxruntime/capi/build_and_package_info.py`
  still reporting a swap package name — e.g. GPU package files still present
  with only its `.dist-info` folder removed/renamed — rather than a full
  file-level plain reinstall) may be what actually reaches the `'swap' &&
  realPlain.length > 0` branch. Worth re-deriving against the design doc's
  own eight-state table before the next attempt.
- **Even if the recipe is simply wrong, the `'deleted'` branch being
  completely silent is a real gap on its own merits** — a marker silently
  disappearing (regardless of why) with zero log line means an operator has
  no way to notice their GPU path just went away, which is the exact failure
  #2192 was filed against. Worth a decision on whether `'deleted'` should log
  too, independent of the manufacture-recipe question.

Decision owed: whether to (a) fix the register's A41 manufacture recipe to
reach the actual `'clobbered'` branch, (b) add logging to the `'deleted'`
branch regardless, or (c) both. Not choosing this myself — it's a design
call about what "any marker of ours is a lie" should do when it fires.

## Disposition

| Row | Verdict | Notes |
|---|---|---|
| A39 | STILL OWED | marker + pip check DISCHARGED; GPU provider check blocked by CUDA13/cuDNN9 gap |
| A40 | STILL OWED | not run — needs full app + Model Manager UI, own step |
| A41 | STILL OWED | remedy command DISCHARGED; refuse-and-log detection defect found (see above) |
| A42 | STILL OWED | not run — needs a real packaged release directory |

Per the issue: this step does not edit `onbox-acceptance-register.md`, its
live-view HTML, or the staleness audit — step 9 of the wave-3 chain is the
single writer for those.
