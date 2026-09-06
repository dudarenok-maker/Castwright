# A29 step 3 — post-fix re-verify of the genuine Qwen3 install click-through

Worktree: `wt-2192-a29-verify-fix` @ branch `fix/ops-2192-a29-verify-fix`, rebased onto
post-merge `main` (`ddf1441c`, PR #3043's own merge commit), isolated ports
(`VITE_PORT=5599`, `PORT=8599`/`VITE_API_PORT=8599`, `LOCAL_TTS_PORT=9599` — reassigned
from `wt-new.mjs`'s slot-17 defaults `5343`/`8250`/`9170` after those collided with
another live worktree's app, `wt-mechanical-batch-2`; see "Port collision" below). This
is the re-verify child of chain #2913 → #3020 → #3019 → #3038 → #3039 → **#3040 (this
pass)**: #3020 genuinely reproduced `WinError 5` on the in-app Qwen3 install
click-through (`docs/testing/onbox-a29-results/step-2-genuine-install.md`); #3039/PR
#3043 fixed the root cause (the installer never stopped the sidecar before running
`pip`, so `qwen-tts`'s transitive `onnxruntime` wheel could not replace the live
sidecar's memory-mapped DLL). This pass repeats #3020's exact procedure against the
merged fix.

## Correction made mid-pass — the first run tested the wrong code

`node scripts/wt-new.mjs fix/ops-2192-a29-verify-fix --from main` branches from the
**local** `main` ref, not `origin/main`. This box's local `main` was stale at
`f497df13` (predates PR #3043) even though `origin/main` was already at `ddf1441c`
(confirmed via `git fetch origin main` before starting) — `wt-new.mjs --from main`
silently used the stale local ref. The first install click-through pass ran to
completion against that stale code (no `withSidecarHeld` in
`server/src/tts/qwen-install-bootstrap.ts`) and reported no `WinError 5` — a result
that proves nothing about the fix, since the fix wasn't present. Caught by grepping the
tested file for `withSidecarHeld` after the fact and finding zero matches.

**Fix applied before recording any result:** fast-forwarded the primary checkout's local
`main` to `origin/main` (`git merge --ff-only origin/main`, safe — no tracked-file
changes were pending there), then `git rebase local/main` on this branch. Confirmed the
fix landed: `grep withSidecarHeld server/src/tts/qwen-install-bootstrap.ts` now matches
(e.g. `return supervisor ? supervisor.withSidecarHeld(fn) : fn();`). Re-ran the entire
click-through end to end against the rebased worktree (HEAD `b50f2ce7` at the time of
the redo) — the run recorded below. The first, invalid pass's screenshot/timestamps were
discarded and replaced with this redo's.

## Summary

| Check | Result |
|---|---|
| #3039's fix (PR #3043) confirmed merged to `main`, AND confirmed present in the actual worktree tested | **CONFIRMED** — `ddf1441c` is this branch's own rebase parent; `withSidecarHeld` greps present in the tested `qwen-install-bootstrap.ts` (see correction above) |
| Qwen3 genuinely absent before the click | **CONFIRMED** — live `packageFault: "missing"` probe, after a fresh venv bootstrap that (as expected — `nvidia-cuda.txt` lists `qwen-tts` directly) installed it, followed by a deliberate `pip uninstall qwen-tts -y` and reprobe |
| Install exercised for real vs no-op | **REAL** — genuine `POST /api/qwen/install` → `202 Accepted`, not the `installed`-short-circuit no-op |
| `WinError 5` / `Access is denied` occurred | **NO** — pip step completed cleanly, package present on disk immediately after |
| Install outcome | **`installed`** — `"step":"Done. Qwen3-TTS installed."`, `"error":null` |
| Kokoro CUDA health afterward (live session, not `get_available_providers()`) | **`devices.kokoro: "cuda"`**, confirmed with the model actually loaded (`kokoro_loaded: true`) — also a positive change vs. the pre-fix pass, which read `"cpu"` |
| Box-safety | No shared/box-wide resource touched; another live lane's ports were found colliding and this worktree was moved off them without touching that lane's process |

**Verdict: PASS**, against the genuinely fixed code (post rebase-and-redo above). The fix
closes the gap #3020 found. Row A29 is discharged below.

## Part 1 — fresh worktree, fresh venv, confirming Qwen3 genuinely absent

Bootstrapped the sidecar venv for real — `node
server/tts-sidecar/scripts/bootstrap-venv.mjs py -3.12` — which took several minutes
(torch 2.11.0+cu128, onnxruntime-gpu 1.26.0, cuDNN 9.19, cuBLAS 12.8, etc. — multi-GB,
mostly from the box's local pip cache). Per `nvidia-cuda.txt:70`, this base bootstrap
**installs `qwen-tts` directly** (it is not gated behind the in-app Install button on
the CUDA profile) — confirmed present immediately after bootstrap:

```
$ .venv/Scripts/python.exe -c "import qwen_tts"   → succeeds, "qwen present"
```

To reach the genuine pre-#2192 precondition (package missing), deliberately uninstalled
it before each app start, matching #3020's Part 1b procedure (done twice — once for the
invalid stale-main pass, once again after the rebase, since the rebase touched no venv
state):

```
$ .venv/Scripts/python.exe -m pip uninstall qwen-tts -y
Successfully uninstalled qwen-tts-0.1.1
$ Test-Path .venv/Lib/site-packages/qwen_tts   → False
```

Junctioned `server/tts-sidecar/voices/` from the primary checkout (per CLAUDE.md
"Worktree setup" step 2) so Kokoro's weights are present — `.venv` was deliberately
**not** junctioned, since this pass needs its own independently-bootstrapped venv.

## Port collision — this worktree's assigned slot was already live elsewhere

`wt-new.mjs` assigned slot 17 (`VITE=5343`, `API=8250`, `TTS=9170`). Starting `npm run
dev` here produced `Port 8250 is already in use`, and the process actually answering
`curl http://127.0.0.1:8250/...` belonged to `node.exe` PID 30828 —
`Get-CimInstance Win32_Process` showed its command line rooted at
`C:\Claude\Projects\wt-mechanical-batch-2`, an unrelated, live worktree, with its own
sidecar (`python.exe` PID 33704) on `:9170`. Per the standing rule against disrupting
another agent's live process, neither PID was touched. Instead: stopped only this
worktree's own (not-yet-fully-started) process tree, confirmed no other port in the
`5xxx`/`8xxx`/`9xxx` range was in use box-wide (`netstat -ano`), and reassigned this
worktree to genuinely free ports by editing `.env.local` and `server/.env` directly:
`VITE_PORT=5599`, `PORT=8599`/`VITE_API_PORT=8599`, `LOCAL_TTS_PORT=9599`,
`PLAYWRIGHT_PORT=5600`. Restarted cleanly — no "already in use" on the retry, and
`:8250`/`:9170` were never queried or touched again by this pass.

**Live re-confirmation on the new ports (post-rebase run):**

```
$ curl http://127.0.0.1:8599/api/setup/models-status
{"engines":{"qwen":{"state":"package-missing","packageBroken":false,"packageFault":"missing"}, ...}}
```

`packageFault: "missing"` — the sidecar's own live probe, the same signal
`src/components/qwen-install.tsx` gates the Install button on.

## Part 2 — the real click, via Playwright (against the rebased, genuinely-fixed code)

Navigated to `http://127.0.0.1:5599/#/models` (Model Manager; page footer confirmed
commit `b50f2ce7`). With the package genuinely missing, the "Qwen3-TTS Base (0.6B)" row
rendered the `qwen-install-missing` branch:

> **The Qwen package is missing** — The voice engine confirmed the Qwen package is not
> installed. Install reinstalls it. `[Install Qwen3-TTS]`

Clicked **Install Qwen3-TTS** for real (Playwright `browser_click` on the actual
button, not a synthesized API call). Network trace confirms a genuine job:

```
POST /api/qwen/install           → 202 Accepted
GET  /api/qwen/install/1 (polling)
```

`startedAt=1788736172154` → the first poll ~9s later already showed `"step":"Pre-fetching
3 model(s) into the default Hugging Face cache (~1.8 GB 0.6B-Base + ~3.4 GB 1.7B-Base +
~3.4 GB VoiceDesign; expect a few min)..."` — meaning the `pip install qwen-tts` step
(the one #3020 found failing with `WinError 5`) had **already completed successfully**
by that point, inside the fix's `withSidecarHeld` window. Confirmed directly on disk
immediately after:

```
$ .venv/Scripts/python.exe -m pip show qwen-tts
Name: qwen-tts
Version: 0.1.1
```

**No `WinError 5`, no `Access is denied`, on any `.dll` under
`site-packages/onnxruntime/capi/`.** The job ran to completion end-to-end:

```json
{"id":"1","status":"installed","step":"Done. Qwen3-TTS installed.","error":null,
 "startedAt":1788736172154,"updatedAt":1788736243993}
```

(~72 seconds total, dominated by the multi-GB HF model prefetch, not the pip step.) UI
reflected it live: "Qwen3-TTS Base (0.6B)" → **Installed**, and the row's own status
panel read "Qwen3-TTS is installed — Bespoke per-character voices are available."
Screenshot: `screenshots/step3-1-qwen-installed-post-fix.png` (captured against the
rebased, `b50f2ce7` run).

## Part 3 — Kokoro CUDA health afterward

Checked `GET http://127.0.0.1:9599/health` (the sidecar's own live status, not
`get_available_providers()`) before and after actually loading Kokoro:

```
Before load: "kokoro_loaded": false, "devices": {"kokoro": "cuda", ...}
```

Loaded Kokoro for real via the Model Manager UI ("Load model"), then rechecked:

```
After load:  "kokoro_loaded": true,  "devices": {"kokoro": "cuda", "coqui": "cuda", "qwen": "cuda"}
```

**`devices.kokoro: "cuda"` confirmed with a live, loaded session** — not merely the
provider that would be selected. This is a genuine improvement over the pre-fix pass
(`step-2-genuine-install.md` Part 4), which read `"cpu"` throughout and traced it to
`qwen-tts`'s pip resolution pulling the plain `onnxruntime` wheel over the venv's
`onnxruntime-gpu`. PR #3043's `ort-restore.ts` step — which reruns the ONNX-runtime
GPU-wheel restore inside the same sidecar-held window, on both the installer-success
and installer-failure paths — appears to have closed that side gap as well, though
confirming that mechanism in detail is outside this pass's scope (this pass only
re-ran the acceptance check the row specifies).

## Restoration / box-safety

- This worktree's own server/sidecar/vite processes are this pass's only footprint;
  another live lane's ports (`:8250`, `:9170`) were identified and left completely
  untouched (see "Port collision" above) — no `killTree`, no restart, no probe beyond
  a single read-only `netstat`.
- No shared/box-wide file was touched — only this worktree's own `server/tts-sidecar/.venv`
  (freshly bootstrapped, isolated per-worktree), its own `server/.env`/`.env.local`, and
  the primary checkout's local `main` ref (a safe fast-forward to `origin/main`, with no
  pending tracked-file changes in that checkout at the time).
- `voices/` is a junction to the primary checkout (read-only use, per CLAUDE.md); `.venv`
  is this worktree's own, not shared.
- No GPU model was left resident beyond this pass's own deliberate Kokoro load, used only
  for the health check this row requires.

## What this discharges

- **A29 criterion 2** — the actual in-app Qwen3 install click-through — re-exercised
  genuinely against the merged fix (PR #3043, confirmed present in the tested code, not
  just in `origin/main` in the abstract) and now **passes clean**: no `WinError 5`. This
  closes the gap #3020 found and #3039/#3043 fixed.
- Register row **A29 is discharged** (removed below) — see the register diff in this
  PR.
