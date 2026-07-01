# TTS performance record

A living log of **measured** TTS synthesis performance (real-time factor + throughput) across engines, models, and settings on the deploy hardware. The point is to drive perf-tuning ([`side-3`](BACKLOG.md) batching, [`side-4`](BACKLOG.md) x-vector-only mode, future quantization/concurrency work) from data rather than felt impressions, and to keep a full history so a change can be compared against a real prior number.

**Append a row per measured run — don't delete old rows.** Stale-looking numbers are the history; a regression is only visible against them.

RTF = generation wall time ÷ produced audio seconds. **< 1 is faster than real-time** (good); a chapter at RTF 4 takes 4 minutes of compute per minute of audio.

## Hardware / stack baseline

- **GPU:** NVIDIA, 8 GB VRAM (the target 4070). `GPU_VRAM_BUDGET=2` on the deploy box → 2 concurrent synths per chapter.
- **Stack (2026-05-26):** torch 2.6.0+cu124, transformers 4.57.3, accelerate 1.12.0, qwen_tts (`Qwen3-TTS-12Hz-0.6B-Base`, bf16, `attn_implementation=sdpa`), kokoro-onnx.
- **Engines:** Kokoro v1 (narrator workhorse, eager-loaded), Qwen3-TTS 0.6B (bespoke per-character, on-demand), Coqui XTTS v2 (alternate).
- flash-attn is **not** installed (Windows build cost) — Qwen runs the PyTorch SDPA path.

## How to measure

- **Reboot / free VRAM first** for a clean baseline (no resident Ollama/Coqui).
- **Serial micro-bench:** `python server/tts-sidecar/scripts/bench-tts.py --engine <e> --voice <v> [--repeat N] [--concurrency N]` against a live sidecar — serial `/synthesize`, reports per-call wall, RTF, and aggregate throughput.
- **Batch path (Qwen production path):** `POST /synthesize-batch` with N `{voice,text}` items in one call.
- **Full pipeline (truest):** `POST /api/books/:bookId/generation {modelKey, chapterIds:[id], force:true}` (SSE) — real per-character chapter. Effective RTF = wall ÷ chapter audio seconds; **ffprobe the produced MP3** for ground-truth duration rather than trusting the tick.

> **Benchmarking gotchas (cost hours once):** (1) the server resolves the sidecar URL from **`user-settings.json`** (→ `localhost:9000`), **not** the `LOCAL_TTS_URL` env — so to point the full pipeline at a custom/fixed sidecar you must **replace the `:9000` sidecar process itself**, not set `LOCAL_TTS_URL`. (2) `QWEN_BATCH_SIZE` *does* read straight from `process.env` (a shell value wins over `server/.env`), while most other server knobs come from `.env` via `loadEnvFile`. Verify which path each knob takes before trusting a run. (3) VRAM contention silently inflates RTF 3–5× — free the GPU first (the original 4.12 figure was a contention artifact).

## Settings & env vars that affect performance

These are the knobs that change the numbers. **Record any non-default value in the run's row/notes** — a row without its settings isn't reproducible. Defaults below are what the code + `server/.env.example` ship.

**Synthesis path — the biggest levers:**

| Var | Default | Effect |
|---|---|---|
| `QWEN_BATCH_SIZE` | `32` | Qwen sentences packed into one batched `generate_voice_clone` forward (plan 113). Larger = more throughput but more VRAM; **`1` disables batching** (the per-call kill-switch). Qwen-only — Coqui/Kokoro/Gemini are always one-per-call. With `QWEN_BATCH_TOKEN_BUDGET` on (the default), this is the **hard width cap** the budget clamps to. Default raised `4 → 32` on 2026-05-30 (the adopted 32/3600 config). |
| `QWEN_BATCH_TOKEN_BUDGET` | `3600` | Token-budget packing (plan 136): batch width is variable — the packer fills each batch while `width × maxLen ≤ budget` (units = normalised chars) and `width ≤ QWEN_BATCH_SIZE`, so short/dialogue batches pack wide (toward the cap) and long sentences stay narrow. `width ≈ budget/maxLen`, so `3600/100 ≈ 36` on typical prose, clamped to the cap (32). **Default flipped `0 → 3600` on 2026-05-30** (adopted after the live A/B); an explicit `0` = exact fixed-width `QWEN_BATCH_SIZE` slicing (kill-switch). Resolved via `resolveQwenTokenBudget` (unset → 3600; explicit `0` → off). Output-preserving. |
| `QWEN_ATTN_IMPL` | `sdpa` | Attention impl: `sdpa` (PyTorch-native, default), `eager` (slow baseline), `flash_attention_2` (needs the flash-attn wheel — installed via `install-qwen3.mjs --flash-attn` / `QWEN_INSTALL_FLASH_ATTN=1`, plan 115). **The model-load log prints the impl that actually engaged** — check it didn't silently fall back to sdpa. |

**Concurrency — server-side:**

| Var | Default | Effect |
|---|---|---|
| `GPU_VRAM_BUDGET` | `1` | GPU semaphore width = max concurrent synths across analyzer + sidecar; also the `poolWidth`/`sentenceConcurrency` default. **Deploy box: `2`.** Raising risks VRAM OOM on the 8 GB card. |
| `GPU_CONCURRENCY` | `1` | Legacy fallback used when `GPU_VRAM_BUDGET` is unset. |
| `GEN_WORKERS` (`generationWorkers` account setting) | `2` | Queue workers processing chapters across books (plan 111). Queue concurrency only — GPU work is still bounded by the semaphore, so raising it never risks OOM. |

**Qwen model / device:**

| Var | Default | Effect |
|---|---|---|
| `QWEN_DEVICE` | `cuda:0` | Device the base + design models load onto. |
| `QWEN_BASE_MODEL` | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | Resident synth/clone model. |
| `QWEN_VOICEDESIGN_MODEL` | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | Transient voice-design model (design-time only). |
| `QWEN_LANGUAGE` | `English` | Default synth language; per-voice manifest overrides. |
| `QWEN_VOICES_DIR` | `<workspace>/voices/qwen` | Designed-voice embedding cache. |

Load-time (code, not env): `dtype=bfloat16` + `low_cpu_mem_usage=False` (real-tensor load — see [plan 112 post-ship fix #2](features/archive/112-qwen-synth-quick-wins.md)). `_apply_torch_perf_flags` (main.py) also enables TF32 once per process in each torch load path — `torch.backends.cuda.matmul.allow_tf32` / `cudnn.allow_tf32` / `set_float32_matmul_precision("high")`. These only affect **fp32** matmuls, so the win is near-zero for bf16 Qwen and lands mostly on Coqui's fp32 residuals — *not* a mover of the dispatch-bound Qwen floor. `cudnn.benchmark` is deliberately left OFF: variable audiobook input lengths make its per-shape autotune re-fire on every new shape, a net loss.

**Preload — cold-start vs. resident VRAM:** `PRELOAD_KOKORO` (on; ~1 GB eager), `PRELOAD_QWEN` (off; warms on first `/load`/synth), `PRELOAD_COQUI` / `PRELOAD_COQUI_MODEL` (off / `xtts_v2`).

**Other engines:** Coqui — `COQUI_DEVICE` (`auto`), `COQUI_HALF` / `COQUI_DEEPSPEED` (on for cuda, off for cpu), `COQUI_LANGUAGE` (`en`); Kokoro — `KOKORO_MODEL_PATH` / `KOKORO_VOICES_PATH`, `KOKORO_LANGUAGE` (`en-us`).

## Records

### Qwen3-TTS 0.6B — sdpa, bf16, 4070 — 2026-05-26 ⚠️ contention-confounded

> **Superseded by the clean run below.** Every number in this section was measured while VRAM sat at **~97% full** (the app's idle Qwen on `:9000` + repeated GPU hammering). Re-measured on a freed GPU, the figures are **3–5× faster** — so the "RTF 4–8 / ~40 h per novel / too slow for books" read here was wrong. Kept for history per the append-only rule; do not cite these numbers.

_Settings:_ `QWEN_ATTN_IMPL=sdpa` (**confirmed** from the model-load log), `dtype=bfloat16`, `low_cpu_mem_usage=False`. The full-pipeline row used the running `server/.env` values for `QWEN_BATCH_SIZE` and `GPU_VRAM_BUDGET` (deploy defaults are `4` and `2`) — not independently re-verified for this run. The serial and batch micro-bench rows hit the sidecar's `/synthesize` and `/synthesize-batch` **directly**, bypassing the server-side `QWEN_BATCH_SIZE`/semaphore — the batch row was one explicit 8-item call.

| Path | Sample | Audio s | Wall s | RTF | Notes |
|---|---|---|---|---|---|
| serial `/synthesize` (cold) | 1 sentence, first call | 3.2 | 27.3 | **8.52** | includes one-time CUDA warm-up |
| serial `/synthesize` (warm) | 10× `qwen-narrator` | 58.6 | 384.5 | **6.63** | warm barely beats cold — cost is the AR decode, not load |
| serial `/synthesize` (real prose) | 8 "DAY ONE" sentences | 30.4 | 251.9 | **8.29** | real Marlow prose, single voice |
| **batch `/synthesize-batch`** | 8 same-voice items, 1 call | 30.2 | 78.8 | **2.61** | **3.2× faster than serial** — clean single-voice batch |
| **full pipeline, mixed cast** | "the Coalfall Commission" ch.2 "DAY ONE", 4 voices | 296.3 | 1221.8 | **4.12** | real per-character gen (Narrator/Marlow/Oduvan/Nim); MP3 ffprobe-confirmed (296.28 s, mono 24 kHz, ~67 kbps) |

**Observations:**

- Warm serial barely beats cold (~6.6 vs ~8.5) — the dominant cost is the autoregressive decode loop, not model load.
- **True batching is the one lever that moved the needle:** 2.61 vs 8.29 (3.2×) for same-voice sentences in one `generate_voice_clone` forward.
- A real **mixed-cast** chapter lands at **~4.1** — between the clean batch (2.6) and serial (8.3): alternating dialogue across 4 voices means the pipeline forms smaller per-voice batches and pays MP3-assembly overhead, and it **does not batch across voices** today. Closing that gap is the open lever (see below).

**Implications for full-book generation on the 4070:**

- A ~100k-word novel (~10 h of audio) ≈ **~40 h serial / ~11 h at the RTF-2.6 batch path** — overnight+ either way.
- Real mixed-cast chapters run at ~RTF 4 → **~2 h of compute per chapter**.
- **Kokoro (sub-1 RTF) stays the workhorse** for anything book-length; Qwen bespoke per-character voices are a "render a few chapters and wait" / overnight feature.

### Qwen3-TTS 0.6B — clean VRAM, SDPA vs FA2 + concurrency — 2026-05-26 (supersedes the above)

_Settings:_ dedicated benchmark sidecar on `:9001`, `PRELOAD_QWEN=1`, **Kokoro/Coqui not loaded**, the app's `:9000` Qwen unloaded → **VRAM ~0.8 GB base** (vs ~97% full for the run above — that contention was the whole 3–5× gap). `dtype=bfloat16`, `low_cpu_mem_usage=False`. Attention impl **confirmed from each load log** (`flash_attention_2` did NOT silently fall back to sdpa). flash-attn 2.7.4 wheel installed via plan 115. Each batch = one `/synthesize-batch` call of N items; concurrency = N such calls fired in parallel. 2 samples per cell.

**SDPA vs FlashAttention-2** (RTF = wall ÷ audio; lower is better; real "DAY ONE" Marlow prose, `qwen-narrator`):

| Batch | SDPA | FA2 |
|---|---|---|
| serial `/synthesize` | 3.2, 3.4 | 3.1, 3.8 — *serial is high-variance; judge on batch* |
| B=4 | 1.80, 1.91 | **1.41, 1.50** |
| B=6 | 1.13, 1.14 | 1.16, **0.97** |
| B=8 | **1.28, 1.28** (stable) | **0.83**, 1.81 (bimodal — one stall) |

**Concurrency** (SDPA, batch-8 per stream — the `GPU_VRAM_BUDGET` lever):

| Parallel streams | Aggregate throughput |
|---|---|
| 1 | 0.96× realtime |
| 2 | 1.22× realtime (+27%) |
| 4 | 1.20× realtime (plateau) |

> ⚠️ **This +27% is unsafe — disregard it.** These parallel streams were *identical-size* batches, so they didn't crash, but the Qwen forward is **not thread-safe**: *different-size* concurrent batches corrupt each other (the `8 vs 7` chapter-generation bug — see the end-to-end record below + plan 113). The fix serialises same-engine forwards, so `GPU_VRAM_BUDGET>1` yields **no** safe same-engine Qwen parallelism; it only helps cross-engine coexistence (Kokoro + Qwen).

**Findings:**

- **Batching is the dominant — and only safe — lever** — serial ~3.3 → batch-8 ~1.0–1.3 RTF; bigger batch = better, B=6–8 the sweet spot.
- **FA2 ≈ SDPA.** FA2 is modestly faster at B=4 and posts the single fastest micro result (B=8 0.83) but is noisier; SDPA is rock-stable. End-to-end (below) they tie, SDPA marginally ahead. TTS is decode-bound, so FA2's prefill optimization is a small, inconsistent edge. **SDPA stays the default; FA2 is a legit opt-in.** (Resolves `side-5`; see plan 115 Ship notes.)
- **Concurrency is not a safe Qwen lever** — see the warning above; same-engine Qwen runs effectively serial after the fix.

**Optimal config on the 4070:** `QWEN_BATCH_SIZE=8` (the throughput lever — **safe** now that the concurrent-batch race is fixed, plan 113), `QWEN_ATTN_IMPL=sdpa` (FA2 ≈ SDPA, not worth flipping). `GPU_VRAM_BUDGET=2` is fine for cross-engine coexistence but adds no same-engine Qwen throughput. No other models co-resident.

### Qwen3-TTS 0.6B — end-to-end (real pipeline) — 2026-05-26

The true per-chapter number through the full server pipeline (per-character voice routing + `QWEN_BATCH_SIZE=8` batching + MP3 assembly), generating "the Coalfall Commission" ch.2 "DAY ONE" (87 sentences, 4 voices, ~290 s audio) on a freed GPU, **after the concurrent-batch race fix** (plan 113):

| Engine | RTF (3 runs) | Mean | Failures |
|---|---|---|---|
| **SDPA** | 1.23 / 1.14 / 1.08 | **1.15** | 0/3 |
| **FA2** | 1.23 / 1.18 / 1.15 | **1.19** | 0/3 |

**Before the fix, ~2 of 3 runs 500'd** with `size of tensor a (8) must match tensor b (7)` (concurrent different-size batches racing the non-thread-safe forward). After the fix: **3/3 clean** for both backends, SDPA marginally faster, both stable. So end-to-end batch-8 is **~RTF 1.15–1.2** — a ~10 h-audio novel ≈ **~11–12 h** (overnight), not the ~40 h the original contention-confounded run implied.

### Qwen3-TTS 0.6B — batch-size sweep + worker/clock diagnosis — 2026-05-28

Driven by a live full-book run reading **RTF ~3.5–5** while the 2026-05-26 clean benchmark says batch-8 ≈ **1.15–1.28**. The gap is **conditions, not the model** — proven below. Measured on the deploy box's **live `:9000` sidecar** (Kokoro + Qwen co-resident, VRAM ~3.8 GB — the real config, not the dedicated 0.8 GB bench sidecar), GPU otherwise idle (queue paused), Windows power plan = **High performance** (changed from Balanced this session). `qwen-narrator`, real prose, `bench-tts.py --batch N --concurrency M` (new `--batch` mode POSTs `/synthesize-batch` and reads the frame's `genMs`/`audioMs`; end-to-end RTF == sidecar compute RTF here, so HTTP overhead is negligible). 4 calls/cell (call #1 warms).

| Path | RTF (median) | Aggregate | Note |
|---|---|---|---|
| `/synthesize-batch` **B=8, 1 stream** | **1.28** (1.17–1.41) | 0.78× | reproduces the 2026-05-26 clean B=8 (1.28) exactly — model + batch path are fine |
| `/synthesize-batch` **B=16, 1 stream** | **0.80** (0.74–0.90) | 1.25× | **bigger batch ~halves RTF** — faster-than-realtime; dispatch amortised over 2× the sequences |
| `/synthesize-batch` **B=8, 2 streams** | **2.00** (1.16–2.32) | 0.88× | concurrency=2 (the `generationWorkers`/`GPU_VRAM_BUDGET=2` analogue): per-call RTF **doubles** (lock-serialised forward → 2nd stream waits) for only **+13%** aggregate |

**Why live (~3.5) ≠ benchmark (~1.3) — it's the pathway, not the data/style:**

- **`QWEN_BATCH_SIZE=8` vs `16`** — B16 is 0.80 vs B8's 1.28. The biggest free lever; raise it (VRAM-permitting — B16 stayed well within 8 GB here).
- **`generationWorkers=2`** — the Qwen forward is serialised (`_synth_lock`, plan 113's concurrent-batch-race fix), so a 2nd same-book Qwen worker can't parallelise. It **doubles per-chapter RTF (1.28→2.00)** — exactly what the live per-chapter telemetry reads — for a marginal +13% aggregate. **The serialisation didn't slow the forward** (the 1.15 benchmark already includes the lock); the 2nd worker's lock-wait + hand-off gaps do. For single-book Qwen, `generationWorkers=1` is faster *per chapter* and barely slower in aggregate.
- **Single-`/synthesize` path elements** — `synthesiseChapter` runs the **title beat** and the **anchor group** as single `/synthesize` calls (RTF ~3–8, the slow non-batched path), pulling each chapter's average up. (These are the exact narrator single-synths that triggered the CUDA crashes this session.)
- **Clock-sag** — `nvidia-smi dmon` during the *live* run showed the SM clock parked at **375–615 MHz (vs 3105 capable)**, 9–14 W, sm 20–37% — the GPU never boosts because gappy generation (MP3 assembly, voice loads, worker hand-offs) looks like light load. The back-to-back bench keeps it busy enough to boost. Balanced→High-performance moved live 5→~3.5; a hard clock lock (`nvidia-smi -lgc`, elevated) is the next isolation test (**pending**).

**CUDA graphs / `torch.compile(mode="reduce-overhead")` is BLOCKED at the library level:** `qwen_tts` declares `_supports_static_cache = False` and uses a growing `DynamicCache` (`modeling_qwen3_tts.py:476/509/1083`); CUDA graphs need static per-step shapes (a fixed `StaticCache`). The talker also runs a **nested `code_predictor.generate()` inside every decode step** (line 1671). Using CUDA graphs would require **forking `qwen_tts` to add static-cache support to both the talker and its code predictor** — large, risky. **Batching + worker-count + clocks are the realistic levers; the CUDA-graphs fork is a last resort.**

**Recommended deploy config (to validate end-to-end):** `QWEN_BATCH_SIZE=16`, `generationWorkers=1` for a single Qwen-heavy book (keep 2 only for cross-engine Kokoro+Qwen coexistence), Windows High-performance + NVIDIA "prefer max performance" for the sidecar `python.exe`. Predicted full-pipeline chapter RTF ≈ ~1 — **needs a real `POST /api/books/:id/generation` run to confirm** (title-beat/anchor single-synths mean it won't be exactly the 0.80 micro-number).

### Qwen3-TTS 0.6B — clock-lock test + worker confound (live full-book) — 2026-05-29

Followed the 2026-05-28 recommendation into a live full-book run (`QWEN_BATCH_SIZE=16`, Windows High-performance, GPU clock locked via `nvidia-smi -lgc`). Two findings, one of them a correction.

**1. It's dispatch-bound, NOT clock-limited — confirmed by forcing the clock.** Live batch-16 forwards (`qwen-narrator` + dialogue, real prose):

| GPU clock | batch-16 RTF | util / power during forward |
|---|---|---|
| `-lgc 2100,3105` (floor 2100) | 1.31 / 2.29 / 2.62 | 0–24%, 4–17 W |
| `-lgc 3105,3105` (forced; ran at **2610** under power envelope) | 2.35 / 2.50 / 2.60 | **0–15%**, 7–24 W |

Forcing the clock higher did **not** improve RTF and util stayed ~15% — the GPU is idle most of every forward waiting on CPU kernel launches. **The clock lock's only value is preventing the earlier sag to 375 MHz** (that was the 5→~2.5 win); past a ~2100 floor, more clock does nothing. Hard `-lgc` is therefore unnecessary — the High-performance plan + NVIDIA "prefer max performance" prevent the sag without pinning idle power.

**2. CORRECTION — `GEN_WORKERS` env is vestigial; the 2-worker reads were contended.** `GEN_WORKERS=1` in `server/.env` did **not** cap concurrency: the worker count is decided **client-side** in `src/store/queue-dispatcher-middleware.ts` (`state.account.generationWorkers ?? 2`), fed by the user-settings GET, which returns the **raw account setting (2)** — the env-aware `getResolvedGenerationWorkers()` (server) is **dead code** (only tests call it). So the live run was **2 workers**, and the rising 2.35→3.66 batch RTFs were **2-worker lock-contended**, not the single-worker number. **Clean single-worker batch-16 ≈ 1.3–2.0.** (Fix tracked: wire `getResolvedGenerationWorkers()` into the user-settings GET so the env override reaches the client; the real lever today is the **account setting**, not the env.)

**Corrected realistic number:** single-worker, batch-16, real-prose chapters land **~2** RTF on this box (dispatch-bound + per-batch padding-to-longest-sentence), **not ~1**. The 0.80/1.15 bench figures were optimistic (short, uniform, back-to-back sentences). **Qwen bespoke ≈ overnight render; Kokoro stays the book-length workhorse.** The remaining realistic lever short of the (blocked) static-cache/CUDA-graphs fork is **length-bucketing** batches (group similar-length sentences to cut padding waste) — **shipped 2026-05-29 (plan 128, default ON via `QWEN_BATCH_BUCKET`)**; the bucketed-vs-unbucketed batch-16 measurement row is still TODO below (run `bench-tts.py --batch 16 --bucket 0` then `--bucket 1`).

### Qwen3-TTS 0.6B — token-budget batching live A/B — 2026-05-29 ⚠️ INCONCLUSIVE (re-run after plan 137)

Tested plan 136 token-budget batching live on "The Hollow Tide" CH 10 "EIGHT" (217 lines, 7 speakers — dialogue-dense) at three configs: `32/2400`, `64/4800`, `64/3600` (`QWEN_BATCH_SIZE`/`QWEN_BATCH_TOKEN_BUDGET`).

**The per-batch / aggregate RTF numbers are NOT trustworthy** — two confounds:
1. **`tsx watch` restart churn** — editing repo files / switching branches mid-run reloaded the server, tearing down the sidecar and re-running the chapter.
2. **The plan-137 fetch-timeout bug** — cap-64 batches ran 400–454 s, blowing undici's 300 s `headersTimeout` → retry loop → re-synthesis. Net: **473 synthesized items for a 217-line chapter (~2.2×)**, repeated `text_len`s, no chapter ever finished. Aggregate RTF drifted 1.3→2.0 as the loop accumulated — junk.

**What IS reliable (VRAM is unaffected by the churn) — peak `nvidia-smi memory.used` during decode, 8 GB 4070 Laptop:**

| `QWEN_BATCH_TOKEN_BUDGET` | peak VRAM | headroom |
|---|---|---|
| 2400 | 3921 MiB | ample (~52%) |
| **3600** | **5631 MiB (69%)** | comfortable |
| 4800 | 6873 MiB (84%) | **too hot — avoid** |

**Qualitative findings (direction trustworthy, magnitudes not):**
- Prose / large-payload batches synth fast (~0.6–1.1) — width helps here.
- **Ultra-short dialogue (avg ~12–30 chars) stayed ~2.3–3.8 regardless of cap (32 *or* 64).** It's **padding-bound, not width-bound**: a batch decodes to its longest item, so a bucket of tiny same-speaker lines wastes most decode steps for little audio. A *wider* cap (64) was a **wash-to-worse** — a 64-wide bucket spans more length variance → more padding.
- ⇒ **Batch width is not the dialogue lever.** The real lever is **coalescing consecutive same-speaker short lines** ([`side-10`](../BACKLOG.md)). Keep the cap modest.

**Next clean A/B (do after plan 137 is live + a reboot, repo untouched during the run):**
- Recommended start config: **`QWEN_BATCH_SIZE=32`, `QWEN_BATCH_TOKEN_BUDGET=3600`** — dialogue-safe cap (batches finish well under any timeout), VRAM ~69% with headroom for long batches to pack a bit wider than 2400.
- Compare fixed-16 (`QWEN_BATCH_TOKEN_BUDGET=0 QWEN_BATCH_SIZE=16`) vs `32/3600`, **same CH 10**, ffprobe-confirmed audio seconds, on a chapter that now actually **completes** (segment count should == sentence count). Record the row here, then flip plan 136 to `stable`.

### Kokoro v1 — 4070 — _TODO_

Not yet benchmarked here. Expected sub-1 RTF on GPU. Run `bench-tts.py --engine kokoro --voice af_heart` and add a row as the reference point.

### Qwen3-TTS 0.6B — token-budget packing adopted as default (32/3600) — 2026-05-30

The plan-136 token-budget A/B — blocked on 2026-05-29 by the plan-137 fetch timeout (cap-64 batches ran >300 s and aborted) — was re-run on the freed 8 GB box once plan 137 lifted the timeout. Outcome:

- **Adopted production config: `QWEN_BATCH_SIZE=32`, `QWEN_BATCH_TOKEN_BUDGET=3600`**, now the shipped **code defaults** (`synthesise-chapter.ts`: cap `4 → 32`, budget `0 → 3600`). The unset-vs-explicit-`0` distinction is preserved by `resolveQwenTokenBudget` (unset → 3600 ON; explicit `0` → fixed-width kill-switch), unit-pinned.
- **Width is capped at 32 deliberately:** `64` was confirmed a wash-to-worse on dialogue-dense chapters — a batch decodes to its LONGEST item, so a 64-wide bucket spans more length variance → more padding waste, and it ran VRAM hot. The token budget lets short/prose batches pack wide while the `width × maxLen ≤ 3600` invariant keeps the long-tail batch inside the proven 8 GB envelope.
- **Output is byte-identical** (per-item prompts + index scatter-back) — this is a pure batch-*composition* change, not an audio change.
- Plans 128 (length-bucketing, the prerequisite sort) and 136 → `stable` + archived; backlog `side-6` and `side-9` closed. The width lever helps prose, not dialogue; the remaining dialogue lever is short-line coalescing (`side-10`), and the dispatch-bound floor (`side-7`) is still the ceiling.

### Qwen3-TTS 0.6B — full-book run RTF (32/3600, merged build) + host-memory leak — 2026-05-30

Live full-book run of **The Hollow Tide** on the merged build (32/3600 token-budget default, single worker, eager Qwen, 8 GB 4070 Laptop / 64 GB host). Two outcomes: the config's per-chapter RTF is **strong**, and the run surfaced a **host-memory leak** that is its own record below.

**Per-chapter RTF (server-reported `synth ÷ audio`, the true pipeline figure):**

| Chapter | Lines | Audio s | Synth s | RTF | Note |
|---|---|---|---|---|---|
| 15 "THIRTEEN" | 166 | 533.6 | 906.4 | **1.70** | first chapter — startup/voice-load warm-up in the wall |
| 16 "FOURTEEN" | 279 | 866.7 | 1241.9 | **1.43** | |
| 17 "FIFTEEN" | 323 | 1216.8 | 1335.8 | **1.10** | 0.91× realtime — best; big prose chapter packs wide |
| 18 "SIXTEEN" | 316 | 1270.3 | 1869.0 | ~~1.47~~ | **contaminated** — a leak-diagnostic bench was stealing the `_synth_lock` during this render; not a real number |

**Takeaway:** the adopted **32/3600** config lands real prose-heavy chapters at **RTF ~1.1–1.7 and falling as chapters get longer/wider** (1.70 → 1.43 → 1.10) — the best end-to-end figures recorded, and ch17 dipped **under realtime**. Confirms the 32/3600 adoption on a genuine multi-voice book, not just a micro-bench.

**HOST-MEMORY LEAK (the big find — see plan 143):** during this run the sidecar's host RAM (RSS / committed-private) climbed steadily — private floor 11.5 → 27 GB over ~30 min (~+0.3 GB/min), peaks to 41 GB — while **`cuda_allocated`/`cuda_reserved` stayed flat (~1.9 GB)**. The 2026-05-30 root-cause work (instrumented via the new `GET /debug/memory` + per-minute `sidecar memory:` log) established:

- **It's a CPU/host leak, not VRAM** (RSS climbs, CUDA flat — the classic signature; corroborated by a user-supplied "Qwen3 TTS 0.6B PyTorch Memory Leak" research report).
- **Driven by VARIABLE INPUT SHAPES.** Decisive controlled experiment: **40 identical fixed-shape `batch-16` synths** against `/synthesize-batch` held the floor **flat** (~28–30 GB private); variable-shape real generation climbed it **unbounded**. Every sentence is a different length → a new native per-shape workspace (MKLDNN / allocator) that's never freed — pytorch/pytorch **#32596**.
- **`gc.collect()` + `torch.cuda.empty_cache()` reclaim ~0** against it (the watchdog logged it every tick) — it's neither Python reference cycles nor the CUDA cache. So plan 141's gc-on-unload fix (correct for the *design-cycle* leak) does NOT touch this. The original 54 GB OOM was **generation watermark + design-cycle leak stacked** over a long cast-review session.
- **Mitigation shipped (plan 143):** an RSS hard-ceiling **process-recycle** — the sidecar self-exits at `SIDECAR_RSS_RESTART_MB` (default 55% of RAM) and the srv-15 supervisor respawns a fresh process; srv-16 skips completed chapters so only the in-flight one re-renders. The report's "bulletproof" pattern, made clean by srv-15/16.
- **Open: eliminate the leak itself** (so recycling isn't needed) — `side-11` / [plan 153](features/archive/153-sidecar-variable-shape-host-leak.md). Candidate 1 LANDED (default OFF, awaiting a live A/B): env-gated `SIDECAR_DISABLE_MKLDNN=1` sets `torch.backends.mkldnn.enabled=False` to kill the suspected CPU per-shape workspace. Instrument LANDED: `bench-tts.py --mem-sample` drives a seeded variable-shape batch loop, samples `/debug/memory` (now exposing `committed_mb`) after each batch, and prints the committed-private slope — reboot, run flag-OFF then flag-ON, PASS iff the ON slope ≈ flat. If MKLDNN isn't the lever, fall to fixed-shape batch padding; `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` already shipped (plan 144) but targets the *separate* VRAM-frag OOM, not this host leak.

### Qwen3-TTS 0.6B — full-book overnight run on the FIXED build (32/3600, plans 141/146/147) — 2026-05-31 ✅ best sustained full-book result

The headline run: a complete overnight render of **The Hollow Tide** (the full story, chapters 25–49 of the manuscript = chapterIds 27–51) on the build carrying all three prior fixes — the gc-on-unload + RSS-recycle leak work (plan 141/143), the Kokoro pre-warm / fallback gate (plan 146), and the sidecar-readiness gate (plan 147 / srv-17b). Goal was twofold: re-render the whole book on Qwen for engine consistency, and validate those fixes on a genuine multi-voice book rather than a micro-bench. **All three held; the config sustained ~realtime across 25 chapters.** A late stall (root-caused below) was a *new*, separate bug (back-matter), since fixed as plan 148.

_Settings:_ adopted production config **`QWEN_BATCH_SIZE=32`, `QWEN_BATCH_TOKEN_BUDGET=3600`** (the shipped defaults), **single generation worker** (account `generationWorkers`; the per-chapter-fastest config per 2026-05-28/29), eager Qwen (`PRELOAD_QWEN=1`), **Kokoro NOT loaded** (plan 146 stopped the unconditional pre-warm), `QWEN_ATTN_IMPL=sdpa`, Windows High-performance plan. 8 GB 4070 Laptop / 64 GB host. RTF = server-reported `synth ÷ audio` (the true pipeline figure; per-character voice routing + batching + MP3 assembly).

**Per-chapter RTF (all 25 rendered chapters, in render order):**

| Ch | Lines | Audio s | Synth s | RTF | Note |
|---|---|---|---|---|---|
| 27 | 230 | 789.6 | 779.9 | **0.99** | post-reboot start; already ~realtime |
| 28 | 268 | 807.6 | 846.0 | 1.05 | |
| 29 | 165 | 583.8 | 567.4 | 0.97 | |
| 30 | 311 | 1221.6 | 1116.8 | **0.91** | big prose chapter packs wide — best |
| 31 | 127 | 530.3 | 510.8 | 0.96 | |
| 32 | 95 | 339.8 | 411.3 | 1.21 | short ch — fixed overhead dominates |
| 33 | 170 | 580.9 | 628.2 | 1.08 | |
| 34 | 171 | 577.7 | 599.7 | 1.04 | |
| 35 | 215 | 717.4 | 754.5 | 1.05 | |
| — | | | | | **recycle #1** 01:56 (RSS ceiling) → respawn 2 s, queue rode through (srv-17b) |
| 37 | 221 | 642.9 | 810.1 | 1.26 | first chapter post-respawn (model just reloaded) |
| 38 | 216 | 856.8 | 890.9 | 1.04 | |
| 39 | 115 | 359.2 | 390.9 | 1.09 | short |
| 40 | 234 | 818.9 | 805.0 | 0.98 | |
| 41 | 224 | 697.9 | 723.8 | 1.04 | |
| 42 | 251 | 972.7 | 966.3 | 0.99 | |
| 43 | 131 | 460.4 | 479.9 | 1.04 | |
| 44 | 307 | 1073.6 | 1048.6 | 0.98 | |
| 45 | 169 | 559.6 | 547.3 | 0.98 | |
| — | | | | | **recycle #2** 03:53 → respawn 2 s, queue rode through (srv-17b) |
| 46 | 286 | 814.8 | 927.4 | 1.14 | first post-respawn |
| 47 | 222 | 771.1 | 814.7 | 1.06 | |
| 48 | 176 | 654.4 | 670.7 | 1.03 | |
| 49 | 244 | 889.0 | 907.7 | 1.02 | |
| 50 | 240 | 1174.4 | 1281.7 | 1.09 | |
| 51 | 293 | 1148.4 | 1042.7 | **0.91** | last story chapter — under realtime |
| 36 | 246 | 1024.3 | 1227.3 | 1.20 | re-rendered ~2 h later (recycle-orphan retry, see srv-17c) |

**Aggregate: ~5.30 h of audio produced at RTF ≈ 1.04** (Σ synth 19 750 s ÷ Σ audio 19 067 s). Per-chapter mean **1.04**, median **1.04**, range **0.91–1.26**, pace ~4.6 ch/hr (excluding the stall). **This is the best sustained full-book figure on record** — the 2026-05-30 partial run showed 1.10–1.70 over 3 chapters; this holds ~1.04 across 25 real multi-voice chapters, with two dipping under realtime. Confirms 32/3600 + single-worker as the production config on the 4070.

**Fix validation (the real point of the run):**
- **No VRAM spill, all night.** `kokoroLoaded` stayed `false` across ~20 health checks; CUDA reserved held **~1.9–3.9 GB** (never near 8 GB). The plan-146 pre-warm fix is what kept Kokoro off the card — the spilling-era ~3.7–4.8 RTF was the oversubscription it caused, and it did not recur (~4× recovery, sustained).
- **2 host-RAM recycles fired and both self-healed** (plan 143 + srv-17b). The sidecar self-exited at the RSS ceiling (`code=0`), the supervisor respawned in ~2 s, host RAM dropped (37→15 GB, 37→11 GB), and **the queue never paused and the breaker never tripped** — the exact failure the 2026-05-30 run hit (paused ~34 min) is now ridden out unattended. The gc/leak work held host RAM bounded (~37 GB plateau, not unbounded growth).
- **srv-17c surfaced** (NOT yet fixed): each mid-chapter recycle drops the single *in-flight* chapter to terminal `failed` (the readiness gate guards the *next* dispatch, not a chapter already synthesizing). Observed twice — ch46 self-recovered, ch36 needed a manual retry (the 07:43 row). Follow-up: drain/requeue the in-flight chapter across a recycle.

**The ~1 h end-of-run stall — a NEW bug, root-caused + fixed (plan 148), not a perf regression.** After ch51 (the last *story* chapter), the queue tail went 4-wide on chapterIds 52–59, which are **EPUB back-matter** (Acknowledgments, a next-book teaser + that book's PREFACE/ONE, About-the-author, Copyright, CONTENTS) the parser admitted as chapters. Degenerate non-prose input (a table of contents) sent Qwen's open-ended decode into a runaway (one batch logged 261 s compute for 51 s audio, RTF >5) and **hung the queue ~1 h with no chapter ever reaching `failed`** (server + sidecar both alive; sidecar memory frozen, GPU idle). Fixed defensively: **Layer A** auto-excludes detected front/back-matter at import/re-parse so it never queues; **Layer B** a per-call synth timeout (`SIDECAR_CALL_TIMEOUT_MS`, default 600 s) aborts a runaway call and fails the chapter so the queue advances. See `docs/features/148-skip-nonnarration-chapters.md` and memory `project_multiworker_qwen_final_batch_stall`. **Lesson for perf reads: 52–59 were never narration — a "full book" tops out at the last story chapter; check `state.json` chapter titles before treating tail chapters as renderable.**

## Open levers to measure

> **Where we are (2026-05-31):** RTF is **solved** — the overnight full-book run held aggregate **~1.04** (~realtime) across 25 real multi-voice chapters. The pure-speed levers below are therefore **parked won't-do**: 4 (`side-4`), 5 (`side-7`), and the dialogue lever `side-10` (it would degrade caption/audit fidelity for a speedup we no longer need). The **one active lever** now is **10 — `side-11`, eliminate the host-memory leak** (promoted to _Should_): not an RTF win, but it removes the periodic process-recycle that interrupts long books and drops the in-flight chapter (`srv-17c`).

1. ~~**Length-bucketing batches**~~ (plan 128) — group similar-length sentences before each `/synthesize-batch` so a batch decodes to a tighter max-length. **SHIPPED + ADOPTED 2026-05-30** (`synthesise-chapter.ts` sort, `QWEN_BATCH_BUCKET` default ON, output-preserving). Validated on the live 8 GB box as the foundation of the token-budget packer (7); plan 128 → `stable`, `side-6` closed.
2. ~~**Larger batch sizes** + concurrency sweep~~ — **measured 2026-05-28/29:** B=16 ~halves RTF vs B=8 (single-stream 1.28→0.80); concurrency=2 only contends (serialised forward). `GEN_WORKERS=1` (single-book) is the recommendation; the env knob is now **wired** (PR #320 overlays `getResolvedGenerationWorkers()` into the user-settings GET, so `GEN_WORKERS` reaches the client dispatcher — pull + restart to apply).
3. **Cross-voice batching** — already implemented (plan 112/113: `synthesize_batch` sends per-element voice prompts, `synthesiseChapter` collects Qwen groups across voices). Length-bucketing (1) is the remaining batch-composition win.
4. ~~**`x_vector_only_mode=True`**~~ ([`side-4`](BACKLOG.md)) — **PARKED won't-do 2026-05-31.** Perf goal met (~1.04); not worth trading bespoke-voice identity-consistency for a marginal further speedup. Wake only if Qwen becomes a real bottleneck again AND a listen-test shows x-vector-only holds identity.
5. ~~**Static-cache fork → CUDA graphs / `torch.compile`**~~ ([`side-7`](BACKLOG.md), [plan 129](features/129-qwen-decode-cuda-graph-spike.md)) — **PARKED won't-do 2026-05-31.** The only path past the dispatch-bound floor to sub-1, but a 2–5-day correctness-risky fork of `qwen_tts` (`_supports_static_cache=False` + DynamicCache + nested per-step `code_predictor.generate()`) we'd then maintain against upstream. Perf goal met, so not worth it; if ever reopened, run plan-129 Probe 1 first (batch-16 already amortizes launch overhead 16× → may be compute-bound, leaving graphs nothing to capture). **Distinct from `side-19`** ([#988](https://github.com/dudarenok-maker/Castwright/issues/988), spec `docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md`): that lever `torch.compile`s the **Code2Wav decoder** (token→waveform) — a self-contained feed-forward module, no cache fork — a separate, lower-risk speed play sized on its own (Phase 0 = Code2Wav's share of batch wall-time, which bounds the user-facing gain before any code lands). **Phase 0 measured 2026-07-01** on the 8 GB RTX 4070 Laptop box (`QWEN_BATCH_SIZE=32`/`QWEN_BATCH_TOKEN_BUDGET=3600`, voice `rv1`, 3 post-warmup `bench-tts.py --code2wav-share --batch 32` runs): **63.3% / 67.3% / 74.6%, median 67.3%** — well above the `>~25–30%` build threshold, so Code2Wav decode is actually the *majority* of batched 0.6B forward-compute time, not a minor tail. **GO Phase 1** → built (both 0.6B and 1.7B tiers) → **on-box Gate 1 FAILED**: the compiled path was dramatically SLOWER than eager (a batch-32 call didn't finish in 26+ minutes vs ~100 s eager; a batch-2 call didn't finish in 3+ minutes either), with direct evidence ruling out recompile-thrash (zero `TORCH_LOGS=recompiles` messages, inductor cache never grew past its initial 3 cached kernels) — the compiled kernel itself (or torch.compile's per-call dynamic-shape overhead across `chunked_decode`'s many small chunk calls) is pathologically slow on this CPU-decode + Windows/MSVC-cpp-inductor profile, for a reason not fully root-caused. **Closed `side-19` won't-ship (deferred) 2026-07-01** — `QWEN_COMPILE_CODEC` ships as tested, reviewed, harmless dead code (default OFF everywhere, hard-OFF on Windows); full writeup + root-cause candidates for a future attempt in the spec's Ship notes.
6. ~~**flash-attn** wheel on Windows~~ — **measured 2026-05-26: FA2 ≈ SDPA (modest + noisy); SDPA stays default, FA2 opt-in** (plan 115 / `side-5` resolved).
7. ~~**Token-budget packing**~~ (plan 136) — variable batch width driven by `width × maxLen ≤ budget`, so short/dialogue batches pack WIDE (toward the cap) where fixed-width left them narrower than VRAM allows. **SHIPPED + ADOPTED AS DEFAULT 2026-05-30** at **`QWEN_BATCH_TOKEN_BUDGET=3600`, `QWEN_BATCH_SIZE=32`** (the live A/B completed cleanly on the 8 GB box after plan 137 lifted the fetch-timeout that confounded the 2026-05-29 attempt). `64` confirmed a wash-to-worse on dialogue (padding waste + VRAM-hot), so width is capped at 32. Plan 136 → `stable`, `side-9` closed. The width lever helps prose, not dialogue — the dialogue lever was short-line coalescing (`side-10`), **now parked won't-do 2026-05-31** (it changes audio — non-byte-identical, coarser sentence captions across merged runs — so it degrades quote-audit/caption fidelity for a dialogue speedup we no longer need at ~1.04); the dispatch-bound floor (`side-7`) is parked too.
8. **Quantization** (int8/fp8) of the 0.6B base.
9. **Clean full-pipeline re-measure** — done 2026-05-26 (batch-8 ~RTF 1.15–1.2) and again 2026-05-31 (full-book overnight, aggregate ~1.04).
10. **Eliminate the variable-input-shape host-memory leak** ([`side-11`](BACKLOG.md) — promoted to **Should** 2026-05-31; [plan 153](features/archive/153-sidecar-variable-shape-host-leak.md)) — **← the next thing to play with for end-to-end runs.** NOT an RTF lever: it kills the periodic process-recycle (plan 143) that interrupts long books and drops the in-flight chapter (`srv-17c`). **Candidate 1 landed** (env-gated `SIDECAR_DISABLE_MKLDNN`, default OFF) **+ the leak-slope instrument** (`bench-tts.py --mem-sample`, samples `/debug/memory`'s new `committed_mb`). **Next: the live A/B** — reboot, run the bench flag-OFF then flag-ON, PASS iff the committed slope flattens; then flip the default ON. If MKLDNN isn't the lever, fall to fixed-shape batch padding (re-tune plan 128 bucketing + a python-side pad).
