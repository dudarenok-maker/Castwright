# E12 step 1 rework — `asr.warm` FootprintTable seed, root-caused (PR #2799)

Date: 2026-09-06 (run window ~2026-09-06T05:56Z – 05:57Z UTC)
Box: Windows 11, RTX 4070 Laptop (8 GB, GPU index 0) + RTX 5070 Ti (16 GB, GPU
index 1, PCI 05:00.0) — same box as step 1 (#2932).
Repo/worktree: `C:\Claude\Projects\wt-2930-e12-confirm`, branch
`docs/docs-2930-e12-confirm`, on top of step 1's commit `4f26f6af`.
File under test: `server/tts-sidecar/main.py`, `FootprintTable` (~line 4292),
`SEED_FOOTPRINTS_MB["asr.warm"] = 128` (~line 4273).

## Task

This is the rework child for #2930/#2799's E12 confirmation chain, following
step 2's verify (#2931), which found step 1 (#2932) could not read back
`FootprintTable`'s learned `asr.warm` value and flagged the 0.0 MB torch CUDA
counter anomaly as unresolved. Three things were asked for:

1. Add minimal instrumentation to read `FootprintTable`'s per-key state from
   outside the running process.
2. Investigate why `torch.cuda`'s allocated/reserved counters read exactly
   0.0 MB throughout step 1's run.
3. Re-run the real on-box confirmation with that instrumentation and paste
   the actual observed `asr.warm` value(s).

## Result summary (headline)

- **Instrumentation added and confirmed working on real hardware** (see
  below): `GET /debug/memory` now returns a `footprints` block with
  `{seed_mb, learned_mb, sample_count}` per `FootprintTable` key.
- **The 0.0 MB counter anomaly is ROOT-CAUSED, not just reproduced.** It is
  not a reset-timing bug, a device-index mismatch, or a transient condition —
  it is structural: `faster-whisper`'s CTranslate2 backend never allocates
  through PyTorch's caching allocator, for *anything*, weights or per-forward
  activations alike. A standalone script (below) loading the same model the
  same way and running an inference confirms `torch.cuda.max_memory_
  allocated()`, `torch.cuda.memory_reserved()`, and
  `torch.cuda.memory_stats()['allocated_bytes.all.current']` all read exactly
  `0` after a real resident forward pass on real CUDA hardware, with no
  exception and no reset-timing issue (CUDA was explicitly initialized first).
  CTranslate2 uses its own CUDA context (cuBLAS/cuDNN calls issued directly,
  not via `torch.cuda.caching_allocator_alloc`), so torch's allocator is
  simply never invoked by anything faster-whisper does, cold load or warm
  forward. `_observed_mb()`'s premise for `asr.warm` (main.py ~line
  4267: "a resident forward's OWN torch-side activity ... is enough for the
  allocator peak to see") does **not** hold for this engine.
- **Re-run with the new instrumentation confirms the consequence live**: after
  1 cold load + 6 resident `/transcribe` calls, `asr.warm`'s `sample_count`
  is still **0** and `learned_mb` is still **0** — `FootprintTable.record()`'s
  `observed_mb <= 0` guard (main.py ~line 4356) discarded every single one of
  the 7 calls' observations, exactly as the root cause above predicts. The
  learned estimate has **not converged and structurally cannot converge**
  under the current `_observed_mb`-based measurement for this specific
  engine/key. This directly answers acceptance criterion 3's "OR" branch: a
  documented, evidence-backed conclusion that it cannot converge as
  originally claimed, and why.
- Zero `noCapacity` refusals reconfirmed for this run (response bodies and
  full server log both checked).

## What was actually run

### 1. GPU inventory (confirms real hardware, not virtual/mocked)
```
nvidia-smi -L
GPU 0: NVIDIA GeForce RTX 4070 Laptop GPU (UUID: GPU-1831b67f-ccc0-c3fc-9167-cff059c3224c)
GPU 1: NVIDIA GeForce RTX 5070 Ti (UUID: GPU-73e7270e-ff5b-d1a2-de93-bc83af87699d)

nvidia-smi --query-gpu=index,name,memory.total,pci.bus_id --format=csv
0, NVIDIA GeForce RTX 4070 Laptop GPU, 8188 MiB, 00000000:01:00.0
1, NVIDIA GeForce RTX 5070 Ti, 16303 MiB, 00000000:05:00.0

faster_whisper 1.2.1, ctranslate2 4.8.0 (from the worktree's own .venv)
```

### 2. Root-cause check — standalone script, no sidecar, direct torch/CTranslate2 probe

Ran directly against the worktree's `.venv` (`CUDA_VISIBLE_DEVICES=1`, i.e.
the RTX 5070 Ti):

```python
import torch
torch.cuda.init()
torch.cuda.reset_peak_memory_stats(0)
from faster_whisper import WhisperModel
import numpy as np
m = WhisperModel('base', device='cuda', compute_type='int8_float16')
print('after load: allocated=', torch.cuda.max_memory_allocated(0), 'reserved=', torch.cuda.memory_reserved(0))
torch.cuda.reset_peak_memory_stats(0)
audio = (0.1*np.sin(2*np.pi*220*np.arange(32000)/16000)).astype('float32')
segs, info = m.transcribe(audio, language='en')
list(segs)
print('after warm forward: allocated=', torch.cuda.max_memory_allocated(0), 'reserved=', torch.cuda.memory_reserved(0))
print('memory_stats current:', torch.cuda.memory_stats(0).get('allocated_bytes.all.current'))
```

Output (verbatim):
```
after load: allocated= 0 reserved= 0
after warm forward: allocated= 0 reserved= 0
memory_stats current: 0
```

This isolates the anomaly to CTranslate2/faster-whisper's own CUDA usage,
independent of the sidecar's reservation bookkeeping, `_reset_peak_mb`
timing, or the device-index masking under `CUDA_VISIBLE_DEVICES` (torch's
own `device_count()`-relative index `0` was used throughout, matching what
`probe_capacity()` and `reservation()` use internally). A real model load and
a real forward pass ran on real CUDA hardware between the two counter reads;
torch's allocator counters never moved off exactly 0. This rules out reset
ordering, a stale snapshot, or a masking bug as the explanation, and confirms
CTranslate2's separate CUDA context as the cause: PyTorch's caching allocator
is a bystander to CTranslate2's own cuBLAS/cuDNN calls, for both weights and
per-forward activation buffers alike (the per-forward attention/feature
buffers are also allocated inside CTranslate2's own context — there is no
torch-side activity for `asr.warm`'s "resident forward" reasoning to
measure).

### 3. Instrumentation added — `GET /debug/memory`'s new `footprints` block

`FootprintTable.snapshot()` (new method, main.py) returns
`{key: {seed_mb, learned_mb, sample_count}}` for every key with a seed or a
recorded observation; wired into `/debug/memory`'s response under a new
`footprints` key, guarded the same way every other block in that route is
(a failure degrades to omission, never a 500).

Confirmed live, `GET /debug/memory` **before** any `/transcribe` call:
```json
"footprints": {
  "asr": {"seed_mb": 400, "learned_mb": 0, "sample_count": 0},
  "asr.warm": {"seed_mb": 128, "learned_mb": 0, "sample_count": 0},
  "coqui": {"seed_mb": 3584, "learned_mb": 0, "sample_count": 0},
  "kokoro": {"seed_mb": 1200, "learned_mb": 0, "sample_count": 0},
  "qwen": {"seed_mb": 3072, "learned_mb": 0, "sample_count": 0},
  "qwen.1.7b": {"seed_mb": 6144, "learned_mb": 0, "sample_count": 0},
  "qwen.1.7b.design": {"seed_mb": 6144, "learned_mb": 0, "sample_count": 0},
  "qwen.1.7b.mint": {"seed_mb": 6144, "learned_mb": 0, "sample_count": 0},
  "spk": {"seed_mb": 200, "learned_mb": 0, "sample_count": 0}
}
```
This is the acceptance-criterion-1 demonstration: a live process, a real
request/response, and `FootprintTable`'s per-key seed/learned/sample-count
state is now readable from outside the process for the first time.

### 4. Launched the sidecar, pinned to GPU 1 (the 5070 Ti) — same method as step 1

Env vars (throwaway helper script, not committed):
```
ASR_DEVICE=cuda
ASR_MODEL=base
CUDA_VISIBLE_DEVICES=1
LOCAL_TTS_PORT=9124
LOCAL_TTS_HOST=127.0.0.1
COQUI_TOS_AGREED=1
PRELOAD_COQUI=0
```
Command: `.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 9124`,
launched detached via `Start-Process -WindowStyle Hidden`, output redirected
to log files.

`GET /health` confirmed the correct card (2026-09-06T05:56Z):
```json
{"ok":true, ..., "asr_loaded":false, "asr_device":"cuda", ...,
 "gpus":[{"uuid":"73e7270e-ff5b-d1a2-de93-bc83af87699d","idx":0,
          "name":"NVIDIA GeForce RTX 5070 Ti","total_mb":17094, ...}], ...}
```
`gpus[0].uuid` matches the RTX 5070 Ti's UUID from `nvidia-smi -L` above.

### 5. Triggered a real ASR warm-up via `POST /transcribe`

Same synthetic 16 kHz mono int16 PCM tone approach as step 1 (2-second,
220 Hz sine, 64000 bytes), posted with the `X-Sample-Rate` header.

Call 1 (cold — triggers the model load), 2026-09-06T05:56:43Z:
```
HTTP_STATUS:200
{"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
```
Server log:
```
2026-09-06 15:56:43.810 [sidecar] Loading Whisper ASR model=base device=cuda:0 compute=int8_float16 revision=(unpinned) ...
2026-09-06 15:56:45.231 [sidecar] Whisper ASR loaded (model=base device=cuda:0).
2026-09-06 15:56:45.232 [sidecar] Processing audio with duration 00:02.000
2026-09-06 15:56:45.281 [sidecar] VAD filter removed 00:02.000 of audio
2026-09-06 15:56:45.606 [sidecar] Detected language 'en' with probability 0.59
```

Calls 2–7 (resident/warm), all HTTP 200, same response shape, log confirms
no repeated "Loading Whisper ASR model=..." line (resident path):
```
2026-09-06 15:56:51.982 .. 15:56:53.052  — 6 more POST /transcribe calls,
each: "Processing audio with duration 00:02.000" / "VAD filter removed
00:02.000 of audio" / "Detected language 'en' with probability 0.59"
```
Periodic memory log line during the run:
```
2026-09-06 15:56:50.276 [sidecar] sidecar memory: rss=1690MB committed=3717MB (peak 3717MB) vram_reserved=0/17094MB (peak 0MB)
```
6 resident/warm calls were made, meeting `_FOOTPRINT_MIN_SAMPLES = 5` in
*call* count — but see below for why this did not translate into 5 *recorded
observations*.

### 6. Reading back `FootprintTable`'s `asr.warm` state — now possible, and confirms the anomaly's consequence

`GET /debug/memory` immediately after all 7 `/transcribe` calls:
```json
"footprints": {
  "asr": {"seed_mb": 400, "learned_mb": 0, "sample_count": 0},
  "asr.warm": {"seed_mb": 128, "learned_mb": 0, "sample_count": 0}
}
"cuda": {"allocated_mb": 0.0, "reserved_mb": 0.0, "total_mb": 17094.475776,
         "host_pinned_owned_mb": 0.0, "host_pinned_active_mb": 0.0}
```
`asr.warm`'s `sample_count` stayed at **0** through all 6 resident calls —
`FootprintTable.record()` never received a positive `observed_mb`, so its
`observed_mb <= 0` guard discarded every one. The learned estimate is still
sitting on the 128 MB seed, **unchanged**, exactly the outcome step 1 flagged
as a possibility and could not confirm. This run confirms it directly, with
the exact per-key sample count now visible.

### 7. `noCapacity` reconfirmation

All 7 response bodies (`resp1.json`, `warm_1.json` .. `warm_6.json`) grepped
for `noCapacity`: 0 matches. Full server log (`sidecar-err.log`) grepped for
`noCapacity`/case-insensitive: 0 matches. Zero refusals, matching step 1.

## Root cause, stated plainly

`_observed_mb()` (main.py ~line 4853) reads
`torch.cuda.max_memory_allocated(index)` — PyTorch's own caching-allocator
peak. `#2682`'s design for `asr.warm` (main.py ~4257-4272) reasoned that even
though CTranslate2 (faster-whisper's backend) allocates its *weights*
entirely outside torch's allocator, a resident forward's *own* torch-side
activity (feature extraction, attention buffers) would still register on
that counter. Root cause #2's standalone reproduction (§2 above) shows that
premise is false: CTranslate2 does not route *any* of its CUDA work — weights
or per-forward buffers — through PyTorch's allocator. It issues its own
cuBLAS/cuDNN calls against its own CUDA context. From `torch.cuda`'s point of
view, a `faster-whisper`/CTranslate2 forward pass is invisible, full stop,
regardless of load state (cold or warm) — there is no torch-side activity of
any kind for `max_memory_allocated`/`memory_reserved`/`memory_stats` to
register. This is a structural mismatch between the measurement technique
(torch's own allocator) and the engine being measured (an engine that
deliberately does not use torch's allocator), not a bug in reset timing,
device selection, or the reservation bookkeeping around it — all of which
were exercised correctly in both step 1's run and this one.

**Consequence**: `asr.warm`'s learned `FootprintTable` estimate cannot
converge under the current `_observed_mb`-based measurement, ever, no matter
how many resident forward calls are made. A real fix (out of scope for this
rework, which is instrumentation + diagnosis only) would need either (a) a
CTranslate2-side memory query (it does expose some allocator stats — not
explored further here since it's a new capability, not a fix to the existing
measurement path) or (b) reverting to the device-wide free-memory delta
`_device_free_mb` already uses for the *cold* `asr` key, with the same
foreign-PID/concurrent-reservation guards `reservation()` already has for
that path. Either is a step 3/rework-of-#2682 decision for a human or a
future ticket, not this one.

## Instrumentation disposition

**Kept.** `FootprintTable.snapshot()` and `/debug/memory`'s `footprints`
block are a real, permanent observability gap this fixes (the same class of
gap `/debug/memory`'s other blocks already fill for RSS, GC, and per-engine
residency) — not removed after this run.

## Cleanup

- `Stop-Process -Id 6136 -Force` (the uvicorn process); confirmed gone via
  `Get-Process -Id 6136` returning nothing.
- `Get-Process | Where-Object { $_.Path -like '*wt-2930-e12-confirm*' }`
  returned nothing — no stray sidecar processes left in this worktree.
- No fixture or log files were committed; all scratch files (tone.pcm,
  response bodies, sidecar logs, the launch helper) live under this run's
  `%OE_RUN_SCRATCH%`, not the worktree.
- `git status` in the worktree is clean apart from this file and the
  `main.py` instrumentation diff (see commit).
