---
status: stable
shipped: null
owner: null
---

# 187 — Large-chapter stage-2 truncation fix + attribution-coverage audit

> Status: active
> Key files: `server/src/analyzer/errors.ts`, `server/src/analyzer/gemini.ts`, `server/src/analyzer/ollama.ts`, `server/src/analyzer/stage2-chunk.ts`, `server/src/analyzer/roster-coverage.ts`, `server/src/routes/analysis.ts`, `scripts/audit-missing-speakers.mts`, `scripts/repair-missing-speakers.mts`
> URL surface: none (analysis pipeline + CLI audit)
> OpenAPI ops: none
> Issues: closes #528 (large-chapter stage-2 failure), closes #529 (attribution-coverage audit)

## Context

Two related bugs from the plan-182 missing-speaker repair.

**#528 — stage-2 fails on large chapters.** Re-analysing *The Drowning Bell* ch19
("Chapter Sixteen", 507 sentences) via the subset route died at stage-2 start
every time: the client saw `ECONNRESET`, `manuscript-edits.json` was never
written, and the server process stayed up. Deterministic and size-correlated.

Root cause (confirmed by reading the engines): stage-2 emits one JSON entry per
sentence, so its **output scales with the chapter**. A 507-sentence chapter needs
~15–20K output tokens — past the model's output cap — so the response is
**silently truncated mid-JSON**, fails to parse, retries at the same size, fails
again, and the call throws. Neither engine detected it: Gemini set no
`maxOutputTokens` and never read `finishReason`; Ollama set `num_ctx: 16384`
(shared by input+output), no `num_predict`, and never read `done_reason: 'length'`.
The **subset** (`/analysis/chapters`) route compounded it — its stage-2 call had
no coverage guard and no per-chapter `manuscript-edits.json` write (unlike the
main route), so the throw discarded the whole job.

**#529 — the missing-speaker audit only checks name presence.** After an
interrupted re-analysis a chapter can sit in a half-state: stage-1 added the
speaker to `cast.json` (name in roster) but stage-2 never attributed their lines,
so their dialogue is still on `narrator` (0 attributed lines). `validateRosterCoverage`
+ `scripts/audit-missing-speakers.mts` only check "is the name in the roster?",
so the audit reported "clean" and the plan-182 repair needed a `--force`
workaround. On ch19: Lessom was in cast.json with 0 lines, narrator had 221.

## What shipped

### #528 — fixed once across the pipeline + both engines

1. **Dual-engine truncation detection** (`analyzer/errors.ts`,
   `gemini.ts`, `ollama.ts`). New shared `AnalyzerTruncatedError`. Gemini reads
   the stream `finishReason`; a non-`STOP` stop (`MAX_TOKENS`/`SAFETY`/…) throws
   it instead of returning the corrupt buffer, and an explicit `maxOutputTokens`
   makes the cap visible (`ANALYZER_MAX_OUTPUT_TOKENS`, default 8192). Ollama
   reads `done_reason: 'length'` off the final NDJSON line and throws the same
   error (plus an optional `ANALYZER_NUM_PREDICT` cap). Both treat it as
   **non-retryable in place** (replaying the same prompt just truncates again);
   it propagates to the chunker. No truncation is ever silent again.

2. **Adaptive stage-2 chunking** (`analyzer/stage2-chunk.ts`).
   `splitBodyIntoChunks` splits an over-budget chapter at **paragraph
   boundaries** (never mid-paragraph, lossless concat) under
   `STAGE2_CHUNK_CHAR_BUDGET` (default 9000). `runStage2ChapterChunked`
   attributes each section under the cap (each wrapped in the existing
   `runStage2WithCoverageGuard`, with a "preceding context, do NOT emit" preamble
   so a quote keeps its speaker across the seam), concatenates, and **renumbers
   ids 1..N** so the result is the exact shape a single call produces. If a
   section *still* truncates (`AnalyzerTruncatedError`), it is **adaptively
   re-split** — self-tuning to the real cap, engine-agnostic. A chapter within
   budget runs exactly one guarded call (byte-identical to before) — and if that
   single call *itself* truncates (see the post-ship addendum), it falls back to
   the same adaptive split.

3. **One shared resilient runner across both routes** (`routes/analysis.ts`).
   `attributeChapterStage2` (built on `buildStage2ChunkInbox` +
   `runStage2ChapterChunked`) replaces the main route's inline coverage-guard
   wiring AND the subset route's bare `runStage2Chapter` call — collapsing the
   divergence that made #528 bite only the subset path. The subset loop now also
   rolls a partial `manuscript-edits.json` after each chapter, so a later
   chapter's failure no longer discards the ones that already succeeded.
   `describeError` classifies `AnalyzerTruncatedError` as `truncated`.

Stage-1 (sites 1 & 3) is **not** chunked — its output is a bounded roster, so
output truncation is rare; the engine-level detection makes any stage-1
truncation loud, and `num_ctx`/`num_predict` give headroom. Input-chunking with
a cross-chunk roster merge is a deliberate follow-up (see below).

### #529 — attribution-coverage detection (option #2)

`analyzer/roster-coverage.ts` gains `validateAttributionCoverage(body, roster,
chapterSentences)`: it resolves each prose `<Name> <verb>` tag to a **rostered
character id** (a name-token→id index) and flags any rostered, prose-tagged
speaker with **0 attributed lines** in that chapter — the half-state. `narrator`
and `unknown-*` buckets never flag (minor speakers fold into the buckets as
aliases, whose ids carry lines). Same false-positive bounding as
`validateRosterCoverage` (stopwords, possessive strip, single-hit quote
adjacency).

`scripts/audit-missing-speakers.mts` now reads `manuscript-edits.json` and runs
**both** checks per chapter — a book is "clean" only when both pass; the
half-state prints distinctly and lands in the re-run list.
`scripts/repair-missing-speakers.mts` `auditBook` surfaces the half-state too, so
the plan-182 repair detects + fixes it **without `--force`** (kept only as a
manual escape hatch).

## Tests

- `analyzer/gemini.test.ts` — `finishReason: 'MAX_TOKENS'` throws (non-retryable);
  explicit `maxOutputTokens` set; `STOP` returns normally.
- `analyzer/ollama.test.ts` — `done_reason: 'length'` throws (non-retryable);
  `'stop'` returns normally.
- `analyzer/stage2-chunk.test.ts` — splitter (paragraph-bounded, lossless,
  budget); single-call vs chunked; contiguous 1..N renumber; preceding context;
  adaptive re-split on truncation; per-chunk coverage retry; un-splittable
  truncation propagates.
- `analyzer/roster-coverage.test.ts` — half-state flagged; speaker-with-lines not
  flagged; narrator/`unknown-*` bucket never flagged; single-hit quote-adjacency
  bound holds.
- Existing analysis-route tests (`routes/analysis*.test.ts`) stay green through
  the shared-runner rewire.

## Env knobs (all optional, in `server/.env.example`)

- `ANALYZER_MAX_OUTPUT_TOKENS` (default 8192) — Gemini `maxOutputTokens`.
- `ANALYZER_NUM_PREDICT` (default -1) — Ollama `num_predict`.
- `STAGE2_CHUNK_CHAR_BUDGET` (default 9000) — chars per attribution section.

## Follow-ups (filed, not built)

- #529 option #1 — make the per-chapter stage-1 cast write + stage-2 attribution
  transactional so the half-state can't form (touches route write-sequencing).
- Stage-1 input chunking with a cross-chunk roster merge for pathologically large
  chapters on Ollama's 16K window.
- Cross-chunk overlap beyond the small preceding-context preamble — only if seam
  mis-attribution shows up in live runs.

## Post-ship addendum (2026-06-07) — single-call truncation fallback

The original `runStage2ChapterChunked` only gave the **multi-chunk** path the
adaptive re-split safety net. The **single-call** path (a body *under*
`STAGE2_CHUNK_CHAR_BUDGET`) re-threw `AnalyzerTruncatedError` straight to the UI,
on the assumption that a sub-budget chapter "can't" truncate. That assumption is
false: the char budget is only a proxy for the model's **output-token** cap, and
stage-2 output scales with **sentence count**, not chars — so a dense,
dialogue-heavy chapter can sit under the char budget yet overflow the 8192-token
output cap. Live hit: a 8,348-char chapter on `gemini-3.1-flash-lite` failed the
whole run with "Analysis failed — … Lower STAGE2_CHUNK_CHAR_BUDGET and retry."

Fix: when the single guarded call truncates, force-split the body in half (at
paragraph boundaries) and run it through the same `attributeSpan` adaptive path
the multi-chunk route already uses. A body that's a single un-splittable
paragraph still surfaces the truncation loudly (nothing to split). New tests in
`stage2-chunk.test.ts`: "re-splits an UNDER-budget body that still truncates on
the single call" and "propagates an under-budget truncation that is a single
un-splittable paragraph".

## Ship notes

Shipped 2026-06-06 (merge 56d0418, PR #532, closes #528 + #529). Live acceptance
confirmed: The Drowning Bell ch19 re-analysed via the subset route — stage-2 completed
(chunked), edits landed in `manuscript-edits.json`, and ch19's tagged speakers
carry lines; `npm run audit:missing-speakers -- --book The Drowning Bell` is clean (no
half-state).
