# E12 on-box confirmation — `asr.warm` FootprintTable seed (PR #2799)

Date: 2026-09-06 (run window ~2026-09-05T23:03Z – 23:06Z UTC / 09:03–09:06 local)
Box: Windows 11, RTX 4070 Laptop (8 GB, GPU index 0) + RTX 5070 Ti (16 GB, GPU index 1, PCI 05:00.0)
Repo/worktree: `C:\Claude\Projects\wt-2930-e12-confirm`, branch `docs/docs-2930-e12-confirm`
File under test: `server/tts-sidecar/main.py`, `FootprintTable` (~line 4292), `SEED_FOOTPRINTS_MB["asr.warm"] = 128` (~line 4273)

## Claim being checked

Once a resident `faster-whisper` ASR model actually runs a warm forward pass on
real CUDA hardware, `FootprintTable`'s learned p95 for the `asr.warm` key
moves off the 128 MB seed to a real positive value in a plausible range
(low hundreds of MB), with zero `noCapacity` refusals during the run.

## Result summary (headline)

- The sidecar **did** start for real on the RTX 5070 Ti and `faster-whisper`
  **did** load and go resident on `cuda:0` (that index is GPU 1 physically,
  because the process was launched with `CUDA_VISIBLE_DEVICES=1`).
- `/transcribe` was called 7 times (1 cold load + 6 resident/warm calls), all
  returned **HTTP 200**, and **zero `noCapacity` refusals** were observed —
  confirmed both in every response body and in the full server log.
- **The actual learned `asr.warm` value could NOT be read back.** There is no
  HTTP endpoint, admin/debug route, or log line in this shipped code that
  exposes `FootprintTable`'s per-key state (seed or learned). This was
  verified by reading the full route table and grepping for every
  `footprints.record` / `peak_mb` call site and every `log.*` call near them
  — see "Observability gap" below. I could not fabricate a number, so this
  file reports what was and was not observed, per the task's own instruction
  not to fabricate a plausible-looking figure.
- A secondary, indirect signal is concerning for the claim: `torch.cuda`'s
  own allocated/reserved counters (surfaced via `/debug/memory` and the
  periodic `sidecar memory:` log line) read **exactly 0.0 MB, before and
  after all 6 resident /transcribe calls**, including the periodic peak
  tracker (`vram_reserved=0/17094MB (peak 0MB)`). `reservation()`'s
  `asr.warm` measurement is documented in main.py (line ~4267) to rely on
  `_observed_mb()`, which reads `torch.cuda.max_memory_allocated()` — i.e.
  exactly the counter that read 0 throughout this run. `FootprintTable.record()`
  discards any `observed_mb <= 0` (main.py line ~4356: `if observed_mb <= 0:
  return`). If the real-hardware behavior mirrors what the counters show,
  none of the 6 warm calls in this run would have produced a positive sample,
  and the learned estimate for `asr.warm` would still be sitting on the 128 MB
  seed, unchanged. I cannot confirm this either way without direct access to
  `FootprintTable._obs["asr.warm"]` inside the running process, which this
  shipped code does not expose. This is flagged as an anomaly, not a
  confirmed failure — it is the opposite of "moved off the seed to a
  plausible value" that the claim asserts.

## What was actually run

### 1. GPU inventory (confirms real hardware, not virtual/mocked)
```
nvidia-smi -L
GPU 0: NVIDIA GeForce RTX 4070 Laptop GPU (UUID: GPU-1831b67f-ccc0-c3fc-9167-cff059c3224c)
GPU 1: NVIDIA GeForce RTX 5070 Ti (UUID: GPU-73e7270e-ff5b-d1a2-de93-bc83af87699d)

nvidia-smi --query-gpu=index,name,memory.total,pci.bus_id --format=csv
0, NVIDIA GeForce RTX 4070 Laptop GPU, 8188 MiB, 00000000:01:00.0
1, NVIDIA GeForce RTX 5070 Ti, 16303 MiB, 00000000:05:00.0
```

### 2. Launched the sidecar, pinned to GPU 1 (the 5070 Ti)
Env vars used (via a throwaway `_launch_e12.ps1` helper, deleted after the
run — not committed):
```
ASR_DEVICE=cuda
ASR_MODEL=base
CUDA_VISIBLE_DEVICES=1
LOCAL_TTS_PORT=9123
LOCAL_TTS_HOST=127.0.0.1
COQUI_TOS_AGREED=1
PRELOAD_COQUI=0
```
Command: `.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 9123`,
launched detached via `Start-Process -WindowStyle Hidden`, output redirected
to a log file.

Confirmed listening via `GET /health` (2026-09-06T09:03Z local):
```
{"ok":true, ... "asr_loaded":false,"asr_device":"cuda", ...
 "gpus":[{"uuid":"73e7270e-ff5b-d1a2-de93-bc83af87699d","idx":0,
          "name":"NVIDIA GeForce RTX 5070 Ti","total_mb":17094, ...}], ...}
```
The `gpus[0].uuid` matches the RTX 5070 Ti's UUID from `nvidia-smi -L` above,
confirming `CUDA_VISIBLE_DEVICES=1` correctly steered the process onto the
5070 Ti (reported internally as `cuda:0` because of the masking), not the
4070.

### 3. Triggered a real ASR warm-up via `POST /transcribe`
No pre-existing sample wav/pcm fixture was found under
`server/tts-sidecar/tests/**` or `fixtures/**`, so a 2-second synthetic
16 kHz mono int16 PCM tone (220 Hz sine, ~64000 bytes) was generated with
numpy and posted as the raw request body, per the route's documented
contract (`X-Sample-Rate` header required).

Call 1 (cold — triggers the actual model load):
```
2026-09-05T23:04:23Z  POST /transcribe  X-Sample-Rate: 16000
-> HTTP_STATUS:200  (returned 2026-09-05T23:04:28Z)
{"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
```
Server log for this call:
```
2026-09-06 09:04:23.577 [sidecar] Loading Whisper ASR model=base device=cuda:0 compute=int8_float16 revision=(unpinned) ...
2026-09-06 09:04:27.237 [sidecar] Whisper ASR loaded (model=base device=cuda:0).
2026-09-06 09:04:27.237 [sidecar] Processing audio with duration 00:02.000
2026-09-06 09:04:27.326 [sidecar] VAD filter removed 00:02.000 of audio
2026-09-06 09:04:27.900 [sidecar] Detected language 'en' with probability 0.59
INFO:     127.0.0.1:55264 - "POST /transcribe HTTP/1.1" 200 OK
```

`GET /debug/memory` immediately after call 1 confirmed residency:
```
"engines":{... "whisper":{"model_loaded":true,"device":"cuda:0"}}
```

Calls 2–7 (resident/warm — each should exercise the `asr.warm` FootprintTable
key per `_key()`'s `resident=True` branch):
```
2026-09-05T23:04:44Z .. 2026-09-05T23:04:53Z  — 6 more POST /transcribe calls
All returned HTTP_STATUS:200. Sample body (identical shape each time):
{"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
```
Server log confirms each of the 6 calls went through the resident path (no
repeated "Loading Whisper ASR model=..." line — only the first call shows
the load):
```
2026-09-06 09:04:44.574 [sidecar] Processing audio with duration 00:02.000
2026-09-06 09:04:44.584 [sidecar] VAD filter removed 00:02.000 of audio
2026-09-06 09:04:44.672 [sidecar] Detected language 'en' with probability 0.59
INFO:     127.0.0.1:57097 - "POST /transcribe HTTP/1.1" 200 OK
... (x5 more, same shape, timestamps 09:04:45 / :49 / :52 / :53 / :53)
```
6 resident/warm calls were made — meeting `_FOOTPRINT_MIN_SAMPLES = 5` in
count, IF each call produced a recordable (`>0`) observation (see the
anomaly noted above for why that is not confirmed).

### 4. Reading back `FootprintTable`'s `asr.warm` state — NOT POSSIBLE

Explored for an observability path before concluding this:
- Full route table (`grep '@app\.(get|post)'` over main.py): `/health`,
  `/devices`, `/capacity`, `/debug/memory`, `/debug/codec-timing(/reset)`,
  `/debug/reclaim`, `/load`, `/unload`, `/recycle`, `/speakers`,
  `/qwen/*`, `/xtts/*`, `/synthesize*`, `/transcribe`, `/embed`. None of
  these serialize `FootprintTable._obs` or call `peak_mb()`/`record()` and
  echo the result.
- `/debug/memory` (the closest candidate — it explicitly returns per-engine
  residency and torch CUDA stats) does NOT include `PlacementController`
  or `FootprintTable` state anywhere in its response.
- Grepped for every `log.info`/`log.debug`/`log.warning` call near
  `FootprintTable`, `peak_mb`, `.record(`, and `asr.warm` in main.py: none
  exist. `record()` (line ~4353) and `peak_mb()` (line ~4344) are pure,
  silent methods with no logging inside them or at any call site.
- Checked the shipped tests (`tests/test_asr_footprint_measurement.py`,
  `tests/test_footprints.py`, `tests/test_placement.py`): all of them
  instantiate `FootprintTable`/`PlacementController` directly in-process
  and assert against `fp.records` (a Python list on a test double object).
  None of this is reachable from outside a live server process — it
  confirms the class's behavior in isolation but gives no live-process
  read-back mechanism.

Per the task's explicit instruction, no code change (print/log statement)
was added to work around this. **Conclusion: this shipped code has no way
to observe `FootprintTable`'s learned `asr.warm` estimate from outside the
process.** The only values available are the seed (`128`, static, read
directly from source) and the indirect torch-allocator signal reported above
(which stayed at 0 throughout the run).

### 5. `noCapacity` refusal check — confirmed ZERO

Checked two independent places:
- **Every `/transcribe` response body** (7 calls): none contained
  `"noCapacity"` — confirmed via `grep -l "noCapacity" /tmp/transcribe*.json`
  → no matches.
- **The full server log for the run** (from process start through the last
  `/transcribe` call): `grep -c "noCapacity"` → **0** matches.

GPU had ample headroom throughout (16303 MiB total, `/health` reported
`free_mb: 15767` before ASR loaded), so a capacity refusal was never a
realistic outcome here — this run does not stress the admission boundary,
it only confirms the happy path is refusal-free.

### 6. Shutdown

Both python processes bound to port 9123 (`.venv\Scripts\python.exe -m
uvicorn ...` and a duplicate parent/worker on the same port) were stopped
via `Stop-Process -Force`. Confirmed down: `GET /health` on port 9123
subsequently failed to connect. The throwaway launcher script, its log
file, and the synthetic PCM sample were deleted (all untracked, outside
this evidence file) — `git status` in the worktree is clean apart from this
new file.

## Deviations from the task's assumptions

1. **`SEG_ASR_ENABLED` does not exist in this codebase.** Grepped
   `main.py` thoroughly; the actual capacity-admission flag is
   `SEG_CAPACITY_ADMISSION` (default enabled, main.py line ~5190). No env
   var gates ASR itself on/off other than `ASR_DEVICE`/`ASR_MODEL`/
   `ASR_COMPUTE_TYPE`/`ASR_MODEL_REVISION`. `SEG_ASR_ENABLED` was not set
   and was not needed — `/transcribe` is unconditionally routed and just
   defaults to `ASR_DEVICE=cpu` if unset.
2. **No debug/metrics/admin endpoint exposes `FootprintTable` state**, and
   no log line does either — contrary to the task description's premise
   that "whatever internal endpoint/log line exposes FootprintTable's
   state" would exist. This was verified thoroughly (full route table +
   full grep of `record`/`peak_mb`/`FootprintTable` call sites), not
   assumed. This is the main blocker to fully confirming the claim.
3. **No sample audio fixture existed** in `tests/**` or `fixtures/**`; a
   synthetic sine-tone PCM buffer was generated instead, which is sufficient
   to exercise the ASR forward pass (loading + inference) even though the
   transcript itself is empty (no speech content).
4. **The initial launch attempts failed silently** twice before a working
   one: (a) processes spawned via `Start-Job` inside a sandboxed shell tool
   call die when that tool call's shell session ends, and (b) the first
   `Start-Process`-based launcher script had `$ErrorActionPreference =
   "Stop"`, which combined with PowerShell's `*>` redirection of a native
   command's stderr caused the whole launcher to abort immediately after
   `uvicorn`'s first stderr-INFO line (a `NativeCommandError`). Fixed by
   setting `$ErrorActionPreference = "Continue"` before invoking uvicorn.
   Neither issue is specific to this codebase; both are Windows/PowerShell
   process-launching gotchas encountered while trying to get a detached,
   log-redirected process running for this test.
5. **Two python processes ended up bound to port 9123** by the time cleanup
   ran (likely a stale leftover from one of the earlier failed launch
   attempts before the working one, though the working one's log showed
   only one `Started server process [...]` line). Both were stopped; the
   port was confirmed down afterward.

## Bottom line

The happy path is real and clean: real GPU (RTX 5070 Ti), real
`faster-whisper` load, real resident forward passes, zero `noCapacity`
refusals across 7 `/transcribe` calls. What could **not** be confirmed is
the specific claim that `FootprintTable`'s learned `asr.warm` estimate moved
off the 128 MB seed to a plausible value — the shipped code provides no way
to read that internal state from outside the process, and the one indirect
signal available (torch's own CUDA allocator counters) stayed at exactly
0 MB throughout, which is consistent with — though does not prove — the
learned estimate never receiving a positive sample at all during this run.
