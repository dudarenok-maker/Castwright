# Batch character regenerate

> Status: removed (2026-05-26) — superseded by
> [114-profile-regen-preview.md](114-profile-regen-preview.md).
> Key files (deleted): `src/modals/batch-character-regenerate.tsx`,
> `src/store/chapters-slice.ts` (`batchRegenerateCharacters`),
> `src/store/ui-slice.ts` (`setBatchRegenIds`)

**Removed.** The multi-character batch modal was deleted: there is no
per-character synthesis (`synthesiseChapter` always re-renders the whole
chapter), and "regenerate selected characters" implied a partial render that
never existed. Profile-change regeneration is now single-character with an
opt-in one-chapter A/B preview — see
[114-profile-regen-preview.md](114-profile-regen-preview.md). The historical
spec below is retained for context only.

---

## What this covers

Lets the user pick multiple characters from the cast and regenerate their lines across a selected chapter range. Useful when the user re-tunes several voices (e.g. after a model upgrade) and wants a bulk re-render rather than one-by-one regeneration. Results land as revision drafts (`20-revisions-and-drift.md`), not as direct audio replacements.

## Invariants to preserve

- `ui.batchRegenIds` (`string[] | null`) holds the in-progress selection; null means the modal is closed (`src/store/ui-slice.ts:27, 115`).
- `setBatchRegenIds([...])` opens the modal with a pre-selected set; `setBatchRegenIds(null)` closes it. The reducer is overlay-flat (not stage-guarded) so the modal can open from any `ready` view.
- The modal must render the chapter-range picker (start + end chapters from the current book's chapter list) plus the selected character names; both lists are required before "Confirm" enables.
- On confirm, dispatches `chaptersActions.batchRegenerateCharacters({ characterIds, chapterStart, chapterEnd })` which enqueues per-(chapter, character) regen tasks. Tasks land in the revisions slice as `pending` drafts; user accepts/rejects per `20-revisions-and-drift.md`.
- Cancel discards the selection without enqueueing anything; `setBatchRegenIds(null)`.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to a book's cast view.

1. **Multi-select 3 characters** (Cmd/Ctrl-click) → "Regenerate selected (3)" button appears.
2. **Click the button** → `ui.batchRegenIds` becomes the 3 character ids; modal opens listing them by name.
3. **Pick chapters 5–8** → range validator confirms 5 ≤ end ≤ chapter count; confirm button enables.
4. **Confirm** → `batchRegenerateCharacters` fires; modal closes (`batchRegenIds = null`); revisions slice gains pending drafts for characters × chapters (3 × 4 = 12 drafts).
5. **Open revisions diff view** (`20-revisions-and-drift.md`) → drafts are listed; user accepts/rejects per draft.
6. **Cancel mid-selection** → `setBatchRegenIds(null)`; no drafts enqueued.
7. **Selecting zero characters** → "Regenerate selected" button stays hidden; modal cannot open.

## Out of scope

- Live preview of the regen during selection — drafts are async.
- Selecting characters across multiple books — single-book scope only.
- Undo of an already-enqueued batch — user must reject the drafts individually.
