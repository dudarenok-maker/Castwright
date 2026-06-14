---
status: stable
issue: 397
---

# 214 — Merge journal for deterministic alias un-link (srv-1)

## Ship notes

Shipped 2026-06-14 via PR [#793](https://github.com/dudarenok-maker/Castwright/pull/793)
(merge commit `46778fbd`), closing `srv-1` / issue #397. Delivered as five
TDD waves (store → manual-merge write → journal-first unlink + fallback →
fold journaling + fresh-clear → regression plan), each spec- and
code-quality-reviewed. `npm run verify` green (all 12 legs); merged `main`
builds clean. Owed: live acceptance — perform a real mid-book merge then
unlink and confirm the Reattribute Lines modal lists exactly the journaled
sentences (automated tests cover the lineage logic but not the end-to-end UI).

## What

A per-book journal `<bookDir>/.audiobook/cast-merges.json` records, for every
cast-merge that rewrites sentence attributions, the exact sentences it moved.
The unlink-alias route reads it to surface precisely those sentences in the
Reattribute Lines modal, replacing the over-reporting `chapterCast` heuristic.

## Invariants

- **Entry shape:** `{ ts, kind: 'manual' | 'fold', sourceId, sourceName,
  targetId, affected: { chapterId, sentenceId }[] }`. Sentence ids are unique
  only within a chapter, so lineage is always chapter-qualified.
- **Write sites:** manual merge (`cast-merge.ts`, append) and post-stage-2
  auto-fold (`analysis.ts`, replace-all fold entries). No other path rewrites
  this book's sentence attributions.
- **Lifecycle:** `fresh: true` re-analysis clears the journal; each fold pass
  replaces `kind:'fold'` entries; manual merges append and survive non-fresh
  re-runs.
- **Lookup:** match `targetId === sourceCharacterId` AND `sourceName` ==
  aliasName (case-insensitive); intersect recorded pairs with sentences still
  attributed to the source. No match (or zero recorded pairs) → fall back to the
  `chapterCast` derivation.
- **Contract unchanged:** `UnlinkResponse` / `ImpactedChapter` shapes are
  identical; no OpenAPI or frontend change.

## Acceptance walkthrough

1. Analyse a book; merge a mid-book duplicate that touches sentences only in
   chapters 7–9.
2. Open the survivor's Profile Drawer, remove the merged alias chip.
3. The Reattribute Lines modal lists exactly the chapters 7–9 sentences the
   merge moved — no chapter 1–6 lines, even if the alias name appears in those
   chapters' rosters.
4. On a pre-journal book (no `cast-merges.json`), the modal falls back to the
   chapterCast behaviour (chapters where the name was in the roster).

## Automated coverage

- `server/src/store/cast-merges.test.ts` — pure helpers + IO round-trip.
- `server/src/routes/cast-merge.test.ts` — manual entry recorded with
  chapter-qualified affected pairs.
- `server/src/routes/cast-aliases.journal.test.ts` — journal path beats
  chapterCast and excludes a colliding id from another chapter.
- `server/src/routes/cast-aliases.test.ts` — fallback path stays green.

## Residual risks (accepted)

- Alias union vs. journal replace: a character the analyzer stops detecting on a
  later re-analysis keeps its chip (aliases are unioned) but loses its fold
  entry (replaced) → that one alias falls back to chapterCast.
- Sentence-id stability across re-segmentation: stale pairs drop out of the
  intersection harmlessly.

See `docs/superpowers/specs/2026-06-14-srv-1-merge-journal-alias-unlink-design.md`
for the full design + adversarial-review findings.
