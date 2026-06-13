---
title: srv-1 — Merge journal for deterministic alias un-link
status: draft
issue: 397
date: 2026-06-14
---

# srv-1 — Merge journal for deterministic alias un-link

## Problem

When a user removes an alias chip in the Profile Drawer ("Garrow" off
"Saltgrave Figure"), the server mints the alias into its own standalone cast
member and the **Reattribute Lines** modal helps the user move the alias's
sentences back. To populate that modal it must answer: _which sentences did the
original merge actually move?_

Today (PR #142, plan 95) there is no per-sentence lineage. The merge route
rewrites `sentence.characterId` in place with no lineage column on the
`Sentence` schema, so the unlink route reconstructs "impacted chapters" from
`chapterCast` — the preserved Phase-0a per-chapter roster. A chapter is
surfaced if the alias name appeared in its roster, **even when the merge that
put the alias on the source happened mid-book and never rewrote any of that
chapter's sentences**. The result is false positives: the user skims chapters
and lines that were never the alias's and reassigns the right ones by hand.

## Goal

Record exact per-sentence lineage at every cast-merge call site in a per-book
journal, and have the unlink route read it to surface **precisely** the
sentences the merge moved — no `chapterCast` heuristic, no third-party lines to
skip.

**Acceptance (from the issue):** a book with a single mid-flight merge that
touched 12 sentences (all in chapters 7–9) → the unlink modal lists exactly
those 12 sentences across chapters 7–9, nothing else. Today's `chapterCast`
path would also list chapters 1–6 sentences attributed to the source if the
alias name happened to be in their roster.

## Non-goals

- **No backfill.** Books merged before the journal exists keep the
  `chapterCast` fallback. The lineage was lost at the old merges; there is no
  way to reconstruct it.
- **No new `Sentence` schema column.** Lineage lives in a sidecar journal, not
  on the per-sentence record.
- **No transitive chain resolution.** When an alias was built through chained
  merges (A folded into B, then B merged into C), unlinking it falls back to
  `chapterCast` rather than walking the chain. (See Decision 1.)
- **No change to the unlink HTTP contract.** `UnlinkResponse` /
  `ImpactedChapter` shapes are unchanged, so no `openapi.yaml` /
  `api-types.ts` regen and the `ReattributeLinesModal` is untouched — it just
  receives more accurate data.

## Design decisions

### Decision 1 — Direct match + fallback (not full transitive resolution)

Unlink matches journal entries where `sourceName` equals the alias **and**
`targetId` equals the character the alias currently sits on, then surfaces that
merge's recorded sentences (filtered to lines still attributed to the source).
Any alias with no matching journal entry — chains, pre-journal books, or aliases
created by a non-sentence-rewriting path — falls back to today's `chapterCast`
heuristic. This satisfies the acceptance test and ships the common case
deterministically without the chain-walking edge surface.

### Decision 2 — Fresh wipes; folds rewritten; manual appended

- A `fresh: true` re-analysis **deletes** the journal (cast + sentence ids are
  regenerated from scratch, so old lineage is meaningless). This hooks into the
  existing `requestedFresh` cleanup block in `analysis.ts` that already `rm`s
  cast.json / manuscript-edits.json / carryover.
- Each post-stage-2 fold pass **replaces all `kind:'fold'` entries** with that
  pass's computed set (idempotent — resume / partial re-analysis can't
  accumulate duplicates). `kind:'manual'` entries are preserved.
- A manual merge **appends** a `kind:'manual'` entry and survives any non-fresh
  re-run.

This mirrors how the analysis cache itself is treated across re-runs.

### Decision 3 — Chapter-qualified sentence references (corrects the issue)

The issue proposed `affectedSentenceIds: number[]`. **This is wrong.** Sentence
ids are assigned per chapter (`stage2-chunk.ts:173` → `id: i + 1`), not
globally, and the entire stack keys on the composite `(chapterId, sentenceId)`:
`manuscriptActions.setSentenceCharacter({ chapterId, sentenceId, … })`, the
existing unlink response's per-chapter `candidateSentenceIds`, and the modal's
`byChapter` map. A flat `number[]` is ambiguous — sentence `5` exists in
chapter 1 _and_ chapter 7 — and could not satisfy the acceptance test. The
journal therefore stores chapter-qualified pairs:

```ts
affected: Array<{ chapterId: number; sentenceId: number }>
```

Both write paths already carry `chapterId` on every sentence, so this is free
to capture.

## Data model

New per-book file: `<bookDir>/.audiobook/cast-merges.json`.

```ts
interface CastMergeEntry {
  /** ISO timestamp the entry was recorded. */
  ts: string;
  kind: 'manual' | 'fold';
  /** Character id that disappeared in the merge. */
  sourceId: string;
  /** The name that became the alias on the target — the match key the
      unlink route uses, since the alias chip carries a name, not an id. */
  sourceName: string;
  /** Survivor that absorbed the source. */
  targetId: string;
  /** The exact sentences this merge rewrote source → target, chapter-
      qualified because sentence ids are unique only within a chapter. */
  affected: Array<{ chapterId: number; sentenceId: number }>;
}

interface CastMergesFile {
  entries: CastMergeEntry[];
}
```

## Store module — `server/src/store/cast-merges.ts`

Mirrors `server/src/store/dropped-quotes.ts` (same atomic-write +
empty-on-missing + OneDrive-EPERM-retry contract via `state-io.ts`).

- `loadCastMerges(bookDir): Promise<CastMergesFile>` — returns `{ entries: [] }`
  when the file is absent.
- `saveCastMerges(bookDir, file): Promise<void>` — atomic write.
- `clearCastMerges(bookDir): Promise<void>` — `rm({ force: true })`; no-op when
  absent (legacy non-workspace manuscripts have no bookDir; callers guard).
- Pure helpers (unit-tested without IO):
  - `appendManualEntry(file, entry): CastMergesFile`
  - `replaceFoldEntries(file, foldEntries): CastMergesFile` — drops existing
    `kind:'fold'`, keeps all `kind:'manual'`, appends the new fold set.
  - `buildFoldJournalEntries(rewrites, preFoldSentences, characters, ts):
    CastMergeEntry[]` — turns a fold's `rewrites` map (old id → new id) into one
    entry per source. `affected` for each source = the `(chapterId, sentenceId)`
    of every pre-fold sentence whose `characterId === source`; `sourceName` is
    looked up from `characters` (the pre-fold roster, which still contains the
    folded sources). Keeping this pure here leaves `fold-minor-cast.ts` IO-free.

New path helper in `server/src/workspace/paths.ts`:

```ts
export function castMergesJsonPath(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'cast-merges.json');
}
```

## Write path — manual merge (`server/src/routes/cast-merge.ts`)

The route already maps `editsAfter` and counts `changed`. While doing that,
collect `{ chapterId: s.chapterId, sentenceId: s.id }` for every sentence where
`s.characterId === sourceId` → `affected`. After the existing cast.json / edits
/ cache writes, append a `kind:'manual'` entry (`sourceName: source.name`).

Recorded even when `affected` is empty (a merge done before stage-2 attribution
exists) — harmless; unlink just falls back for that one alias.

**Non-fatal:** the journal write is wrapped in `try/catch` + `console.warn`. The
merge has already mutated cast.json / edits / cache; a journal failure must
never fail the merge (mirrors the reuse-link / dropped-quotes precedent).

## Write path — folds (`server/src/routes/analysis.ts`, both fold call sites)

At the main route (~3447) and the subset re-analysis route (~4341): after
`foldMinorCast`, call
`buildFoldJournalEntries(folded.rewrites, recovered.sentences, stage1.characters, ts)`
and persist via `replaceFoldEntries` + `saveCastMerges`. `recovered.sentences`
is the pre-fold list, so `affected` for each source is its sentences before the
rewrite.

Both paths fold over the **full whole-book sentence set** — the subset path
stitches every cached chapter (`analysis.ts:4322–4329`) before folding and
persists the full `manuscript-edits.json` — so replace-all fold journaling is
correct on both. Wrapped `try/catch` + warn, non-fatal.

`fresh: true` clear: add `await clearCastMerges(recordRef.bookDir)` to the
existing `requestedFresh` cleanup block (`analysis.ts:2041–2047`), guarded by
the same `recordRef.bookDir` check.

## Read path — unlink (`server/src/routes/cast-aliases.ts`)

Replace the `chapterCast` derivation (lines ~164–208) with:

1. `loadCastMerges(bookDir)`; select entries where `targetId === sourceCharacterId`
   **and** `sourceName` matches `aliasName` (case-insensitive, trimmed).
2. **Match found (journal path):** union the matched entries' `affected` pairs,
   then intersect with the sentences in `manuscript-edits.json` still attributed
   to `sourceCharacterId` (drops lines already reattributed / re-merged
   elsewhere; also drops any stale pair whose id no longer exists). Group the
   survivors by `chapterId` → `impactedChapters`.
3. **No match (fallback path):** run today's exact `chapterCast` derivation,
   unchanged.

Emit a one-line server log noting `journal` vs `fallback` so the path taken is
observable in support.

`newCharacter` minting and the response shape are unchanged.

## Why the other alias paths are NOT journaled

Audited during design review. Only the manual merge and the auto-fold rewrite
**this book's** `sentence.characterId` while rolling a name into `aliases`:

- **Stage-1 roster merge** (`mergeRosterChapter`) dedups the roster _before_
  stage-2 attribution exists — there are no per-sentence rewrites to record, so
  `chapterCast` (chapters where the name was in the roster) is the best lineage
  available and the fallback is correct, not a gap.
- **`cast-link-prior` / `voice-match`** append a cross-book _recognition_ alias
  to a prior book and never rewrite the current book's sentences.

Documented in the journal module + `cast-aliases.ts` headers so a future reader
doesn't mistake the fallback for an omission.

## Residual risks (accepted)

- **Sentence-id stability across non-fresh re-analysis.** Ids are positional, so
  stable while a chapter's segmentation is unchanged. If a re-analysis
  re-segments a chapter, a stale `(chapterId, sentenceId)` pair in a manual
  entry simply fails the "still attributed to source" intersection and is
  dropped — graceful degradation, no crash.
- **`mergeAnalysisResultWithExistingCast` can resurrect a folded character**
  (re-adds a voiced survivor the fold dropped). Pre-existing analysis behavior;
  the journal neither helps nor worsens it. Out of scope.
- **Load-modify-write race.** Two near-simultaneous merges (or a merge racing a
  fold pass) could lose an entry, same as the `dropped-quotes` ledger. Accepted
  at this concurrency profile (manual merges are user-driven, one at a time on
  the confirm screen; analysis is guarded by the active-analysis lock).

## Testing

- **`server/src/store/cast-merges.test.ts`** (new): load-empty default;
  `appendManualEntry`; `replaceFoldEntries` preserves `manual` + replaces
  `fold`; `buildFoldJournalEntries` maps a multi-source rewrite to correct
  chapter-qualified `affected` sets.
- **`server/src/routes/cast-merge.test.ts`** (extend): after a merge, the
  journal holds a manual entry with the exact `affected` pairs; a journal-write
  failure does not fail the merge.
- **`server/src/routes/cast-aliases.test.ts`** (extend): the acceptance case — a
  mid-flight merge touching 12 sentences in ch7–9 → unlink lists exactly those
  12; a ch1 sentence whose **id collides** with a ch7 affected id is **not**
  surfaced (proves the composite key; the flat-`number[]` design would get this
  wrong); the `chapterCast` fallback still fires when the journal is absent.
- **No e2e.** The modal behavior and HTTP contract don't change; this is
  server-side data accuracy covered by integration tests. Existing
  `e2e/cast-alias-edit.spec.ts` stays green.

## Touch list

- `server/src/workspace/paths.ts` — `castMergesJsonPath` helper.
- `server/src/store/cast-merges.ts` — new module.
- `server/src/routes/cast-merge.ts` — append manual entry.
- `server/src/routes/analysis.ts` — fold journaling at 2 sites + fresh clear.
- `server/src/routes/cast-aliases.ts` — journal lookup + fallback.
- 3 test files above.
- Short regression plan under `docs/features/` (new) + `INDEX.md` entry.

Closes #397.
