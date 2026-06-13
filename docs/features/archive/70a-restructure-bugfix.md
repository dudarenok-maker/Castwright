---
status: stable
shipped: 2026-05-19
owner: null
---

# Plan 70a — Chapter restructure bug fix (orphan recovery + empty-chapter prune + generic-title renumber)

> Status: stable
> Key files: `server/src/workspace/restructure.ts`, `server/src/routes/chapters-restructure.ts`, `server/src/routes/chapters-restructure.test.ts`
> URL surface: `#/books/<id>/restructure` (consumes the same `POST /api/books/:id/chapters/{merge,split,reorder}` endpoints — no new routes)
> OpenAPI ops: `POST /api/books/{bookId}/chapters/merge`, `POST /api/books/{bookId}/chapters/reorder` (response now carries `warnings: string[]`)

## Benefit / Rationale

- **User:** Three observable bugs disappear:
  1. **Stale chapter numbers after merge.** Chapters titled `Chapter 6 / 7 / 37` at positions 4 / 5 / 6 (screenshot `Screenshot 2026-05-19 180837.png`) now re-derive against the new positions on every merge / reorder.
  2. **Empty chapter rows at the end of the list.** Rows reading `0 sentences · 00:00` (screenshot `Screenshot 2026-05-19 181725.png`) get auto-pruned during the next merge / reorder so the list stays clean.
  3. **Silent content loss on sequential merges.** Sentences whose `chapterId` no longer matches any chapter in the current structure used to be silently dropped by `remapSentences`. They are now re-attached to the nearest preceding surviving chapter, with a `warnings` entry surfacing the recovery so future regressions are observable.
- **Technical:** Closes a silent-data-loss class. The pre-fix `remapSentences` (`server/src/workspace/restructure.ts:116–140`) had an `if (!fate) continue;` skip that ate any sentence whose chapter id had drifted out of the current hint list. Now no path through merge / reorder can drop content without a logged warning.
- **Architectural:** Introduces a `warnings: string[]` advisory channel on `RestructureResult` and the HTTP response envelope. Cheap, non-breaking — clean operations return `[]` — and gives future structural ops (Part C exclude in 70b) an established place to surface non-fatal diagnostics.

## Architectural impact

- **New seams.**
  - `RestructureResult.warnings: string[]` — surfaced through the route handler to the response body.
  - `postProcessRestructure(result)` — a private chain of `pruneEmptyChaptersInResult` → `renumberGenericTitlesInChapters` invoked at the end of `applyMerge` and `applyReorder`. `applySplit` intentionally bypasses it (split's "(cont.)" title would be misread as generic, and split's invariant already forbids empty halves).
  - Detector regex `GENERIC_TITLE_RE = /^Chapter\s+\d+(\s*[—\-:]\s*(.+))?$/` is the gate for "this title was auto-generated and should re-derive." User-customised titles ("The Verdict", "Day One", word-form "Chapter Two") are non-matching by design.
- **Invariants preserved.**
  - Excluded chapters are never pruned, even when empty (soft-hide invariant from `src/store/chapters-slice.ts:545–549` / `src/views/generation.tsx:360`).
  - Sentence id renumbering remains per-chapter restart from 1; the orphan-recovery path tracks the ORIGINAL `oldChapterId` separately so the emitted remap still answers the frontend reducer's `(oldChapterId, oldSentenceId)` lookup.
  - Pre-analysis books (zero input sentences) are not subject to the prune-pass — otherwise every chapter would look "empty" and the freshly imported book would collapse to zero.
- **Migration story.** None. Existing books on disk re-flow through the structural endpoints unchanged; the next merge / reorder cleans up any pre-existing drift.
- **Reversibility.** Pure server change; `warnings` is additive. Revert is a single git revert of the diff.

## Invariants to preserve

1. `RestructureResult.warnings` is always an array (never `undefined`). Empty array on clean ops — see `applySplit` returning `warnings` straight from `remapSentences`, and `postProcessRestructure` accumulating into the chain.
2. `GENERIC_TITLE_RE` matches `"Chapter 1"`, `"Chapter 12 — Subtitle"`, `"Chapter 3: Foo"` (digit form, optional subtitle separated by em-dash / hyphen / colon). It does NOT match `"Chapter One"`, `"The Verdict"`, `"Day Two"`, `"Prologue"`. Cited at `server/src/workspace/restructure.ts` near `/^Chapter\\s+\\d+/`.
3. Orphan-recovery attachment policy: nearest preceding surviving chapter (lowest known id ≤ orphan's chapterId); falls back to smallest known id if no preceding survivor exists. Cited at the `for (const knownId of sortedKnownIds)` loop in `remapSentences`.
4. Prune-pass is skipped when `result.sentences.length === 0`. Cited at the early return in `pruneEmptyChaptersInResult`.

## Test plan

### Automated coverage

- `server/src/routes/chapters-restructure.test.ts`:
  - `plan 70a — orphan recovery (Part F) > recovers sentences whose chapterId is not in current state` — seeds a sentence with `chapterId: 99`, asserts `warnings` carries the recovery message and all 8 sentences land in the output.
  - `plan 70a — orphan recovery (Part F) > preserves the original oldChapterId in the response remap for orphans` — asserts the response's `sentenceRemap` carries `oldChapterId: 77` for a sentence that was originally attached to chapter 77 (now nonexistent).
  - `plan 70a — prune empty chapters (Part F) > drops chapters with zero sentences after merge and renumbers survivors` — uses a 4-chapter manuscript where chapter 3 has body content on disk but ZERO sentences in `manuscript-edits.json`; merge of 1+2 prunes the empty chapter and renumbers chapter 4 → id 2.
  - `plan 70a — prune empty chapters (Part F) > preserves excluded chapters even when they have zero sentences` — soft-hide invariant.
  - `plan 70a — renumber generic titles (Part E) > re-derives "Chapter N" titles against new ids after merge` — 5 chapters titled "Chapter 1..5", merge of 2+3 produces titles ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 4"] and a `Renumbered N auto-generated chapter title(s)` warning.
  - `plan 70a — renumber generic titles (Part E) > preserves user-customized chapter titles during the renumber pass` — "The Verdict" remains a custom title, the renumber pass skips it; "Chapter 3" / "Chapter 4" get re-derived against new positions.
  - `plan 70a — renumber generic titles (Part E) > preserves subtitled generic titles round-trip` — `Chapter 3 — The End` at new id 1 becomes `Chapter 1 — The End` (subtitle preserved, prefix renumbered).
- `server/src/workspace/restructure.test.ts` — existing 16 unit tests stay green. Pre-analysis cases (`applyMerge(state, hints, [], …)`) skip the prune-pass thanks to the zero-sentence guard.

### Manual acceptance walkthrough

1. With a 5-chapter book whose import auto-generated `Chapter 1 / Chapter 2 / Chapter 3 / Chapter 4 / Chapter 5` titles → Restructure view → merge chapters 2 + 3.
2. **Expected:** list shows `Chapter 1`, `Chapter 2` (merged), `Chapter 3`, `Chapter 4`. No stale `Chapter 4 / 5` numbers leak through.
3. Open a book whose state has accumulated empty rows (e.g. from prior parser drift — the user's screenshot scenario) → merge any two adjacent non-empty chapters.
4. **Expected:** empty rows disappear from the list, survivors renumber, console (server stderr) shows the `[restructure] Removed N empty chapter(s)` advisory.
5. Make a sentence-attribution edit referencing a chapter that no longer exists in the state (simulate by hand-editing `manuscript-edits.json`) → run any merge.
6. **Expected:** the orphan sentence appears under the nearest preceding chapter in the resulting view; server stderr shows the `[restructure] Recovered N orphaned sentence(s)` advisory.

## Out of scope

- **Parser oversplit fix** (decorative POV separators like `- TWELVE - MARLOW` emitting empty chapters at parse time). Root cause investigation needs more data than the screenshots provide. The structural prune-pass cleans up the symptom by removing 0-sentence chapters during the next merge / reorder, so the user-visible bug is resolved without a parser change. Reopen if the user reports the symptom returning on fresh imports of a known file. Tracked as a backlog follow-up.
- **Frontend `warnings` toast.** The HTTP response now carries the field but the frontend ignores it. Adding a `pushToast` consumer is part of plan 70b along with the rest of the Restructure-view UI work.
- **Exclude endpoint** (Part C of the larger plan) — landed separately in plan 70b.
- **Refresh chapter names button** (Part D) — landed separately in plan 70b.
- **`applySplit` does NOT run the post-pass.** Split's `(cont.)` title would match the user-custom branch, and split's invariant already forbids empty halves. If a future bug shows split producing dirty state, reopen here.

## Ship notes

Shipped 2026-05-19 via PR #62 (merge commit `b2ba2a5`). Server-only change — `applyMerge` and `applyReorder` now flow through a new `postProcessRestructure` chain that auto-prunes empty chapters and renumbers generic "Chapter N" titles against new ids; `remapSentences` recovers orphan sentences (preserving the original `oldChapterId` in the response remap so the frontend reducer lookup still resolves). Added a `warnings: string[]` field to the merge / reorder response — channel opened here, frontend consumer wired in plan 70b the same day.

Followed by [plan 70b](70b-restructure-extensions.md) on 2026-05-19 — the feature half (Manuscript-view entry point, sticky toolbar, exclude affordance, refresh chapter names, warnings toast).
