---
status: stable
shipped: 2026-05-30
owner: null
---

# Qwen batch length-bucketing

> Status: stable (mechanism + automated coverage + bench harness shipped 2026-05-29; live A/B completed 2026-05-30 — the ascending length sort is now the foundation of the shipped-default token-budget packer, plan 136)
> Key files: `server/src/tts/synthesise-chapter.ts` (the work-item partition), `server/tts-sidecar/scripts/bench-tts.py` (measurement)
> URL surface: none (internal synthesis-pipeline change)
> OpenAPI ops: none

## Benefit / Rationale

A Qwen `/synthesize-batch` call runs ONE batched `generate_voice_clone` forward; the forward decodes for as many steps as the **longest** sequence in the batch, and every shorter item is padded to that length. So a batch's compute is `max_length × per_step`, while the audio it produces is `Σ length_i`. A batch that mixes a 250-char sentence with fifteen 30-char ones decodes 250-char-worth of steps but only yields ~1 long + 15 short sentences of audio → most of the decode is wasted padding.

The 2026-05-29 measurements (`docs/tts-performance.md`) show real-prose batch-16 RTF ~1.3–2.0 (single-worker) vs the 0.80 the bench hit with uniform-length sentences. Much of that gap is this padding waste. Length-bucketing — grouping similar-length sentences into the same batch — makes each batch decode to a tight `max_length ≈ avg_length`, so all N items contribute near-full audio for the steps spent.

- **User:** real-chapter Qwen generation gets faster (target ~10–30% off per-chapter RTF; depends on the chapter's sentence-length variance — high-variance chapters benefit most). No audio change.
- **Technical:** maximises audio-produced-per-decode-step. Works **even though synthesis is dispatch-bound** — the per-step launch cost is fixed, so the win is in producing more audio per (fixed-cost) step, not in cutting compute.
- **Architectural:** a pure batch-*composition* change behind the existing `synthesizeBatch` seam; no new interfaces, no wire-format change, no sidecar change.

## Architectural impact

- **Where:** `synthesiseChapter` (`synthesise-chapter.ts`) already collects all batchable Qwen groups into `batchable[]`, then slices them into `batchSize`-capped work items, ordered by first-group index. The change: **sort `batchable` by a length proxy (e.g. `normaliseForTts(group.text).length`, tie-break by `group.index` for determinism) before slicing.** Similar-length groups then land in the same batch.
- **Invariants preserved (the safety property):** each sentence is an **independent sequence with its own voice-clone prompt** — no shared decode context across batch items (plan 112/113). So *which batch a sentence is in does not change its audio* — output is byte-identical regardless of batch composition. And the existing **scatter-back by `group.index`** means the final concat order is unaffected by how groups are grouped/sorted into batches. These two together make bucketing provably output-preserving.
- **Determinism:** sort must be stable / fully-ordered (length then index) so a given chapter always batches identically.
- **Reversibility:** a one-line env/const kill-switch (e.g. `QWEN_BATCH_BUCKET=0`) reverts to index-order batching, or just delete the sort.
- **No interaction with the `batchSize` cap, the anchor single-call, the title beat, or non-Qwen groups** — those paths are untouched; only the *order* of the already-collected `batchable` list changes.

## Invariants to preserve

- Per-sentence audio is independent of batch composition (`synthesize_batch` passes a per-item prompt list; no cross-item context) — `server/tts-sidecar/main.py` `synthesize_batch`.
- Final PCM concat is by `group.index`, not batch/completion order — `synthesise-chapter.ts` index-order pass.
- The up-front anchor group stays a SINGLE call (sample-rate anchor), and only `route.engine === 'qwen'` groups with a `synthesizeBatch` provider are bucketed.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/synthesise-chapter.test.ts`) — **byte-identical output** with bucketing ON vs OFF for a mixed-length, mixed-voice chapter (the headline guarantee); bucketed batches group similar lengths (assert the per-batch length spread shrinks); scatter-back order + segment timing unchanged; kill-switch restores index-order batching.
- Measurement (not CI): `bench-tts.py` — add a high-variance sentence set (or a `--bucket` toggle) and compare batch-16 RTF bucketed vs unbucketed on real prose; record a row in `docs/tts-performance.md`. Expect the gain to track the chapter's length variance.

### Manual acceptance walkthrough

1. Generate one real Qwen chapter with bucketing OFF, ffprobe RTF.
2. Same chapter, bucketing ON → expect **lower RTF, identical audio** (spot-check a few sentences sound the same).

## Out of scope

- The dispatch-bound ceiling itself (static-cache / CUDA-graphs fork — open lever 5).
- Cross-voice batching (already implemented).
- Changing `QWEN_BATCH_SIZE` or worker count (separate knobs).

## Ship notes

**2026-05-29 — mechanism + tests + bench shipped** (`feat/server-plan-128`).

- `synthesise-chapter.ts`: `QWEN_BATCH_BUCKET` module const (env, default ON) + a per-call `qwenBatchBucket` opt; the batchable Qwen groups are sorted by `normaliseForTts(group.text).length` (tie-break `group.index`, lengths memoised) **before** the `batchSize` slice loop. The downstream work-item sort, scatter-back, and index-order concat are untouched — output is byte-identical to index-order batching.
- Kill-switch: `QWEN_BATCH_BUCKET=0` (or `false`) reverts; documented in `server/.env.example`.
- Vitest (`synthesise-chapter.test.ts`): byte-identity ON vs OFF, per-batch length-spread shrinks when bucketed, and the kill-switch reproduces index-order composition. The pre-existing size-8-vs-1 test was pinned to `qwenBatchBucket: false` (its voiceName-order assertion is index-order specific).
- `bench-tts.py`: `HIGH_VARIANCE_SENTENCES` pool + `--bucket {0,1}` (sort-by-length vs interleave); prints the per-batch char-length spread.

**2026-05-30 — live A/B completed; flipped to `stable`.** The length sort was validated on the live 8 GB sidecar as the foundation of the token-budget packer (plan 136). The adopted production config is the **32/3600** setting (hard cap `QWEN_BATCH_SIZE=32`, `QWEN_BATCH_TOKEN_BUDGET=3600`), now the shipped code default (plan 136). Bucketing stays ON by default (`QWEN_BATCH_BUCKET=1`); it is a precondition of the token-budget greedy fill. Closes backlog `side-6`. The dispatch-bound floor remains (see plan 133); the residual dialogue-padding lever is short-line coalescing (`side-10`).
