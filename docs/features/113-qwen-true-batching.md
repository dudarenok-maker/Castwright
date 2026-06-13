---
status: active
shipped: null
owner: null
---

# Qwen3-TTS true batching (whole-chapter scatter/gather)

> Status: active (code + automated tests landed; real-GPU manual acceptance pending)
> Key files: `server/tts-sidecar/main.py` (`QwenEngine.synthesize_batch`, `POST /synthesize-batch`), `server/src/tts/sidecar.ts` (`synthesizeBatch` + frame parser), `server/src/tts/index.ts` (`TtsProvider.synthesizeBatch`), `server/src/tts/synthesise-chapter.ts` (work-item dispatch), `src/views/generation.tsx` (stall copy)
> URL surface: indirect — Generate tab SSE (see archive/16-generation-stream.md)
> OpenAPI ops: none (sidecar is an internal HTTP service, not the public OpenAPI surface)

## Benefit / Rationale

- **User:** a Qwen-heavy chapter (now the common case — the narrator lives on Qwen, not Kokoro) renders meaningfully faster, because the GPU does one batched forward over many sentences per decode step instead of one forward per sentence.
- **Technical:** the one lever that scales throughput on a single GPU. `generate_voice_clone` already accepts list `text` / `language` / `voice_clone_prompt`, so a batch runs N sequences in one forward and returns N wavs. Coqui/Kokoro/Gemini have no list API and are untouched (one-per-call).
- **Architectural:** opens an OPTIONAL `TtsProvider.synthesizeBatch` seam without breaking the engine-agnostic single-call contract every other consumer relies on; the chapter reassembly stays index-keyed, so batching is a pure dispatch-layer change.

## Architectural impact

- **New seams:** optional `TtsProvider.synthesizeBatch?` (`server/src/tts/index.ts`); a new sidecar route `POST /synthesize-batch` (Qwen-only); env knob `QWEN_BATCH_SIZE` (default 4; `=1` is the per-call kill-switch) + `qwenBatchSize` on `SynthesiseChapterOpts`.
- **Why true batching ≠ plan 70d folding:** plan 70d banned folding N sentences into ONE concatenated string (one long autoregressive context → mid-chunk voice drift + watchdog hangs). True batching sends N INDEPENDENT sequences sharing only the GPU forward — each keeps its own `voice_clone_prompt`, so there is no shared decode context and no drift, and a batch may MIX the narrator + dialogue voices. See [70d](70d-per-sentence-synth-and-tag-strip.md).
- **Invariants preserved:** the plan-107 within-chapter determinism rules — PCM order (results scattered into `results[group.index]`, concatenated only in the single index-order pass), deterministic sample-rate anchor (title rate, else `groups[0]` synthed up front as a SINGLE call, never inside a batch), and the 30 s stall watchdog (the `onGroupStart` heartbeat now fires for in-flight batches too). The reassembly pass and `buildSentenceGroups` (one group per sentence) are reused verbatim.
- **Wire format:** length-prefixed binary frame — `{"sampleRate":N,"lengths":[…]}\n<pcm0><pcm1>…`. One minified-JSON header line (newline-free), terminated by the FIRST `\n`; the body is each item's 16-bit LE mono PCM concatenated in item order, sliced by `lengths`. Binary (not base64) avoids ~33 % inflation; the client splits on the first newline only, so PCM bytes equal to `0x0A` never mis-parse.
- **Reversibility:** set `QWEN_BATCH_SIZE=1` (every Qwen sentence becomes a single `synthesize` call, byte-identical to pre-113) or drop the `synthesizeBatch` method (the dispatcher feature-detects it and falls back to per-call). No data-shape or storage change.

## Invariants to preserve

- `QwenEngine.synthesize_batch` (`server/tts-sidecar/main.py`) calls `generate_voice_clone` **exactly once** with equal-length `text` / `language` / `voice_clone_prompt` LISTS, and hard-asserts `len(wavs) == len(items)` before demux — never silently misaligns audio to sentences.
- `parseBatchFrame` (`server/src/tts/sidecar.ts`) splits on the FIRST `0x0A` only and verifies the declared `lengths` sum equals the body length.
- The dispatch partition in `synthesiseChapter` (`server/src/tts/synthesise-chapter.ts`) only batches a group when `route.engine === 'qwen'` AND the resolved provider exposes `synthesizeBatch`; the up-front anchor group is always a single call; each batched chunk is scattered to its OWN `results[group.index]` slot.
- `_load_voice_prompt` returns `(prompt, lang, cache_hit)` and is shared by `synthesize` + `synthesize_batch` so they can't drift (and the batch path inherits the plan-112 prompt cache).
- `synthesize` / `synthesize_batch` / `design_voice` run `generate_voice_clone` (and the design forwards) under the per-engine `_synth_lock` (`server/tts-sidecar/main.py`). The Base forward is **not thread-safe**, so this serialises same-engine GPU forwards; a concurrent Kokoro synth still runs in parallel (separate engine instance + lock). See the concurrency-safety fix below.
- `_ensure_base_loaded` single-flights the COLD load under `_base_load_lock` (a `threading.Lock`, double-checked) (`server/tts-sidecar/main.py`). It runs on `asyncio.to_thread` worker threads (both the synth path and `/load` offload it), so two workers that both observe a cold `_base` on the first synth after a restart must NOT both `from_pretrained` — the racing loads leave the model half-cast (`float != BFloat16` on every later forward). The asyncio `_load_lock` only serialises concurrent `/load` HTTP calls, NOT the synth-path lazy load, so the threading lock is the actual guarantee.
- `processOneChapter` awaits `ensureSidecarEngineReady(engine, signal)` (`server/src/tts/ensure-sidecar-loaded.ts`) BEFORE `synthesiseChapter`, so the queue worker explicitly preloads the engine (POST sidecar `/load`, wait for `ready`) instead of dispatching synth into a cold model. Best-effort (a `/load` failure logs + falls back to the locked lazy load), idempotent (per-chapter calls are cheap + recover from a mid-run eviction), abort-aware, and sidecar-engines only (Gemini is cloud). The `_base_load_lock` is the correctness floor; this is the explicit "wait until ready, in code" layer on top.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_batch_synthesis.py`) — N items → N ordered chunks; per-item voice honored (voice-derived PCM, no demux swap); no cross-item bleed (text-derived round-trip); single sample rate matching `X-Sample-Rate`; **batch-of-1 == single `/synthesize` byte parity**; undesigned voice fails the whole batch naming the item index; frame robustness (PCM containing `0x0A` not mis-split); one-`generate_voice_clone`-call-with-matching-lists assertion.
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`, `describe('Qwen true batching (plan 112)')`) — byte-identical batched (size 8) vs per-call (size 1); mixes voices in one batch; scatter-back preserves narrative order + timing; mixed Qwen+Kokoro (Kokoro one-per-call, Qwen batched); batchSize-cap splitting; abort propagation + signal forwarding; back-compat fallback when `synthesizeBatch` is absent; heartbeat re-fires during a pending batch.
- Vitest server (`server/src/tts/sidecar.test.ts`) — the shared error-classification helpers are exercised through `synthesize`; `synthesizeBatch` reuses them unchanged.
- Vitest frontend (`src/views/generation.test.tsx`) — the "Worker has gone quiet" banner copy now sets the batched-synthesis expectation.
- `test_synthesize_batch_serialises_concurrent_forwards` — two concurrent batches of DIFFERENT sizes must not overlap inside the model forward (regression for the `8 vs 7` race). Instruments the fake forward to flag concurrent entry; fails without `_synth_lock` (`max_concurrent=2`), passes with it.
- `test_ensure_base_loaded_single_flights_concurrent_cold_loads` — 8 threads released by a barrier call `_ensure_base_loaded` against a cold `_base` with a slow counting loader; must load **exactly once**. Fails without `_base_load_lock` (`8 concurrent loads` → the `float != BFloat16` dtype-corruption race that 500'd every batch after a restart), passes with it.

### Manual acceptance walkthrough (real GPU — replaces the deferred spike)

1. Start the sidecar + server + Vite; open a Qwen-heavy book.
2. Generate one chapter at `QWEN_BATCH_SIZE=1`, then again at `QWEN_BATCH_SIZE=4` (or higher). Expect: **per-line audio perceptually identical** (no drift), no reordered/wrong-voice lines, and a meaningfully shorter wall-clock at the larger batch size.
3. During a batch, confirm the Generate view never false-trips "Worker has gone quiet" (the heartbeat ticks every 10 s, under the 30 s watchdog).
4. If drift or VRAM pressure appears, drop `QWEN_BATCH_SIZE` (or `=1` to disable). Canonical manuscript: `server/src/__fixtures__/the-coalfall-commission.md` (do not commit).

### Concurrency-safety fix (2026-05-26)

The real-GPU walkthrough at `QWEN_BATCH_SIZE=8` with `GPU_VRAM_BUDGET=2` surfaced an **intermittent** (~2 of 3 chapter runs) `size of tensor a (8) must match tensor b (7) at non-singleton dimension 0` 500 — only at batch sizes that leave a remainder, only with the N-worker parallelism. Root cause: the Base model's `generate_voice_clone` is **not thread-safe**, and two batched forwards of DIFFERENT sizes dispatched in parallel (a full batch of 8 overlapping a chapter's 7-item remainder) collide on shared model state. Confirmed deterministically (6/6) by firing concurrent 8- and 7-item batches; fixed (0/6) by the per-engine `_synth_lock` serialising the forward. The single-voice micro-bench never hit it (parallel calls had identical shapes), and serial replays of the real chapter all passed — the trigger was strictly concurrent different-size forwards. Note this means `GPU_VRAM_BUDGET>1` gives **no safe same-engine Qwen parallelism** (batching is the throughput lever); it still benefits cross-engine coexistence (Kokoro + Qwen).

### Batch-test fake realigned to the uniform calibration reference (2026-05-28)

`test_batch_synthesis.py`'s fake modelled per-voice identity by stamping the clone prompt's **`ref_text`** into the synthesised PCM, with `_design` passing a distinct `cal-<voice>` line per voice. That assumption predated the plan-108 follow-up "the reference clip no longer voices the long quote" (108 ship notes, 2026-05-27), which made `design_voice` use the fixed `CALIBRATION_TEXT` pangram for the reference clip **and its clone prompt** for *every* voice — identity rides on the reference **audio** (distilled from the persona `instruct`); the ref_text is just a phonetic carrier. `test_qwen3.py` was updated for that change but the batch fake was missed, so its two marker assertions read `8280` (the pangram's marker) where they expected the per-voice `cal-<voice>` marker (`446` for `cal-a`) — a red `test:sidecar` leg on any box with the sidecar venv bootstrapped (CI skips it, which is why it slipped through). Fixed by carrying the per-voice marker through the **reference audio** in the fake (`generate_voice_design` stamps `_ref_marker(instruct)` into the clip → `create_voice_clone_prompt` recovers it → `ref_code`), matching how the real model carries voice identity. **No production code changed**; the demux / no-swap / ordering / list-form invariants are untouched — the marker just travels the audio path now, not `ref_text`.

## Out of scope

- **Length-bucketing** to cut padding waste (`generate_voice_clone` pads a batch to its longest member). The packing fn is written so bucketing is a one-line sort-by-length swap; deferred until the ear-check shows padding hurts.
- Batching Coqui/Kokoro/Gemini — no list API; they stay one-per-call.
- Per-item retry/bisect on a partial batch failure — a batch is atomic; a permanent failure fails the chapter exactly as a single call does today.

## Ship notes

(Filled when status flips to `stable` — after the real-GPU manual acceptance walkthrough confirms the speedup and no voice drift.)
