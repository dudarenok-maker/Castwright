# A29 step 1 — Qwen3 install click-through retry (isolated venv + port)

Register row **A29** ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192),
plan 282), retried per parent [#2913](https://github.com/dudarenok-maker/Castwright/issues/2913)
now that the sidecar port hardcode ([#2632](https://github.com/dudarenok-maker/Castwright/issues/2632))
is fixed on `main`. Run entirely in worktree
`C:\Claude\Projects\wt-2913-a29-retry` (branch `docs/docs-2913-a29-retry`,
slot 8: VITE 5253 · API 8160 · TTS 9080).

## Pre-flight — confirm the box's other lane was left alone

Before starting anything, checked what already held the shared `:9000` port:

```
netstat -ano | Select-String ":9000"
  TCP 127.0.0.1:9000 0.0.0.0:0 LISTENING 49540
```

PID 49540 was a live python process (another lane's sidecar), started earlier
that morning. It was never touched. Re-checked at the very end of this run —
same PID, same start time (`5/09/2026 3:34:19 AM`), still listening on `:9000`,
confirming this retry never collided with it.

## Bootstrap — fresh venv, not the primary's

`server/tts-sidecar/.venv` did not exist in this worktree (confirmed before
starting). Ran the bootstrap directly rather than through the app's
auto-respawn (the app's sidecar supervisor gives up after 6 rapid exits if the
venv is missing — see "First `npm run dev` attempt" below):

```
node server/tts-sidecar/scripts/bootstrap-venv.mjs py -3.12
```

This created `C:\Claude\Projects\wt-2913-a29-retry\server\tts-sidecar\.venv`
(a fresh venv scoped to this worktree, never touching the primary checkout's
live sidecar venv), pre-installed the CUDA-index torch build, installed the
`nvidia-cuda` requirements overlay (~150 packages, torch/onnxruntime-gpu/
qwen-tts/kokoro-onnx/etc. — all served from pip's local wheel cache, so no
first-time download), and **swapped the ONNX runtime to the NVIDIA GPU
build** — the exact operation that used to throw `WinError 5` / `Accès
refusé` when installing into a venv another process still had DLLs open
from. Log ends:

```
[bootstrap-venv] swapping ONNX runtime → the nvidia GPU build
...
Successfully installed onnxruntime-gpu-1.26.0
...
[bootstrap-venv] done
```

Full bootstrap log checked for the failure signature — zero hits:

```
grep -ic "WinError\|Traceback\|Accès refusé\|Access is denied" bootstrap-venv.log
0
```

### First `npm run dev` attempt (before the venv existed)

For completeness: starting the app before running the bootstrap manually
showed the failure mode the fresh-venv step avoids — the sidecar supervisor
spawned a python child against a venv that didn't exist yet, it exited
immediately (`code=1`) every time, and after 6 rapid exits the supervisor
gave up (`TTS is DOWN; restart the server to recover`). Killed the whole
process tree (`taskkill /PID <concurrently-root> /T /F`), ran the bootstrap
to completion, then relaunched `npm run dev` clean.

## Port binding — confirmed from the server's own log, not assumed

`server/.env` in this worktree already had `LOCAL_TTS_PORT=9080` (slot 8).
After the clean relaunch:

```
[server] 2026-09-05 11:29:14.522 [server] listening on http://localhost:8160
[server] 2026-09-05 11:29:14.579 [sidecar] spawned pid=48428 (...)
```

```
netstat -ano | Select-String ":9080"
  TCP 127.0.0.1:9080 0.0.0.0:0 LISTENING 14608
```

`GET /api/sidecar/health` (via the API on :8160, which proxies to the
sidecar) confirms the sidecar is reachable at `http://127.0.0.1:9080` — this
worktree's assigned port, not the shared `:9000` the other lane holds. This
is the whole point of the retry: two worktrees' sidecars no longer collide.

## Step 2 — Qwen3 install state, via real Chrome, Model Manager

Drove the app with the project's own Playwright Chromium
(`node_modules/@playwright/test`, launched against the installed
`chromium-1228` full build — the newer `chromium_headless_shell-1234` build
this repo's playwright version wants was not present, so the driver script
pinned `executablePath` to the full Chromium binary that was already
installed; this is still real Chrome-family browser automation, not a
headless-shell shortcut).

Navigated to `http://127.0.0.1:5253/#/models`, expanded the Qwen3-TTS Base
(0.6B) installer row. Screenshot:
`screenshots/1-qwen-installed.png`.

**Finding:** Qwen3-TTS was already fully installed on this box — package
importable (installed fresh into this worktree's venv by the bootstrap
overlay above) and weights already present under the box's shared Hugging
Face cache (`C:\Users\dudar\.cache\huggingface\hub\models--Qwen--...`, not
per-worktree). The UI rendered the green **"Qwen3-TTS is installed"** card
with **zero** error state and **zero** browser console errors — no
`WinError 5`, no import failure, nothing. Clicked **Re-check** to force a
real round-trip through the app→server→sidecar chain; it stayed on the same
ready state with no error.

Because the weights/package were already resident, this run could not
observe a *fresh* "click Install, watch it download" transition for Qwen
specifically — that transition was, however, fully exercised for Kokoro
(below), which needed a real download in this worktree. The operation that
matters for the register's actual regression (#2632) — installing/swapping
the ONNX GPU runtime into an isolated venv without a `WinError 5` — happened
during the bootstrap step above, and succeeded cleanly.

## Step 3 — Kokoro, install then load, confirm no CPU fallback

Kokoro's weights are stored **per-worktree**
(`server\tts-sidecar\voices\kokoro`), unlike Qwen's shared HF cache, so this
worktree genuinely had **no** Kokoro weights yet — a real install
click-through was available here.

1. Expanded the Kokoro row: state was "not installed" / "Weights missing".
2. Clicked **Download weights** (`kokoro-install-weights-missing` →
   `startInstall`). Polled the job every 3s; `data-job-status` went
   `installing` → the ready card appeared ~15s later, zero errors. Screenshot:
   `screenshots/2-kokoro-weights-installed.png` (row now shows `337 MB`,
   `verified`, `Installed`).
3. Clicked **Load model** on the Kokoro row. Polled the row's text; it
   transitioned `Loading kokoro v1…` → `Loaded` / `Kokoro v1 ready` /
   `Stop`. Screenshot: `screenshots/3-kokoro-loaded-cuda.png`.

The Model Manager's own device panel confirms, from the UI itself:
**"Currently running on: NVIDIA GPU (CUDA)"**, with `Kokoro · NVIDIA GPU
(CUDA)` listed explicitly.

Cross-checked against the sidecar's real state (not just the UI's summary)
via `GET /api/sidecar/health`:

```json
"kokoroLoaded": true,
"devices": { "kokoro": "cuda", "coqui": "cuda", "qwen": "cuda" },
"devicesState": "ready"
```

This `devices.kokoro` field is read directly from the **loaded ONNX
session's actual providers** (`sess.get_providers()` in
`_kokoro_session_device`, `server/tts-sidecar/main.py:10487`) — not from
requested/intended device — so `"cuda"` here is direct proof
`CUDAExecutionProvider` landed in the real session, not a silent CPU
fallback. Confirmed the raw sidecar health (`GET http://127.0.0.1:9080/health`)
independently reports the same `devices.kokoro: "cuda"`.

Zero browser console errors across all three driver scripts (install-state
check, weights download, and load).

## Summary

| Check | Result |
|---|---|
| Fresh venv, isolated from primary's live sidecar venv | ✅ created at `wt-2913-a29-retry\server\tts-sidecar\.venv` |
| ONNX GPU runtime swap during bootstrap — no `WinError 5` | ✅ (0 hits scanning the full log) |
| Sidecar bound its assigned port (`:9080`), not `:9000` | ✅ confirmed via server log + `netstat` |
| Other lane's `:9000` sidecar left untouched | ✅ same PID/start-time before and after |
| Qwen3-TTS shows installed, no error, via real Chrome | ✅ (package+weights already present; Re-check round-trip clean) |
| A genuine install click-through (Kokoro, weights not yet present) completes with no error | ✅ |
| Kokoro loads afterward via the app and reports `CUDAExecutionProvider`, not CPU | ✅ (`devices.kokoro: "cuda"` from the live session, both via API proxy and raw sidecar) |

Retry confirms #2632's fix holds: this worktree's sidecar and the box's other
live lane never collided, and the Qwen3/Kokoro install + load paths complete
cleanly against a truly isolated venv and port.
