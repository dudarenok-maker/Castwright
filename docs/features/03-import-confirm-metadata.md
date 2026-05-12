# Import & confirm metadata

> Status: stable
> Key files: `src/views/confirm-metadata.tsx`, `src/modals/confirm-dialog.tsx`, `src/lib/api.ts` (`importManuscript`, `confirmBook`)
> URL surface: between `#/new` and `#/books/:bookId/analysing` (modal overlay)
> OpenAPI ops: `POST /api/import`, `POST /api/books`

## What this covers

Two-step write to the workspace: `POST /api/import` parses a manuscript in memory and returns detected metadata (`tempId`, candidate `{title, author, series, seriesPosition, sourceText, wordCount, byteSize, chapters[]}`); the user edits fields in a dialog; `POST /api/books` confirms and writes to disk under `books/<Author>/<Series>/<Title>/`. Filename heuristic `"<author> - <series> <pos> - <title>"` pre-fills the dialog.

## Invariants to preserve

- `realImportManuscript` does not write to disk; only `realConfirmBook` does (`src/lib/api.ts:318-336`, `353-365`).
- 409 from `POST /api/books` is translated into `SlugCollisionError` carrying `suggestedTitle` (`src/lib/api.ts:359-362, 367-374`). The dialog must surface the suggested title, not a generic "duplicate" error.
- Filename heuristic regex: `/^(?<author>.+?)\s+-\s+(?<series>.+?)\s+(?<pos>\d+)\s+-\s+(?<title>.+)$/` against the filename stem (`src/lib/api.ts:131-133`). H1 from sourceText takes precedence over filename for `title`.
- `isStandalone: true` → server stores under `Standalones` directory regardless of `series` field (`mockConfirmBook` mirrors this at `src/lib/api.ts:160`).
- `ConfirmBookResponse.paths` carries the on-disk paths (`bookDir`, `manuscript`, `dotAudiobook`) the user may need to see for troubleshooting.

## Acceptance walkthrough

Run with both `VITE_USE_MOCKS=false` (server on `:8080`) and `VITE_USE_MOCKS=true` for the mock-only steps.

1. **Drop file `Dudarenok - Northern Star 1 - The Cliff.md`** → import fires → dialog opens with `author='Dudarenok'`, `series='Northern Star'`, `seriesPosition=1`, `title='The Cliff'`.
2. **Drop file `random.txt` containing `# Frostfall\n…`** → dialog opens with `title='Frostfall'`, `author=null`, `series=null`, `seriesPosition=null`.
3. **Toggle "Standalone"** → series field disables (or shows "Standalones"). Confirm → `POST /api/books { isStandalone: true, series: <ignored> }`; response has `series='Standalones'`.
4. **Confirm with title that collides with an existing book** (run twice in real mode) → second confirm rejects with 409. Frontend catches `SlugCollisionError`; dialog shows "A book with this title already exists. Try: <suggestedTitle>" and offers a one-click accept.
5. **Accept the suggested title** → confirm fires again with the new title; succeeds; response carries `bookId` and `paths`.
6. **Stage transition** → on success the app transitions to `#/books/<bookId>/analysing`.
7. **Mock mode** — `mockConfirmBook` always succeeds (no real collision detection); `paths` are `'(mock)'` (`src/lib/api.ts:172-175`). Treat this as the documented mock divergence.

## Out of scope

- Cover art selection — covers are auto-generated gradients (`Voice.gradient` tuple), no upload UI.
- Author/series renaming after confirm — handled by re-parse flow, not import.
- Bulk import — v1 is single-file.
