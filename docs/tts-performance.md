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

## Records

### Qwen3-TTS 0.6B — sdpa, bf16, 4070 — 2026-05-26

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
