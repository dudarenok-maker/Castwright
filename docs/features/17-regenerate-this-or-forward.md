# Regenerate (this or forward)

> Status: stable
> Key files: `src/modals/regenerate.tsx`, `src/store/chapters-slice.ts` (`regenerateChapter`, `regenerateChapterIds`), `src/store/ui-slice.ts` (`setRegenChapter`, `setRegenInitialScope`)
> URL surface: modal overlay, no URL component
> OpenAPI ops: indirect — drives `POST /api/books/:bookId/generation` (often with subset + `force: true`)

> **Per-character / profile-change regeneration moved to
> [114-profile-regen-preview.md](archive/114-profile-regen-preview.md).** The old
> "Character regen re-synthesises only that character's lines" model was
> removed — there is no per-character synthesis (the server always re-renders
> the whole chapter). `CharacterRegenerateModal` is now the profile-change
> chooser (Regenerate-all vs. opt-in one-chapter A/B preview); the
> `regenerateCharacter` reducer is gone.

## What this covers

The **chapter regen** modal offers scope `'this' | 'forward'` — re-synthesise
only this chapter, or this chapter plus every later one. The render replaces the
chapter audio directly (the server preserves the prior take as `.previous.*` on
disk, but there is no in-app accept gate — that gate is reserved for plan 114's
opt-in preview).

## Invariants to preserve

- Chapter regen modal scope union: `'this' | 'forward'`. The modal is opened by `setRegenChapter(chapter)`; closed by `setRegenChapter(null)` (`src/store/ui-slice.ts`).
- `setRegenInitialScope('forward')` pre-selects "this and all subsequent" when opened from the post-generation header button; cleared when the modal closes.
- Both confirm and cancel are flat overlays (not stage-guarded); cancel never enqueues.
- `chaptersActions.regenerateChapter` takes scope + chapter id and expands `'forward'` into the chapter id list; `regenerateChapterIds` flips an explicit chapter-id list (head → `in_progress`, rest → `queued`). Every regen enqueues whole-chapter entries (`scope:'this'`) — there is no `scope:'character'` producer anymore (plan 114).
- A successful chapter regen overwrites the chapter's `audioModelKey` / `audioRenderedAt` stamp with the active engine (see plan 35). So regenerating a drifted chapter clears its drift caption + banner contribution automatically — no separate "clear drift" affordance is needed.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to a book in `ready` state.

1. **Click Regenerate on chapter 5** → `setRegenChapter(chapter5)`; modal opens with chapter title.
2. **Pick scope = "this chapter"**, confirm → chapter 5 re-renders; modal closes.
3. **Pick scope = "this chapter and forward"** on chapter 5 (book has 10 chapters), confirm → chapters 5–10 queue.
4. **Cancel** → `setRegenChapter(null)`; nothing enqueued.
5. **Open while one is already open** → previous modal state is replaced (chapter swaps).

## Out of scope

- Per-character / profile-change regeneration + the A/B preview gate — see [114-profile-regen-preview.md](archive/114-profile-regen-preview.md).
- Multi-character bulk regen — removed; see archived [11-batch-character-regenerate.md](archive/11-batch-character-regenerate.md).
- Re-running with a different model key per regen (regen uses the current `ui.ttsModelKey`).
