# Wave 4 step 5c — A40, in-app Qwen3 install through Model Manager (real browser)

Run against Castwright#2561. Row: `docs/testing/onbox-acceptance-register.md` §A40,
run sheet `docs/testing/ort-marker-onbox-acceptance.md` §4.

**Run by:** claude. **Date:** 2026-08-21.

## Summary verdict

**A40: STILL OWED — partially run, not fully dischargeable on this box right now.**

The click-through was genuinely driven in a browser end to end. The core #2192
repro action — clicking Install on Qwen3-TTS Base (0.6B) in Model Manager —
completed cleanly with **no `WinError 5`**, against **this worktree's own venv**.
The follow-on check (load Kokoro, confirm `CUDAExecutionProvider` survives the
install) could **not** be validated, because this box's TTS sidecar binds a
single hardcoded port (`:9000`) shared across every worktree, and another live
agent lane already held it for the whole session — a structural box constraint,
not a code defect, and distinct from the already-filed #2534 CUDA13/cuDNN9 gap.

## 1. This worktree's venv — bootstrap, not a copy

Per the brief: `server/tts-sidecar/.venv` did not exist in this worktree before
this run, so no throwaway copy was needed — a fresh bootstrap writes straight
into a disposable venv by construction, and the primary checkout's live venv
(`C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv`) is never
touched by anything below.

```
$ node scripts/bootstrap-venv.mjs "C:\Users\dudar\AppData\Local\Programs\Python\Python312\python.exe"
   (ACCELERATOR=nvidia)
[bootstrap-venv] creating venv at C:\Claude\Projects\wt-2551-onbox-wave4-retire\server\tts-sidecar\.venv
...
[bootstrap-venv] swapping ONNX runtime → the nvidia GPU build
Successfully installed onnxruntime-gpu-1.27.0
[bootstrap-venv] done
```

```
$ .venv/Scripts/python.exe -m pip check
No broken requirements found.
EXIT=0
```

Marker present immediately after bootstrap (this release's install path stamps
it inline, not only at first server boot):

```
onnxruntime-1.27.0.dist-info/INSTALLER = castwright-ort-marker
onnxruntime-1.27.0.dist-info/RECORD    = 0 bytes
onnxruntime_gpu-1.27.0.dist-info present alongside it
```

**I did bootstrap this worktree's venv** (nvidia profile) and **deleted it
again** after capturing the evidence below (`rm -rf .venv`, confirmed gone via
directory listing; 5.6 GB reclaimed). Successor **#2564** needing E7's
*absent-venv* card states does **not** need to delete anything itself — the
absent state is already restored.

**`SIDECAR_VENV_DIR` was never set or used.** The six-consumer inconsistency
named in the brief was not re-verified line-by-line this run (no code change
made either way) — the brief's citation stands:
`server/src/tts/spawn-sidecar.ts:579` honours it; `coqui-install-detect.ts:61`,
`kokoro-install-detect.ts:16`, `qwen-install-detect.ts:57`,
`venv-core-package.ts:13`, `whisper-install-detect.ts:72`, and
`server/tts-sidecar/scripts/install-qwen3.mjs:169-170` all hardcode the venv
path instead. Still flagged as needing a design pass, not a fix, per the
brief's own instruction — not touched this run.

## 2. App started from this worktree — ports verified

```
$ node scripts/start-app.mjs   (background; its own 60s health-check timed out
                                 mid-vite-bundling, but both services *did* come up)

logs/server.log:
2026-08-21 12:08:41.139 [server] listening on http://localhost:8170
2026-08-21 12:08:41.141 [server] workspace root: C:\Claude\Projects\wt-2551-onbox-wave4-retire\castwright-workspace
2026-08-21 12:08:41.284 [sidecar] already listening on :9000 (protocol v1), skipping spawn (current sidecar honoured)
2026-08-21 12:08:41.285 [sidecar] supervisor: watching adopted sidecar on :9000 (not our child) — will respawn an owned process if it exits or becomes unfit.

logs/frontend.log:
  VITE v8.0.16  ready in 8507 ms
  ➜  Local:   http://127.0.0.1:5263/
```

```
$ curl -s -o /dev/null -w "server:%{http_code}\n" http://localhost:8170/   -> server:404 (route exists, expected for a bare GET on the API root)
$ curl -s -o /dev/null -w "frontend:%{http_code}\n" http://localhost:5263/ -> frontend:200
$ netstat -ano | grep -E ":8170 |:5263 "  -> both LISTENING, no 5173/8080 anywhere
```

Confirmed **8170/5263**, not the primary checkout's 5173/8080.

## 3. The sidecar-port blocker, found before clicking anything

Before starting the app, `netstat -ano` already showed `127.0.0.1:9000
LISTENING` owned by PID 42352 — a live `python.exe -m uvicorn main:app --host
127.0.0.1 --port 9000` from **another agent lane's worktree**, not this one.
`server/.env`'s own comment names this exact limitation: *"the TTS sidecar is
NOT isolated the same way — it still binds the hardcoded :9000 every checkout's
server polls ... so only one worktree's sidecar can run at a time."*
`spawn-sidecar.ts:12` documents the resulting behaviour: *"port 9000 already
listening → log 'skipping spawn' and return null."* My server's own boot log
confirms it took exactly that branch (§2 above): it **adopted** the other
lane's sidecar instead of starting its own.

Per this issue's own box-safety rule ("never stop or kill another agent's
process... if you find another agent mid-generation, wait or record the row as
still owed rather than competing for the GPU"), PID 42352 was left untouched
for the entire run.

## 4. The click-through — Account → Models → Qwen → Install

Screenshots in `step-5c-a40-screens/` (all captured live during this run):

1. `01-home.png` — app home (`/#/setup`) right after navigating to `127.0.0.1:5263`.
2. `02-model-manager.png` — Model Manager, "Installed models" section, **before**
   clicking Install. Note the "Currently running on: NVIDIA GPU (CUDA)" panel —
   this reads the *adopted* (foreign) sidecar's state, not this worktree's venv;
   see the caveat in §5.
3. `03-qwen-install-expanded.png` — the Qwen3-TTS Base (0.6B) row's install
   dropdown expanded, showing "The Qwen package is missing / Install reinstalls
   it" and the "Install Qwen3-TTS" button.
4. `04-installing.png` — immediately after clicking "Install Qwen3-TTS".
5. `05-restart-409-error.png` — the resulting error toast/console state (see §5).
6. `06-final-state.png` — Model Manager after the install job resolved.

Real network trace (via the browser's own devtools network log, not asserted):

```
POST /api/qwen/install            -> 202 Accepted
GET  /api/qwen/install/1          -> 200 OK
     {"id":"1","status":"installed","step":"Already installed.","error":null,...}
POST /api/sidecar/restart         -> 409 Conflict
     {"ok":false,"error":"No sidecar child is currently running. If auto-start is on, the supervisor will spawn one shortly."}
```

`.venv` state directly after, from this worktree's own venv (not the adopted
sidecar's):

```
$ .venv/Scripts/python.exe -m pip show qwen-tts
Name: qwen-tts
Version: 0.1.1
Location: C:\Claude\Projects\wt-2551-onbox-wave4-retire\server\tts-sidecar\.venv\Lib\site-packages

$ .venv/Scripts/python.exe -m pip check
No broken requirements found.
```

## 5. Per-check verdict

- **Install completes with no `WinError 5` / `Accès refusé` on any
  `onnxruntime/capi/*.dll`: PASS.** `qwen-install-bootstrap.ts` spawns
  `install-qwen3.mjs` with `cwd: this.repoRoot` — **this worktree's** repo
  root, confirmed by the job resolving `"Already installed."` against a
  package that was only ever installed into *this* venv (bootstrap in §1, not
  the adopted sidecar's venv, which belongs to a different worktree entirely).
  No error, no exception, no partial state. This is the actual #2192
  repro action and it is clean.
- **Kokoro still reports `CUDAExecutionProvider` after install: UNREACHABLE,
  not FAIL.** The install flow's own `onInstalled` callback calls
  `POST /api/sidecar/restart` to pick up the freshly-(re)installed package —
  and that call 409s, because the currently-listening sidecar on `:9000` is
  **adopted, not owned** (§3): the supervisor refuses to restart a process it
  didn't spawn. Without a restart, nothing in this worktree's own venv is ever
  loaded into a running sidecar during this session, so a GPU-provider check
  right now would silently measure the *other* lane's venv/sidecar, not mine —
  which would be worthless evidence, exactly the failure mode the brief warned
  against for `SIDECAR_VENV_DIR`. I did not attempt it for that reason.
- **This is a genuine, reportable finding distinct from #2534.** #2534 is a
  CUDA13/cuDNN9 *library* gap that degrades GPU inference to CPU. This is a
  *process-ownership* gap: `POST /api/sidecar/restart` has no path to succeed
  whenever the box's single shared `:9000` is currently held by a sidecar this
  server process didn't spawn — which, on a box that deliberately runs several
  agent worktrees at once (per this issue's own "Box safety" section), is not
  a rare edge case. `qwen-install-bootstrap.ts`'s reinstall-then-restart
  sequence and `spawn-sidecar.ts`'s adopt-on-conflict behavior are each correct
  in isolation; together, on a multi-worktree box, they leave the *reinstall
  and pick up the new package* half of Model Manager's own "Reinstalls the
  engine package, then restarts the sidecar" promise unfulfillable while any
  other lane's sidecar is up. Reporting only — not fixing, per this issue's
  scope.

## 6. Cleanup

- App (server pid 18192, frontend pid 50836, plus their `npm`/`start-app.mjs`
  parents) stopped. Confirmed via `netstat`: 8170 and 5263 no longer listening.
- Zero processes on `:9000` were touched. PID 42352 (the adopted, foreign
  sidecar) is exactly as it was found, still listening, still owned by its own
  lane.
- Browser tab closed (`browser_close`).
- This worktree's `.venv` deleted (`rm -rf`, confirmed absent via `ls`);
  5.6 GB reclaimed.
- Primary checkout's venv verified untouched:
  `C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv-stamp.json`
  mtime **2026-07-03**, unchanged by anything in this run (nothing in this run
  ever referenced the primary checkout's path).

## Not in scope / not done

- No fix to the `SIDECAR_VENV_DIR` inconsistency or to the restart-409 gap
  found in §5 — both reported for a design pass, per this issue's own "report,
  do not opportunistically fix" rule.
- Did not touch `docs/testing/onbox-acceptance-register.md` — step 6 is its
  sole writer.
- Did not attempt A42 (out of scope per the brief — no newer release than
  v1.14.0 exists on this box).
