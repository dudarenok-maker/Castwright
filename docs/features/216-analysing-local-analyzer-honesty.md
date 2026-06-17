---
status: active
area: G. Generation (analysis)
issues: []
shipped: null
---

# 216 — Analysing view honesty + robustness for local analyzers

Five coupled fixes from a 2026-06-14 local-Qwen analysis session. The common
thread: when the analyzer is local Ollama (`qwen3.5:4b`) — especially with a
per-phase model split configured and a per-run override picked on the
analysis-failed card — the analysing view either **lied about which model was
running**, **showed a wildly wrong ETA**, or **hard-failed a chapter** that
should have recovered.

All are bug fixes with paired automated tests. Live-GPU on-box acceptance is
owed (the device probe, the live ETA refinement, and the truncation recovery
all want a real Ollama + a long chapter to confirm end to end).

## The five fixes

1. **Wrong model label (display only).** With a per-phase split active and a
   per-run override picked, the server collapses both phases onto the override
   (precedence priority 2) and runs it — proven by the log `via Ollama
   (qwen3.5:4b)` — but `PhaseModelChip` + `PhaseModelSwap` kept showing the
   saved phase model (e.g. "Gemini 3.1 Flash Lite"). Now both mirror
   `requestModel`: when `ui.selectedModelExplicit`, show `ui.selectedModel` for
   both phases; the swap renders the override **disabled** with a tooltip.
   *Files:* `src/components/analysing/phase-model-chip.tsx`,
   `phase-model-swap.tsx`.

2. **ETA pinned at 10 min.** The whole-book stage estimate ran through
   `clampEst` (capped at `MAX_EST_MS` = 10 min) and was then divided per
   chapter → "~1:43" for a 110k-char chapter that really takes ~10 min. The cap
   is a per-chapter bar concern, not an aggregate one. `clampStageEstMs` is
   floor-only (no ceiling); `MAX_EST_MS` removed.
   *File:* `server/src/routes/analysis.ts`.

3. **Device-aware + live-refined ETA.** The flat `5 ms/char` local fallback was
   wrong for both CUDA (~150 chars/s) and CPU (~15 chars/s) and never refined
   until a whole chapter completed. Now: `detectOllamaDevice()` reads `/api/ps`
   `size_vram` (best-effort, defaults to the GPU rate) to seed the first-chapter
   rate via `engineFallbackMsPerChar`; and `projectChapterEstMsFromOutput`
   projects a chapter's total time from live output throughput (against a
   self-calibrating output:input ratio) so the "X of ~Y" ticker tightens within
   seconds — no waiting for chapter one.
   *Files:* `server/src/routes/analysis.ts`, `routes/ollama-health.ts`.

4. **Re-estimate on engine change.** Cached per-chapter durations
   (`castDurations` / `stage2Durations`) seeded the observed-rate tracker on
   every resume with no record of which engine produced them, so a Gemini→Qwen
   switch mis-seeded the ETA ~10×. Durations are now tagged with their engine
   (`castDurationsEngine` / `stage2DurationsEngine`); `durationsForEngine` only
   seeds on a match and otherwise re-derives from scratch. Legacy untagged
   caches read as a mismatch (safe).
   *Files:* `server/src/store/analysis-cache.ts`, `routes/analysis.ts`.

5. **Stage-2 truncation hard-fail.** A chapter whose over-cap span was a single
   paragraph failed the whole run (`splitBodyIntoChunks` never cuts inside a
   paragraph; the adaptive re-split had nothing to divide). `qwen3.5:4b`'s
   effective output window is smaller than the requested `num_ctx`, so a 9000-
   char chunk overflowed. Now `splitParagraphIntoSentences` is a last-resort
   sentence-boundary splitter (preceding context carried across the seam), and
   `stage2ChunkBudgetForEngine` sizes the per-chunk budget from `num_ctx` for
   local engines (MIN with the configured value — only ever tightens).
   *Files:* `server/src/analyzer/stage2-chunk.ts`, `routes/analysis.ts`.

6. **Per-chapter sentence progress.** During Stage-1 attribution, long chapters
   now show a live `Attributed ~N of ~M sentences` headline + fraction bar
   instead of only an elapsed-time row. The numerator is section-accumulated
   (exact `sentences.length` per completed section via a new `onSectionDone`
   chunker callback, plus a `"characterId":` marker count for the in-flight
   section); the denominator self-calibrates from observed sentences-per-char
   once a section completes; a server-side one-way `inSentenceMode` flag
   (`SENTENCE_MODE_MIN_MARKERS`) gates the display; the chars/s speed pulse is
   retained. *Files:* `server/src/analyzer/sentence-progress.ts`,
   `server/src/analyzer/stage2-chunk.ts`, `server/src/routes/analysis.ts`,
   `src/components/analysing/phase-card.tsx`, `src/lib/api.ts`.

## Invariants (regression guards)

- A per-run override (`selectedModelExplicit`) collapses the split in the UI —
  the chip/swap must never show a different model than the run uses.
- The whole-stage ETA has a floor but **no 10-min ceiling**.
- ETA rate seeds only from same-engine cached durations.
- A single oversized paragraph with sentence boundaries recovers via sentence
  split; one with no sentence boundary still surfaces the truncation loudly.
- The chunk budget for a local engine never exceeds the configured budget.

## Automated coverage

- Frontend: `phase-model-chip.test.tsx`, `phase-model-swap.test.tsx` (override
  cases).
- Server: `analysis.test.ts` (`clampStageEstMs`, `durationsForEngine`,
  `engineFallbackMsPerChar` / `localFallbackMsPerChar`,
  `projectChapterEstMsFromOutput`), `stage2-chunk.test.ts`
  (`splitParagraphIntoSentences`, `stage2ChunkBudgetForEngine`, sentence-split
  recovery), `ollama-health.test.ts` (`detectOllamaDevice`).

## Manual acceptance (live GPU, owed)

1. Configure a per-phase split (both phases Gemini). Start analysis on a
   copyrighted ch.1 so Gemini recitation-blocks. On the failed card pick
   **Qwen3.5 4B (local)** → Try again. **Chip + swap + ticker all read
   "Qwen3.5 4B"**, and the log says `via Ollama (qwen3.5:4b)`.
2. On a ~110k-char chapter, the per-chapter ticker shows a realistic estimate
   (minutes, not ~1:43) and **tightens within ~10s** of streaming, not at
   chapter end.
3. Switch a partially-cached book Gemini→Qwen and resume: the ETA re-derives
   (no instant optimistic number).
4. A dense / single-paragraph chapter that previously failed with "truncated
   the response (length)" now completes (logged as attributed in N sections).
5. CPU box (`ASR`/Ollama on CPU): first-chapter ETA seeds slow (~15 chars/s),
   not GPU-fast.

## Ship notes

_Pending: shipped date + merge SHA on merge._ Branch
`fix/analysing-local-analyzer-honesty`.
