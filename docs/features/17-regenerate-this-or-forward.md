# Regenerate (this or forward) + per-character

> Status: stable
> Key files: `src/modals/regenerate.tsx`, `src/modals/character-regenerate.tsx`, `src/store/chapters-slice.ts` (`regenerateChapter`, `regenerateCharacter`), `src/store/ui-slice.ts` (`setRegenChapter`, `setRegenCharacterCtx`)
> URL surface: modal overlays, no URL component
> OpenAPI ops: indirect — drive `POST /api/books/:bookId/generation` (often with subset + `force: true`)

## What this covers

Two scoped regeneration modals. **Chapter regen** offers `'this' | 'forward'` — synthesise only this chapter, or this chapter plus every later one. **Character regen** picks a single character + a chapter (or chapter range) and re-synthesises only that character's lines. Both flows produce revision drafts (`20-revisions-and-drift.md`) rather than overwriting audio directly.

## Invariants to preserve

- Chapter regen modal scope union: `'this' | 'forward'`. The modal is opened by `setRegenChapter(chapter)`; closed by `setRegenChapter(null)` (`src/store/ui-slice.ts:25, 113`).
- Character regen context shape: `RegenCharacterCtx { characterId; defaultChapterId? }` (`src/store/ui-slice.ts:15-18`). Modal is opened by `setRegenCharacterCtx(ctx)`; closed by `setRegenCharacterCtx(null)` (`ui-slice.ts:26, 114`).
- Both modals close on confirm; cancel never enqueues. State transitions are flat overlays (not stage-guarded).
- `chaptersActions.regenerateChapter` takes scope + chapter id; expands `'forward'` into the chapter id list and dispatches; `regenerateCharacter` takes character id + chapter range.
- Results land as `pending` revisions in `revisions.pending[]` (see `20-revisions-and-drift.md`), NOT as direct chapter audio replacements. The user accepts/rejects per draft.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to a book in `ready` state.

### Chapter regen

1. **Click Regenerate on chapter 5** → `setRegenChapter(chapter5)`; modal opens with chapter title.
2. **Pick scope = "this chapter"**, confirm → revision drafts for chapter 5 enqueue; modal closes.
3. **Pick scope = "this chapter and forward"** on chapter 5 (book has 10 chapters), confirm → drafts for chapters 5–10 enqueue.
4. **Cancel** → `setRegenChapter(null)`; no drafts.
5. **Open while one is already open** → previous modal state is replaced (chapter swaps).

### Character regen

1. **Click Regen on Mara's row in chapter 3** → `setRegenCharacterCtx({ characterId: 'mara', defaultChapterId: 3 })`; modal opens pre-filled with chapter 3.
2. **Confirm with default range (just chapter 3)** → drafts for Mara in chapter 3 enqueue; modal closes.
3. **Change range to 3–6** → drafts for Mara in chapters 3, 4, 5, 6 enqueue.
4. **Defaults** — `defaultChapterId` is optional; modal must handle `undefined` by defaulting to the current `currentChapterId` from `ui.stage` (if `ready`).
5. **Cancel** → `setRegenCharacterCtx(null)`; no drafts.

## Out of scope

- Cross-character / cross-chapter bulk operations — that's `11-batch-character-regenerate.md`.
- Auto-acceptance of drafts — always user-mediated via revision diff view.
- Re-running with a different model key per regen (regen uses the current `ui.ttsModelKey`).
