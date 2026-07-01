---
status: deferred
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

### Phase 0 — measured 2026-07-01, GO

**M1 (decode-path verification).** Confirmed by reading the installed `qwen_tts` package directly (`qwen3_tts_model.py:620`, inside `Qwen3TTSModel.generate_voice_clone`): `wavs_all, fs = self.model.speech_tokenizer.decode([{"audio_codes": c} for c in codes_for_decode])`. `self` is the `Qwen3TTSModel` wrapper, so this is exactly `model.model.speech_tokenizer.decode` — the call site `_resolve_speech_tokenizer`/`_install_codec_timing` wrap. One `decode` call per batched forward (the whole batch's codes are decoded in a single call), so `calls == 1` per bench run is the expected, valid signal — not an M1 red flag.

**Measurement.** 8 GB box (RTX 4070 Laptop), `CUDA_VISIBLE_DEVICES` pinned so only that card was visible to the sidecar (the box also has a 16 GB 5070 Ti — Phase 0 and the VRAM gate (Task 6) must run on the 8 GB card specifically). `QWEN_CODEC_TIMING=1`, `QWEN_BATCH_SIZE=32`, `QWEN_BATCH_TOKEN_BUDGET=3600`, voice `rv1` (0.6B-Base designed voice), `bench-tts.py --engine qwen --voice rv1 --code2wav-share --batch 32`.

Run 1 (cold load — model load time inflates `gen_ms`, discarded per plan): 66.4% (decode 77133 ms / forward 116228 ms).

Three post-warmup runs (model already resident):

| Run | Share | decode ms | forward (gen_ms) |
|---|---|---|---|
| 2 | 63.3% | 67879 | 107187 |
| 3 | 74.6% | 74179 | 99424 |
| 4 | 67.3% | 77288 | 114810 |

**Median: 67.3%.**

**Decision: GO Phase 1.** 67.3% is well above the `>~25–30%` build threshold — Code2Wav decode is the *majority* of batched 0.6B forward-compute time on this box, not a minor tail. Proceeding to Task 4 (locate the decoder submodule + device + confirm live-lookup) and Task 5 (the compile + per-batch swap).

**Scope extended to the 1.7B-Base tier too (2026-07-01, user decision):** given the size of the Phase 0 win, Phase 1 now targets both `_ensure_base_loaded` (0.6B) and `_ensure_base17_loaded` (1.7B), not 0.6B alone. Task 4 (below) confirms the codec is structurally identical across both tiers, so one mechanism covers both — each tier still gets its OWN compiled decoder clone (separate `Qwen3TTSModel` instances, separate `speech_tokenizer` objects; nothing is shared cross-tier). `reconcileResidentQwenTiers` (`server/src/tts/ensure-sidecar-loaded.ts:172`) allows a genuinely mixed-tier book to keep BOTH bases resident simultaneously, so Task 6's VRAM gate must be re-run with both tiers loaded, not just one. The 1.7B live-instruct path (`_icl_instruct_synth_batch`, fs-57) and its manual decode call are a separate batch branch from the `generate_voice_clone` wrapper path — Task 5 must wire the swap into both.

### Task 4 — decoder submodule, device, live-lookup (2026-07-01)

Read-only inspection on the 8 GB box (both `Qwen/Qwen3-TTS-12Hz-0.6B-Base` and `Qwen/Qwen3-TTS-12Hz-1.7B-Base`, loaded exactly as `_load_qwen_model` does, inner module moved to `cuda`).

**Correction to the plan's assumed submodule path.** The plan assumed the compile target was one level below `_resolve_speech_tokenizer(model)` (a `speech_tokenizer.decoder` attribute). It is actually **two** levels below:

- `_resolve_speech_tokenizer(model)` returns a `Qwen3TTSTokenizer` instance (`st`) — this is a plain Python wrapper class (`st.model = None` in `__init__`), **not an `nn.Module`** (no `named_children`).
- `st.model` is the real `nn.Module` — `AutoModel.from_pretrained(...)` resolves it to `Qwen3TTSTokenizerV2Model` for the 12Hz tokenizer both tiers use (confirmed identical class + identical decoder class on both 0.6B-Base and 1.7B-Base — the codec is tier-independent; only the talker/LM differs in size).
- `st.model.decoder` (`Qwen3TTSTokenizerV2Decoder`) is the actual feed-forward codec decoder submodule. Its hot method is `chunked_decode(codes, chunk_size=300, left_context_size=25)` — a plain Python `while` loop (no KV-cache, no autoregressive generate loop, confirming the spec's "self-contained feed-forward" framing) that repeatedly calls `self(codes_chunk)` (i.e. `Decoder.__call__` → `Decoder.forward`) per 300-code chunk.

**M2 — device: CPU, confirmed on both tiers.** `next(decoder.parameters()).device` is `cpu` for both 0.6B-Base and 1.7B-Base, even though the wrapper's `.model.to("cuda")` call (in `_load_qwen_model`) moves the talker/LM. The codec decoder never leaves the CPU. This matches `main.py:166`'s note and explains why the measured share is so large: the codec runs on the CPU while the LM's autoregressive decode uses the GPU, so Code2Wav is genuinely competing with (not overlapping) the GPU-bound stage. **Backend/mode per M2: CPU decode → inductor's cpp backend, `torch.compile(fn, dynamic=True)`, no CUDA-graph modes.** A C++ toolchain is present on this box (`Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207`, same one `start.ps1` already sources for DeepSpeed), so inductor's cpp codegen has a compiler to shell out to.

**R2-B — live lookup, confirmed, but the swap target changes.** Two nested live lookups matter: `Qwen3TTSTokenizer.decode` does `self.model.decode(...)` (live), and `Qwen3TTSTokenizerV2Model.decode` does `self.decoder.chunked_decode(...)` (live) — so replacing `codec_model.decoder` before a batch and restoring after **would** take effect, confirming R2-B in the sense the plan intended. **However, swapping the whole `decoder` object is the wrong mechanism**, because `chunked_decode`'s internal `self(codes_chunk)` calls are resolved through *attribute lookup on whatever object `chunked_decode` was called on* — if `decoder` were swapped for a `torch.compile(decoder)`-wrapped `OptimizedModule`, calling `.chunked_decode(...)` on it delegates (via `OptimizedModule.__getattr__`) to the **original, uncompiled** module's bound method, whose internal `self(codes_chunk)` then binds `self` to the *original* module, not the compiled wrapper — silently defeating the compile with no error (exactly the invisible-failure shape R2-B warned about, just one level deeper than the plan anticipated).

**Corrected mechanism for Task 5:** compile the decoder's `forward`, not the module object, and swap the **instance attribute** `decoder.forward` (which `nn.Module.__call__`/`_call_impl` re-reads on every call, so an instance attribute transparently shadows the class method): `decoder.forward = torch.compile(decoder.forward, dynamic=True)` for the batch's duration, restored in `finally`. Because `chunked_decode`'s `self(codes_chunk)` still resolves `self.forward` via normal Python attribute lookup on the *same* `decoder` instance (never swapped, only its `forward` attribute is), the compiled path is reached correctly through the chunking loop with no `OptimizedModule` indirection. `_CODEC_DECODER_ATTR`-style helpers must resolve `st.model.decoder`, not `st.decoder`.

### Task 5 — implementation (2026-07-01)

Implemented exactly the corrected mechanism above, for **both** tiers (0.6B and 1.7B — scope extended past the plan's original 0.6B-only boundary once Phase 0's 67.3% share made the case for BOTH). `_resolve_codec_decoder`, `_should_compile_codec`, `_maybe_compile_codec`, `_codec_compiled_for_batch` added to `main.py`; install-at-load calls added to both `_ensure_base_loaded` and `_ensure_base17_loaded`; the per-batch swap wired into the 0.6B `generate_voice_clone` call and the ENTIRE 1.7B `if live_instruct: … else: …` block. 8 GPU-free unit tests pin the corrected three-hop resolver and the forward-attribute-only swap (never the module object). Task-review: spec ✅, quality Approved, independently re-verified against the `OptimizedModule.__getattr__` delegation trap (no silent-no-op regression). Commits: `2cd0a655` (Task 4 findings), `23c44b8c` (Task 5 implementation).

### Task 6 — acceptance gates (2026-07-01): Gate 1 FAILS, closing won't-ship

**Environment for the on-box run:** `QWEN_COMPILE_CODEC` is hard-OFF on Windows (`sys.platform == "win32"`) by design — this whole spike's only box IS Windows, so exercising the compiled path at all required a **testing-only** bypass (never shipped): monkeypatching `main._should_compile_codec` to ignore the platform guard for this run only (a scratch launcher script outside the repo, never a tracked-file edit). The shipped `main.py` keeps the Windows guard exactly as implemented regardless of what this section found.

**Setup snags fixed along the way** (worth recording — none of them are the actual finding, they're just what it took to get a clean measurement):
- Faking `sys.platform` globally (instead of monkeypatching just `_should_compile_codec`) breaks `numpy` at import (`os.uname()` doesn't exist on Windows) and breaks `torch`'s own CUDA-library probing at runtime (it also reads `sys.platform`) — a global platform fake is too blunt; the final approach monkeypatches only the one function.
- Launching `uvicorn` directly (bypassing `start.ps1`) skips the `vcvars64.bat` sourcing `start.ps1` does for DeepSpeed — inductor's cpp backend needs the same MSVC (`cl.exe`) on `PATH`; without it, compilation fails with `Compiler: cl is not found` at the FIRST real (lazy) invocation, not at `torch.compile()`'s wrap call, so `_maybe_compile_codec`'s try/except never sees it — it surfaces as a raw 500 on the first `/synthesize-batch`. Sourcing `vcvars64.bat` (same block `start.ps1` uses) before launching fixes this.
- An unrelated default-computation quirk transiently set the host committed-memory restart ceiling far below its expected ~45 GB default on this box during testing; overriding `SIDECAR_RESTART_MB`/`SIDECAR_VRAM_RESTART_MB` explicitly sidesteps it (not investigated further — orthogonal to this spike, and the plan's constraints don't touch the memory watchdog).

**M1 re-confirmed on-box:** `calls == 1` per batch (the whole batch's codes decode in one `speech_tokenizer.decode` call) is the *expected* signal, not an M1 red flag — matches the Phase-0 finding.

**Gate 1 (felt speedup) — FAIL, with direct evidence:**
- Flag-OFF (eager): a batch-32 `--code2wav-share` call reliably completes in ~85–135 s (matches Phase 0's numbers).
- Flag-ON (compiled): the SAME batch-32 call did not complete within **26+ minutes**. A follow-up batch-2 call (a much smaller, controlled case, on a fresh process) did not complete within **3 minutes** either.
- This is not an environmental artifact (the session had several of those — GPU contention, a stray low memory-ceiling, the platform-fake breaking torch, missing `cl.exe` on `PATH` — all diagnosed and fixed first, independently of this result):
  - The worker process is genuinely CPU-bound the entire time (`tasklist` CPU-time climbs 1:1 with wall-clock — not hung/deadlocked, not idle).
  - `TORCH_LOGS=recompiles` on the batch-2 diagnostic run emitted **zero** recompile messages — ruling out the plan's own pre-flagged "recompile thrash on variable shapes" risk as the mechanism.
  - The on-disk inductor cache (`%TEMP%\torchinductor_<user>`) did not grow a single new compiled artifact during either run (still exactly the 3 `.pyd` files from the initial successful compile) — ruling out "repeatedly recompiling from scratch" as the mechanism.
  - So the SAME cached compiled kernel is being reused correctly (Task 4/5's forward-swap mechanism works exactly as designed — this is NOT the R2-B silent-no-op failure mode), yet invoking it is dramatically slower than eager. The precise torch-internals root cause (candidate-kernel autotuning cost, per-call dynamic-shape guard/rebind overhead across `chunked_decode`'s many small per-chunk calls, or something else) was not isolated further — establishing WHY was judged not worth the additional on-box time once the WHAT (severe, reproducible regression) was solid.
- **Gates 2–4 were not completed** — Gate 1 failing outright makes them moot; there is no speedup to validate VRAM-neutrality, output-preservation, or interactive-latency-safety FOR.

**Decision: close `side-19` Phase 1 as won't-ship (deferred).** The plan's own Risks section flagged "recompile thrash on variable shapes" and "speedup smaller than expected" as the two things that could kill this lever — what actually happened is a third, worse outcome neither anticipated: the compiled path is a severe regression on this box's CPU-decode + Windows/MSVC-cpp-inductor profile, for reasons not fully root-caused. Phase 0's instrumentation (Tasks 1–2, `QWEN_CODEC_TIMING` + `bench-tts.py --code2wav-share`) and Phase 1's implementation (Tasks 4–5, `QWEN_COMPILE_CODEC`) both ship as-is — they're default-OFF (Phase 1 additionally hard-OFF on Windows), fully tested, reviewed, and harmless dead code until someone deliberately flips the flag. Nothing here blocks or risks production. **Revisit only if:** (a) a non-Windows box becomes available to test the Triton/cpp-Linux-inductor path (untested here — Windows-only box), or (b) someone wants to root-cause the actual slowdown mechanism first (profile the compiled call directly, try `mode="reduce-overhead"`, or try `dynamic=False` with shape-bucketing instead of `dynamic=True`) — none of that work is done, so a future attempt starts from this Ship notes section, not from scratch.
