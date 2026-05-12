# Book library

> Status: stable
> Key files: `src/views/book-library.tsx`, `src/store/library-slice.ts` (`hydrate`), `src/lib/api.ts` (`getLibrary`, `deleteBook`, `reparseBook`), `server/src/routes/library.ts`, `server/src/routes/books.ts`
> URL surface: `#/`
> OpenAPI ops: `GET /api/library`, `DELETE /api/books/:bookId`, `POST /api/books/:bookId/reparse`

## What this covers

Home view that scans the on-disk workspace (`books/<Author>/<Series>/<Title>/`) and renders a hierarchical author → series → book tree. Each book carries a derived status (analysing / cast_pending / generating / complete / unreadable / orphaned). Clicking a book routes to the correct stage based on status. Supports per-book delete and re-parse.

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
- Coverage gradient is a `[string, string]` tuple per `Voice.gradient` style; the row card renders both stops.

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=false`, server on `:8080` with at least one book per status in the workspace.

1. **Land on `#/`** → tree renders: authors expandable, series expandable, books inline with title + status badge + chapter/character/voice counts.
2. **Click a `not_analysed` book** → URL becomes `#/books/<id>/cast`.
3. **Click an `analysing` book** → URL becomes `#/books/<id>/analysing`; SSE stream resumes (or restarts).
4. **Click a `cast_pending` book** → URL becomes `#/books/<id>/confirm`.
5. **Click a `complete` book** → URL becomes `#/books/<id>/listen`.
6. **Click a `generating` book** → URL becomes `#/books/<id>/generate`.
7. **Delete a book** → confirm dialog → DELETE fires → tree refreshes without the book; no broken neighbours; if last book in series, series collapses; if last series for author, author collapses.
8. **Re-parse a book** → `POST /api/books/<id>/reparse` fires; response carries the new chapter list; UI transitions to analysing (cast preserved, chapters refreshed).
9. **Empty workspace** → tree renders an empty state; "New book" CTA visible.
10. **Mock mode** → `getLibrary` returns `MOCK_LIBRARY` (`src/lib/api.ts:112-115`) — covers the same statuses; delete + reparse are no-ops.

## Out of scope

- Search / filter inside the library — v1 is full tree only.
- Bulk delete or bulk re-parse.
- Drag-to-reorganise across series.
