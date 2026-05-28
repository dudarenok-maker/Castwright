---
status: deferred
shipped: null
owner: null
---

# Qwen decode: CUDA-graph / static-cache spike (probe-gated)

> Status: deferred — post-1.5.0; a GATED spike, not a build task. Do NOT start the fork before the two probes below pass.
> Key files: `server/tts-sidecar/main.py` (`QwenEngine` synth + `synthesize_batch` path), the installed `qwen_tts` package (`generate_voice_clone` + the nested per-step `code_predictor.generate()` — read-only), `server/tts-sidecar/scripts/bench-tts.py` (measurement), `docs/tts-performance.md` (open lever 5)
> URL surface: none (internal sidecar synthesis change)
> OpenAPI ops: none

## Benefit / Rationale

Qwen autoregressive decode is **dispatch-bound** (kernel-launch-bound): each decode step fires tiny one-token GPU kernels with CPU-side gaps between launches, so the GPU sits 75–85% idle and the SM clock sags to ~400 MHz on the live gappy path (full measurements in `docs/tts-performance.md`). CUDA graphs are the canonical fix for exactly this shape — they capture the per-step kernel launch sequence once and replay it as a single op, so the inter-launch CPU gaps disappear. (This is also why locking the GPU clock did NOT help: clock was never the bottleneck, the launch gaps are.)

- **User:** the only path from the realistic ~1–2 per-chapter RTF floor toward sub-1 (Kokoro-class speed). Output-preserving — no audio change.
- **Technical:** would unlock `torch.compile(mode="reduce-overhead")` (which uses CUDA graphs under the hood) on the Qwen decode loop, or a hand-rolled `torch.cuda.CUDAGraph` capture/replay.
- **Architectural:** n/a beyond the sidecar — but it forks a third-party model's cache management, which is a standing maintenance commitment (re-validate audio bit-correctness on every `qwen_tts` upgrade).

**Honest caveat — the reason this is gated, not green-lit:** large batching already does much of CUDA-graphs' job. `QWEN_BATCH_SIZE=16` packs 16× more work into each kernel launch, which is why the clean bench already drops to RTF 0.80. So it is **unknown** whether the *batched* forward is still launch-bound (graphs would help) or already close to compute-bound (graphs are a dead end with little left to capture). The dispatch-bound diagnosis is firmest for the *serial* path (RTF ~6–8); do NOT commit to the fork on the serial-path hunch. Settle it with Probe 1 first.

## Why every path to CUDA graphs is blocked here

All three routes hit the same root cause — `qwen_tts` has no static-shape KV cache and a nested decode loop:

1. **`torch.compile(mode="reduce-overhead")`** — the easy button (uses CUDA graphs internally). Needs a **static-shape KV cache** so tensor shapes don't change between steps. `qwen_tts` uses `DynamicCache` and reports `_supports_static_cache=False`. → blocked.
2. **Manual `torch.cuda.CUDAGraph` capture + `graph.replay()`** — capture the step forward, replay with static input/output buffers. Same static-cache prerequisite, *plus* the nested per-step `code_predictor.generate()` (a second autoregressive loop inside each outer decode step) has its own dynamic control flow that forces graph-breaks. Correctness-fragile — stale-buffer bugs are silent and surface as corrupted audio.
3. **Fork `qwen_tts` to add static-cache support** — the principled path: implement a `StaticCache` for the talker + code predictor, flip `_supports_static_cache=True`, then route #1 works. This is a *real project*: modifying a third-party model's cache management, keeping audio bit-identical across the nested loop, and owning the re-validation burden on every `qwen_tts` upgrade.

## The spike — two cheap probes, gated (run BEFORE any fork)

**Probe 1 (~1–2 h, decisive): profile the batch-16 decode loop.** Run one long `generate_voice_clone` under `torch.profiler` (or `nvidia-smi dmon` + manual per-step timing) against a live sidecar mid-render. Split wall time into GPU-kernel / CPU-Python / idle-gap.

- **idle-gap large → launch-bound → graphs are worth pursuing → do Probe 2.**
- **GPU-kernel dominant → compute-bound → CLOSE this item.** We're at the model's floor; ship at the batching RTF and stop. (This is the bet — see the caveat above.)

**Probe 2 (~half day, only if Probe 1 is green): audit the nested `code_predictor.generate()`** in the installed `qwen_tts` (read-only). Two questions decide feasibility:

- **Fixed vs variable token count per outer step?** Fixed count → graph-able (fixed loop). EOS-terminated / variable → very hard, likely infeasible even with a static cache.
- **Per-step CPU sync points** — `.item()` / `.cpu()` / Python branches on tensor values. Each one is a graph-break that erodes (or kills) the benefit.

If the nested loop is variable-length, **stop** — even a static-cache fork won't cleanly graph it.

**Only if BOTH probes are green:** commit to the fork (static cache + `torch.compile`, ~2–5 days, audio-bit-correctness risk). The fork itself ships behind an env kill-switch and a byte-identical-audio regression test (compiled vs un-compiled path), never as the unconditional default until that test is green on this box.

## Decision tree (recorded so it doesn't get lost)

```
Probe 1: profile batch-16 decode
  ├─ compute-bound (GPU-kernel dominant) ──► CLOSE. We're at the floor. Ship at batching RTF.
  └─ launch-bound (idle-gap large)
        └─ Probe 2: audit nested code_predictor.generate()
              ├─ variable-length / many sync points ──► STOP. Not cleanly graph-able.
              └─ fixed-length, few sync points
                    └─ FORK qwen_tts static cache + torch.compile (2–5 days, gated kill-switch + bit-identical test)
```

## Invariants to preserve (only if the fork ever lands)

- **Per-sentence audio must be byte-identical to the un-compiled path** — the batching-independence invariant from plans 112/113 (`server/tts-sidecar/main.py` `synthesize_batch`). A compiled/graphed path that changes a single PCM sample fails the gate.
- **The per-engine `_synth_lock` serialisation (plan 113) stays** — CUDA graph replay is also not concurrency-safe, so the fork does not relax the lock.
- **Scatter-back by `group.index`** (`synthesise-chapter.ts`) is untouched — this is a within-step decode change, not a batch-composition change.

## Test plan

### Automated coverage

This is a **spike**: the deliverable of Probes 1–2 is a measurement + a go/no-go note appended to `docs/tts-performance.md` (open lever 5), NOT code. No CI coverage for the probes themselves. **If the fork lands**, it MUST ship a pytest in `server/tts-sidecar/tests/` asserting byte-identical PCM (compiled vs un-compiled) for a fixed seed / voice / text, plus a case proving the kill-switch reverts to the un-compiled path. Note the sidecar pytest suite is venv-gated, so CI skips it (see the project-memory note) — the gate only fires on a dev box running full `verify`.

### Manual acceptance walkthrough

1. Run Probe 1 against a live sidecar mid-render; record the kernel / CPU / idle-gap split in `docs/tts-performance.md` and resolve the go/no-go.
2. If green, run Probe 2 against the installed `qwen_tts`; record fixed-vs-variable nested-loop finding.

## Out of scope

- **Length-bucketing** (plan 128 / `side-6`) — the realistic, output-preserving lever, **mechanism shipped 2026-05-29** (`QWEN_BATCH_BUCKET`, default ON); this spike is the fallback only after that win is measured and banked.
- `GEN_WORKERS` / `QWEN_BATCH_SIZE` tuning — separate, already-landed knobs.
- Any non-Qwen engine (Kokoro / Coqui / Gemini are untouched).

## Ship notes

(Filled when the spike runs or a go/no-go decision is reached.)
