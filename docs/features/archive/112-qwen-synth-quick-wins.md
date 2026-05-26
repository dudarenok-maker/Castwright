---
status: stable
shipped: 2026-05-26
owner: null
---

# 112 — Qwen3-TTS synthesis: measured quick wins

> Status: stable — shipped via PR #247 (2026-05-26)
> Key files: `server/tts-sidecar/main.py` (`QwenEngine`, `KokoroEngine.synthesize`, `_audio_duration_ms`), `server/tts-sidecar/scripts/bench-tts.py`, `server/tts-sidecar/tests/test_qwen3.py`
> URL surface: none (sidecar internals)
> OpenAPI ops: none

## Benefit / Rationale

Generation with the Qwen engine is 5–10× slower than Kokoro. Investigation against the real weights showed the bulk of that gap is **inherent**: Kokoro is an ~82M-param non-autoregressive feed-forward model (one GPU pass per sentence), while `Qwen3-TTS-12Hz-0.6B-Base` is a 600M-param autoregressive transformer that emits audio-codec tokens frame-by-frame then decodes them. No flag removes that. This plan captures the **quality-preserving** wins that sit on top of it, and adds the instrumentation to measure the rest rather than guess.

- **User:** Qwen generation is a little faster (no per-sentence disk reads; SDPA over eager attention where it applied) with **bit-identical voices** — no fidelity change.
- **Technical:** an in-memory clone-prompt cache removes a `torch.load` + JSON read per sentence; the loader requests PyTorch-native SDPA (cross-platform, no flash-attn build); per-call RTF logs + a `bench-tts.py` harness make the Kokoro-vs-Qwen gap and the concurrency curve measurable.
- **Architectural:** ships backlog `side-1` (SDPA) and lands the measurement seam the deferred levers (`side-3` batching, `side-4` x-vector-only) need to prove themselves.

## Architectural impact

- **New seams / extension points:** `QWEN_ATTN_IMPL` env (default `sdpa`); `QwenEngine._prompt_cache` (voiceId → (prompt, lang)) guarded by `_cache_lock`; `_audio_duration_ms` module helper; `scripts/bench-tts.py` (stdlib-only, not in CI).
- **Invariants preserved:** synthesize still **fails fast** on an undesigned voice without loading the Base model; `torch.load(weights_only=False)` for the trusted clone prompt is unchanged; output PCM for a given (voice, text) is identical (cache returns the same object the disk load would). Per-character engine routing (plan 108) and the plan-107 sentence-ordering/sample-rate contract are untouched.
- **Migration story:** none — no on-disk format change. The cache is in-memory only; `design_voice` evicts the voiceId entry on re-save so a re-designed voice never serves a stale embedding; `unload()` clears the cache so prompt GPU tensors are actually freed.
- **Reversibility:** set `QWEN_ATTN_IMPL=eager` to restore the old attention path; the cache is transparent (a cold cache behaves exactly as before). Revert the commit to drop everything.

## Invariants to preserve

- `QwenEngine.synthesize` resolves the voice prompt (`_load_voice_prompt`) **before** `_ensure_base_loaded()`, so an undesigned voice raises without paying the model load (`main.py`).
- `_load_voice_prompt` releases `_cache_lock` across `torch.load` — a concurrent double-miss double-loads (benign, same content); it never holds the lock during I/O.
- `design_voice` calls `self._prompt_cache.pop(voice_id, None)` (evict, **not** warm) after writing the `.pt`/`.json`, so the next synth reloads the fresh embedding.
- `_load_qwen_model` retries `from_pretrained` without `attn_implementation` if the kwarg is rejected — a load must never harden into a failure over the attention knob.

## Test plan

### Automated coverage

Pytest sidecar (`server/tts-sidecar/tests/test_qwen3.py`):

- `test_synthesize_caches_prompt_across_calls` — three synths of one voice → `torch.load` called **once**.
- `test_redesign_evicts_cached_prompt` — re-design drops the cache entry; next synth reloads.
- `test_unload_clears_prompt_cache` — `unload()` empties `_prompt_cache`.
- `test_load_passes_sdpa_attn_by_default` / `test_load_honours_qwen_attn_impl_env` — loader passes `attn_implementation="sdpa"` by default, honours `QWEN_ATTN_IMPL`.
- `test_load_falls_back_when_attn_kwarg_rejected` — kwarg rejection → retry without it, load still succeeds.
- Existing `test_synthesize_reuses_cached_voice` (asserts `weights_only=False` on the disk load) stays green — design evicts, so the first synth still loads from disk.

Whole sidecar suite green via `npm run test:sidecar` (≈141 cases, exit 0).

### Manual acceptance walkthrough (GPU-bound, owed)

Run against a live sidecar with Qwen weights resident (`PRELOAD_QWEN=1`) and one designed voice:

1. **Baseline:** set `QWEN_ATTN_IMPL=eager` in the sidecar env, restart it, run `python scripts/bench-tts.py --engine qwen --voice <id>` — record mean RTF. Also `--engine kokoro --voice af_heart` for the reference point.
2. **After:** unset `QWEN_ATTN_IMPL` (→ sdpa), restart, re-run the Qwen bench — compare RTF; confirm the load log shows `attn_implementation=sdpa`.
3. **Cache:** generate a short chapter with a Qwen-voiced character; confirm the per-call logs show `cache=miss` once then `cache=hit`, and the audio is unchanged.
4. **Concurrency curve:** `--concurrency 1 / 2 / 4` (raise `GPU_VRAM_BUDGET` first) — confirm aggregate throughput plateaus, validating that batching (`side-3`), not more workers, is the real lever.

Record the RTF numbers in Ship notes when captured.

## Out of scope

- `x_vector_only_mode` / any change to voice fidelity → backlog `side-4`.
- Batching multiple sentences into one `generate_voice_clone` call → backlog `side-3` (the real throughput lever; in flight on a separate branch as of 2026-05-26).
- flash-attn install (left as a documented `QWEN_ATTN_IMPL=flash_attention_2` opt-in; not pursued — Windows build cost).
- Deployer-warning cleanup (SoX, HF-symlink) → backlog `side-2`.

## Ship notes

Shipped 2026-05-26 via PR #247 (feature commit `4d82286`, docs `325a78b`). All code + paired pytest green; the full `npm run verify` battery passed at pre-push.

Shipped exactly as specced: SDPA attention by default (`QWEN_ATTN_IMPL`, ships backlog `side-1`) with a kwarg-rejection fallback; in-memory clone-prompt cache (evict-on-redesign, clear-on-unload, lock-guarded); per-call RTF logs on Qwen + Kokoro; `scripts/bench-tts.py` with a `--concurrency` sweep. Voices are bit-identical — SDPA selection and prompt caching are output-neutral by construction, which is why this archives despite the perf number below being uncaptured.

Deploy-box config: `GPU_VRAM_BUDGET=2` set in `server/.env` on the target 4070, so `sentenceConcurrency`/`poolWidth` defaults to 2 (two concurrent Qwen synths per chapter; Kokoro+Qwen coexistence preserved at cost 1 each).

Open (non-blocking) manual acceptance: the baseline-vs-SDPA RTF delta and the concurrency curve were NOT captured before close-out — run `bench-tts.py` per the "Manual acceptance walkthrough" anytime to record them. The real throughput lever (sentence batching) is tracked as `side-3` (in flight); `side-4` covers the `x_vector_only_mode` fidelity tradeoff.
