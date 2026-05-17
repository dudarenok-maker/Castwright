# Book library

> Status: stable
> Key files: `src/views/book-library.tsx`, `src/modals/edit-book-meta.tsx`, `src/store/library-slice.ts` (`hydrate`), `src/lib/api.ts` (`getLibrary`, `deleteBook`, `reparseBook`, `putBookState`), `server/src/routes/library.ts`, `server/src/routes/book-state.ts`
> URL surface: `#/`
> OpenAPI ops: `GET /api/library`, `DELETE /api/books/:bookId`, `POST /api/books/:bookId/reparse`, `PUT /api/books/:bookId/state` (slice='state')

## What this covers

Home view that scans the on-disk workspace (`books/<Author>/<Series>/<Title>/`) and renders a hierarchical author → series → book tree. Each book carries a derived status (analysing / cast_pending / generating / complete / unreadable / orphaned). Clicking a book routes to the correct stage based on status. Supports per-book delete, re-parse, and **edit details** (title / author / series / position / standalone toggle) via the card's "…" menu.

## Invariants to preserve

- `LibraryResponse { authors: LibraryAuthor[] }`; `LibraryAuthor { name, series: LibrarySeries[] }`; `LibrarySeries { name, books: LibraryBook[] }` (`src/lib/types.ts:181-184, 171-179, 150-169`). The hierarchy is exactly 3 levels.
- `LibraryBookStatus` enum: `'not_analysed' | 'analysing' | 'cast_pending' | 'generating' | 'complete' | 'unreadable' | 'orphaned'` (`src/lib/types.ts:141-148`). Backend derives from `.audiobook/state.json` + `cast.json` + audio output count.
- `openBook` status → stage routing (`src/store/ui-slice.ts:78-88`):
  - `analysing` → `{ kind: 'analysing', bookId, manuscriptId }`
  - `cast_pending` → `{ kind: 'confirm', bookId }`
  - `complete` → `{ kind: 'ready', bookId, view: 'listen', ...defaults }`
  - `generating` → `{ kind: 'ready', bookId, view: 'generate', ...defaults }`
  - else (`not_analysed`, `unreadable`, `orphaned`) → `{ kind: 'ready', bookId, view: 'cast', ...defaults }`
- `realDeleteBook` issues `DELETE /api/books/:bookId`; on error surfaces `error` from JSON body or `Delete failed (<status>)` (`src/lib/api.ts:500-507`).
- `realReparseBook` issues `POST /api/books/:bookId/reparse`; response is `{ state: { chapters }, chapterCount, chapterTitles }` (`src/lib/api.ts:485-498`). Mock returns empty arrays (`src/lib/api.ts:513-516`).
- **Edit details** opens `EditBookMetaModal` and on Save calls `api.putBookState(bookId, { slice: 'state', patch })` with any subset of `{ title, author, series, seriesPosition, isStandalone }`. The route handler refetches `getLibrary` and re-hydrates the slice so the card heading updates in place. On error, `showError` surfaces the message with the eyebrow "Edit"; the library is NOT refetched on the failure path.
- **Server-side rename + folder move** (`server/src/routes/book-state.ts`, `case 'state'`): the `state` slice whitelist accepts `seriesPosition: number | null` and `isStandalone: boolean` in addition to the existing `title / author / series / narratorCredit / genre / publicationDate`. When the patch changes `title`, `author`, `series`, or `isStandalone`, the server computes the new `bookDirByDisplay(author, isStandalone ? 'Standalones' : series, title)` and uses `renameWithRetry` to move the on-disk folder there (creating parent dirs, returning **409** when the target path already exists). The in-memory `ManuscriptRecord.bookDir` is refreshed to the new path. Best-effort `rmdir` cleanup of the now-empty old series + author parents.
- **`bookId` is stable across renames.** It's computed from the _original_ author/series/title slugs at import time and persisted in `state.json#bookId`; subsequent renames do not regenerate it. All routes keyed by bookId (delete, reparse, exclude, state) continue to resolve via `findBookByBookId`, which walks the tree and matches `state.bookId` rather than the folder name.
- **`isStandalone: true` forces the on-disk series folder to `'Standalones'`** and clears `seriesPosition` to `null`. The user-typed `state.series` string is preserved in state.json so flipping back to non-standalone restores the previous series label without losing it.
- Coverage gradient is a `[string, string]` tuple per `Voice.gradient` style; the row card renders both stops.
- **Derived per-book stats are computed at scan time, not hardcoded** (`server/src/workspace/scan.ts`):
  - `characterCount` = number of entries in `cast.json#characters` (0 when cast.json absent or malformed).
  - `voiceCount` = distinct `voiceId ?? id` from `cast.json#characters` — characters sharing a library voice collapse into one slot (0 when cast.json absent or malformed).
  - `runtime` = sum of `durationSec` across every `<slug>.segments.json` present in `audio/`, formatted as `"Xh Ym"` (or `"Xm"` when under one hour). `undefined` when no segments files exist, so the card renders `'—'`. Partial generations report the runtime of the chapters generated so far.

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=false`, server on `:8080` with at least one book per status in the workspace.

1. **Land on `#/`** → tree renders: authors expandable, series expandable, books inline with title + status badge + chapter/character/voice counts.
2. **Click a `not_analysed` book** → URL becomes `#/books/<id>/cast`.
3. **Click an `analysing` book** → URL becomes `#/books/<id>/analysing`; SSE stream resumes (or restarts).
4. **Click a `cast_pending` book** → URL becomes `#/books/<id>/confirm`.
5. **Click a `complete` book** → URL becomes `#/books/<id>/listen`.
6. **Click a `generating` book** → URL becomes `#/books/<id>/generate`.
7. **Delete a book** → confirm dialog → DELETE fires → tree refreshes without the book; no broken neighbours; if last book in series, series collapses; if last series for author, author collapses.
8. **Re-parse a book** → `POST /api/books/<id>/reparse` fires; response carries the new chapter list. Server wipes cast.json + revisions.json + audio dir + analysis cache; client mirrors by dispatching `castActions.setCharacters([])` + `manuscriptActions.reset()` so the Analysing view's "Cast so far" pill opens at 0 and the layout's per-book hydration guard doesn't short-circuit. UI transitions to analysing on "Analyse now".
9. **Edit details — fix a title typo** → "…" menu → "Edit details" → modal opens seeded with current title/author/series/position. Change the title → Save → modal closes, card heading updates, `PUT /api/books/:bookId/state` fires with `slice: 'state'`. The on-disk folder is now at the new title's path; reload the page and the card still resolves to the same `bookId` URL.
10. **Edit details — move into a new series** → uncheck **Standalone**, fill in **Series** and **Position in series**, Save → card moves under the new series heading; on-disk folder is now `books/<Author>/<NewSeries>/<Title>/`; the old empty series + author folders (if any) are pruned.
11. **Edit details — flip to standalone** → check **Standalone**, Save → card moves under the Standalones heading; on-disk folder is now `books/<Author>/Standalones/<Title>/`; `seriesPosition` is cleared. The user-typed series label remains inside `state.json` so flipping back restores it.
12. **Edit details — collision** → renaming Title (or Author/Series) into a path that already holds another book responds **409** with a clear error; showError surfaces "A book already exists at that Author/Series/Title path."; the original folder on disk is unchanged.
13. **Empty workspace** → tree renders an empty state; "New book" CTA visible.
14. **Mock mode** → `getLibrary` returns `MOCK_LIBRARY` (`src/lib/api.ts:112-115`) — covers the same statuses; delete + reparse + edit are no-ops (mock `putBookState` just resolves).

## Loading affordance (initial app open)

The view renders one of three states based on `library.loaded` and
`authors.length`, in that order — never collapse this back into a binary check:

| `library.loaded` | `authors.length` | Renders                                                  |
| ---------------- | ---------------- | -------------------------------------------------------- |
| `false`          | (any)            | `<LibrarySkeleton/>` — placeholder shelves, no copy      |
| `true`           | `0`              | `<EmptyLibrary/>` — "Your library is empty" + import CTA |
| `true`           | `>0`             | populated author / series / book grid                    |

The skeleton mirrors the populated grid shape (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5`, `min-h-[180px]` cards) so the layout doesn't shift when real data swaps in. Reason for the `loaded` check: without it, the first paint flashes `<EmptyLibrary>` for the duration of the `api.getLibrary()` round-trip (mock = 120 ms; real backend = whatever the disk scan takes), reading as "library wiped." `library-slice.ts` always tracks `loaded`; `book-library.tsx` is the only consumer.

## Out of scope

- Search / filter inside the library — v1 is full tree only.
- Bulk delete or bulk re-parse.
- Drag-to-reorganise across series.
- Replicating the same skeleton pattern on the voices / cast / chapters lists. Their flash window is shorter (they only mount after a book is opened, by which time `library.loaded` is true). Copy this pattern if real flicker is reported on those surfaces.
