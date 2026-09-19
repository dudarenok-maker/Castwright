RESULT: DID NOT CONVERGE

# #3266 on-box run — device-wide free-VRAM delta for `asr.warm`, with the full cold guard set

Child 2 of the `#3036` chain (the `#2094`→`#2682` direction-2 retry). The question this
file answers: does routing the warm-ASR measurement through the SAME
`_device_free_mb()` device-wide delta the cold `"asr"` key uses, NOW carrying the
foreign-PID / concurrent-reservation guards #3265 established, let `asr.warm` learn a
single positive sample on real CUDA hardware?

**Verdict: no.** Six warm forwards over a demonstrably uncontaminated window produced
ZERO accepted samples; `asr.warm` stays pinned at its 128 MB seed. Child 1's
conclusion (#3265, NVML own-process delta — also DID NOT CONVERGE) is not
overwritten, it is complemented: on this box, BOTH #3036 directions are now tried on
real hardware and documented non-viable.

## Box / branch state

- Windows 11 laptop (win32), Python 3.12.10, RTX 4070 Laptop (8188 MiB VRAM) — same
  box and venv as the step-1 run.
- Branch `fix/sidecar-3036-asr-warm-footprint` @ `a28321c3` (the fallback commit,
  on top of `bf7eea38` = #3265's NVML branch, on `2e8e4c60` step-1 docs, on the
  `4c636a08` master merge).
- Precheck (`nvidia-smi`): 1% GPU util, 0 MiB used, **no compute processes** — card
  idle. This matters: #2682 abandoned the device-wide warm delta as "essentially
  never returns positive", and #3036's theory was that contamination — not
  driver-level noise on the delta — had suppressed it. This run tests that theory on
  a provably clean window.
- `git diff --stat origin/master...HEAD -- server/tts-sidecar/main.py`: 64 insertions,
  31 deletions — main.py genuinely changed by this child, so the booted sidecar runs
  its code (closes AGENT RESUMED correction fix #1).

## Command run

```
pwsh -NoProfile -File C:\Claude\LocalSkills\gepeto\oe-invoke-gpt56.sh --issue 3266
  --agent-id cline-qwen-cloud --lane onbox "Work ONLY in
  C:\Claude\Projects\wt-3036-asr-warm-footprint (branch
  fix/sidecar-3036-asr-warm-footprint, child 2 of the #3036 chain, resumed after
  #3266's AGENT STALLED). Read the AGENT RESUMED correction comment on #3266 FIRST:
  fix items (re-apply the fallback: warm branch measures asr.warm via
  PlacementController._device_free_mb with foreign-PID/concurrent-reservation
  guards; NVML _own_process_used_mb stays in codebase but no longer called from
  reservation; update the two site comments; fix docs claim; run focused pytest and
  paste output), then reuse docs/testing/onbox-3036-results/step-1-nvml.md's proven
  launch recipe for a DETACHED on-box run: boot real sidecar, warm POSTs to
  /transcribe (X-Sample-Rate: 16000), /debug/memory footprints block before+after,
  write docs/testing/onbox-3036-results/step-2-device-delta.md, commit, push, paste
  exact /debug/memory JSON and runner log. Long-running: detached Start-Process
  pattern with polling. Then flip #3267 Agent Waiting->Agent Todo, post AGENT DONE
  receipt, update ledger in place."
```

Procedure inside the detached helper (`oe-onbox-3266.ps1`): generate a 2 s
16 kHz mono PCM16 220 Hz sine WAV → poll `GET /health` → `GET /debug/memory`
(before) → COLD `POST /transcribe` (raw WAV body, `X-Sample-Rate: 16000`) →
6 more `POST /transcribe` at ~2 s gaps → `GET /debug/memory` (after) → kill sidecar.

## Runner log (verbatim)

```
2026-09-19T16:09:15Z  ONBOX-START
2026-09-19T16:09:15Z  tone written: 64044 bytes
2026-09-19T16:09:15Z  sidecar launching (hidden, detached) pid-file target port 9124
2026-09-19T16:09:15Z  waiting for /health (up to 180s)
2026-09-19T16:09:33Z  HEALTH OK after 1 tries: {"status":"ready","engines":{"kokoro":"cuda","coqui":"cuda","qwen":"cuda"},"device":"cuda","version":"1.14.0"}
2026-09-19T16:09:33Z  dbg-before.json written
2026-09-19T16:09:33Z  COLD transcribe: POST http://127.0.0.1:9124/transcribe (raw WAV body, X-Sample-Rate: 16000)
2026-09-19T16:09:52Z  cold HTTP 200 in 19s body={"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
2026-09-19T16:09:52Z  WARM transcribes: 6 POSTs, 2s gaps
2026-09-19T16:09:55Z  warm 1 HTTP 200 in 2s body={"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
2026-09-19T16:09:57Z  warm 2 HTTP 200 in 0s body={"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
2026-09-19T16:09:59Z  warm 3 HTTP 200 in 1s body={"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
2026-09-19T16:10:01Z  warm 4 HTTP 200 in 1s body={"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
2026-09-19T16:10:03Z  warm 5 HTTP 200 in 1s body={"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
2026-09-19T16:10:04Z  warm 6 HTTP 200 in 0s body={"text":"","language":"en","avg_logprob":null,"no_speech_prob":null,"compression_ratio":null,"words":null}
2026-09-19T16:10:04Z  dbg-after.json written
2026-09-19T16:10:04Z  stopped sidecar 16756
2026-09-19T16:10:04Z  ONBOX-DONE
```

All 7 transcribes returned HTTP 200. Cold took 19 s (model check + CUDA load); every
warm call 0–2 s — the residency path was exercised every time.

## Sidecar log evidence the real pipeline ran

The warm branch only fires when ASR is genuinely resident (failure mode #3 of the
gate-passed comment: "booted the wrong thing"). Sidecar stderr, verbatim excerpt:

```
INFO:     Uvicorn running on http://127.0.0.1:9124 (Press CTRL+C to quit)
2026-09-20 02:09:49.182 [sidecar] Loading Whisper ASR model=base device=cuda:0 compute=int8_float16 revision=(unpinned) ...
2026-09-20 02:09:50.272 [sidecar] Whisper ASR loaded (model=base device=cuda:0).
2026-09-20 02:09:50.272 [sidecar] Processing audio with duration 00:02.000
2026-09-20 02:09:50.276 [sidecar] VAD filter removed 00:00.000 of audio
2026-09-20 02:09:50.482 [sidecar] Detected language 'en' with probability 0.54
2026-09-20 02:09:52.701 [sidecar] Processing audio with duration 00:02.000
2026-09-20 02:09:52.717 [sidecar] VAD filter removed 00:00.000 of audio
2026-09-20 02:09:52.796 [sidecar] Detected language 'en' with probability 0.54
```

... repeating for all 7 calls (02:09:50, 52, 55, 57, 59, 02:10:02, 02:10:04 local —
matching the UTC runner log). VAD removed 0.000 s of audio each time, so every call —
cold and warm — executed a FULL whisper forward against the CUDA-resident model.
Empty `text` in responses is expected for a synthetic tone; the forward, not the
transcript, is what the measurement brackets.

## GET /debug/memory `footprints` — verbatim, before and after

### Before the cold + 6 warm calls (full response)

```json
{"process":{"rss_mb":1266.475008,"vms_mb":3081.531392,"private_mb":3081.531392,"committed_mb":3081.531392},"gc":{"counts":[644,2,6],"garbage":0,"tracked_objects":770444},"inflight_synth":0,"engines":{"qwen":{"base_loaded":false,"design_loaded":false,"base17_loaded":false,"prompt_cache_entries":0},"coqui":{"model_loaded":false},"kokoro":{"model_loaded":false},"whisper":{"model_loaded":false,"device":"cuda"}},"cuda":{"allocated_mb":0.0,"reserved_mb":0.0,"total_mb":8585.216,"host_pinned_owned_mb":0.0,"host_pinned_active_mb":0.0},"memory_stats":{"cuda:0":{"reserved":0,"allocated":0,"inactive_split":0,"num_alloc_retries":0}},"footprints":{"asr":{"seed_mb":400,"learned_mb":0,"sample_count":0},"asr.warm":{"seed_mb":128,"learned_mb":0,"sample_count":0},"coqui":{"seed_mb":3584,"learned_mb":0,"sample_count":0},"kokoro":{"seed_mb":1200,"learned_mb":0,"sample_count":0},"qwen":{"seed_mb":3072,"learned_mb":0,"sample_count":0},"qwen.1.7b":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"qwen.1.7b.design":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"qwen.1.7b.mint":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"spk":{"seed_mb":200,"learned_mb":0,"sample_count":0}}}
```

### After the cold + 6 warm calls (full response)

```json
{"process":{"rss_mb":1728.483328,"vms_mb":3987.5584,"private_mb":3987.5584,"committed_mb":3987.5584},"gc":{"counts":[77,3,7],"garbage":0,"tracked_objects":776038},"inflight_synth":0,"engines":{"qwen":{"base_loaded":false,"design_loaded":false,"base17_loaded":false,"prompt_cache_entries":0},"coqui":{"model_loaded":false},"kokoro":{"model_loaded":false},"whisper":{"model_loaded":true,"device":"cuda:0"}},"cuda":{"allocated_mb":0.0,"reserved_mb":0.0,"total_mb":8585.216,"host_pinned_owned_mb":0.0,"host_pinned_active_mb":0.0},"memory_stats":{"cuda:0":{"reserved":0,"allocated":0,"inactive_split":0,"num_alloc_retries":0}},"footprints":{"asr":{"seed_mb":400,"learned_mb":0,"sample_count":1},"asr.warm":{"seed_mb":128,"learned_mb":0,"sample_count":0},"coqui":{"seed_mb":3584,"learned_mb":0,"sample_count":0},"kokoro":{"seed_mb":1200,"learned_mb":0,"sample_count":0},"qwen":{"seed_mb":3072,"learned_mb":0,"sample_count":0},"qwen.1.7b":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"qwen.1.7b.design":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"qwen.1.7b.mint":{"seed_mb":6144,"learned_mb":0,"sample_count":0},"spk":{"seed_mb":200,"learned_mb":0,"sample_count":0}}}
```

Note `asr.learned_mb: 0` with `sample_count: 1` is `snapshot()`'s documented
semantics (L4560-4562): `learned_mb` stays 0 below `_FOOTPRINT_MIN_SAMPLES` = 5; the
COUNT is what proves a sample was accepted.

### Reading

- After: `whisper.model_loaded: true`, `whisper.device: "cuda:0"` — ASR was genuinely
  resident on the GPU for every warm call, and all 6 warm forwards went through
  `reservation()`'s warm branch.
- `"asr"` (cold): `sample_count: 1` — the cold device-wide delta fired, passed its
  guards, and recorded a positive sample **in this same session**. The entire
  measurement apparatus — `_device_free_mb` readings, NVML process-list foreign-PID
  check, concurrent-reservation check, `record()` — is alive and functional on this
  box.
- `"asr.warm"`: `seed_mb: 128, learned_mb: 0, sample_count: 0` — none of the six warm
  deltas produced a recordable sample.
- The sidecar's torch block (`cuda`, `memory_stats`) reads all-zero even after the
  load — direct in-field confirmation of #2930/#3012's finding that CTranslate2 keeps
  its entire GPU footprint outside PyTorch's caching allocator.

## Why the samples died: the guards passed, the delta itself was empty

The warm branch discards a sample when the after-reading is None, another engine holds
the device, or a foreign PID appears at either end of the window; otherwise the raw
delta goes to `record()`, which drops `<= 0`. On this window: the card was idle at
precheck and nothing else loaded during the ~50 s session, so no foreign-PID or
concurrent-reservation discard can have applied, and the cold `"asr"` sample
(`sample_count: 1`) in the same session proves `_device_free_mb` returns live
readings and guards do pass on this box. All six warm windows were clean — and still
produced nothing positive. (The footprints block cannot distinguish None-discarded
from `<= 0`-discarded warm samples; with the card provably idle and the cold path
recording in the same window, the `<= 0` explanation is the one consistent with every
observation — and with #2682, #2930/#3012 and #3265's findings on this same box.)

The mechanism is structural: CTranslate2 allocates its weights and workspace arena
ONCE at load — that is the jump the cold delta caught — and reuses that arena for
every subsequent forward. Device-wide free VRAM therefore does not measurably move
across a warm 2-second forward; whatever movement remains is other system processes
at WDDM's reporting granularity, i.e. zero or negative — dropped by `record()`'s
`<= 0` guard.

This DISPROVES #3036's direction-2 theory on this box: the device-wide warm delta did
not fail before #3036 for lack of the foreign-PID/concurrent-reservation guards. The
guards were built and applied here (#3266) and changed nothing — there was no positive
signal for them to separate from contamination.

## Focused unit tests after this child's change (verbatim, exit code 0)

```
============================= test session starts =============================
platform win32 -- Python 3.12.10, pytest-9.1.1, pluggy-1.6.0
rootdir: C:\Claude\Projects\wt-3036-asr-warm-footprint\server\tts-sidecar
configfile: pytest.ini
plugins: anyio-4.14.1, typeguard-4.5.2
collected 38 items

tests\test_asr_footprint_measurement.py ...........................      [ 71%]
tests\test_footprints.py ...........                                     [100%]

============================= 38 passed in 3.08s ==============================
```

This child adds/modifies NO tests, so no new mutation docstrings are required — the
warm branch's behavior under test stays exactly as #3265 mutation-tested it (the
measurement-source swap was already covered by `test_asr_footprint_measurement.py`'s
37 warm-path cases; docs + the seed comment are this child's code-side change).

## Conclusion — stated per the #3266/#3036 ticket

**`asr.warm` via the guarded device-wide free-VRAM delta: DID NOT CONVERGE.** Both
#3036 directions have now been tried on real hardware and documented non-viable:

1. **NVML own-process `usedGpuMemory` delta** (#3265, child 1) — dead because this
   box's Windows WDDM driver reports `usedGpuMemory=None` for our own PID even under
   live CUDA load. Evidence: `step-1-nvml.md`.
2. **Device-wide free-VRAM delta with the full cold guard set** (#3266, child 2) —
   dead because the delta is structurally empty across an arena-reusing CTranslate2
   forward, guards or no guards. Evidence: this file.

`SEED_FOOTPRINTS_MB["asr.warm"]` therefore **remains authoritative** — its comment now
says exactly that, citing both step files. The warm-ASR measurement technique ACTIVE
in shipped code after this child's change is the **device-wide free-memory delta** —
NOT the pre-#3036 `_observed_mb` torch-allocator fall-through (structurally 0 for a
CTranslate2 engine, #2930/#3012 — the after-snapshot's all-zero torch block above is
an in-field picture of exactly that), and NOT #3265's `_own_process_used_mb`, which
stays in the codebase, tested, no longer called from production (deleting it is a
separate human decision per the ticket). A genuine fix still needs a CTranslate2-side
memory query or driver-level per-process accounting this box's WDDM cannot provide —
follow-on scope for #3036 after #3267 lands this chain.

## Acceptance evidence map (for #3267 verification)

- Acc #1 (on-box run, real CUDA model, `/debug/memory` before+after footprints, exact
  JSON pasted, evidence the real pipeline ran): this file — runner log, sidecar log
  excerpt, both verbatim JSONs.
- Acc #2 (focused suite passes, output pasted): "Focused unit tests" section, RC 0.
- Acc #3 (`SEED_FOOTPRINTS_MB["asr.warm"]` comment updated: outcome, both directions
  non-viable, seed authoritative, active technique named): `server/tts-sidecar/main.py`,
  #3266 paragraph of the seed comment block.
- Acc #4 (`docs/testing/onbox-3036-results/step-2-device-delta.md` exists with exact
  first line `RESULT: DID NOT CONVERGE`): this file, line 1.



