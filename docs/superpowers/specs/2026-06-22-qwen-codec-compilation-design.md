---
status: draft
backlog: side-19
issue: 988
supersedes-relationship: distinct-from side-7 (plan 129) — different decode stage
---

# `side-19` — Faster book rendering: `torch.compile` the Qwen Code2Wav decoder

## TL;DR

**A speed play for our users.** Qwen is our default generation engine, so every
audiobook render runs through it. This spike compiles the **Code2Wav** codec
decoder (the token→waveform stage of `Qwen3-TTS-12Hz-0.6B`) with `torch.compile`
to shave time off **batched chapter rendering** — the goal is **long books
finishing faster than playback by a wider margin**, so a multi-hour audiobook is
ready sooner and generation feels snappier.

It's a **low-risk** lever (compiling a self-contained feed-forward module, not
forking anything) and the warmup cost lands once per render, where it's
negligible against hours of audio. We **measure first** to size the win — ship it
if it meaningfully helps our users, bank the number if it doesn't — so we never
trade complexity for a speedup that isn't there.

## The user win

- **Long books finish sooner.** We're already ~realtime (~1.04 RTF); pushing the
  codec stage faster widens the "renders faster than you can listen" margin, so a
  10-hour audiobook is done in fewer hours.
- **Snappier batched generation** on the engine every default render uses — a
  better felt experience, not just a benchmark number.
- **No downside to interactive use.** The compile only touches the batched
  book-render path, so cast preview and single-line repair stay instant.

## How — and why it's low-risk

`torch.compile` fuses and graph-optimizes a module's forward pass. We point it at
**Code2Wav** — the feed-forward neural-codec decoder that turns the LM's codec
tokens into a waveform (`server/tts-sidecar/main.py:156`, "speech_tokenizer /
Code2Wav decode"). It's a self-contained `nn.Module` run (mostly) once per batch:
**no KV-cache semantics, no generate-loop fork** — the textbook, low-risk use of
`torch.compile`. The one-time compile warmup amortizes to nothing over a
multi-hour render.

### Keep this separate from the parked `side-7`

A different `torch.compile` lever was already considered and parked — don't
conflate them:

- **`side-7` / plan 129** (`docs/features/129-qwen-decode-cuda-graph-spike.md`,
  **parked won't-do 2026-05-31**) targets the **autoregressive LM decode loop** —
  a correctness-risky 2–5-day fork of `qwen_tts` (`_supports_static_cache=False`
  + DynamicCache + nested per-step `code_predictor.generate()`). Parked because
  the maintenance/correctness cost wasn't worth it.
- **`side-19` (this spec)** targets the **Code2Wav decoder** — a separate stage,
  with none of that fork risk. `side-19` does **not** reopen `side-7`.

## Goal / non-goals

**Goal.** Make batched book rendering on our default Qwen engine faster for users
by compiling the Code2Wav decoder — shipped env-gated, output-preserving, and
VRAM-safe — once we've measured the gain is real.

**Non-goals.**
- Not reopening `side-7` (the LM-loop CUDA-graph fork stays parked).
- Not touching Kokoro (ONNX — `torch.compile` is a no-op there) or Coqui.
- Not a correctness change — output stays within the golden-audio tolerance.

## Design

### Phase 0 — Size the win (the gate). No production code.

Measure how much of batched Qwen wall-time is the Code2Wav decode — that tells us
the ceiling on the user-facing gain before we build anything.

- Instrument the Code2Wav call as a fraction of `generate_voice_clone` batch
  wall-time at the production batch width (`QWEN_BATCH_SIZE=32`,
  `QWEN_BATCH_TOKEN_BUDGET=3600`), via `server/tts-sidecar/scripts/bench-tts.py`,
  over a representative multi-voice chapter.
- Run on the 8 GB box with real Qwen weights (the only place the number is real).

**What the number means for users (codec share of batch wall-time):**

| Code2Wav share | Read |
|---|---|
| **> ~25–30%** | A real, felt speedup is on the table → build Phase 1. |
| **~10–25%** | A modest win — ship it if Phase 1 stays cheap and VRAM-neutral. |
| **< ~10%** | The codec isn't where the time goes; the speedup would be too small to justify the complexity. Bank the measurement and look elsewhere (e.g. the `side-7` LM stage). |

### Phase 1 — Ship the speedup (only if Phase 0 clears the bar)

- **`QWEN_COMPILE_CODEC` env flag**, **default OFF**, **OFF on Windows** until
  proven on-box (inductor/Triton is the historically-fragile `torch.compile`
  backend on Windows).
- Wrap **only** the Code2Wav module's forward in `torch.compile` (e.g.
  `mode="reduce-overhead"` / default backend), applied **once** at Qwen Base
  load, inside the existing `_apply_torch_perf_flags` neighborhood.
- **Batch-path only.** Used by `synthesize_batch`; the single `/synthesize`
  preview path stays eager so interactive use never eats the warmup.
- Handle **variable input shapes** explicitly (audiobook line lengths vary
  wildly — the same reason `cudnn.benchmark` is deliberately OFF). Use
  dynamic-shape compilation or length-bucketed fixed shapes (we already
  length-bucket batches, plan 128) so recompiles don't thrash. Observe recompile
  count.

### Acceptance gates (all must hold)

1. **A real, felt speedup.** A live `POST /api/books/:id/generation` chapter
   render is faster flag-ON than flag-OFF by a margin worth the complexity (A/B
   on the 8 GB box; the micro-benchmark alone does not ship it).
2. **8 GB VRAM-neutral.** Compiled Code2Wav at batch-32 holds within the 8 GB
   budget (we're at the edge — the plan-108 Qwen OOM). If compile busts budget on
   8 GB, it stays disabled there.
3. **Output-preserving within tolerance.** Compiled vs eager Code2Wav passes the
   golden-audio gate (`npm run test:golden-audio --engine=qwen`). `torch.compile`
   may perturb the last ULPs — assert within existing per-line length/loudness
   tolerance, not byte-identity. A speedup must never change what the listener
   hears.
4. **No interactive regression.** Single `/synthesize` preview latency is
   unchanged (the flag never touches that path); the one-time compile lands only
   on the first batched render.

## Testing plan

- **Sidecar pytest** (`server/tts-sidecar/tests/`): a `test_compile_codec.py`
  pinning (a) flag default OFF, (b) OFF on Windows even if set, (c) compiled
  module wired in the batch path and **not** the single path, (d) load survives a
  compile failure (swallow + fall back to eager, like `_apply_torch_perf_flags`
  swallows attribute drift — a perf knob must never kill a model load).
- **Golden-audio** (`--engine=qwen`): flag-ON output stays within tolerance of
  the committed baseline.
- **Bench instrument**: `bench-tts.py` reports `code2wav_ms` share (Phase 0) and
  is the A/B harness (Phase 1 acceptance gate 1).

## Risks

- **Windows-compile fragility** — mitigated by default-OFF-on-Windows + the
  load-time try/except fallback to eager.
- **Recompile thrash on variable shapes** — mitigated by dynamic-shape or
  bucketed-fixed-shape compilation; observe recompile count in Phase 1.
- **VRAM regression on 8 GB** — gate 2 disables on 8 GB if it busts budget.
- **Speedup smaller than expected** — Phase 0 sizes it before any code lands, so
  we only build when the user-facing win is real.

## Rollout / linkage

- Issue [#988](https://github.com/dudarenok-maker/Castwright/issues/988)
  (`area:side`, `moscow:could`, `type:chore`) is the canonical detail home; the
  thin `docs/BACKLOG.md` row links it.
- The distinction vs the parked `side-7` is recorded in `docs/tts-performance.md`
  (item 5) so the two `torch.compile` levers don't get re-conflated.
- On a Phase 0 stop, close `side-19` won't-do with the measured share recorded.

## Ship notes

_(unfilled — spike not yet executed.)_
