# Wave 4, step 1 — A41 re-run (Castwright#2569)

Acceptance re-run for register row **A41** (`docs/testing/onbox-acceptance-register.md`
§A41), gated on defect [#2535](https://github.com/dudarenok-maker/Castwright/issues/2535)
and its verify child [#2546](https://github.com/dudarenok-maker/Castwright/issues/2546)
(PASSED, opened [PR #2578](https://github.com/dudarenok-maker/Castwright/pull/2578)).
Run against branch `fix/sidecar-2535-ort-marker-fix`, worktree
`C:/Claude/Projects/wt-2535-ort-marker-fix`, at commit `5142039` — this is the
merge commit created during this run to bring the branch's docs up to date
with `origin/main` (51 commits behind at claim time; the merge touched
neither `install-ort.mjs` nor its test file).

## Manufacture recipe (per the row's own corrected §8.1 procedure)

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
- Found unrelated, already-staged (uncommitted) changes to
  `server/tts-sidecar/scripts/install-ort.mjs` and
  `server/src/tts/ort-ensure-marker.test.ts` in this worktree at claim time
  (a message-wording improvement to the same `'clobbered'` log line, mtime
  predating this run) — left completely untouched throughout: temporarily
  `git stash push` on just those two paths to allow merging `origin/main`
  cleanly (origin/main does not touch either file, so the merge was risk-free
  for them), then `git stash pop` + re-`git add` to restore them to their
  original staged state, byte-for-byte. Not committed as part of this task —
  they belong to whoever is mid-edit on them.
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
