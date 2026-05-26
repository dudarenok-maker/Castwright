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

## Settings & env vars that affect performance

These are the knobs that change the numbers. **Record any non-default value in the run's row/notes** — a row without its settings isn't reproducible. Defaults below are what the code + `server/.env.example` ship.

**Synthesis path — the biggest levers:**

| Var | Default | Effect |
|---|---|---|
| `QWEN_BATCH_SIZE` | `4` | Qwen sentences packed into one batched `generate_voice_clone` forward (plan 113). Larger = more throughput but more VRAM; **`1` disables batching** (the per-call kill-switch). Qwen-only — Coqui/Kokoro/Gemini are always one-per-call. |
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

Load-time (code, not env): `dtype=bfloat16` + `low_cpu_mem_usage=False` (real-tensor load — see [plan 112 post-ship fix #2](features/archive/112-qwen-synth-quick-wins.md)).

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
| serial `/synthesize` (real prose) | 8 "DAY ONE" sentences | 30.4 | 251.9 | **8.29** | real Keefe prose, single voice |
| **batch `/synthesize-batch`** | 8 same-voice items, 1 call | 30.2 | 78.8 | **2.61** | **3.2× faster than serial** — clean single-voice batch |
| **full pipeline, mixed cast** | "Bonus Keefe Story" ch.2 "DAY ONE", 4 voices | 296.3 | 1221.8 | **4.12** | real per-character gen (Narrator/Keefe/Elwin/Ro); MP3 ffprobe-confirmed (296.28 s, mono 24 kHz, ~67 kbps) |

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

**SDPA vs FlashAttention-2** (RTF = wall ÷ audio; lower is better; real "DAY ONE" Keefe prose, `qwen-narrator`):

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
| 2 | **1.22× realtime** (+27%) |
| 4 | 1.20× realtime (plateau) |

**Findings:**

- **Batching is the dominant lever** — serial ~3.3 → batch-8 ~1.0–1.3 RTF; bigger batch = better, B=6–8 the sweet spot.
- **FA2 ≈ SDPA.** FA2 is modestly faster at B=4 and posts the single fastest result (B=8 0.83), but is **noisier** (the 1.81 stall) while SDPA is rock-stable. Consistent with the prefill-vs-decode theory: TTS is token-by-token decode, so FA2's optimization yields only a small, inconsistent edge. **SDPA stays the sensible default; FA2 is a legit opt-in.** (Resolves `side-5`; see plan 115 Ship notes.)
- **Concurrency 2 adds ~27%; 4 plateaus** → `GPU_VRAM_BUDGET=2` is optimal. 4-wide wastes VRAM (and risks OOM on 8 GB) for no throughput gain — confirms `side-3`'s "batching scales, concurrency plateaus".

**Optimal config on the 4070:** `QWEN_BATCH_SIZE=8`, `GPU_VRAM_BUDGET=2`, `QWEN_ATTN_IMPL=sdpa` (FA2 optional), no other models co-resident.

**Corrected full-book reality:** a ~10 h-audio novel ≈ **~8–10 h** (overnight), **not** the ~40 h the contended run implied. Caveat: these are **micro-bench** (raw model). The real per-character pipeline adds per-voice batch fragmentation + MP3 assembly, so end-to-end chapters run somewhat slower than the micro RTF — but far better than the contended 4.12. A clean full-pipeline re-measure is still owed for the true end-to-end number.

### Kokoro v1 — 4070 — _TODO_

Not yet benchmarked here. Expected sub-1 RTF on GPU. Run `bench-tts.py --engine kokoro --voice af_heart` and add a row as the reference point.

## Open levers to measure (feeds `side-3` / `side-4`)

1. **Cross-voice batching** — batch mixed-cast sentences in one forward regardless of voice (each item keeps its own clone prompt). Would close the 4.1-vs-2.6 mixed-cast gap; the single biggest realistic win for real chapters.
2. **Larger batch sizes** (VRAM-permitting) + a **concurrency sweep** (`bench-tts.py --concurrency 1/2/4`) to confirm batching scales where concurrency plateaus.
3. **`x_vector_only_mode=True`** ([`side-4`](BACKLOG.md)) — drop the ICL prefix; speed vs. fidelity A/B.
4. ~~**flash-attn** wheel on Windows~~ — **measured 2026-05-26: FA2 ≈ SDPA (modest + noisy); SDPA stays default, FA2 opt-in** (plan 115 / `side-5` resolved).
5. **Quantization** (int8/fp8) of the 0.6B base.
6. **Clean full-pipeline re-measure** — real per-character chapter under freed VRAM, for the true end-to-end RTF (the micro-bench is raw-model only).
