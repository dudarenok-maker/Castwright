# Manuscript view

> Status: KNOWN: scaffolded (manuscript-edits hydration partial)
> Key files: `src/views/manuscript.tsx`, `src/store/manuscript-slice.ts` (`setSentenceCharacter`), `src/lib/types.ts` (`Sentence`), `server/src/routes/book-state.ts`
> URL surface: `#/books/:bookId/manuscript?chapter=N`
> OpenAPI ops: `PUT /api/books/:bookId/state` with `slice: 'manuscript'`

## What this covers

Renders the manuscript a chapter at a time, sentence-by-sentence, with each sentence colour-coded by its attributed character. Auto-attribution confidence is surfaced visually so the user can spot likely errors. Clicking a sentence opens a speaker dropdown to manually reassign it; reassignments persist to `.audiobook/manuscript-edits.json`.

## Invariants to preserve

- `Sentence` type extends the OpenAPI shape with an optional `confidence?: number` (`src/lib/types.ts:10-12`). Confidence is 0–1; absent means "unknown / not analysed."
- Low-confidence sentences are visually flagged (e.g. dashed border) but the auto-attributed speaker is never silently replaced — the user has to act.
- Reassignment dispatches `manuscriptActions.setSentenceCharacter({ sentenceId, characterId })` and triggers `PUT /api/books/:bookId/state` with `{ slice: 'manuscript', patch: { sentences: [...] } }` (`src/lib/types.ts:131-134`).
- Audio tags (see `07-audio-tag-vocabulary.md`) render inline in the sentence text as badges, not stripped.
- Chapter navigation is keyboard-friendly: left/right arrows step `currentChapterId`; URL updates via `setCurrentChapterId`.
- The view is only mounted when `stage.kind === 'ready' && stage.view === 'manuscript'`. Other views never render it.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to `#/books/<id>/manuscript`.

1. **Land on the view** → sentences for `currentChapterId` (default 3) render; each carries a coloured left-border indicating the speaker.
2. **Hover a sentence with low confidence** → tooltip / badge surfaces "low confidence" or a numeric score.
3. **Click a sentence** → inline dropdown lists characters; pick a new speaker → colour updates immediately (optimistic).
4. **Mock mode: reload the page** → reassignment is lost (mock does not persist). This is documented behavior; do not assert otherwise.
5. **Real mode: reload the page** → reassignment SHOULD persist via the PUT. CURRENT BEHAVIOR: `manuscriptEdits.sentences` hydration on reload is partial — assert what the backend actually returns; do not assert end-to-end persistence until the gap is closed.
6. **Audio tags in text** — sentence `"Are you sure? [hesitant]"` renders the `[hesitant]` badge inline.
7. **Navigate chapters** — left/right arrow keys step `currentChapterId`; URL updates; sentence list rerenders for the new chapter.

## KNOWN: scaffolded

- `mockGetBookState` throws "Book state hydration is not available in mock mode (no disk workspace)." — mock mode never round-trips manuscript edits.
- Real backend writes `manuscript-edits.json` on PUT but the GET hydration of `sentences` from disk is incomplete; the slice may reset to analyser output on reload. Document the current gap; do not assert end-to-end persistence in this plan.

## Out of scope

- Inline tag editing.
- Drag-to-reassign multiple sentences at once.
- Diff view of analyser-original vs user-edited speakers.
