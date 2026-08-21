# Wave 4, step 1 — A41 re-run (Castwright#2569)

*Dated run record (2026-08-21). References to #2534 as a blocker in this document are from a prior state; that blocker has been resolved by PR #2576 (which re-pinned `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27`). The row remains owed pending re-run against the fixed pin.*

Acceptance re-run for register row **A41** (`docs/testing/onbox-acceptance-register.md`
§A41), gated on defect [#2535](https://github.com/dudarenok-maker/Castwright/issues/2535)
and its verify child [#2546](https://github.com/dudarenok-maker/Castwright/issues/2546)
(PASSED, opened [PR #2578](https://github.com/dudarenok-maker/Castwright/pull/2578)).
Run against branch `fix/sidecar-2535-ort-marker-fix`, worktree
`C:/Claude/Projects/wt-2535-ort-marker-fix`, at committed HEAD `fe77babd`
(16:28:46) — but with a **local, uncommitted edit to `install-ort.mjs`**
already in place at boot time (16:51:52), containing the corrected clobbered-state
log message wording. This uncommitted edit was later committed as `bd09fcfa`
(17:04:35) which introduced the recorded 452-character log message; the prior
commit `51420399` (the merge at 17:00:54) carried the old 262-character wording,
which the recorded transcript does not match because the run exercised the edit,
not any committed ref.

## Manufacture recipe (per the row's own corrected §8.1 procedure)

**CRITICAL NOTE:** This run uses the INCORRECT recipe version (1.27.0/1.27.0 —
both the same version). This is a separate defect from the ordering issue
wave-3 step 2 exposed. The corrected recipe
verification with 1.28.0 plain and 1.27.0 GPU is documented separately
(`docs/testing/ort-marker-onbox-acceptance.md` §8.5).

Fresh throwaway venv (not a copy of the sidecar's own):

```powershell
python -m venv <venv>
<venv>\Scripts\pip install onnxruntime==1.27.0
<venv>\Scripts\pip install --force-reinstall --no-deps onnxruntime-gpu==1.27.0
```

Confirmed manufactured state via the real `detectOrtOwner`/
`findPlainOrtDistInfos` (imported directly from
`server/tts-sidecar/scripts/install-ort.mjs`):

```
owner=swap
plainCount=1
```

Both `onnxruntime-1.27.0.dist-info` (real, INSTALLER `pip`) and
`onnxruntime_gpu-1.27.0.dist-info` present under `Lib/site-packages`.

## Boot

Booted the real worktree server: `node_modules\.bin\tsx.cmd watch
--include=.env src/index.ts` from `server/`, with `SIDECAR_VENV_DIR` pointed
at the throwaway venv, `PORT=8290` (confirmed free before starting, isolated —
not another lane's port), `LAN_HTTPS_PORT=8544`.

Observed log line at boot:

```
2026-08-21 16:51:52.232 [ort-marker] A stray real plain onnxruntime dist-info coexists with the GPU build's files (which own the namespace). This corrupts pip's dependency resolution — a landmine for the next pip operation. GPU Kokoro is currently working, but the inconsistency must be repaired. Refusing to write a marker that would certify this bad state. Repair with:
  CASTWRIGHT_ACCELERATOR_PROFILE=<profile> node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
2026-08-21 16:51:54.012 [server] listening on http://localhost:8290
```

*Log wording superseded by commit c556f51c; the phrase "GPU Kokoro is currently working" was later removed (the function cannot verify GPU Kokoro's actual status) and replaced with "The GPU build's files currently own the namespace" — see server/src/tts/ort-ensure-marker.test.ts:96-99 for the correction.*

`ensureOrtMarker` returned `'clobbered'` and logged it — exactly the
refuse-and-log branch this row is meant to exercise, and exactly the branch
wave-3 found silent (filed as #2535).

**No marker written over the real distribution** — dist-info listing after
boot unchanged (`onnxruntime-1.27.0.dist-info`, `onnxruntime_gpu-1.27.0.dist-info`).
`pip check` was clean both before and after boot (versions pinned to match
here, unlike wave-3's mismatched-1.29.0 run, so there was nothing for boot to
silently "fix" either way — the marker-refusal is the only observable effect,
same as intended).

Server was stopped cleanly after observing the log (process tree: the
launched `tsx.cmd` PID and its child `node` processes, confirmed by parent-PID
chain before killing — none of them pre-existed my launch).

## Repair

Ran the named remedy command directly against the throwaway venv:

```
$ CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node server/tts-sidecar/scripts/install-ort.mjs <venv-python>
[install-ort] pip uninstall -y onnxruntime onnxruntime-gpu
Found existing installation: onnxruntime 1.27.0
Uninstalling onnxruntime-1.27.0: Successfully uninstalled onnxruntime-1.27.0
Found existing installation: onnxruntime-gpu 1.27.0
Uninstalling onnxruntime-gpu-1.27.0: Successfully uninstalled onnxruntime-gpu-1.27.0
[install-ort] pip install --force-reinstall --no-deps onnxruntime-gpu>=1.27,<1.28
Successfully installed onnxruntime-gpu-1.27.0
[install-ort] onnxruntime-gpu in place.
```

Post-repair:

```
$ pip check
No broken requirements found.

owner=swap
plainCount=0
```

`onnxruntime-1.27.0.dist-info` (now the marker, not a real plain
distribution) and `onnxruntime_gpu-1.27.0.dist-info` present;
`findPlainOrtDistInfos.length === 0` confirms the stale real-plain
distribution is gone and only our marker remains — the box is genuinely
repaired.

**Kokoro execution provider after repair:** not independently re-tested
beyond `get_available_providers()`, which lists `CUDAExecutionProvider` and
`TensorrtExecutionProvider`. Constructing a real inference session was not
attempted — this box has only CUDA 12.4 system-wide while `onnxruntime-gpu`
1.27 needs CUDA 13.x/cuDNN 9.x, the same gap documented for A39/A40
([#2534](https://github.com/dudarenok-maker/Castwright/issues/2534)), not a
new gap from this fix.

## Verdict

**PASS for the filed defect.** The silent `'deleted'` path #2535 was filed
against is gone: the loud `'clobbered'` path fires with the exact remedy
command, and the remedy genuinely repairs the box. The row stays **STILL
OWED** in the register only because its own criteria include the
CUDA-execution-provider re-check, which remains blocked by the pre-existing
`#2534` box gap — same precedent as A39, not a new failure.

## Box hygiene

- The live sidecar venv at `server/tts-sidecar/.venv` (in the main repo
  checkout `C:/Claude/Projects/Audiobook-Generator` — this worktree has no
  `.venv` of its own) was never touched. Confirmed: its `python.exe` mtime
  (2026-07-03) predates this entire session and was unchanged throughout.
- Found load-bearing, already-staged (uncommitted) changes to
  `server/tts-sidecar/scripts/install-ort.mjs` and
  `server/src/tts/ort-ensure-marker.test.ts` in this worktree at claim time
  (the message-wording improvement to the `'clobbered'` log line, mtime
  predating this run) — this is the exact edit the run exercised, explaining
  why the recorded transcript shows the new wording. Left completely untouched
  throughout: temporarily `git stash push` on just those two paths to allow
  merging `origin/main` cleanly (origin/main does not touch either file, so
  the merge was risk-free for them), then `git stash pop` + re-`git add` to
  restore them to their original staged state, byte-for-byte. Not committed
  as part of this task — they belong to whoever is mid-edit on them.
- Server boot used an isolated port (`8290`, `8544`), confirmed free before
  starting and not another lane's port. Process tree fully torn down after
  each boot via parent-PID chain (never a bare `taskkill` by name).
- No GPU activity, real book data, or golden-audio baseline touched.

## Register update

- `docs/testing/onbox-acceptance-register.md` — added a dated wave-4 note
  under A41 and a recompute note under "At a glance" (74 owed, unchanged —
  A41 does not leave the count since it stays STILL OWED).
- `docs/testing/ort-marker-onbox-acceptance.md` — added run-sheet §8.4 with
  the full re-run record.
- `docs/testing/onbox-acceptance-register-live-view.html` — added the
  matching wave-4 flag to A41's entry.
- `npm run check:onbox-register` — green (see commit).
