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

### Qwen3-TTS 0.6B — sdpa, bf16, 4070 — 2026-05-26

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

### Kokoro v1 — 4070 — _TODO_

Not yet benchmarked here. Expected sub-1 RTF on GPU. Run `bench-tts.py --engine kokoro --voice af_heart` and add a row as the reference point.

## Open levers to measure (feeds `side-3` / `side-4`)

1. **Cross-voice batching** — batch mixed-cast sentences in one forward regardless of voice (each item keeps its own clone prompt). Would close the 4.1-vs-2.6 mixed-cast gap; the single biggest realistic win for real chapters.
2. **Larger batch sizes** (VRAM-permitting) + a **concurrency sweep** (`bench-tts.py --concurrency 1/2/4`) to confirm batching scales where concurrency plateaus.
3. **`x_vector_only_mode=True`** ([`side-4`](BACKLOG.md)) — drop the ICL prefix; speed vs. fidelity A/B.
4. **flash-attn** wheel on Windows (vs. the current SDPA path).
5. **Quantization** (int8/fp8) of the 0.6B base.
