---
status: stable
shipped: 2026-05-21
owner: dudarenok@gmail.com
---

# Chapter rename (manual title override)

> Status: active
> Key files: `src/modals/edit-chapter-title.tsx`, `src/store/chapters-slice.ts`, `src/lib/api.ts`, `src/components/listen/listen-player-region.tsx`, `src/views/generation.tsx`, `src/components/restructure-chapters-panel.tsx`, `src/views/restructure.tsx`, `server/src/routes/chapters-restructure.ts`, `server/src/workspace/restructure.ts` (`applyRename`), `server/src/routes/book-state.ts` (`refreshChapterTitles`), `server/src/workspace/scan.ts` (`BookStateJson.chapters[].titleOverridden`)
> URL surface: `#/books/<id>/listen`, `#/books/<id>/generate`, `#/books/<id>/restructure`
> OpenAPI ops: `POST /api/books/{bookId}/chapters/{chapterId}/rename`

## Benefit / Rationale

- **User:** when the parser's auto-derived chapter title is wrong (parse heuristics in `server/src/parsers/text.ts` are imperfect — Markdown-heading detection misses, "Chapter N — Subtitle" merging picks the wrong subtitle, first-line promotion (plan 70b) grabs body text), the user can fix it inline from any of the three views that show chapter rows. The fix is sticky: subsequent heuristic refresh-titles passes leave it alone.
- **Technical:** a single dedicated endpoint mirrors the `setChapterExcluded` precedent — minimal new surface area, reuses the per-book write lock + atomic state.json write. Audio files follow the new slug via the existing `rewriteChapterSlugs` op; sentence ids and analysis cache are untouched.
- **Architectural:** introduces `titleOverridden: boolean` as a first-class sticky flag on the chapter record. Closes the long-standing fragility in plan 70b's title-preservation logic (which gated only via `GENERIC_TITLE_RE` and could clobber any title that happened to look generic). The flag rides through merge / split / reorder / portable export round-trip.

## Architectural impact

- **New seam:** `applyRename(state, hints, sentences, op: RenameOp)` in `server/src/workspace/restructure.ts` as a workspace transform alongside merge/split/reorder/exclude/refresh-titles. Route `POST /:bookId/chapters/:chapterId/rename` wraps it via the shared `applyRestructure` plumbing (per-book write lock + atomic state.json write + audio op application).
- **Invariants preserved:**
  - Chapter `id` is purely numeric (1-based) and stable — rename is a label mutation, no id reflow.
  - Sentences carry only `chapterId` (number), no denormalised title.
  - Audio file slugs follow `chapterSlug(id, title)`; renaming a chapter with rendered audio emits a `rename` audio op so the file follows the new slug. Audio bytes are unchanged.
- **Migration story:** `titleOverridden?` is optional on the chapter record — legacy state.json files (no flag) load cleanly with `titleOverridden: undefined`. The first user rename sets the flag and writes back atomically.
- **Reversibility:** to undo a rename, the user renames again (set the title back, the flag stays true). There is no "reset to auto-derived" affordance in v1 — see Out of scope.

## Invariants to preserve

1. `Chapter.titleOverridden` is set to `true` by `renameChapter` and by `applyMerge` / `applySplit` when an explicit `mergedTitle` / `newTitle` is supplied (`server/src/workspace/restructure.ts` — search for `titleOverridden`). It is propagated through `buildNewStateChapters` (line ~272) for unchanged-content chapters across merge/split/reorder.
2. `applyRefreshTitles` and `book-state.ts:refreshChapterTitles` MUST skip chapters with `titleOverridden === true` BEFORE the `GENERIC_TITLE_RE` gate. The regex gate stays as backup for legacy chapters without the flag.
3. The rename route returns the setChapterExcluded-shaped envelope `{ id, title, slug, titleOverridden }`, NOT the full `ChapterRestructureResponse` — frontend slice has only one chapter to update.
4. The slice action `chaptersActions.renameChapter` is NOT broadcast across tabs (mirrors `setChapterExcluded`, see `src/store/broadcast-middleware.ts:92`).
5. The shared modal `EditChapterTitleModal` is keyed by `chapter.id` at every mount site so flipping between two rows re-mounts the form rather than carrying over a stale draft.

## Test plan

### Automated coverage

- **Vitest server** (`server/src/routes/chapters-restructure.test.ts`):
  - `POST /:bookId/chapters/:chapterId/rename (plan 78)` describe block — happy path (title updates, `titleOverridden=true`, other chapters untouched), whitespace trimming, audio file rename, post-rename refresh-titles preserves the override, empty/oversized/missing title rejection (400), unknown chapter id (404), non-integer chapterId path param (400), unknown bookId (404).
  - `POST /:bookId/chapters/refresh-titles (plan 70b)` block — new case "skips chapters with titleOverridden=true" pins the second gate.
  - `merge/split propagate titleOverridden (plan 78)` block — explicit `mergedTitle` / `newTitle` flips the flag on the resulting chapter; absent override leaves it undefined; reorder preserves the flag across renumber.
- **Vitest server** (`server/src/routes/book-state.refresh-titles.test.ts`):
  - `plan 78 — skips chapters with titleOverridden=true; refreshes neighbours; bumps version` — locks the opportunistic refresh path.
- **Vitest unit** (`src/store/chapters-slice.test.ts` `chaptersSlice — renameChapter (plan 78)` block):
  - updates title + locks `titleOverridden`, is a no-op on unknown chapter id, preserves other chapter state (progress, characters, excluded) across rename.
- **Vitest component** (`src/modals/edit-chapter-title.test.tsx` — new file, 10 cases):
  - seeds input from current title; null-renders on `open={false}` / `chapter={null}`; disables Save when empty / unchanged; Save calls `api.renameChapter` with trimmed title + dispatches slice action + closes; Enter submits; Escape closes without saving; Cancel does not call api; api rejection surfaces a toast and keeps modal open.
- **Playwright e2e** (`e2e/listen-rename-chapter.spec.ts`):
  - golden path — pencil button → modal → type new title → Save → modal closes → row re-renders with new title → restructure view shows new title too.
  - Cancel discards changes without mutating the row.

### Manual acceptance walkthrough

Run against real backend (`npm start`) with the canonical end-to-end manuscript `server/src/__fixtures__/the-coalfall-commission.md`:

1. **Import → confirm metadata → analyse → listen view.** Note a chapter whose auto-derived title looks wrong.
2. **Click the pencil icon** on that chapter row. Modal opens with the current title in the input.
3. **Type the new title** → click **Save**. Toast does NOT appear (success path). Modal closes. The row re-renders with the new title.
4. **Reload the page (F5).** The new title is still present — state.json round-trip works.
5. **Open the Restructure view** (`#/books/<id>/restructure`). Same chapter shows the new title.
6. **Click "Refresh chapter names"** in the Restructure view. The renamed chapter is NOT touched. A still-generic neighbour, if any, gets promoted from its first-sentence candidate. Toast confirms the count.
7. **Generate audio** for the renamed chapter → download MP3 (default codec). Inspect the file's ID3 `title` tag via `ffprobe <file>` or VLC → Tools → Media Information → confirm it carries the new title. Try AAC and Opus exports too (plan 72 codec selector).
8. **Export M4B** (`docs/features/archive/33-voice-export.md`). Open in a player that surfaces chapter atoms (e.g. VLC chapter list) → confirm the new title appears in the chapter index.
9. **Plan 75 portable-bundle round-trip:** export the book as a portable bundle, delete the source workspace, import the bundle into a fresh slot. Open Listen view → confirm the renamed chapter and its `titleOverridden` flag survived.

## Out of scope

- **Cross-tab sync.** Rename is not broadcast (mirrors `setChapterExcluded`, see `src/store/broadcast-middleware.ts:92`). Other tabs see the new title on next focus / reload.
- **Bulk rename** / find-and-replace across chapter titles. Single-chapter rename only for v1; bulk is a `docs/BACKLOG.md` follow-up if the user reports renaming five chapters in a row.
- **Reset to auto-derived.** There is no "clear my override and re-run heuristic" button in v1. Workaround: rename to the parser's likely candidate manually.
- **History / undo.** No per-rename audit trail; the user just renames again if the new title is wrong.
## Ship notes

Initial rename + override flag shipped 2026-05-20. The manuscript-diff-on-reupload structural-mismatch gap (where `titleOverridden` could attach to drifted content after a re-parse) is closed by plan 84 (shipped 2026-05-21 in PR #96) — `detectOverrideConflicts` + a chapter-slice `clearOverrides` reducer dispatched from the re-upload diff modal's apply path. Plan 78 graduates to stable now that gap is closed.
