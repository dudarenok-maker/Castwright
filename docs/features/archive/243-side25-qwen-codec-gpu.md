---
status: stable
shipped: 2026-07-06
owner: null
---

# side-25 — Qwen Code2Wav codec GPU placement

> Status: stable
> Key files: `server/tts-sidecar/main.py` (`_resolve_codec_device`, `_move_codec_to_device`, `_apply_codec_chunk_size`, `_load_qwen_model`), `server/src/config/registry.ts`, `server/tts-sidecar/tests/test_qwen3.py`, `server/tts-sidecar/tests/test_codec_device_smoke.py`
> URL surface: indirect — Advanced Settings (`#/advanced`) surfaces the three new knobs generically via the existing registry-driven UI, no new route.
> OpenAPI ops: none (sidecar-internal + config registry only).

## Benefit / Rationale

- **User:** none directly yet — ships **inert by default** (`QWEN_CODEC_DEVICE=cpu`, unchanged behavior). The payoff (faster batch RTF, lower host-memory pressure) only lands once an operator opts a box in after the on-box acceptance run (see Out of scope).
- **Technical:** the Qwen Code2Wav codec decode — measured at ~40-50% of every batch's compute — can now run on GPU instead of CPU, closing the remaining facet of the side-11 host-leak investigation (#399) not explained by the oneDNN cache or pinned staging. Root cause: `Qwen3TTSTokenizer` is a plain Python object, not an `nn.Module`, so it was silently skipped by the existing `inner.to(device)` move.
- **Architectural:** establishes the pattern for moving a non-`nn.Module`-wrapped submodule alongside its parent model's device placement, and for making a library function's undocumented-but-real keyword defaults (`chunked_decode`'s `chunk_size`/`left_context_size`) operator-configurable via a `functools.partial` bound onto the instance, mirroring the existing `_maybe_compile_codec` forward-swap pattern.

## Architectural impact

- **New seams / extension points:** three new registry knobs (`tts.qwen.codecDevice` / `QWEN_CODEC_DEVICE`, `tts.qwen.codecChunkSize` / `QWEN_CODEC_CHUNK_SIZE`, `tts.qwen.codecLeftContextSize` / `QWEN_CODEC_LEFT_CONTEXT_SIZE`), all `apply: restart-sidecar`, `risk: high`, surfaced generically via the existing Advanced Settings UI (`GET /api/config`) — no new frontend wiring needed.
- **Invariants preserved:** the codec move is all-or-nothing per attempt — a failed `.to(device)` explicitly rolls the codec's `.model` back to CPU (a real `.to('cpu')` call, not just resetting the cached `.device` attribute) before resyncing; if the rollback itself fails, the exception propagates to `_load_qwen_model`'s existing outer reclaim-and-fail handler rather than being swallowed. No half-migrated model is ever returned to a caller. `QWEN_CODEC_DEVICE=auto` mirrors the Qwen instance's own already-resolved device rather than independently probing cuda→mps→cpu (deliberately different semantics from the pre-existing `QWEN_DEVICE=auto`), so the codec can never land on a different card than its own model.
- **Migration story:** none — no persisted state shape changed. All three knobs default to today's exact CPU-only behavior when unset.
- **Reversibility:** setting `QWEN_CODEC_DEVICE=cpu` (the default) reverts to pre-side-25 behavior exactly. No data migration to undo.

## Invariants to preserve

1. All three knobs default to `cpu` / `300` / `25` (today's behavior) — `server/src/config/registry.ts:524-541` and `server/tts-sidecar/main.py`'s `_resolve_codec_device`/`_read_int_env` defaults must stay in sync.
2. `_move_codec_to_device` (`main.py`) must remain all-or-nothing: any exception path either lands the codec cleanly on CPU (both `.model` and cached `.device`) or propagates to the caller — never a mixed-device state.
3. `_apply_codec_chunk_size` applies **unconditionally** (not gated on the codec's device) — this is intentional (harmless on CPU, per the final-review finding it was documentation, not code, that needed correcting), not a bug to "fix" by adding a device gate.
4. `QWEN_CODEC_DEVICE=auto` must resolve via the Qwen instance's own `self._device` (set by `_ensure_device_resolved()` before `_load_qwen_model` runs), never an independent device probe.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_qwen3.py`) — `_resolve_codec_device` parsing (cpu/auto/explicit pin), the happy-path move + device resync, the CPU-default no-op, the OOM-rollback-succeeds path, the OOM-rollback-also-fails-and-propagates path, the chunk-size `functools.partial` binding, and the chunk-size no-op-when-unset path. 10 new test functions total, added incrementally across 3 tasks, all passing against the fake `qwen_tts` harness.
- Pytest sidecar (`server/tts-sidecar/tests/test_codec_device_smoke.py`, new file) — real-model smoke check for the 0.6B-Base and VoiceDesign load paths (the two call-sites `test_instruct_golden.py`'s golden suite doesn't cover), gated to SKIP cleanly without real Qwen weights/CUDA. **Ran for real during implementation** (this dev box has real weights) and passed: `2 passed, 25 warnings in 49.88s` / `50.76s` (independently reproduced twice) — genuine hardware validation that the codec correctly moves to CUDA and decodes with matching output length/sample-rate vs. the CPU baseline, on both load paths.
- Vitest server (`server/src/config/registry.test.ts`) — asserts the three new knobs' exact `env`/`default`/`group`/`apply`/`risk` values.
- Existing 1.7B-Base golden suite (`server/tts-sidecar/tests/golden/test_instruct_golden.py`, `npm run test:golden-audio` Suite A) provides quality-tolerance coverage for the third load path (1.7B-Base 12Hz decode) — not modified by this feature, but the design intends it be re-run with `QWEN_CODEC_DEVICE=auto` as part of the on-box acceptance (see Out of scope).
- `npm run verify` (typecheck + all Vitest unit/server suites + Playwright e2e + both builds) passed clean on the full branch before merge.

### Manual acceptance walkthrough

N/A — this feature has no UI surface beyond the three Advanced Settings rows (which render generically through the pre-existing registry-driven panel; no bespoke UI code was added, so there's nothing feature-specific to click through). Confirm via Advanced Settings (`#/advanced` → TTS section) that `Qwen codec device` / `Qwen codec chunk size` / `Qwen codec left-context size` rows appear with defaults `cpu` / `300` / `25`.

## Out of scope

- **On-box full-book overnight acceptance run** (the design spec's Phase 3): flat committed-memory floor, zero VRAM-guard trips, zero host recycles, RTF delta recorded into `docs/tts-performance.md`, with `QWEN_CODEC_DEVICE=auto` on real production hardware over hours. This cannot happen inside an implementation session — it is a distinct, human-run operational follow-up, not a gate on this plan's stability. The knob ships safely inert (`cpu` default) in the meantime.
- **Default-flip policy**: no automatic VRAM-threshold heuristic — flipping `QWEN_CODEC_DEVICE=auto` on any given box is a manual, per-operator decision made after that box's own acceptance run, documented in `server/.env.example`'s comment once validated.
- **GPU-semaphore VRAM cost accounting** (`server/src/tts/engine-vram-cost.ts`'s `ENGINE_VRAM_COST.qwen`) is not adjusted when `QWEN_CODEC_DEVICE` moves the codec onto the GPU — an operator who opts in without also re-tuning `GPU_WEIGHT_QWEN` upward has no automatic protection against concurrent-op VRAM contention. Tracked as its own follow-up: [#1396](https://github.com/dudarenok-maker/Castwright/issues/1396).
- **bf16 codec decode, sub-batch grouping, batch-size cap**: explicitly deferred follow-ups per the design spec, only pursued if the fp32 + chunk-size levers prove insufficient on a real 8GB card.
- Full design rationale, root-cause analysis, and the two rounds of adversarial review that shaped this feature: `docs/superpowers/specs/2026-07-06-side25-qwen-codec-gpu-design.md`. Implementation plan: `docs/superpowers/plans/2026-07-06-side25-qwen-codec-gpu.md`.

## Ship notes

Shipped 2026-07-06. Branch `perf/sidecar-qwen-codec-gpu`, PR #1389. Implemented via 5 subagent-driven tasks + 1 final-review fix commit, each with an independent task-scoped review; the design spec went through 2 rounds of Opus-tier adversarial review (catching a broken OOM-rollback design and an unreachable chunk-size wiring approach before implementation) and the plan through 1 round (catching broken acceptance-run CLI examples). The final whole-branch review found one Important documentation-accuracy issue (chunk-size knobs' help text falsely claimed "no effect on CPU") — fixed in the same PR. No behavior delta vs. the design spec's final (post-review) intent.

**On-box acceptance run, 2026-07-06 — NEGATIVE result on this box's hardware/batch combination.** Flipped `QWEN_CODEC_DEVICE=auto` on the production 8 GB RTX 4070 Laptop box and drove it through both `bench-tts.py` and a real chapter generation at the box's actual production `QWEN_BATCH_SIZE=32`:

- **Baseline (`codec=cpu`, today's default):** clean, `bench-tts.py --batch 32` measured end-to-end RTF **0.63** (median), VRAM peak **5234 MB** — matches the ~0.6–0.9 range already on record for this box.
- **`codec=auto` + `QWEN_CODEC_CHUNK_SIZE=100`** (already reduced from the library default 300, per the design spec's chunk-size lever): dedicated VRAM peak rose to **7934 MB**, with an additional **~10.9 GB** spilling into Windows' shared-memory GPU fallback, and the CUDA context was **fully poisoned** (0/2 batch calls succeeded; every request 503'd with `"poisoned": true` until the sidecar auto-restarted). Reproduced consistently across a `bench-tts.py` A/B and a real chapter generation through the live app.
- Root-caused via a controlled A/B (isolating a suspected "double-spawn" process artifact first, ruled out as normal Windows venv-launcher-stub behavior, then isolating batch size) that this is a genuine VRAM capacity limit at this box's real production batch size — not a code defect. It matches the risk this plan's design spec's Out of scope section already anticipated (batch-size cap / bf16 codec / sub-batch grouping as deferred follow-ups "only pursued if the fp32 + chunk-size levers prove insufficient on a real 8GB card") — they proved insufficient here.
- **Action taken:** reverted this box's `server/.env` to the default (`QWEN_CODEC_DEVICE` unset → `cpu`), confirmed a clean restart back to the ~114 MB idle VRAM baseline. **Do not flip `QWEN_CODEC_DEVICE` on an 8 GB card at `QWEN_BATCH_SIZE=32`** without either a much smaller batch size or progress on the deferred batch-size-cap/bf16/sub-batch-grouping follow-ups (tracked alongside [#1396](https://github.com/dudarenok-maker/Castwright/issues/1396)). Documented in `docs/wiki/Troubleshooting.md` (new paragraph under "GPU out of memory (VRAM)") and as comments on [#1374](https://github.com/dudarenok-maker/Castwright/issues/1374) and [#1396](https://github.com/dudarenok-maker/Castwright/issues/1396).
- This does not change the feature's stability or default-off shipping status — the knob remains correctly implemented, tested, and safely inert by default; this box's specific hardware/batch-size combination just isn't a fit for opting in yet.
