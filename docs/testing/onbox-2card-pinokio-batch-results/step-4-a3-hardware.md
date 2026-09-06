# Step 4 — A3 real-hardware trigger for auto-revert (Castwright#2971)

Parent #2950, campaign #2435. Step 4 of the 2-card-boot + Pinokio batch
chain — the ONLY place step 3's `runAutoRevert` (`server/src/gpu/auto-revert.ts`,
commit b6075855, #2974) is watched against real hardware rather than a unit
test's injected `tripEvent()` payload.

## Result: BLOCKED by the same architecture gap step 2 already found

**Both triggers (card-specific and non-card-specific) produce the required
3+ code-43 self-exits inside the 10-minute window, exactly as designed. In
neither case does `runAutoRevert` fire, `/api/gpu/trip-status` ever leave
`null`, or any toast appear** — because `sidecar-supervisor.ts`'s
`onChildExit` (the only place `restart43Timestamps`/`RESTART43_STREAK_TRIP_COUNT`
are evaluated) never runs. This is the identical root cause
`step-2-a3-checklist.md` (items 5-6, Castwright#2979) already documented and
flagged as `AGENT FOLLOW-UP` before step 3 was built, reproduced here
end-to-end against the actual shipped `runAutoRevert`/toast code, on this
worktree's own server + sidecar instance:

`server/src/tts/spawn-sidecar.ts` spawns the sidecar as
`powershell.exe -ExecutionPolicy Bypass -NoProfile -File start.ps1`
(unchanged since step 2 — confirmed by reading the current file before this
run). `start.ps1` has its own independent, uncapped restart loop for exit
codes 42/43 (`sidecar-restart-policy.ps1`'s `Test-SidecarShouldRestart`), so
the Python process cycles internally and the wrapping `powershell.exe` never
exits. Node's `ChildProcess.on('exit', …)` — wired to
`sidecar-supervisor.ts`'s `onChildExit`, the sole place `code === 43` is
checked, the streak counted, and `onTrip` (hence `runAutoRevert`) fired —
therefore never sees an individual Python exit. The wrapper PID confirmed
this directly in both runs below.

**This is not a question this run can resolve — fixing the wrapper-exit
propagation is a code change to `spawn-sidecar.ts`/`start.ps1`, explicitly
out of this step's scope** ("Not in scope: Building any new code (that was
step 3)"). The evidence below is the confirmation the issue asked for: the
built code has been run against real hardware, and the observed result is
that it cannot currently fire in production on Windows, for the same reason
already on record.

## Hardware / setup

Same box as steps 1-3: `nvidia-smi -L` — GPU 0 `RTX 4070 Laptop GPU`
(UUID `GPU-1831b67f-ccc0-c3fc-9167-cff059c3224c`), GPU 1 `RTX 5070 Ti`
(UUID `GPU-73e7270e-ff5b-d1a2-de93-bc83af87699d`). Worktree
`C:\Claude\Projects\wt-2card-pinokio-batch`, branch
`docs/docs-2card-pinokio-batch`, own sidecar on `LOCAL_TTS_PORT=9150`
(server on `PORT=8230`, from this worktree's own `server/.env`). Following
step 2's own finding, ran the production build (`npm run build && node
dist/index.js`) rather than `npm run dev` (`tsx watch`'s file-watcher reloads
the module graph on the sidecar's own continuously-written log files,
wiping the in-memory code-43 streak counter as a side effect).

A stale `node.exe`/`python.exe` pair from an earlier session was already
bound to this worktree's own ports (`8230`/`9150`, confirmed via
`Get-CimInstance Win32_Process` — command lines pointed at this worktree's
own path) when this run started; stopped it (`taskkill /T /F`, this
worktree's own instance, not another lane's) before launching the runs
below.

## Run 1 — card-specific trigger (`SIDECAR_VRAM_FREE_FLOOR_MB=999999`)

Same trigger step 2 used for its item 2/5. Server started 14:03:36, sidecar
spawned pid=46156 (wrapper `powershell.exe`).

```
logs/tts.err.log:
2026-09-06 14:04:40.673 [sidecar] sidecar card 0 driver_free_floor 7411MB breached
the restart limit 999999MB (card 0) ... self-exiting (code 43) ...
INFO:     Started server process [<new pid>]
...
2026-09-06 14:05:09.106 [sidecar] ... breached ... self-exiting (code 43) ...
INFO:     Started server process [<new pid>]
...
2026-09-06 14:05:31.750 [sidecar] ... breached ... self-exiting (code 43) ...
INFO:     Started server process [<new pid>]
```

3 code-43 self-exits at 14:04:40 / 14:05:09 / 14:05:31 — 51 seconds apart in
total, well inside the 10-minute (`RESTART43_STREAK_WINDOW_MS`) window and
past the 3-exit (`RESTART43_STREAK_TRIP_COUNT`) threshold.

**Node's own server log (`server-card-specific.log`) shows no corresponding
activity at all** — no `[sidecar] supervisor:` streak-trip warning, no
`[gpu] auto-revert:` line, nothing — across the entire window. The only
line it wrote after boot was an unrelated catalog-audit timeout.

```
$ curl http://127.0.0.1:8230/api/gpu/trip-status
null
```

Confirmed the wrapper never exited across all three cycles:

```
$ Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where CommandLine -match wt-2card-pinokio-batch
ProcessId ParentProcessId CreationDate         CommandLine
46156     5264            6/09/2026 2:03:36 PM  powershell.exe ... -File ...\start.ps1
```

Same PID (`46156`), same `CreationDate` (server boot time) — still alive
after three internal Python restarts, each logging its own fresh
`Started server process [pid]` line.

**No "auto-reverted: ..." toast — the trip never reached
`runAutoRevert`, so there is nothing for the frontend to poll and no toast
to render.**

## Run 2 — non-card-specific trigger (`SIDECAR_RESTART_MB=1`)

Same trigger step 2 used for its item 3/6. Server restarted 14:06:24 (ports
freed first — confirmed via `Get-NetTCPConnection`), sidecar spawned
pid=40980 (wrapper `powershell.exe`).

```
logs/tts.err.log:
2026-09-06 14:06:43.199 [sidecar] sidecar committed memory 2720MB breached the
restart limit 1MB ... self-exiting (code 43) ...
2026-09-06 14:07:05.607 [sidecar] ... committed memory 2713MB breached ... self-exiting (code 43) ...
2026-09-06 14:07:28.023 [sidecar] ... committed memory 2728MB breached ... self-exiting (code 43) ...
```

3 code-43 self-exits at 14:06:43 / 14:07:05 / 14:07:28 — 45 seconds apart —
again well inside the 10-minute window, host-RAM ceiling trigger (not tied
to either card).

**Identical result: Node's own server log shows nothing after boot, and**

```
$ curl http://127.0.0.1:8230/api/gpu/trip-status
null
```

**stayed `null` through all three cycles** — no `unrevertable` status, no
"not tied to a specific GPU card... manual investigation" toast, because
(as in Run 1) `onChildExit` never observed any of the three exits. Wrapper
PID confirmed still alive across all three cycles:

```
$ Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where CommandLine -match wt-2card-pinokio-batch
ProcessId ParentProcessId CreationDate         CommandLine
40980     41204           6/09/2026 2:06:24 PM  powershell.exe ... -File ...\start.ps1
```

## Verdict

**Both halves of this step's ask reproduce step 2's item 5/6 finding
end-to-end against the real, shipped `runAutoRevert`/toast code, not just
the theoretical `tripEvent()` gap it originally described.** The trigger
mechanisms both work exactly as designed — real, correctly-timed,
correctly-attributed (per-card vs. host-RAM) code-43 self-exits, well inside
any 10-minute window, confirmed via real sidecar logs on real hardware. The
consequence under test — `runAutoRevert` firing, `/api/gpu/trip-status`
reporting a result, either toast appearing — never happens in either case,
because Node's `onChildExit` cannot see the individual Python exits that
`start.ps1`'s own internal restart loop absorbs first. This was true before
step 3 built `runAutoRevert` and remains true with it built: the feature is
implemented and unit-tested correctly (step 3's 4 mutation-verified tests
pass), but is unreachable through the real process-spawn path on this
Windows box as currently wired.

**This blocks step 4's literal pass condition** ("confirm the built
`runAutoRevert` actually fires with the right toast") **for a reason outside
this step's scope to fix.** Surfacing this for whoever owns the
`spawn-sidecar.ts`/`start.ps1` wrapper-exit propagation — the fix belongs
there (e.g. having `start.ps1` exit on its own 3rd consecutive 42/43 within
the same window instead of restarting internally, or having Node signal the
wrapper to relay the child's real exit code), not in `auto-revert.ts` or
`sidecar-supervisor.ts`, both of which behave correctly for any exit they
DO see (per step 3's own unit + mutation tests).

## Not attempted / out of scope

- Fixing the wrapper-exit propagation gap in `spawn-sidecar.ts`/`start.ps1` —
  explicitly out of this step's scope ("Not in scope: Building any new code
  (that was step 3)").
- A2, A12, E7, E11, A18 (separate register rows, out of scope per the issue).
- Any register edit (step 9 is the sole writer).
- Opening a PR (per instructions — commit only, on this worktree's own
  `docs/docs-2card-pinokio-batch` branch).
