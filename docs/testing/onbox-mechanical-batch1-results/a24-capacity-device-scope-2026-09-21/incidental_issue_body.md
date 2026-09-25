## What

During Castwright#3299 (register row A24, bullet-5 live-squeeze attempt) the sidecar's `/transcribe` cold-ASR capacity admission **granted at 573 MB free on `cuda:1`**, below both the 400 MB cold `asr` seed footprint (`SEED_FOOTPRINTS_MB["asr"]`, server/tts-sidecar/main.py:4386) and the device's 1024 MB `free_floor_mb` (visible in `/health` `gpus[]`). The subsequent real load (large-v3) could not possibly fit that budget — had the weights been fetchable, the result would have been a genuine OOM, not a refusal. Across 10 squeeze rounds (r0–r9, artifacts in `docs/testing/onbox-mechanical-batch1-results/a24-capacity-device-scope-2026-09-21/`) the gate **never emitted one real `noCapacity` 503** (`denials_503: 0` in every `x_result.json`), so the Node-side `withCapacityRetry` evict-and-retry loop had nothing to react to.

## Evidence

- `rounds/r9-largev3-500/x_result.json` — `cuda1_free_mb: 573` at squeeze, single POST → HTTP 500 after 98 s (crash inside weight fetch: `WinError 1314` a symlink call, this box's HF cache is empty — incidental environment note, not the admission issue), `denials_503: 0`, `health_at_end.qwenDesignResident: true`.
- `sidecar_stdout10.log` 12:11:57 — `Loading Whisper ASR model=large-v3 device=cuda:1` **after** the 573 MB-free measurement: admission passed, gate never consulted-or-refused.
- r6–r8 (`rounds/r6-815mb`, `r7-39mb-loaded`, `r8-7mb-loaded`) — status 200 in ~2 s: ASR warm-resident in those sidecar instances, so only the `asr.warm` reservation applied (stuck at its 128 MB seed per main.py:4410-4421 / #3036) and trivially fits.

## Ask

Root-cause the cold `/transcribe` gate arithmetic (`reservation("asr", None, {}, resident=False)` path around main.py:12724-12728): does it apply `free_floor_mb`? Is `peak_mb` keyed with `model=None` when `ASR_MODEL=large-v3` is configured (model-agnostic seed lookup under-estimating non-default models)? A cold gate that admits a load that cannot fit defeats `SEG_CAPACITY_ADMISSION` for ASR on every box, not just this one.

Found while recording A24 bullet 5; cited in the register's 2026-09-21 note. Not fixed here per batch-1 read-and-record protocol.
