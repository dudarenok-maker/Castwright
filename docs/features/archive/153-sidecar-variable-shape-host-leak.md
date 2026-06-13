---
status: stable
shipped: 2026-06-01
owner: null
---

# 153 — Variable-input-shape host-memory leak: candidate-1 (MKLDNN-disable) probe + leak-slope harness

> Status: stable — candidate-1 (MKLDNN-disable) was **REJECTED** by the 2026-06-01 live A/B: disabling MKLDNN cripples Qwen synth ~15×+ (see "A/B result"), so it's non-viable regardless of leak effect. `SIDECAR_DISABLE_MKLDNN` stays **default OFF**. The durable deliverables of this plan are the **leak-slope harness** (`bench-tts.py --mem-sample`) and the **committed-private `/debug/memory` readout** — both reused for the next candidate. The still-open leak work (candidate 2 — fixed-shape padding) lives in `docs/BACKLOG.md` `side-11`.
> Key files: `server/tts-sidecar/main.py`, `server/tts-sidecar/scripts/bench-tts.py`, `server/tts-sidecar/tests/test_memory.py`, `server/.env.example`
> URL surface: none (sidecar runtime + bench tooling)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** on long books the process-recycle (plan 143) currently fires ~every 10 chapters; each ~2-min drain window cascaded 12 queued chapters to a failed state on the 2026-05-31 run (see `152-recycle-drain-readiness.md`). Eliminating the underlying leak means a full book runs on one warm sidecar with **no recycles and no dropped chapters** — the cleanest end-to-end win now that RTF is solved (~1.04).
- **Technical:** the Qwen generation forward leaks committed-private host RAM monotonically because every sentence is a different length → a new native per-shape workspace that is never freed (committed climbs unbounded on variable-length generation, flat on fixed shapes; CUDA flat — pytorch/pytorch #32596). `gc.collect()` + `empty_cache()` reclaim ~0 against it. This plan adds the cheapest candidate fix (disable MKLDNN, suspected CPU per-shape workspace) plus the instrument to prove it.
- **Architectural:** establishes a repeatable, seeded **leak-slope harness** (`bench-tts.py --mem-sample`) and surfaces the recycle's own metric (committed-private) on `/debug/memory`, so future memory work is measured, not felt.

## Architectural impact

- **New seams / extension points:**
  - Env flag `SIDECAR_DISABLE_MKLDNN` (default OFF) read by `_disable_mkldnn()` and applied in the shared `_apply_torch_perf_flags(torch)` hook (`main.py`). Opt-in until proven; flip to ON in a one-line follow-up after the live A/B.
  - `committed_mb` added to the `/debug/memory` `process` block (the metric the recycle keys on).
  - `bench-tts.py --mem-sample` mode (seeded variable-shape corpus → per-batch `/debug/memory` sampling → least-squares committed-slope verdict; optional `--out` CSV).
- **Invariants preserved:** `_apply_torch_perf_flags` stays idempotent + fully defensive (the new flag lives inside the same `try`, so torch attr-drift is swallowed exactly like the TF32 flags); the TF32 / matmul-precision flags are unaffected when the gate is off; the batch demux invariant `len(wavs) == len(items)` (`main.py` `synthesize_batch`) is untouched (no batch-shape change in candidate 1).
- **Reversibility:** the flag defaults OFF, so this round is a no-op in production until deliberately enabled; the plan-143/srv-15 process-recycle is **preserved as the safety net, not removed** — even with the flag on, `SIDECAR_RESTART_MB` stays armed during acceptance.
- **Migration story:** none — no on-disk shape change.

## Invariants to preserve

- `_apply_torch_perf_flags` (`server/tts-sidecar/main.py`) remains idempotent and swallows any attribute drift; with `SIDECAR_DISABLE_MKLDNN` off it sets exactly the TF32 + matmul-precision flags it always has.
- `_disable_mkldnn()` defaults OFF: only `{1,true,yes,on}` enable it; garbage / `0` / unset → OFF.
- `/debug/memory` continues to expose `process.rss_mb`, `gc.counts`, per-engine state, and `cuda.*`; `committed_mb` is additive.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_memory.py`):
  - `test_disable_mkldnn_parsing` — default OFF; truthy tokens enable; garbage / `0` / unset → OFF.
  - `test_apply_torch_perf_flags_disables_mkldnn_when_gated` — gate on → `torch.backends.mkldnn.enabled` flipped False; gate off → left True; TF32 + matmul-precision flags applied either way (no regression).
  - `test_debug_memory_endpoint_shape` — extended to assert `process.committed_mb` is present and positive.
- **Empirical (not CI):** `bench-tts.py --mem-sample` is the instrument for the live committed-slope A/B; it needs resident weights so it is run by hand, not in CI (matches the existing `bench-tts.py` exclusion). `npm run test:sidecar` is venv-gated and skipped on CI, so run the full sidecar suite on the dev box before pushing.

### Manual acceptance walkthrough (USER-RUN, live GPU)

1. **Clean reboot** (clears VRAM + prior sidecar state — the project perf-baseline rule).
2. Start the sidecar warm (eager Qwen) on `:9000`; design/choose one Qwen voice.
3. **Baseline (flag OFF):** `python server/tts-sidecar/scripts/bench-tts.py --engine qwen --voice <id> --batch 16 --mem-sample --batches 200` → record `LEAK SLOPE` (expect a steep committed slope, CUDA flat).
4. **Fix ON:** restart the sidecar with `$env:SIDECAR_DISABLE_MKLDNN='1'`, re-run the identical command.
5. **Compare:** pass iff the committed-MB slope with the fix ON is ≈ flat (within ±2 MB/batch of the `--bucket 1` length-tight control) versus a clearly steeper OFF slope.
6. **End-to-end acceptance (the real bar):** with the proven flag set and `SIDECAR_RESTART_MB` left at its default (recycle armed as backstop), run a full book through the queue. `tts.log` `sidecar memory:` holds a flat committed floor for the whole book and the run completes with **zero `code 43` recycles and zero dropped/re-rendered chapters**.
7. **If pass:** flip `SIDECAR_DISABLE_MKLDNN` default ON (one-line follow-up) and flip this plan to `stable`. **If fail:** MKLDNN is not the lever (likely a CUDA-allocator-side workspace) → proceed to candidate 2 (fixed-shape batch padding) on the same harness.

## A/B result (2026-06-01) — candidate 1 REJECTED

Run on the 8 GB box (cold sidecar each side, voice `qwen-maerin`, `--batch 16 --mem-sample`):

- **OFF (`SIDECAR_DISABLE_MKLDNN=0`):** healthy throughput (~120–150 s/batch). The leak reproduced emphatically — committed-private ~20.2 GB @ batch 12 → ~32.9 GB @ batch 23 ≈ **+1,150 MB/batch**, with CUDA also climbing into heavy WDDM spill (reserved 3.3 → 16.2 GB) by ~batch 23, at which point batches stall. (NB: that spill regime is well past production, which never exceeds ~6 GB VRAM — cap A/B runs at ~25 batches.)
- **ON (`SIDECAR_DISABLE_MKLDNN=1`):** **synth catastrophically slow.** A single 16-sentence batch did **not complete in 31 minutes** (vs ~120 s OFF); the sidecar pegged ~7–8 CPU cores (13,724 cpu-s over ~31 min wall) while the **GPU sat idle (0 %)** — the bottleneck moved to an un-accelerated CPU op in the Qwen audio path (tokenizer / Code2Wav vocoder). The leak slope was unmeasurable because no batch finished.

**Verdict:** MKLDNN is load-bearing for the Qwen CPU audio path on this stack — the "small CPU cost" assumption was wrong. A ~15×+ slowdown is non-viable, so candidate 1 fails the gate on throughput grounds (independent of any leak effect). Keep the flag OFF. Move to candidate 2 (fixed-shape batch padding) — `side-11`. The host leak stays mitigated meanwhile by the process-recycle (plan 143) + the load-failure VRAM reclaim (plan 155).

## Out of scope

- **Candidate 2 — fixed-shape batch padding** (Node packer `QWEN_BATCH_FIXED_SHAPE` + `QWEN_BATCH_LEN_BUCKETS` in `synthesise-chapter.ts` + a python-side pad in `synthesize_batch` so `generate_voice_clone` sees ≈3 fixed shapes). Heavier, carries an RTF cost; only built if candidate 1 fails the gate. Its own future branch.
- **The separate VRAM-fragmentation OOM** already handled by `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` (plan 144) — a CUDA-allocator issue, not this host leak.
- **Removing the process-recycle** — the goal is to make it unnecessary, not delete it (plan 143 stays as the safety net).

## Ship notes

Shipped 2026-06-01. The candidate-1 probe (`SIDECAR_DISABLE_MKLDNN`, default OFF), the `committed_mb` `/debug/memory` field, and the `bench-tts.py --mem-sample` leak-slope harness landed earlier in this plan's branch. The live A/B (above) **rejected candidate 1 on throughput** — the flag stays OFF and is retained only as a measurement/diagnostic toggle, not a production lever. This plan is closed for candidate 1; the leak itself is still open under `side-11` (candidate 2 — fixed-shape batch padding), kept bounded in the meantime by the plan-143 process-recycle + the plan-155 load-failure VRAM reclaim. The bench's summary print was also de-glyphed (`Δ`/`≈` → ASCII) so it doesn't crash under Windows cp1252.
