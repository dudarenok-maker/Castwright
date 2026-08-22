# Step 5f — E4, the wizard CPU caveat: STILL OWED, blocked on a live shared sidecar

Issue: Castwright#2565 ("wave 4 step 5f — run E4, the wizard CPU caveat, on
forced-CPU Qwen").

## What was checked before touching anything

`tts.qwen.device` is real (`server/src/config/registry.ts:676-684`), and its
registry entry says plainly: `apply: 'restart-sidecar'`. Changing it is not a
config-file edit — it triggers the server to restart the TTS sidecar process.

This worktree's own `server/.env` documents, in its own header comment, that
the sidecar is **not** isolated per-worktree the way the HTTP port and
workspace are:

> Known limitation: the TTS sidecar is NOT isolated the same way — it still
> binds the hardcoded :9000 every checkout's server polls (spawn-sidecar.ts /
> LOCAL_TTS_URL), so only one worktree's sidecar can run at a time.
> LOCAL_TTS_PORT is deliberately omitted below: setting it would make the
> sidecar bind a different port than the server reads, breaking TTS rather
> than isolating it.

`server/src/tts/spawn-sidecar.ts:12` confirms the other half: if port 9000 is
already listening when this worktree's server starts, it does not spawn its
own — it logs "skipping spawn" and **adopts** whatever is already there. This
worktree does not own that process either way.

## What was found running on :9000

Before starting this worktree's app, port 9000 was checked directly rather
than assumed:

```
> Get-NetTCPConnection -LocalPort 9000 | Select LocalPort,OwningProcess
LocalPort OwningProcess
--------- -------------
     9000         42352

> Get-CimInstance Win32_Process -Filter 'ProcessId=42352' | Select CommandLine
"C:\Users\dudar\AppData\Local\Programs\Python\Python312\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 9000

> Get-CimInstance Win32_Process -Filter 'ProcessId=52308' | Select CommandLine   # parent
"C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\claude-2506-20260820-034711\a41-venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 9000
```

Something is already live on :9000, spawned from a **different run's** scratch
venv (`open-engine-scratch\claude-2506-20260820-034711\a41-venv`) — not this
worktree, not this run. It is either another lane's own sidecar work in
progress or a leftover from one. Either way it is not mine to touch.

## Why this stops the row here

The task's own box-safety section is explicit: *"Changing `tts.qwen.device`
restarts the sidecar. Make sure you are driving this worktree's own sidecar on
port 9090, not the box's shared one. If you cannot isolate it, stop and record
E4 still owed with that as the reason — do not restart a sidecar another lane
is using."*

This worktree cannot drive an isolated sidecar on 9090 — the sidecar has no
per-worktree port (confirmed above from `server/.env`'s own comment and
`spawn-sidecar.ts`'s adopt-on-listening behaviour). Starting this worktree's
app and setting `tts.qwen.device` to `cpu` would restart the process already
listening on :9000 — a process this run did not start and does not own,
possibly mid-render for another lane. That is exactly the forbidden action.

No app was started for this step. No setting was changed. No sidecar was
restarted. `git status` in this worktree is clean before and after (no files
touched other than this evidence file).

## Verdict

**E4 is STILL OWED.** The wizard's CPU-caveat claim — that a forced-CPU Qwen
render still completes, slow but not crashing — remains unconfirmed on real
hardware. Not because the knob doesn't exist (it does, and the registry entry
looks correct on inspection: `default: 'auto'`, sidecar-side resolution in
`tts-sidecar/main.py::_resolve_torch_device`), but because this box currently
has no way to flip it without restarting a sidecar this run does not own.

**What would unblock it:** a run that starts when :9000 is confirmed idle (or
when a genuinely per-worktree sidecar port lands — out of scope for this row
to build), so that a restart-sidecar apply only affects this run's own
process.

## Acceptance check for this step

- App demonstrably on 8170 / 5263 / 9090 — **not attempted**; starting the app
  would have contended with the live process on :9000 for the eventual device
  change, so the run stopped before that step. ❌ (by design — see above)
- Sidecar resolved-device confirmed as CPU — not attempted. ❌ (same reason)
- Short render attempted with wall-clock recorded — not attempted. ❌ (same reason)
- Clear verdict on the caveat's claim — **STILL OWED**, reason stated above. ✅
- Setting restored and verified — nothing was changed, so there is nothing to
  restore; `git status` clean before/after. ✅
- Shared sidecar untouched — confirmed: no restart, no kill, no config change
  issued against it. ✅
- No register edit — `docs/testing/onbox-acceptance-register.md` and the
  `onbox-sitting-*.md` views were not touched by this step. ✅
