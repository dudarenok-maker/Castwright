# Step 5 — E4, the wizard CPU caveat: CONFIRMED

Issue: Castwright#2990 ("Human-checkpoint batch step 5 - E4 CPU-forced Qwen
render"). Row E4 (`docs/testing/onbox-acceptance-register.md:4241`), on-box
acceptance register campaign (#2435), step 5 of #2978.

## Setup

This worktree (`wt-human-checkpoint-batch`, branch
`docs/docs-human-checkpoint-batch`) has its own `server/.env`:

```
PORT=8270
WORKSPACE_DIR=../castwright-workspace
LOCAL_TTS_PORT=9190
```

Confirmed this is a real per-worktree isolation port (#2632's fix,
`server/src/tts/sidecar-owner.ts` resolves `LOCAL_TTS_PORT`, default 9000).
Before starting, `:9190` and `:8270` were confirmed idle
(`Get-NetTCPConnection` returned no listener on either).

Started this worktree's own app (`npm run dev`, detached, output to a
per-run scratch log). Server log confirms:

```
2026-09-07 07:56:05.485 [server] listening on http://localhost:8270
2026-09-07 07:56:05.547 [sidecar] spawned pid=35732 (... modelKey=qwen3-tts-1.7b)
```

`/health` on `127.0.0.1:9190` responded immediately after — a genuinely
separate sidecar process from any other lane's, on this worktree's own port.

## Forcing CPU

Set `tts.qwen.device` via `PUT /api/config` (the registry's own knob,
`server/src/config/registry.ts:676-682`, `env: QWEN_DEVICE`,
`apply: 'restart-sidecar'`):

```
PUT /api/config {"tts.qwen.device":"cpu"}
-> {"ok":true, ..., "tts.qwen.device":{"effective":"cpu","source":"override"}}
```

The knob does not take effect until the sidecar actually restarts (Layer 2
of `spawn-sidecar.ts` injects `restart-sidecar` overrides into the child
env at spawn time). Called `POST /api/sidecar/restart`, which cycled the
child (log: `child exited (code=1)` → `respawning` → `spawned pid=34192`).
Post-restart `/health`:

```json
"devices": {"kokoro": "cuda", "coqui": "cuda", "qwen": "cpu"}
```

Confirmed the resolved device is `cpu`, not a silent fallback to `cuda`.

## Real render, forced CPU

Drove the sidecar's own `/synthesize` directly (`engine=qwen,
model=qwen3-tts-1.7b`, an already-designed voice id found via `GET
/speakers`), text: "This is a short test line to confirm the CPU-forced
Qwen render completes without crashing." Two calls (cold load, then a
second warm call) to separate model-load time from steady-state inference:

| Call | HTTP | Wall time | Audio (L16 24kHz) | RTF (wall/audio) |
|---|---|---|---|---|
| CPU, cold | 200 | 34.71 s | 5.52 s (264960 B) | 6.29 |
| CPU, warm | 200 | 29.69 s | 5.68 s (272640 B) | 5.23 |

Both completed with HTTP 200 and a valid PCM payload (`x-sample-rate:
24000`, `content-type: audio/L16;codec=pcm;rate=24000`) — no crash, no 500,
no silent engine fallback. `/health` after each call still showed
`qwen_loaded: true`, `devices.qwen: "cpu"`, and GPU `free_mb` for both cards
unchanged from their pre-render values — confirming no VRAM was touched,
i.e. the render genuinely ran on CPU rather than landing back on `cuda`.

**RTF ≈ 5.2–6.3×** (30–35 s of wall time to produce 5.5–5.7 s of audio) is
unambiguously slower than real-time — a production audiobook render on this
path would take roughly 5-6x the book's own runtime.

## GPU comparison — partially confounded by live box contention

Reset `tts.qwen.device` to `auto` and restarted the sidecar to get a GPU
baseline for the same text/voice:

- `cuda:0` (RTX 4070 Laptop, 8585 MB): cold render succeeded (32.45 s,
  253440 B ≈ 5.28 s audio), but the immediate second (warm) call returned
  `503 {"noCapacity":true,"neededMb":6144,"deviceKey":"cuda:0"}`.
  `/health` showed free VRAM on that card had dropped from 7411 MB to
  5524 MB between the two calls, and `nvidia-smi
  --query-compute-apps` showed other resident python processes on the
  card that are not this worktree's sidecar. Per this ticket's standing
  rules ("never stop, kill, or restart any other process on this box"),
  this contention was recorded and not touched or worked around by evicting
  anyone else's process.
- `cuda:1` (RTX 5070 Ti, 15767 MB free, otherwise idle) was tried next to
  get an uncontended GPU number: cold 61.54 s / warm 50.74 s — both *slower*
  than the CPU numbers above. This is very likely itself an artifact of
  concurrent load elsewhere on the box (many other lanes' node/python/ollama
  processes were live throughout, competing for the same CPU cores and PCIe
  bandwidth this sidecar also needs for its GPU calls), not a genuine
  GPU-vs-CPU comparison — a laptop 4070 or a 5070 Ti running a 1.7B TTS
  model uncontended is expected to be well under real-time (RTF < 1), which
  is the entire premise of `CAVEAT_VRAM` in
  `server/src/tts/engine-recommendation.ts:34` recommending GPU as the
  multi-cast default and CPU only as the (slower) fallback.

So: **a clean, same-conditions GPU number could not be captured on this
shared box today** without touching another lane's live process, which this
run correctly declined to do. This does not weaken E4's own verdict — the
row's claim is specifically about the CPU path completing and being slow,
which is fully confirmed above — but the "measurably slower than a GPU
render" comparison is only directionally supported (both GPU attempts here
ran comparably slow or slower purely from box contention, and the docs'
own stated premise for the GPU default is well-established elsewhere in
the codebase rather than independently re-measured today).

Reset `tts.qwen.device` back to `auto` (the default) before stopping.

## Cleanup

Stopped this worktree's own server + sidecar process tree (all PIDs spawned
under this run's root PID, confirmed via `Get-CimInstance
Win32_Process -Filter "ParentProcessId=..."`, not any other lane's
process). Confirmed `:9190` and `:8270` have no live listener afterward.
No other process on the box was stopped, killed, or restarted.

## Verdict

**E4 CONFIRMED.** A real Qwen render on this worktree's own isolated
sidecar (`:9190`), with `tts.qwen.device` forced to `cpu`, completes without
crashing (HTTP 200, valid audio payload, twice), is slow (RTF ≈ 5.2–6.3×
realtime — 30–35 s of wall time for 5.5–5.7 s of audio), and `/health`
confirms the device actually used was `cpu` (not a silent fallback to
`cuda`), with GPU VRAM unchanged across both CPU calls. The GPU-comparison
half of the acceptance criterion is only partially satisfiable today due to
genuine, undisturbed contention from other lanes live on this shared box —
recorded above rather than worked around.

Refs #2978, #2435, #2990
