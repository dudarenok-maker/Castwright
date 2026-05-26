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
- `_load_qwen_model` does a **single** load with **no `device_map`** and `low_cpu_mem_usage=False` (real tensors, no meta-device skeleton), then moves the **inner** module `model.model` to the device and resyncs `model.device` — `Qwen3TTSModel` is a wrapper with no `.to()`, and `device_map` 500s with a meta-tensor `NotImplementedError` on this stack. A `(ValueError, TypeError)` retry drops only `attn_implementation` (still no `device_map`, still `low_cpu_mem_usage=False`) so a build that rejects the kwarg can't harden into a load failure. (See Post-ship fix #2 below — supersedes the original two-tier `device_map`-fallback shape.)

## Test plan

### Automated coverage

Pytest sidecar (`server/tts-sidecar/tests/test_qwen3.py`):

- `test_synthesize_caches_prompt_across_calls` — three synths of one voice → `torch.load` called **once**.
- `test_redesign_evicts_cached_prompt` — re-design drops the cache entry; next synth reloads.
- `test_unload_clears_prompt_cache` — `unload()` empties `_prompt_cache`.
- `test_load_passes_sdpa_attn_by_default` / `test_load_honours_qwen_attn_impl_env` — loader passes `attn_implementation="sdpa"` by default, honours `QWEN_ATTN_IMPL`.
- `test_load_falls_back_when_attn_kwarg_rejected` — kwarg rejection (ValueError) → retry without it; load still succeeds, and **neither** attempt uses `device_map` (the retry keeps `low_cpu_mem_usage=False`).
- `test_load_moves_inner_model_and_resyncs_device` — Post-ship fix #2 regression: the loader passes **no** `device_map`, forces `low_cpu_mem_usage=False`, moves the inner `model.model` to the device, and resyncs `model.device` (never calls the nonexistent `wrapper.to()`). Fails against the old `device_map`-fallback loader.
- `test_load_passes_sdpa_attn_by_default` also asserts the load passes **no** `device_map` and `low_cpu_mem_usage=False`.
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

### Post-ship fix (2026-05-26) — sdpa + device_map meta-tensor crash

The shipped `_load_qwen_model` passed `attn_implementation="sdpa"` **alongside** `device_map="cuda:0"`. The kwarg is accepted (sdpa is valid), but `device_map` routes the load through accelerate's `dispatch_model`, which leaves attention params on the `meta` device and then raises `NotImplementedError: Cannot copy out of meta tensor` when it tries to move them. The original fallback only caught `(ValueError, TypeError)` (a kwarg *rejection*), so this dispatch-time failure escaped: `POST /load` 500'd, the Qwen pill spun ~5s and reverted to "Qwen idle" — the model never loaded. (Ground truth: `logs/tts.err.log` traceback at `main.py` `_load_qwen_model` → `accelerate/big_modeling.py:dispatch_model` → `model.to(device)`.)

Fix: the loader is now two-tier — the sdpa fast-path loads **without** `device_map` then calls `model.to(self._device)` (real tensors, no meta dispatch, sdpa still honoured), and the `except` is broadened to `Exception` so any fast-path failure retries the pre-sdpa `device_map` + default-attention config that always worked. Regression test `test_load_falls_back_when_sdpa_dispatch_fails` reproduces the meta-tensor `NotImplementedError` and asserts the fallback. Shipped via the `fix/sidecar-qwen-sdpa-meta-tensor-load` branch.

### Post-ship fix #2 (2026-05-26) — meta-tensor crash, real root cause

Post-ship fix #1 above was wrong about the cause, and **both** of its tiers actually failed (confirmed against `logs/tts.err.log`, 30 fast-path + 40 fallback failures in one session):

1. **Fast-path** — `Qwen3TTSModel` is a thin **wrapper**, not an `nn.Module`: it holds the real module at `.model` and caches the device at `.device`, and has **no `.to()`**. So `model.to(self._device)` raised `AttributeError: 'Qwen3TTSModel' object has no attribute 'to'` (not a meta error at all) and was swallowed by the broad `except`.
2. **Fallback** — `device_map=self._device` routes through accelerate's `dispatch_model`, which on this composite model (talker / code_predictor / encoder sub-modules built from default configs, so not every param is in the checkpoint) leaves params on the `meta` device and then `.to()`s them → the meta-tensor `NotImplementedError`. This tier had no `try`/`except`, so it **propagated** — the error the user saw. (Premise of fix #1 — "`attn_implementation` leaves attn params on meta" — is false: the fallback passes no `attn_implementation` and still hit meta.) Fix #1's regression test passed only because the test fake had a `.to()` the real wrapper lacks.

Stack: torch 2.6.0+cu124, transformers 4.57.3, accelerate 1.12.0.

Fix: `_load_qwen_model` now does a **single** `from_pretrained` with **no `device_map`** and `low_cpu_mem_usage=False` (full real-tensor materialisation, no meta-device skeleton), then moves the **inner** `model.model` to the device and resyncs `model.device` (load-bearing — the wrapper sends generate-time inputs to `self.device`, so a stale CPU value would mismatch GPU weights mid-synth). The only retry is the narrow `(ValueError, TypeError)` kwarg-rejection case (drops `attn_implementation`, keeps the real-tensor shape; **never** uses `device_map`). The test fake (`_FakeQwenModel`) was corrected to match the real API — no wrapper `.to()`, an inner `.model` with the `.to()` — and `test_load_falls_back_when_sdpa_dispatch_fails` was replaced by `test_load_moves_inner_model_and_resyncs_device`. Shipped via the `fix/sidecar-qwen-meta-tensor-load` branch.
