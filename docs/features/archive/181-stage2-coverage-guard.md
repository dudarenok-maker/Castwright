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

- Vitest server (`server/src/analyzer/stage2-coverage.test.ts`, 14 cases):
  faithful pass, truncation, duplicated block, loop-and-truncate (ch18 shape),
  short-but-complete preface (no false positive), normal compression ~0.7 (no
  false positive), tag tolerance, env + explicit thresholds, empty input; plus
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

## Ship notes

Shipped 2026-06-06 (merge 1e93419, PR #516, closes #515). Live acceptance
confirmed: The Drowning Bell ch12 + ch18 re-analysed and regenerated;
`npm run audit:stage2-coverage` came back clean; the data-fix issue #517 is closed.
