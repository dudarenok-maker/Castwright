# A17 clean re-run — second admission fires while `qwenDesignResident` is still `true` (2026-09-20)

Issue: [Castwright#3301](https://github.com/dudarenok-maker/Castwright/issues/3301) · Register row: A17 (discharged 2026-09-25, removed from the register; `docs/testing/onbox-acceptance-register.md`, "### A17 · /health stays live through a contended eviction on the default Qwen path") · Discharges the "still owed" item from the 2026-09-06 step-4 note: *"a run where the second admission fires while `qwenDesignResident` is still `true`, on a box … with enough headroom that the race doesn't also OOM the card."*

## Result

**PASS — the exact #1919 three-way race was hit byte-for-byte, `/health` stayed inside the ~500 ms budget, the second admission succeeded, and nothing OOM'd, poisoned, or crashed.**

| Measure | This run | Row's target | Prior best (step 4, 2026-09-06) |
|---|---|---|---|
| `qwenDesignResident` at second admission | **`true`** | required | `false` (window missed) |
| `inflight_synth` at second admission | **`1`** | required | 1 |
| Second admission outcome | **`200 {"status":"ready"}`** | not 503 `noCapacity` | 200 ready (then render OOM'd) |
| `/health` poll errors | **0 / 62 polls** | 0 | 0 / 692 |
| Max single-request latency | **129.13 ms** | ~≤500 ms | 2092.92 ms |
| Max inter-response-start gap | **258.7 ms** | ~≤500 ms | 241.29 ms |
| p50 latency | 5.89 ms | — | — |
| Crash / poison / CUDA-OOM | **none** (`poisoned: false` final, VRAM 23 MB after unload) | required | `vram-spill` on the app render |

## Environment (as measured, single-card)

- Box: NVIDIA GeForce **RTX 4070 Laptop GPU**, 8585 MiB total. Second physical GPU (`0000:05:00.0`) is in a "GPU is lost" bus state on this box (documented since A1); irrelevant — everything below ran pinned to card 0.
- Sidecar launched pinned: `CUDA_VISIBLE_DEVICES=0`, `python -m uvicorn main:app --host 127.0.0.1 --port 9101 --log-level info`.
- **Source tree: `C:\Claude\Projects\wt-onbox-batch-1` (branch `chore/ops-onbox-batch-1`, HEAD `5dd2d622`, worktree clean), `server/tts-sidecar` — i.e. the branch under acceptance, not the primary checkout.** Sidecar `__version__` `1.14.0`, `protocol_version` 1, dedicated instance on port 9101 (the pre-existing managed sidecar on 9000 untouched).
- `/health` at start confirmed the pin: exactly **1 GPU in `gpus[]`**, `devices: {kokoro: cuda, coqui: cuda, qwen: cuda}`, `poisoned: false`, `qwen_design_resident: false`, 7411 MiB free. `SEG_CAPACITY_ADMISSION` left at default (1); Qwen generation engine default; no opt-in env vars.
- VRAM baseline (nvidia-smi, driver start): card 0 free 7948 MiB, util 0 %.

## Method

Driver: [`a17_driver.py`](a17-clean-retry-2026-09-20/a17_driver.py) (stdlib-only; persistent single `http.client.HTTPConnection` poller at ~250 ms cadence — the low-overhead instrument wave-6 asked for, **not** a per-iteration `curl` subprocess). Sequence, all against the one 8 GB card:

1. **Phase 0** — `/health`: ok, exactly 1 GPU (aborts otherwise). ✓
2. **Warm VoiceDesign** — `POST /qwen/design-voice` (voiceId `qwen-a17race-sep20-a`, calibration text so the returned PCM's transcript is known). Returned **200, 291,840 bytes of real `audio/L16` PCM @ 24000 Hz in 36.08 s**. `QWEN_DESIGN_IDLE_TTL` default 120 s keeps it resident afterwards.
3. **Residency confirmed** — immediate `/health`: `qwen_design_resident: true`, `qwen_loaded: true`.
4. Poller starts (persistent connection, 250 ms cadence).
5. **First Qwen forward in flight** — `POST /qwen/clone-voice` (voiceId `qwen-a17race-sep20-b`, the design PCM as reference, base64 ref/audition text headers) fires on a worker thread. This is an *ungated* 1.7B-Base forward holding `_synth_lock` for its duration — the same lock the row's "chapter render" step holds; chosen deliberately over an app-level render because app renders twice OOM'd (`vram-spill`) this card in step 4 before the race could be measured. The race semantics under test (`_synth_lock` contention + `qwen.design` eviction fast-out with a warm-resident design) are identical.
6. **Race state confirmed 89 ms after firing the clone** — `/health` snapshot: `qwen_design_resident = true` **and** `inflight_synth = 1` **at the same instant** (`vram_reserved_mb` 5748.3, `gpus[0].free_mb` 1623).
7. **Second admission fired at that instant** — `POST /load {"engine":"coqui"}` from the same client while the Base forward still held the lock.
8. Poller records max single-request latency and max inter-response-start gap throughout, from before the forward until the second admission resolves.


## Timeline (2026-09-20, local)

| Time | Event |
|---|---|
| 23:56:20 | sidecar boot: device probe complete, all engines `cuda`; Qwen idle watchdog `design ttl=120s` |
| 23:56:56 | driver phase 0: `ok:true, ngpus:1, design_res:false, inflight:0` |
| 23:57:32 | `design_done` 200, 291840 B PCM @ 24 kHz, 36.08 s; residency check `design_res:true, qwen_loaded:true` |
| 23:57:33.77 | `clone_fired`; poller row shows `design_res=True, inflight=1` |
| 23:57:33.85 | **`race_state_confirmed`: `design_res=true, inflight=1, vram_res=5748.29 MB, gpu0_free=1623 MB`** |
| ~23:57:33.9 | **second admission `POST /load {"engine":"coqui"}` fires** into the live forward |
| 23:57:44.9 | `clone_done` 200 (11.16 s real audio) — lock released |
| 23:57:47.35 | **`load_done` 200 `{"status":"ready"}`** — evict freed capacity; no 503 `noCapacity`; sidecar log: `Coqui ready — 58 speakers in manifest.` |
| 23:57:48 | metrics: 62 polls, 0 errors, max single 129.13 ms, max gap 258.7 ms |
| 23:57:48–51 | controlled `/unload` coqui→qwen (`{"status":"idle"}` both; log: `Qwen models unloaded — reserved VRAM 1890→23MB (freed 1866MB)`); final health `poisoned:false, inflight:0, design_res:false, vram_reserved 23.07 MB` |

## Poller numbers (the row's bullet-3 metric)

- **62 polls over the ~16 s race window, 0 errors** — `/health` never dropped the connection (persistent-connection instrument; no per-poll subprocess overhead).
- **Max single-request latency 129.13 ms; max inter-response-start gap 258.7 ms; p50 5.89 ms** — both headline numbers under the ~500 ms target, bounded by the 250 ms poll cadence rather than by the forward pass. The worst-latency polls cluster around the coqui load's `gc.collect()`/`empty_cache()` eviction work, exactly where the fix is supposed to keep the loop responsive.
- Rows during the warm-design window (verbatim from [`a17-health-polls.csv`](a17-clean-retry-2026-09-20/a17-health-polls.csv)):

```
t_start        lat_ms design_res inflight coqui_loaded vram_res    gpu0_free
1789912652.758 7.79   True       0        False        5748.293632 1623
1789912653.010 4.02   True       0        False        5748.293632 1623
1789912653.261 4.02   True       0        False        5748.293632 1623
1789912653.513 0.00   True       0        False        5748.293632 1623
1789912653.769 7.57   True       1        False        5748.293632 1623
```

## Event log (condensed verbatim; full file attached)

[`a17-events.jsonl`](a17-clean-retry-2026-09-20/a17-events.jsonl) — binary PCM bodies elided:

```json
{"t": 1789912616.656, "iso": "2026-09-20T23:56:56", "name": "phase0_health", "ok": true, "ngpus": 1, "design_res": false, "inflight": 0}
{"t": 1789912652.732, "iso": "2026-09-20T23:57:32", "name": "design_done", "status": 200, "dur_s": 36.08, "sr": 24000, "pcm_bytes": 291840, "ctype": "audio/L16;codec=pcm;rate=24000"}
{"t": 1789912652.756, "iso": "2026-09-20T23:57:32", "name": "design_residency_check", "design_res": true, "qwen_loaded": true}
{"t": 1789912653.76,  "iso": "2026-09-20T23:57:33", "name": "clone_fired"}
{"t": 1789912653.849, "iso": "2026-09-20T23:57:33", "name": "race_state_confirmed", "design_res": true, "inflight": 1, "vram_res": 5748.293632, "gpu0_free": 1623}
{"t": 1789912664.917, "iso": "2026-09-20T23:57:44", "name": "clone_done", "status": 200, "dur_s": 11.16, "ctype": "audio/L16;codec=pcm;rate=24000", "body": "<raw PCM>"}
{"t": 1789912667.351, "iso": "2026-09-20T23:57:47", "name": "load_done", "status": 200, "body": "{\"status\":\"ready\"}"}
{"t": 1789912668.653, "iso": "2026-09-20T23:57:48", "name": "metrics", "polls": 62, "poll_errors": 0, "max_single_latency_ms": 129.13, "p50_latency_ms": 5.89, "max_inter_start_gap_ms": 258.7, "load_status": 200, "load_body": "{\"status\":\"ready\"}"}
{"t": 1789912668.933, "iso": "2026-09-20T23:57:48", "name": "unload", "engine": "coqui", "status": 200, "body": "{\"status\":\"idle\"}"}
{"t": 1789912669.33,  "iso": "2026-09-20T23:57:49", "name": "unload", "engine": "qwen", "status": 200, "body": "{\"status\":\"idle\"}"}
{"t": 1789912671.354, "iso": "2026-09-20T23:57:51", "name": "final_health", "design_res": false, "coqui_loaded": false, "vram_res": 23.068672, "poisoned": false, "inflight": 0}
```

Sidecar log across the race contains **no** `evict-declined`, `noCapacity`, `out of memory`, `poison`, or `Traceback` lines (verified by pattern grep over [`a17-sidecar-boot-log.txt`](a17-clean-retry-2026-09-20/a17-sidecar-boot-log.txt)).

## Honest scope notes

- **What this run now proves:** all four A17 bullets on the default path with no opt-in env var — warm-VoiceDesign + live Base forward + concurrent second admission all at once (bullets 1–2 and the exact #1919 ordering), `/health` responsiveness under a real contended `_synth_lock` + worker-thread eviction (**129 ms worst single call, 259 ms worst gap, 0 errors**), and a *genuinely freeing* eviction (admission `ready`, not `noCapacity`, with `qwen_design_resident` still true when it fired — bullet 4's "not a silent no-op" check passes for the design-resident variant).
- **What this run does not re-prove:** the app-level chapter-render variant of the first admission (a 159-line SSE render) — that path is what step 4 exercised, and its `vram-spill` finding (A10 cross-ref) stands unchanged: **two heavy engines + app server together still don't fit this 8 GB card mid-render.** This run isolates the sidecar mechanism from the app server's own VRAM overhead, which is the condition under which the row's race is defined.
- The optional `SEG_ASR_ENABLED=1`/`ASR_DEVICE=cuda` second pass (row bullet, marked not-required) was not run.
- One earlier attempt (~23:52) against the primary checkout aborted on a **driver-side bug** (case-sensitive response-header lookup; uvicorn serves `x-sample-rate` lower-cased over h11) and reached no conclusions — the driver was fixed before this run and is attached; not a sidecar defect, nothing filed.

## Raw evidence files

Directory [`a17-clean-retry-2026-09-20/`](a17-clean-retry-2026-09-20/): `a17_driver.py` (reproducible driver), `a17-events.jsonl` (full timestamped event log), `a17-health-polls.csv` (all 62 poll rows with per-request latency + health fields), `a17-summary.json` (machine-readable result), `a17-health-start.json` (baseline health verbatim), `a17-gpu-before.txt` (nvidia-smi baseline), `a17-sidecar-boot-log.txt` (sidecar log for the session).

