RESULT: DID NOT CONVERGE

# #3265 on-box run — NVML own-process `asr.warm` delta, real hardware

Child 1 of the `#3036` chain. This file records whether the new
`PlacementController._own_process_used_mb` NVML own-process VRAM delta
(concept per `#3265`: filter `nvmlDeviceGetComputeRunningProcesses` to
`os.getpid()`, diff `usedGpuMemory` across a resident `/transcribe`
forward) actually moves `asr.warm`'s learned estimate off its 128 MB seed
on real CUDA hardware.

**Verdict: the technique cannot converge on this box.** The code path is
correct and live — but Windows' WDDM driver reports `usedGpuMemory = None`
for our own PID in NVML's compute-process list even when that process
holds hundreds of MB of live CUDA memory, so `_own_process_used_mb`
returns `None` exactly as designed for that edge case, every warm sample
is discarded, and the learned estimate stays on the seed. Evidence below.

## Box / environment

- Windows 11 (win32), Python 3.12.10, sidecar `__version__` 1.14.0.
- GPU (the box's ONLY one — note this differs from the `#3012`/e12-era box
  that had a second 5070 Ti; `CUDA_VISIBLE_DEVICES=1` initially produced
  `gpus:[]` and a 503 on `/transcribe`, corrected to `0` for the recorded
  run below):

```
$ nvidia-smi -L
GPU 0: NVIDIA GeForce RTX 4070 Laptop GPU (UUID: GPU-1831b67f-ccc0-c3fc-9167-cff059c3224c)
$ nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv
0, NVIDIA GeForce RTX 4070 Laptop GPU, 8188 MiB, 0 MiB
```

- Sidecar venv: `server/tts-sidecar/.venv` (junctioned from the primary
  checkout), `faster-whisper` + `pynvml` (`nvidia-ml-py`) + torch
  `2.11.0+cu128` all import OK.

## Commands run

Sidecar launched from `server/tts-sidecar/` with:

```powershell
$env:ASR_DEVICE='cuda'; $env:ASR_MODEL='base'; $env:CUDA_VISIBLE_DEVICES='0'
$env:LOCAL_TTS_PORT='9124'; $env:LOCAL_TTS_HOST='127.0.0.1'
$env:COQUI_TOS_AGREED='1'; $env:PRELOAD_COQUI='0'
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 9124
```

Then, against `http://127.0.0.1:9124`: `GET /health` (poll) →
`GET /debug/memory` (before) → **1 cold `POST /transcribe`** (2-second
16 kHz 220 Hz PCM sine, `X-Sample-Rate: 16000`, raw body) → **6 warm
`POST /transcribe`** (same audio, 2 s apart) → `GET /debug/memory`
(after). Full runner log timestamps are pasted verbatim below.
## Runner log (verbatim)

```
=== ONBOX RUN START 2026-09-19T20:58:07.1379629+10:00 ===
2026-09-19T10:58:07Z  precheck: main.py clean
2026-09-19T10:58:07Z  sidecar PID=36636
health: {"ok":true,"protocol_version":1,"__version__":"1.14.0", ... ,
"asr_loaded":false,"asr_device":"cuda", ... ,
"gpus":[{"uuid":"1831b67f-ccc0-c3fc-9167-cff059c3224c","idx":0,"name":
"NVIDIA GeForce RTX 4070 Laptop GPU","total_mb":8585,"free_mb":7411,
"torch_reserved_mb":0,"free_floor_mb":1024.0,"reserved_ceiling_mb":8413.3,
"resident":[]}],"devices_state":"ready", ... ,
"vram_reserved_mb_by_device":{"cuda:0":{"reserved_mb":0.0,"total_mb":8585.216}},"vram_restart_mb":8413.51168}
2026-09-19T10:58:46Z  dbg-before.json written
2026-09-19T10:58:52Z  cold call HTTP 200 in 6s body={"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
2026-09-19T10:58:54Z  warm 1 HTTP 200 body={"text":"","language":"en",...}
2026-09-19T10:58:56Z  warm 2 HTTP 200 body={"text":"","language":"en",...}
2026-09-19T10:58:59Z  warm 3 HTTP 200 body={"text":"","language":"en",...}
2026-09-19T10:59:01Z  warm 4 HTTP 200 body={"text":"","language":"en",...}
2026-09-19T10:59:03Z  warm 5 HTTP 200 body={"text":"","language":"en",...}
2026-09-19T10:59:05Z  warm 6 HTTP 200 body={"text":"","language":"en",...}
2026-09-19T10:59:08Z  dbg-after.json written
2026-09-19T10:59:08Z  stopped sidecar 36636
ONBOX-DONE
```

Sidecar log confirms every call ran the real pipeline (weights loaded on
`cuda:0`, forwards executed — the sine contains no speech, so VAD removed
the audio and the language detector ran a full encoder forward per call;
`reservation()`'s warm bracketing thus executed 6 times):

```
2026-09-19 20:58:53.114 [sidecar] Processing audio with duration 00:02.000
2026-09-19 20:58:53.314 [sidecar] VAD filter removed 00:02.000 of audio
2026-09-19 20:58:53.520 [sidecar] Detected language 'en' with probability 0.61
(repeats for each of the 7 calls)
```

## /debug/memory footprints — BEFORE (verbatim, full response)

```json
{"process":{"rss_mb":1264.06656,"vms_mb":3083.472896,"private_mb":3083.472896,"committed_mb":3083.472896},"gc":{"counts":[644,2,6],"garbage":0,"tracked_objects":770446},"inflight_synth":0,"engines":{"qwen":{"base_loaded":false,"design_loaded":false,"base17_loaded":false,"prompt_cache_entries":0},"coqui":{"model_loaded":false},"kokoro":{"model_loaded":false},"whisper":{"model_loaded":false,"device":"cuda"}},"cuda":{"allocated_mb":0.0,"reserved_mb":0.0,"total_mb":8585.216,"host_pinned_owned_mb":0.0,"host_pinned_active_mb":0.0},"memory_stats":{"cuda:0":{"reserved":0,"allocated":0,"inactive_split":0,"num_alloc_retries":0}},"footprints":{"asr":{"seed_mb":400,"learned_mb":0,"sample_count":0},"asr.warm":{"seed_mb":128,"learned_mb":0,"sample_count":0},"coqui":{"seed_mb":3584,"learned_mb":0,"sample_count":0},"kokoro":{"seed_mb":1200,"learned_mb":0,"sample_count":0},"qwen":{"seed_mb":3072,"learned_mb":0,"sample_count":0},"qwen.1.7b":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"qwen.1.7b.design":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"qwen.1.7b.mint":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"spk":{"seed_mb":200,"learned_mb":0,"sample_count":0}}}
```
## /debug/memory footprints — AFTER cold + 6 warm calls (verbatim, full response)

```json
{"process":{"rss_mb":1605.967872,"vms_mb":3810.566144,"private_mb":3810.566144,"committed_mb":3810.566144},"gc":{"counts":[95,3,7],"garbage":0,"tracked_objects":776048},"inflight_synth":0,"engines":{"qwen":{"base_loaded":false,"design_loaded":false,"base17_loaded":false,"prompt_cache_entries":0},"coqui":{"model_loaded":false},"kokoro":{"model_loaded":false},"whisper":{"model_loaded":true,"device":"cuda:0"}},"cuda":{"allocated_mb":0.0,"reserved_mb":0.0,"total_mb":8585.216,"host_pinned_owned_mb":0.0,"host_pinned_active_mb":0.0},"memory_stats":{"cuda:0":{"reserved":0,"allocated":0,"inactive_split":0,"num_alloc_retries":0}},"footprints":{"asr":{"seed_mb":400,"learned_mb":0,"sample_count":1},"asr.warm":{"seed_mb":128,"learned_mb":0,"sample_count":0},"coqui":{"seed_mb":3584,"learned_mb":0,"sample_count":0},"kokoro":{"seed_mb":1200,"learned_mb":0,"sample_count":0},"qwen":{"seed_mb":3072,"learned_mb":0,"sample_count":0},"qwen.1.7b":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"qwen.1.7b.design":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"qwen.1.7b.mint":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"spk":{"seed_mb":200,"learned_mb":0,"sample_count":0}}}
```

Reading: `whisper.model_loaded:true device:"cuda:0"` — a resident ASR
engine existed and the 6 warm forwards went through `reservation()`'s
warm branch. Yet `"asr.warm":{"seed_mb":128,"learned_mb":0,
"sample_count":0}` — zero warm samples recorded. (The COLD `"asr"` key
took its usual device-wide-delta observation: `sample_count:1`.)

## WHY it did not converge — direct evidence

Standalone probe reproducing `_own_process_used_mb`'s exact NVML sequence
inside a process holding a KNOWN 400 MB CUDA allocation (sidecar venv's
Python, same box, minutes after the on-box run):

```
$ .venv\Scripts\python.exe oe-nvmlprobe.py
pid = 8432
pynvml import OK, version ?
torch 2.11.0+cu128 cuda avail: True
allocated 400MB on cuda:0; torch reserved_mb = 400
compute procs: [(8432, None)]
RESULT: own pid entry usedGpuMemory = None -> MB = None
```

So on this driver/OS:

- `nvmlInit` + `nvmlDeviceGetComputeRunningProcesses` **work**;
- our own PID **is** in the compute-process list (`8432` present);
- but its `usedGpuMemory` field is **`None`** despite 400 MB of live
  CUDA memory — the exact "field documented as potentially unavailable
  under WDDM" edge case `#3265` anticipated in `_own_process_used_mb`'s
  docstring (`main.py:5144-5147`).

`_own_process_used_mb` therefore returns `None` on every snapshot →
`warm_before_mb is None` short-circuits the delta at `main.py:5498` →
`observed_mb` stays `None` → `record(engine, ..., observed_mb or 0)` hits
`FootprintTable.record()`'s `<= 0` guard → sample discarded. The failure
contract held perfectly (never `0`-as-if-measured, never raises, never
poisons the estimate) — but there is no numeric signal to learn from.
This is a property of the box (WDDM per-process GPU memory accounting
needs driver support this consumer Windows laptop does not provide —
matches NVIDIA's NVML docs, which mark `usedGpuMemory` as not guaranteed
on WDDM), not of the implementation.

Corroborating detail: the sidecar's own torch accounting is also zero
(`"cuda":{"allocated_mb":0.0,"reserved_mb":0.0}`) while whisper sits on
`cuda:0` — re-confirming #2930/#3012's finding that CTranslate2 bypasses
the torch allocator, which is what motivated this technique at all.
## Mutation proofs (observed, not asserted)

Each mutation applied to `main.py` one line at a time,
`pytest tests/test_asr_footprint_measurement.py` run, `main.py` restored
afterward (post-run `# MUT` count verified `0` every time). Verbatim
pytest failure output per mutation:

- **MUT1** — warm branch `elif engine == "asr" and resident:` →
  `elif False:` (the exact #2682-era revert, routes warm back to the
  structurally-0 `_observed_mb`):

```
FAILED tests/test_asr_footprint_measurement.py::test_asr_warm_measurement_uses_the_nvml_own_process_delta
FAILED tests/test_asr_footprint_measurement.py::test_asr_warm_reservation_discards_when_the_after_reading_fails
FAILED tests/test_asr_footprint_measurement.py::test_asr_warm_reservation_does_not_double_guard_non_positive_deltas
3 failed, 21 passed in 9.56s
```

- **MUT2** — `if warm_after_mb is not None:` → `if True:` (removes the
  None-guard, arithmetic on None):

```
FAILED tests/test_asr_footprint_measurement.py::test_asr_warm_reservation_discards_when_the_after_reading_fails
1 failed, 23 passed in 6.53s
```

- **MUT3** — own-PID-absent path returns `0` instead of `None` (breaks
  the never-0-on-failure contract):

```
FAILED tests/test_asr_footprint_measurement.py::test_own_process_used_mb_returns_none_when_own_pid_is_absent
1 failed, 23 passed
```

- **MUT4** — falsy-`usedGpuMemory` check removed (`if not used:` →
  `if False:`):

```
FAILED tests/test_asr_footprint_measurement.py::test_own_process_used_mb_returns_none_when_used_gpu_memory_is_zero
1 failed, 23 passed
```

- **MUT5** — pynvml-unavailable path returns `0` instead of `None`:

```
FAILED tests/test_asr_footprint_measurement.py::test_own_process_used_mb_returns_none_when_pynvml_is_unavailable
1 failed, 23 passed
```
## Full unit-test output (acceptance #3)

```
$ .venv\Scripts\python.exe -m pytest tests/test_asr_footprint_measurement.py tests/test_footprints.py -vv
platform win32 -- Python 3.12.10, pytest-9.1.1, pluggy-1.6.0 -- C:\Claude\Projects\wt-3036-asr-warm-footprint\server\tts-sidecar\.venv\Scripts\python.exe
rootdir: C:\Claude\Projects\wt-3036-asr-warm-footprint\server\tts-sidecar
configfile: pytest.ini
collected 35 items

tests/test_asr_footprint_measurement.py::test_asr_cold_reservation_records_the_free_memory_delta PASSED
tests/test_asr_footprint_measurement.py::test_asr_reservation_discards_when_another_engine_holds_the_device PASSED
tests/test_asr_footprint_measurement.py::test_asr_warm_measurement_uses_the_nvml_own_process_delta PASSED
tests/test_asr_footprint_measurement.py::test_asr_warm_reservation_discards_when_the_after_reading_fails PASSED
tests/test_asr_footprint_measurement.py::test_asr_warm_reservation_does_not_double_guard_non_positive_deltas PASSED
tests/test_asr_footprint_measurement.py::test_asr_cold_measurement_is_not_capped PASSED
tests/test_asr_footprint_measurement.py::test_non_asr_engine_still_uses_the_torch_allocator_path PASSED
tests/test_asr_footprint_measurement.py::test_admit_and_reservation_agree_on_needed_mb_for_a_resident_engine PASSED
tests/test_asr_footprint_measurement.py::test_foreign_pid_holds_device_returns_none_for_a_non_cuda_device_key PASSED
tests/test_asr_footprint_measurement.py::test_foreign_pid_holds_device_returns_none_when_pynvml_is_unavailable PASSED
tests/test_asr_footprint_measurement.py::test_foreign_pid_holds_device_returns_false_when_only_self_is_present PASSED
tests/test_asr_footprint_measurement.py::test_foreign_pid_holds_device_returns_false_when_the_process_list_is_empty PASSED
tests/test_asr_footprint_measurement.py::test_foreign_pid_holds_device_returns_true_when_a_foreign_pid_is_present PASSED
tests/test_asr_footprint_measurement.py::test_foreign_pid_holds_device_returns_none_on_an_nvml_error PASSED
tests/test_asr_footprint_measurement.py::test_asr_cold_reservation_discards_when_a_foreign_pid_is_present PASSED
tests/test_asr_footprint_measurement.py::test_asr_cold_reservation_records_when_only_self_holds_the_device PASSED
tests/test_asr_footprint_measurement.py::test_asr_cold_reservation_discards_when_nvml_is_unavailable PASSED
tests/test_asr_footprint_measurement.py::test_own_process_used_mb_returns_none_for_a_non_cuda_device_key PASSED
tests/test_asr_footprint_measurement.py::test_own_process_used_mb_returns_none_when_pynvml_is_unavailable PASSED
tests/test_asr_footprint_measurement.py::test_own_process_used_mb_returns_none_when_own_pid_is_absent PASSED
tests/test_asr_footprint_measurement.py::test_own_process_used_mb_returns_mb_for_an_own_entry PASSED
tests/test_asr_footprint_measurement.py::test_own_process_used_mb_returns_none_when_used_gpu_memory_is_zero PASSED
tests/test_asr_footprint_measurement.py::test_own_process_used_mb_swallows_a_missing_used_gpu_memory_attribute PASSED
tests/test_asr_footprint_measurement.py::test_own_process_used_mb_swallows_nvml_init_failure PASSED
tests/test_footprints.py::test_peak_is_above_weight_size PASSED
tests/test_footprints.py::test_learned_p95_decays_not_max PASSED
tests/test_footprints.py::test_seed_used_until_min_samples PASSED
tests/test_footprints.py::test_nonpositive_observation_ignored PASSED
tests/test_footprints.py::test_design_family_keys_separate_from_synth PASSED
tests/test_footprints.py::test_design_family_windows_are_independent PASSED
tests/test_footprints.py::test_design_family_seeds_fit_bare_8gb_headroom PASSED
tests/test_footprints.py::test_asr_residency_splits_the_key PASSED
tests/test_footprints.py::test_asr_warm_seed_is_lower_than_cold PASSED
tests/test_footprints.py::test_asr_warm_and_cold_windows_learn_independently PASSED
tests/test_footprints.py::test_seed_parity_with_local_llm_doc PASSED

============================= 35 passed in 4.73s ==============================
```

## What #3266 should take from this

1. Own-process NVML attribution is **structurally dead on this box's
   Windows WDDM driver**: the own-PID entry EXISTS in
   `nvmlDeviceGetComputeRunningProcesses` but its `usedGpuMemory` reads
   `None` even with hundreds of MB of live CUDA memory. Do not re-attempt
   per-process NVML reads on this box expecting numbers.
2. The delta-window plumbing itself (before-snapshot in
   `_resolve_admission`, after-reading + three-way `observed_mb` routing
   in `reservation()`, the None-discipline throughout) is in place and
   mutation-proven — a fallback only needs to swap the READING inside
   `_own_process_used_mb`, not the bracketing.
3. The device-wide `_device_free_mb` delta remains the only VRAM reading
   on this box that returns values at all (#2094's foreign-PID
   contamination guards remain the cost of using it for warm sampling).




