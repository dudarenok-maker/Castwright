# A3 · Wave 2 per-card safety — 10-item on-box checklist (real 2-card box)

Castwright#2979. Step 2 of the 2-card-boot + Pinokio batch chain (parent
#2950, campaign #2435). Runs the Wave 2 on-box acceptance checklist restated
in `docs/superpowers/plans/2026-07-02-multi-gpu-wave2-plan2.md` ("## Ship
notes" → "### Wave 2") and #1230, against this worktree's own sidecar
instance on both GPUs.

## Hardware / setup

- Real 2-card box: `nvidia-smi -L` — GPU 0 `RTX 4070 Laptop GPU`
  (UUID `GPU-1831b67f-ccc0-c3fc-9167-cff059c3224c`), GPU 1 `RTX 5070 Ti`
  (UUID `GPU-73e7270e-ff5b-d1a2-de93-bc83af87699d`).
- Worktree `C:\Claude\Projects\wt-2card-pinokio-batch`, branch
  `docs/docs-2card-pinokio-batch`, own sidecar on `LOCAL_TTS_PORT=9150`
  (server on `PORT=8230`).
- Items 5/6's respawn cycling needed clean, reliable exit-code timestamps.
  `npm run dev` (`tsx watch`) was dropped in favour of a production build
  (`npm run build && node dist/index.js`) for those two items — `tsx watch`'s
  file-watcher on this box picks up the sidecar's own continuously-written
  `logs/tts.err.log`/`tts.log` and full-reloads the server module graph,
  which (as a side effect, not the item's target) wipes the in-memory
  code-43 streak counter. Items 1–4 and 7–8 ran fine under the ordinary
  `npm run dev` dev server.

## Item 1 — real per-card UUIDs

```
$ .venv\Scripts\python.exe -c "import torch; print(torch.cuda.get_device_properties(0).uuid); print(torch.cuda.get_device_properties(1).uuid); print(torch.cuda.device_count())"
1831b67f-ccc0-c3fc-9167-cff059c3224c
73e7270e-ff5b-d1a2-de93-bc83af87699d
2
```

**PASS.** Both UUIDs match `nvidia-smi -L` exactly. `DeviceLedger`'s
renumber-detection is live on this box, not the `idx-N` synthetic fallback —
step 3's premise holds here.

## Item 2 — card-specific VRAM-floor breach self-exits (code 43)

Both cards had several GB free at baseline (GPU0 ~6.8 GB, GPU1 ~15.8 GB), well
above the 1024 MB default floor, so a natural starve-to-breach needed either
loading something else onto a card or (as item 5 itself suggests) temporarily
raising `SIDECAR_VRAM_FREE_FLOOR_MB` far above any real free reading — used
here for item 2 too, since it is the same trigger and the checklist's own
wording endorses it.

```
SIDECAR_VRAM_FREE_FLOOR_MB=999999 node dist/index.js   (server/.env otherwise default)

logs/tts.err.log:
2026-09-06 12:13:41.672 [sidecar] sidecar card 0 driver_free_floor 7411MB
breached the restart limit 999999MB (card 0) — draining 0 in-flight synth
(grace 180000ms) then self-exiting (code 43) so the server respawns a fresh
process. Completed chapters are skipped (srv-16); the in-flight chapter
finishes here or is re-rendered by the server (srv-17c). Raise the ceiling to
recycle less often.
2026-09-06 12:13:41.684 [sidecar] sidecar recycle: in-flight synth drained —
self-exiting now.
```

**PASS.** `/health`'s `gpus[]` reported the real `free_mb` (7411) and
`free_floor_mb` (999999) — the breach was visible before exit — and the
process self-exited with code 43 exactly as designed.

## Item 3 — different cards (`QWEN_DEVICE=cuda:0 KOKORO_DEVICE=cuda:1`), no blocking

Concurrent `POST /qwen/design-voice` (cold, Qwen → cuda:0) and
`POST /synthesize` (`engine:"kokoro"`, → cuda:1), fired in the same shell
instant:

```
kokoro HTTP=200 time=12.871053
design HTTP=200 time=83.567939
```

`/health` afterward: `qwen_device_key:"cuda:0"`; GPU0 free dropped
7411→1615 MB (Qwen's load), GPU1 free dropped 15767→15205 MB (Kokoro's small
ONNX load) — confirms each engine actually landed on its configured card.

**PASS.** Kokoro (13s) finished long before the cold Qwen design (84s) —
clean concurrent completion, `shares_device=False` path, no blocking.

## Item 4 — same card (`QWEN_DEVICE=cuda:0 KOKORO_DEVICE=cuda:0`), Kokoro blocks

Same concurrent fire, both engines pinned to cuda:0 this time:

```
design HTTP=200 time=65.196209
kokoro HTTP=200 time=44.697540
```

`/health` afterward: GPU0 free_mb dropped to 0, GPU1 untouched — confirms
both engines shared cuda:0 as configured.

**PASS (with the documented partial-hold nuance).** Reading
`_VdKokoroArbiter` directly (`main.py`): `design()` releases the arbiter
once model load finishes, not for its whole forward — so Kokoro doesn't wait
the *entire* design span, only until the design's load phase clears. That's
by design (#2809). The evidence for the hold is the latency delta: Kokoro
took 44.7s here vs 12.9s in item 3's cold, unblocked case on a different
card — same box, same load pattern, ~3.5x slower under the same-card
arbiter contention.

## Item 5 — 3 code-43 exits in 10 min, card-specific trigger → streak trips, respawn stops

**FINDING: the Node-side streak-trip guard never engages, on this box, in
this configuration — a real gap, not a test artifact.** With
`SIDECAR_VRAM_FREE_FLOOR_MB=999999` still set, the sidecar produced far more
than 3 code-43 self-exits inside a single 10-minute window — 13+ exits
between 12:13:41 and 12:21:28 under `npm run dev`, and (after switching to
the production build to rule out a `tsx watch` reload artifact) 5 more
between 12:24:43 and 12:26:15, cadence ~20-25s/cycle — and respawning never
stopped:

```
logs/tts.err.log (repeated, unbroken):
2026-09-06 12:2X:XX [sidecar] sidecar card 0 driver_free_floor 7411MB breached
the restart limit 999999MB (card 0) ... self-exiting (code 43)
INFO:     Started server process [<new pid each time>]
```

Root cause, read directly from the source: `server/src/tts/spawn-sidecar.ts`
(~line 770) spawns the sidecar as `powershell.exe -File start.ps1`
unconditionally on Windows — **not** the Python process directly. Node's
`ChildProcess.on('exit', ...)` therefore fires on the *wrapper
`powershell.exe`'s* exit code, never on Python's. But `start.ps1`
(tail of the file) has its **own independent, uncapped `while ($true)`
restart loop** for uvicorn, driven by `sidecar-restart-policy.ps1`'s
`Test-SidecarShouldRestart` (`return ($ExitCode -eq 42) -or ($ExitCode -eq
43)`, no count/window cap of its own) — it relaunches uvicorn internally on
every 42/43 and the wrapper `powershell.exe` process **never exits** while
that's happening. Confirmed directly: `Get-Process powershell` showed the
wrapper PID (`26080`, then `42092` in the item-6 run) with a fixed
`StartTime` that predates and outlives every one of the code-43 cycles
counted inside it.

Consequently `server/src/tts/sidecar-supervisor.ts`'s `onChildExit(code,
signal)` — which holds `restart43Timestamps` / `RESTART43_STREAK_WINDOW_MS`
/ `RESTART43_STREAK_TRIP_COUNT` and is the only place `code === 43` is ever
checked — **never runs** for these cycles, because from Node's point of view
the child (the wrapper) hasn't exited. The whole Wave 2 §W2.5 streak-trip
guard, as currently wired on Windows, is unreachable dead code: `start.ps1`'s
own crash-loop absorbs every 42/43 exit before Node's supervisor can ever see
one.

**Item 5 does not pass as specified.** The trigger mechanism itself works
(sidecar breaches and self-exits 43, repeatedly, well within any 10-minute
window); the guarded *consequence* (`tripEvent()` firing, respawn stopping)
never fires, because the architecture that wires the sidecar's own restart
loop (`start.ps1`) on top of Node's supervisor means Node never observes the
individual exits it needs to count. This should be flagged to whoever owns
Task 16/16.5 (auto-revert, gated on this very acceptance) before that work
proceeds on the assumption `tripEvent()` is reachable in production.

## Item 6 — 3 code-43 exits in 10 min, non-card-specific trigger (`SIDECAR_RESTART_MB=1`)

Same architecture, different trigger — confirms the finding isn't specific to
the VRAM-floor code path:

```
logs/tts.err.log:
2026-09-06 12:28:38.386 [sidecar] sidecar committed memory 2712MB breached the
restart limit 1MB ... self-exiting (code 43)
2026-09-06 12:29:00.440 ... breached ... self-exiting (code 43)
2026-09-06 12:29:22.768 ... breached ... self-exiting (code 43)
2026-09-06 12:29:44.857 ... breached ... self-exiting (code 43)
```

4 exits inside 90 seconds (host-RAM ceiling, not per-card) — again well past
3 within any 10-minute window. `Get-Process powershell` confirmed the same
wrapper PID (`42092`, started 12:28:18) stayed alive across every cycle.

**Item 6 does not pass, for the identical root cause as item 5.** The
host-RAM trigger correctly produces repeated code-43 self-exits; the
supervisor-level "no specific card... requires MANUAL investigation" path
(Task 16's `runAutoRevert` / Task 16.5's `/api/gpu/trip-status`) is
unreachable for the same reason — Node's `onChildExit` never sees these
exits. (`/api/gpu/trip-status` doesn't exist yet in this branch's routes
either — Task 16.5 is listed "NOT YET SHIPPED" in the plan's own Ship notes,
consistent with this.)

## Item 7 — analyzer on CPU, concurrent Qwen GPU synth not serialized

This box's shared Ollama instance is GPU-resident by default (see item 8),
and reconfiguring the shared Ollama *service* to CPU-only was out of scope
(other lanes depend on it — never touch shared infra for one worktree's
test). Used the existing per-request override instead:
`ANALYZER_NUM_GPU=0` (`server/src/analyzer/ollama.ts` /
`server/src/config/registry.ts`, forces `num_gpu: 0` on the analyzer's own
Ollama calls) — genuinely CPU-only for this analyzer call, without touching
the shared service.

Uploaded a manuscript (`POST /api/manuscripts`), fired
`POST /api/manuscripts/<id>/analysis` concurrently with a Qwen
`design-voice` call:

```
$ curl http://localhost:11434/api/ps   # sampled while the analysis was running
{"models":[{"name":"qwen3.5:4b", ..., "size_vram":0, ...}]}
```

`size_vram:0` confirms the analyzer's model was resident CPU-only, not GPU.
The analysis SSE stream was still mid-"Detecting characters" at 89s
un-finished (CPU inference is much slower than GPU — cf. item 8's 34s GPU
run of a similar-sized chapter); by that same point `/health` already showed
`qwen_design_resident:true, qwen_loading:false` — Qwen's GPU design had
already progressed to residency **while the CPU analyzer job was still
running**, not serialized behind it. Design ultimately returned `HTTP 200`
after 226s total (slow, consistent with this box's other concurrent lanes
contending for the same GPUs — unrelated to the analyzer).

**PASS.** CPU analyzer confirmed via `size_vram:0`; concurrent Qwen GPU work
was not blocked behind it.

## Item 8 — analyzer on GPU, regression check

Default env (no `ANALYZER_NUM_GPU` override) — Ollama loads the analyzer
model onto GPU as before Wave 2:

```
$ curl http://localhost:11434/api/ps
{"models":[{"name":"qwen3.5:4b", "size":3799420762, "size_vram":3799420762, ...}]}
```

`size_vram == size` — 100% GPU-resident, confirming the analyzer default is
unchanged (GPU) post-Wave-2. Fired the same analysis concurrently with a
Qwen `design-voice` call twice (first attempt raced the sidecar's own cold
boot and got `HTTP=000`; retried once the sidecar was actually listening):

```
analysis finished at 34s   (HTTP 200, GPU-resident analyzer)
design HTTP=200 time=156.467054
```

**PASS (regression check).** Both GPU consumers — analyzer and Qwen —
completed cleanly and concurrently with no crash, no OOM, no wrong-card
placement. This is the same "coherent completion under contention" behaviour
already confirmed for Qwen-vs-Qwen concurrency in #2981's step-1-a2.md;
nothing about Wave 2's per-card additions broke the pre-existing coarse
GPU-semaphore coordination between the analyzer and TTS engines.

## Item 9 — `COQUI_DEVICE=cpu` while the analyzer holds the GPU, no eviction wait

Built a real book end-to-end via HTTP for this and item 10:
`POST /api/import` → `POST /api/books` (real `bookDir` on disk, one
chapter split from the manuscript automatically), then seeded
`.audiobook/cast.json` directly (one character, `jenna`) and flipped
`castConfirmed:true` in `state.json` — no lightweight HTTP route exists to
confirm a cast short of the full analysis pipeline (confirmed via
`cast-create.test.ts`'s own `writeBookOnDisk` helper, which does the same
thing). Ran `POST /api/manuscripts/<manuscriptId>/analysis` once against
that book's own manuscript to populate its per-sentence cast cache (required
by the generation route — `"No analysed sentences cached for this book"`
otherwise), confirming `analysisProvenance` and 4 attributed sentences in
`state.json`.

With `COQUI_DEVICE=cpu`, fired a fresh analysis (GPU, holding the analyzer's
model on GPU per item 8's own confirmation) concurrently with
`POST /:bookId/generation` (`modelKey:"coqui-xtts-v2"`, the one real chapter):

```
$ curl http://localhost:9150/health | jq '{devices, vram_reserved_mb_by_device}'
{"devices":{"kokoro":"cuda","coqui":"cpu","qwen":"cuda"},
 "vram_reserved_mb_by_device":{"cuda:0":{"reserved_mb":0.0,...},"cuda:1":{"reserved_mb":0.0,...}}}

logs/tts.err.log:
2026-09-06 12:58:14.855 [sidecar] Loading Coqui model=tts_models/multilingual/multi-dataset/xtts_v2 on device=cpu half=False deepspeed=False ...
2026-09-06 12:58:41.653 [sidecar] Coqui ready - 58 speakers in manifest.

analysis finished at 17s   (GPU, unrelated concurrent load)
gen HTTP=200 time=343.520944
data: {"type":"chapter_complete", ..., "audioModelKey":"coqui-xtts-v2",
"audioEngines":{"coqui":1}, "durationSec":19.45,
"audioQa":{"status":"ok","measuredLufs":-16,"truePeakDb":-1.2,...}}
```

`nvidia-smi` during the run showed GPU0 (the box's usual idle baseline) at
0% utilization throughout, consistent with Coqui never touching a card.
The Coqui load began immediately on `POST /generation` (no delay, no
eviction/wait log line, no queuing behind the concurrently-running GPU
analyzer) — the 344s total is real CPU-XTTS synthesis time for 4 sentences
(CPU inference for this model is known-slow; this is not a stall), not a
Node-side semaphore wait. `engineOnGpu=false` short-circuits
`withGpuLoad` (`server/src/gpu/gpu-load.ts:57-58`) exactly as the code
predicts.

**PASS.** Chapter rendered successfully end-to-end via the real generation
route with `audioQa.status:"ok"`, confirming Coqui-on-CPU incurs no
GPU-eviction wait while the analyzer holds the GPU.

## Item 10 — Qwen voice-design while `tts.qwen.device=cpu`, no eviction wait

Same book, its one character (`jenna`). Restarted with `QWEN_DEVICE=cpu` and
called the real route, `POST /:bookId/cast/:characterId/design-voice`
(`server/src/routes/qwen-voice.ts:557`, the second `withGpuLoad` call site —
`designQwenVoiceForCharacter`, line 466-475), concurrently with a
GPU-analyzer analysis:

```
logs/tts.err.log:
2026-09-06 12:50:29.082 [sidecar] Device probe complete:
{'kokoro': 'cuda', 'coqui': 'cuda', 'qwen': 'cpu'} (state=ready).

$ curl -X POST .../cast/jenna/design-voice -d '{"persona":"...","sampleVoiceId":"...","modelKey":"qwen3-tts-1.7b"}'
design HTTP=200 time=172.213943
{"voiceId":"qwen-e9VvAOcrO9W7wfxlrn-hc","url":"/audio/voices/...","voiceUuid":"..."}
```

`engineDeviceIsGpu('qwen')` (`server/src/gpu/engine-device.ts:30-37`) reads
the sidecar's *ground-truth* last-known device first, and the sidecar's own
boot-time device probe reported `qwen:'cpu'` — so at the moment the route
computed `onGpu = engineDeviceIsGpu('qwen')` (qwen-voice.ts:474), it read
`false`, and `withGpuLoad` short-circuited straight to `loadFn()` with no
semaphore/eviction wait, exactly as item 10 asks.

**Caveat worth flagging (not this item's own claim, but adjacent and
surprising):** the *sidecar's own* load path did not actually honor the CPU
pin for this transient VoiceDesign load — `main.py`'s log shows
`Loading Qwen VoiceDesign model=... on cuda:1 (transient)` moments later, and
the design ultimately ran on GPU. Reading `_ensure_design_loaded`'s own
comment (`main.py:6702-6712`): "a concrete `device` from an admitted
reservation overrides the env-derived pref for THIS cold load" — plan 264's
capacity-admission system (on by default) re-picks a live-probed best card
for a transient design load regardless of a `QWEN_DEVICE=cpu` pin. That's a
sidecar-internal admission behaviour, separate from item 10's actual target
(the **Node-side** `withGpuLoad` gate, confirmed above to skip correctly),
but it means `QWEN_DEVICE=cpu` does not currently achieve CPU-only Qwen
*inference* on a box with capacity admission on — worth a note for whoever
next touches plan 264's admission controller or Wave 2/Plan 2's device-pin
UI, since a user pinning Qwen to CPU via the picker would reasonably expect
it to stay off the GPU.

**PASS** on item 10's actual claim (Node-side `withGpuLoad` skip for a
CPU-probed engine); the admission-override caveat is flagged separately
above, not a failure of this item.

## Verdict

7 of 10 items **PASS** with real, on-box evidence (1, 2, 3, 4, 7, 8, 9, 10 —
that's actually 8; see below). 2 of 10 (**5, 6**) do **not** pass: the
trigger mechanisms both work exactly as designed (repeated, correctly-timed
code-43 self-exits, well inside any 10-minute window), but the guarded
consequence — `sidecar-supervisor.ts`'s streak-trip (`tripEvent()`, held-down
TTS, no further respawn) — never fires, because `spawn-sidecar.ts` spawns
the sidecar via `start.ps1` on Windows, and `start.ps1` has its own
independent, uncapped restart loop for codes 42/43 that never lets the
wrapping process exit. Node's `onChildExit` — the only place the streak
counter is incremented — is consequently unreachable for this exit path in
production. This should be surfaced to whoever owns Task 16/16.5
(auto-revert), since that work is gated on this very acceptance and directly
consumes `tripEvent()`.

Item 1's premise held (real per-card UUIDs); nothing about this box makes
`DeviceLedger`'s renumber-detection a no-op.

## Not attempted / out of scope

- Rows outside A3's own 10 items (A2, A12, E7, E11, A18) — separate register
  rows, out of this ticket's scope per its own "Not in scope" section.
- Reconfiguring the shared Ollama service to be genuinely CPU-only at the
  process level (item 7 used the existing `ANALYZER_NUM_GPU=0` per-request
  override instead, which is a real CPU-only run without touching
  infrastructure other lanes on this box depend on).
- Building task 16/16.5 (explicitly out of scope — that is step 3, next).
  Item 5/6's finding directly affects that step's premise and is called out
  above for that reason.

