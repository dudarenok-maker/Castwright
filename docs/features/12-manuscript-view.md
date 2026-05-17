# Manuscript view

> Status: stable (manuscript-edits hydrate, persist, and survive reparse)
> Key files: `src/views/manuscript.tsx`, `src/store/manuscript-slice.ts` (`setSentenceCharacter`, `setSentencesCharacter`, `splitSentence`, `hydrateFromAnalysis` merge), `src/lib/types.ts` (`Sentence`), `server/src/routes/book-state.ts` (GET filter + reparse migration)
> URL surface: `#/books/:bookId/manuscript?chapter=N`
> OpenAPI ops: `PUT /api/books/:bookId/state` with `slice: 'manuscript'`
> Cross-links: [12a — Fix: sentence reassignment scoped by (chapterId, id)](12a-fix-reassign-cross-chapter-id.md) — patches the original single-id keying in the reassign reducers and the inspector prop.

## What this covers

Renders the manuscript a chapter at a time, sentence-by-sentence, with each sentence colour-coded by its attributed character. Auto-attribution confidence is surfaced visually so the user can spot likely errors. Clicking a sentence opens a speaker dropdown to manually reassign it; reassignments persist to `.audiobook/manuscript-edits.json`.

## Invariants to preserve

- `Sentence` type extends the OpenAPI shape with an optional `confidence?: number` (`src/lib/types.ts:10-12`). Confidence is 0–1; absent means "unknown / not analysed."
- Low-confidence sentences are visually flagged (e.g. dashed border) but the auto-attributed speaker is never silently replaced — the user has to act.
- Reassignment dispatches `manuscriptActions.setSentenceCharacter({ chapterId, sentenceId, characterId })` (or `setSentencesCharacter` / `splitSentence` for the batch + split paths — same `chapterId` scoping) and triggers `PUT /api/books/:bookId/state` with `{ slice: 'manuscript', patch: { sentences: [...] } }` (`src/lib/types.ts:131-134`). Sentence ids restart at 1 in every chapter, so all sentence-targeting reducers match by `(chapterId, id)` — mirrors the hydrate-merge keying at `src/store/manuscript-slice.ts:86-88`. See [12a — Fix](12a-fix-reassign-cross-chapter-id.md) for the regression history.
- `hydrateFromAnalysis` MERGES rather than overwrites once a manuscriptId is set: incoming sentences refresh fields (text, etc.) from analysis where ids match, but the slice's existing `characterId` is preserved. Split-sentence offsprings (ids the analyzer didn't emit) survive in narrative order. First-call hydrate (manuscriptId null) replaces wholesale.
- Reparse PRESERVES `manuscript-edits.json`. The GET-side merge in `server/src/routes/book-state.ts` filters edits against the analysis cache: edit ids present in cache are kept; edit ids above the cache's max id are kept (likely split offsprings); edits with ids in the cache range but absent from cache are dropped as orphans. A `'reparse'` change-log entry records the count carried forward.
- Audio tags (see `07-audio-tag-vocabulary.md`) render inline in the sentence text as badges, not stripped.
- Chapter navigation is keyboard-friendly: left/right arrows step `currentChapterId`; URL updates via `setCurrentChapterId`.
- The view is only mounted when `stage.kind === 'ready' && stage.view === 'manuscript'`. Other views never render it.
- **Excluded chapters are visibly indicated.** Rows in the sidebar with `chapter.excluded === true` render the title in `line-through text-ink/40` and replace the duration line with `"Excluded"`; the per-state icon (spinner/check/warning) is suppressed because the chapter never queued. Selecting an excluded chapter swaps the main panel for an explanatory empty card ("This chapter was excluded at import. …") and a pill next to the title — never a blank `<article>` with `"0 segments · 0 speakers · 0 low-confidence"`. The user re-includes from the Generate view (see `16-generation-stream.md`).
- **Sidebar scales to large books.** The Chapters and Detected (cast) cards live in a fixed-height flex column with no outer scroll. Each card owns its own `overflow-y-auto` scroll region, so a 500-chapter book never pushes the cast list off the bottom of the viewport. Both cards split the vertical space equally (`flex-1 basis-0` on each) so they're the same height regardless of how many chapters or characters each holds — small books leave both cards short of their bound, large books scroll internally.
- **Right-pane inspector scales to large casts.** The SegmentInspector card is a `flex flex-col max-h-[calc(100vh-100px)]` with the segment header (name, Profile / Close, confidence bar) as a `shrink-0` top, the long "Reassign whole segment to" list + "Per-sentence reassign" section in a `flex-1 min-h-0 overflow-y-auto` middle, and the highlight-text / drag-boundary help line as a `shrink-0` border-top footer. On a 30-character cast the character list scrolls inside the card; the segment header and the help line both stay visible. A `Filter chapters…` input at the top of the Chapters card narrows the list by case-insensitive substring against the title or `CH NN` form; the active chapter remains the active chapter even when filtered out of the sidebar (filter is a view, not a selection mutation). When the active chapter changes (via Prev/Next or external `setCurrentChapterId`), the matching sidebar row is `scrollIntoView({ block: 'nearest' })`-ed inside the chapter scroll region.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to `#/books/<id>/manuscript`.

1. **Land on the view** → sentences for `currentChapterId` (default 3) render; each carries a coloured left-border indicating the speaker.
2. **Hover a sentence with low confidence** → tooltip / badge surfaces "low confidence" or a numeric score.
3. **Click a sentence** → inline dropdown lists characters; pick a new speaker → colour updates immediately (optimistic).
4. **Mock mode: reload the page** → reassignment is lost (mock does not persist). This is documented behavior; do not assert otherwise.
5. **Real mode: reload the page** → reassignment persists via the PUT and is hydrated back on next book open. After reparse, surviving edits (whose sentence ids the next analysis pass also produced) carry through; orphaned ids are dropped silently and a `reparse` entry summarising the carry-forward count appears in the Activity log.
6. **Audio tags in text** — sentence `"Are you sure? [hesitant]"` renders the `[hesitant]` badge inline.
7. **Navigate chapters** — left/right arrow keys step `currentChapterId`; URL updates; sentence list rerenders for the new chapter.
8. **Open an excluded chapter** — sidebar row shows a strikethrough title and the word `Excluded` in place of the duration. Click it: the main panel swaps to "This chapter was excluded at import. …" with an `Excluded` pill next to the title. No empty article, no `0 segments` counter.
9. **Large-book sidebar** — load a 500-chapter book (e.g. the new bulk fixture, 509 chapters / 30 cast). The Detected card is visible at the bottom of the sidebar without scrolling. Mouse-wheel over the Chapters card scrolls the chapter list in place; the cast card does not move. Type `epilogue` into `Filter chapters…` and the list collapses to matching rows. Clear the filter and all rows return. Click Next from chapter 200 and the active row is scrolled into the chapter scroll region on its own.
10. **Large-cast inspector** — on the same 30-cast book, click any paragraph in the middle pane. The right-pane inspector opens and the "Reassign whole segment to" list scrolls inside the inspector card; the segment header (name + confidence) stays pinned at the top and the highlight-text / drag-boundary help line stays pinned at the bottom. Neither pushes past the viewport.

## Out of scope

- Inline tag editing.
- Drag-to-reassign multiple sentences at once.
- Diff view of analyser-original vs user-edited speakers.
