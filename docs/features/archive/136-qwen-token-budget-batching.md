---
status: stable
shipped: 2026-05-30
owner: null
---

# Qwen token-budget batch packing

Variable-width Qwen batching: pack short/dialogue sentences wide and long
sentences narrow, bounded by a per-batch **token budget**, so the worst
(short-text) batches amortise the dispatch cost — pulling per-chapter RTF toward
~1 while structurally bounding peak VRAM on the 8 GB card.

## Why

Live monitoring of a dialogue-dense Qwen3-TTS run (2026-05-29) measured a
per-chapter **mean RTF ~2.4**, swinging 1.0–4.5 batch-to-batch. `nvidia-smi`
during decode showed the GPU **clock is fine** (2100 MHz, boosts to 2610 — not
the plan-133 parking) but **utilisation is only ~12–18%**: the card is
*dispatch-starved*, finishing each tiny autoregressive decode step in µs then
idling for the CPU to launch the next. This matches the documented finding in
[docs/tts-performance.md](../tts-performance.md) that forcing the clock to
3105 MHz did **not** improve RTF.

RTF tracked **audio-per-batch**: the biggest batches (text_len 2348/1727/1407)
hit RTF ~1.0, the tiny ones (text_len 88/175) hit ~4.0. The fixed per-batch
dispatch cost is only amortised when the batch carries lots of audio.

`docs/tts-performance.md` already measured the width curve: **B=8 → RTF 1.28,
B=16 → 0.80** ("bigger batch ~halves RTF"), within the 8 GB budget — but on
*uniform-length* bench sentences. Real prose has length variance, and a batched
forward decodes to its **longest** item, padding the rest (plan
[128](128-qwen-batch-length-bucketing.md) length-bucketing attacks this). The
fixed-width slicer (plan [113](113-qwen-true-batching.md)) caps only the
*count*; a batch of long sentences costs far more VRAM/compute than a batch of
short ones at the same width, so the safe width is set by the long batches —
leaving short/dialogue batches *narrower than VRAM allows*, exactly where RTF is
worst.

## What changed

`server/src/tts/synthesise-chapter.ts` — the partition that chunks the
length-sorted `batchable[]` list into work items. New module constant +
test option `QWEN_BATCH_TOKEN_BUDGET` (env, default `0` = OFF). The fixed-width
slice loop is replaced by a greedy packer:

- Keep the plan-128 ascending length sort (`lenOf` is now hoisted so the sort
  and the packer share the one `normaliseForTts(g.text).length` computation).
- `budget <= 0` → **exact** fixed-width `QWEN_BATCH_SIZE` slicing (byte-for-byte
  the pre-136 loop — the kill-switch and back-compat path).
- `budget > 0` → fill each batch while `(count+1) × candidateMaxLen <= budget`
  **and** `count+1 <= QWEN_BATCH_SIZE` (the hard width cap). Because the list is
  ascending-sorted, the candidate is normally the batch's new max; the packer
  tracks a running max so the `count × maxLen` proxy stays a true upper bound
  even with bucketing off.

`QWEN_BATCH_SIZE` is repurposed as the **hard width cap** when the budget is on.
Everything downstream — `isBatchable` collection, the `firstIndexOf` work-item
sort, the worker pool, and the index-order scatter-back/concat — is untouched.

### Calibration (live-tunable via env, no code)

Width ≈ `budget / maxLen`. Recommended on the 8 GB box: **budget 2400, hard cap
32.**

- Typical prose long-pole ~100 chars → `2400/100 = 24` (center).
- Dialogue ~40 chars → `2400/40 = 60` → clamped by the **cap 32**.
- Long sentence ~200 chars → `2400/200 = 12` (narrow, VRAM-safe).

## Invariants to preserve

- **Output-preserving.** Packing only changes which groups co-occur in a batch.
  Per-item voice prompts + index-order scatter-back keep the concatenated audio
  byte-identical regardless of composition. (Test: ON vs `budget=0` `pcm.equals`.)
- **VRAM guard.** Every emitted batch satisfies `width × maxLen <= budget` AND
  `width <= QWEN_BATCH_SIZE`. The first clause means the longest-items batch
  can never exceed the budget regardless of sentence length — the central OOM
  guard. The hard cap binds only on short batches. (Test: invariant on every
  `batchCall`.)
- **Deterministic.** Pure function of the length-sorted list (tie-broken by
  `group.index` in the existing sort); dispatch order re-imposed by the
  `firstIndexOf` work-item sort. (Test: same input twice → identical widths +
  per-batch texts.)
- **Kill-switch.** `QWEN_BATCH_TOKEN_BUDGET=0` (or unset) = exact fixed-width
  slicing. `QWEN_BATCH_SIZE=1` still fully disables batching regardless of the
  budget (the collection gate at the partition is unchanged).
- **Length proxy** must be `normaliseForTts(g.text).length` — the exact string
  the sort, `synthBatch`, and the sidecar all use — never `g.text.length`.
- **Anchor unchanged.** The lowest-index body group is still synthed up front as
  a single (sample-rate anchor) and excluded from `batchable[]`; never packed.

## Test plan

Automated — `server/src/tts/synthesise-chapter.test.ts`, new
`/* ── Token-budget packing (plan 136) ── */` section (runs in the main
`npm run test:server` battery; this file is not in `vitest.config.slow.ts`):

1. Output-preserving — token-budget ON byte-identical to `budget=0` (pcm,
   sampleRate, durationSec, segments).
2. Short batches at the cap, long batches narrower; `width × maxLen <= budget`
   and `width <= hardMax` on every batch.
3. `budget=0` falls back to exact fixed-width composition.
4. A single over-budget sentence is emitted as its own work item (lands in
   `singleCalls`, never co-batched); audio still byte-identical.
5. Determinism — same input twice → identical batch composition.

Manual acceptance — the live width A/B (below).

## Verification & live tuning

Both knobs are read once at module load, so a `server/.env` change needs a
**server restart** to apply (hand the kill to the user; process-kill is
classifier-gated). Gotcha: a shell-exported `QWEN_BATCH_SIZE` /
`QWEN_BATCH_TOKEN_BUDGET` wins over `server/.env`.

1. **Baseline**: `QWEN_BATCH_TOKEN_BUDGET=0 QWEN_BATCH_SIZE=16`, restart,
   generate the dialogue-dense chapter that read RTF ~2.4 (`force:true`),
   ffprobe the MP3 for ground-truth audio seconds, compute RTF.
2. **Token-budget**: `QWEN_BATCH_TOKEN_BUDGET=2400 QWEN_BATCH_SIZE=32`, restart,
   regenerate the **same** chapter.
3. Watch `logs/tts.err.log` `qwen batch synth: items=N … rtf=`: expect short
   batches near 32, prose ~24, long sentences single-digit; per-chapter rollup
   RTF trending from ~2.4 toward ~1.
4. VRAM: `nvidia-smi -l 1`; peak should stay ≤ the B=16-proven ~3.8 GB
   co-resident footprint. A real OOM surfaces as a sidecar `RuntimeError → 503`
   (`server/tts-sidecar/main.py`). Recovery: lower the budget first, then the
   hard cap — both live via env + restart, no code change.
5. Record the A/B row in [docs/tts-performance.md](../tts-performance.md); if
   the win holds and no OOM, flip this plan to `stable` and clear the backlog
   item.

## Out of scope

- Cross-chapter / book-level batch packing (eliminates the per-chapter anchor +
  tail batches) — bigger change touching the streaming contract; backlog.
- Reducing the dispatch floor itself (HAGS A/B, CUDA graphs) — orthogonal lever;
  token-budget packing only amortises the fixed cost better, it can't beat the
  per-step dispatch latency. See plan 133 (dispatch-latency).

## Known interaction (plan 137)

The practical batch-width cap is bounded not only by VRAM but by **per-batch gen
time vs the server→sidecar fetch timeout.** Live testing at cap 64 (gen
400–454 s) blew past undici's default 300 s `headersTimeout`, which aborted the
fetch → retry loop → "sidecar not running" (the chapter never finished). That's
a separate bug fixed in plan [137](137-sidecar-fetch-timeout.md) (no-timeout
dispatcher on the synth POST). Until 137, keep the cap low enough that batches
finish under ~250 s (cap 32 was safe). Note the A/B also showed wide caps are a
wash-to-worse on dialogue-dense chapters (padding waste), so width is not the
dialogue lever regardless — short-line coalescing is.

## Ship notes

**2026-05-30 — live A/B completed; shipped as the default.** The fixed-width vs token-budget A/B was run on the live 8 GB sidecar with no OOM, and the adopted production config is **cap 32 / budget 3600**. That config is now the **shipped code default** (`server/src/tts/synthesise-chapter.ts`): `QWEN_BATCH_SIZE` default `4 → 32`, `QWEN_BATCH_TOKEN_BUDGET` default `0 → 3600`. The unset-vs-explicit-`0` distinction is preserved by the new exported `resolveQwenTokenBudget` helper (unset/empty → 3600 ON; an explicit `0` → the fixed-width kill-switch), unit-pinned in `synthesise-chapter.test.ts`. `server/.env.example` documents the new defaults. Output remains byte-identical (per-item prompts + index scatter-back). Closes backlog `side-9`.

Wide caps were confirmed a wash-to-worse on dialogue-dense chapters (padding waste — a batch decodes to its longest item), so width is not the dialogue lever; the remaining lever there is short-line coalescing (backlog `side-10`). Smaller GPUs that OOM should lower `QWEN_BATCH_TOKEN_BUDGET` (then `QWEN_BATCH_SIZE`) via `server/.env` + restart.
