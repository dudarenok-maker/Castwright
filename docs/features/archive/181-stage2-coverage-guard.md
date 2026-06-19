---
status: stable
shipped: null
owner: null
---

# 181 — Stage-2 attribution coverage guard + audit

> Status: active
> Key files: `server/src/analyzer/stage2-coverage.ts`, `server/src/routes/analysis.ts`, `scripts/audit-stage2-coverage.mts`
> URL surface: none (analysis pipeline + CLI audit)
> OpenAPI ops: none
> Issues: closes #515 (analyzer loop-and-truncate — The Drowning Bell ch12/ch18)

## Context

While listening to *The Drowning Bell* the user hit duplicated sections in Chapter 18.
Forensics (2026-06-05) traced it through every layer — raw EPUB clean (×1),
stage1 + stage2 PROMPTS clean (×1), but the **stage2 attribution response ×2 and
truncated**. The per-chapter attribution model (prose → per-sentence JSON) fell
into a **degenerate repeat-loop**: it re-emitted a ~48-sentence span and
terminated early, so Chapter 18 is BOTH duplicated (~7 min replayed) AND missing
~54% of its content. A cross-book sweep found a second silent casualty —
Chapter 12 (~78% missing, no duplicate, just ends early at 3:59).

The defect slips through because the model's output is **internally consistent**
(ids 1..N, no gaps), so schema validation passes, and the cache ingest
(`analysis.ts`) writes `result.sentences` straight to disk with **no check that
it covers the input prose**. The plan-179 audio QA gate can't see it (it judges
per-sentence audio quality, not source fidelity).

## Benefit / Rationale

- **User:** chapters can no longer silently lose half their content or replay a
  span twice — a looped/truncated attribution is re-run, and if it never clears,
  the chapter is flagged for retry instead of shipping bad. The audit script
  reports exactly which already-analyzed chapters are damaged.
- **Technical:** a pure, unit-tested detector (`validateStage2Coverage`) compares
  the attributed sentences against the exact `ch.body` the model saw — robust to
  the tag/quote/split normalisation that made prompt-based forensic greps
  false-positive. Reused by the runtime guard AND the offline audit.
- **Architectural:** adds an output-validation seam at the analysis ingest that
  the model layer (schema-only) structurally cannot provide.

## Architectural impact

- **New module** `server/src/analyzer/stage2-coverage.ts`:
  `validateStage2Coverage(body, sentences, thresholds?)` → `{ ok, coverageRatio,
  endingPresent, duplicatedBlock, issues }`, plus `runStage2WithCoverageGuard({
  body, maxRetries, call, onRetry })` — the validate-and-retry-keeping-best wrapper.
- **`analysis.ts` ingest** (stage-2 worker `runChapter`): the single
  `runStage2Chapter` call is wrapped by `runStage2WithCoverageGuard`. On a still-
  failing verdict the chapter is added to `cache.failedChapterIds` (existing
  Retry-button surface) and a loud `log` + `console.warn` fire. **`0` retries =
  byte-identical to pre-guard.**
- **Audit script** `scripts/audit-stage2-coverage.mts` (`npm run
  audit:stage2-coverage`): re-parses each book's EPUB via the same `parseEpub`
  and validates every cached chapter; title-gated to skip re-parse id drift
  (guide books) and a >3× coverage misalignment guard. Read-only.
- **Invariants preserved:** schema/parse contract unchanged; the guard only adds
  a semantic post-check + retry. Detector is pure (no I/O), env-tunable
  (`STAGE2_*`), mirroring `audio-qa.ts` / `segment-qa.ts`.
- **Reversibility:** `STAGE2_COVERAGE_RETRIES=0` disables the guard entirely.

## Invariants to preserve

- `validateStage2Coverage` compares against `ch.body` (the analyzer input), never
  the handoff prompt (header-padded, divergently normalised → false positives).
- Pass/fail rests on coverage ratio bounds + duplicated-block only;
  `endingPresent` is advisory (a missing tail at high coverage is normalisation
  noise — it false-positived clean chapters at 94–99%).
- `minCoverageRatio` default 0.6 — healthy attribution compresses to ~0.65–1.0;
  the real bug is catastrophic (0.12 / 0.52). Don't raise it back toward 1.0.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/stage2-coverage.test.ts`, 16 cases):
  faithful pass, truncation, duplicated block, loop-and-truncate (ch18 shape),
  short-but-complete preface (no false positive), normal compression ~0.7 (no
  false positive), tag tolerance, **non-Latin (Cyrillic) faithful pass +
  truncated-still-flagged** (the 2026-06-15 fix below), env + explicit
  thresholds, empty input; plus
  `runStage2WithCoverageGuard` — accepts good first try, retries-and-keeps-good,
  exhausts-and-keeps-least-bad, disabled at 0.
- Real-data validation: `npm run audit:stage2-coverage` flags exactly The Drowning Bell
  ch12 (12%) + ch18 (52% + DUP×44) and clears every other novel.

### Manual acceptance (owed — needs the analyzer running)

1. Re-analyze The Drowning Bell ch12 + ch18 with the guard on; confirm the log shows a
   coverage re-analysis if the model loops, and the resulting cache passes the
   audit (no dup, full coverage). Then regenerate their audio.

## Out of scope

- Re-analyzing + regenerating the two damaged chapters (the user runs this once
  the app is on the new code).
- Auditing non-EPUB (txt/pdf) books and the Floodmark guide book (re-parse id
  drift makes title-gated alignment unreliable — reported as skipped).
- **Missing-speaker / roster coverage** — a speaker the prose tags but Phase-0a
  dropped from the roster (so stage-2 demotes their lines to narrator). That is a
  distinct failure mode handled by plan
  [182](182-missing-speaker-roster-guard.md) (`roster-coverage.ts`), not this
  sentence-coverage guard.

## Follow-up — non-Latin (Cyrillic) coverage fix (2026-06-15)

A 9-chapter **Russian** book stalled in analysis: every chapter logged
`Low coverage — attributed 0 words vs ~28 source (ratio 0.00 below 0.6)` and
re-ran to the retry budget on every chunk. Root cause: `words()` normalised with
`[^a-z0-9]`, which deleted every Cyrillic character — so the source prose AND its
faithful attribution both collapsed to ~0 words → ratio 0.00 → a permanent false
"truncated" verdict that no retry could clear. Fix: normalise letters/digits
script-agnostically via `[^\p{L}\p{N}]+/gu`. Restores all three signals
(coverage ratio, ending-tail, dup-block) for any script; English behaviour is
unchanged (ASCII letters are `\p{L}`). Paired tests: faithful-Cyrillic-passes +
truncated-Cyrillic-still-flagged.

The **same `[^a-z0-9]` flaw** existed in the generation-side ASR content-QA gate
(`tts/segment-asr-qa.ts` `normalizeForWer`); fixed identically in the same change.
There it failed *safe* (empty expected text → `inconclusive`, no re-record), so it
silently provided zero content-QA on non-English books rather than stalling — the
fix makes the WER gate actually function on Russian (Whisper transcribes it fine).

**Still ASCII-only (tracked separately):** character-id generation (`toKebabId`,
`analysis.ts` slug, `workspace/paths.ts`) and cross-book name-match keys
(`series-prior-dedup.ts`, `cast-series-patch.ts`, `voice-override-linked.ts`)
collapse Cyrillic names to empty/colliding ids/keys. That touches persisted ids +
on-disk filenames, so it is its own plan (see `docs/features/`), not this fix.

## Follow-up — word-free chunk stuck loop (2026-06-19)

The 9-chapter Russian book *Ночной дозор* stalled on Chapter 7 with
`Low coverage — attributed 1303 words vs ~0 source (ratio 0.00 below 0.6)` re-run
to the retry budget on one section. **Same failure class as the Cyrillic fix
above (zero-word source → permanent false "truncated"), different trigger** — and
this time the source word count really *was* 0 for that span.

Root cause: the chapter has a lone `***` scene-break paragraph sitting between two
**over-budget** paragraphs (11.5k + 9.8k chars). `splitBodyIntoChunks` flushed on
both, isolating `"***\n\n"` as its own ~5-char section. `words("***")` = 0 (no
`\p{L}\p{N}`), so the guard forced `coverageRatio = 0` and flagged "truncated" on
every attempt; meanwhile the model attributed the huge preceding-context paragraph
it was handed (the 1303 words), wasting ~4 min/attempt and producing garbage
sentences. A source-side word count can't change on retry → effectively stuck.

Two-layer fix (`stage2-coverage.ts` + `stage2-chunk.ts`):

1. **Skip word-free chunks before attribution** (`runStage2ChapterChunked` →
   `attributeSpan`): a span with no attributable words (`hasAttributableContent`)
   has nothing to attribute — no model call, no sentences. A `***` scene break
   isn't spoken anyway.
2. **Guard treats a zero-word source as un-evaluable** (`validateStage2Coverage`):
   `truncated`/`excess` only fire when `bodyWords.length > 0`. An empty *output* is
   now gated by an explicit `noSentences` check (previously it failed only as a
   side effect of the forced-zero ratio, which a word-free source no longer
   produces). Defense-in-depth for the single-call path.

Paired tests: `stage2-chunk.test.ts` "skips a word-free chunk (a *** scene break)
without calling the model"; `stage2-coverage.test.ts` "does NOT flag a word-free
source as truncated" + the existing empty-input invariant still holds.

## Ship notes

Shipped 2026-06-06 (merge 1e93419, PR #516, closes #515). Live acceptance
confirmed: The Drowning Bell ch12 + ch18 re-analysed and regenerated;
`npm run audit:stage2-coverage` came back clean; the data-fix issue #517 is closed.
