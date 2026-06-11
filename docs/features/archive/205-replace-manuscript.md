---
status: stable
shipped: 2026-06-11
owner: null
---

# Replace manuscript on an existing book

> Status: stable
> Key files: `server/src/routes/book-state.ts` (`applyReparse` + `POST /:bookId/replace-manuscript`), `src/lib/api.ts` (`replaceManuscript`), `src/components/library/library-grid.tsx`, `src/components/library/library-table.tsx`, `src/views/book-library.tsx`, `src/routes/index.tsx`
> URL surface: library card/row menu → "Replace manuscript…" (indirect — no hash route)
> OpenAPI ops: `POST /api/books/{bookId}/replace-manuscript` (multipart `file`)

## Benefit / Rationale

- **User:** revise a manuscript on a book you've already cast — upload the new file in place, keep your designed voices. Previously the only way to change manuscript *content* was delete + re-upload, which threw away every designed Qwen voice / reuse link. (The existing `reparse` re-ran the parser on the *unchanged* on-disk file; it could not take a new file.)
- **Technical:** the post-parse half of `reparse` is now a shared `applyReparse()` core, so replace and reparse cannot drift apart. Replace is reparse with a new file written to disk first.
- **Architectural:** Wave 1 of the fs-22 bundled-demo-book initiative (`docs/superpowers/specs/2026-06-11-fs22-bundled-demo-book-design.md`) — the capability used to fold the revised demo manuscript onto the existing workspace book while preserving its 5 designed voices, before freezing it into the bundle.

## Architectural impact

- **New seam:** `applyReparse(bookDir, state, parsed, { changeLogType, changeLogTitle })` in `book-state.ts` — the single post-parse routine both `reparse` and `replace-manuscript` call. Extracted behaviour-neutral; the existing reparse suite (15 cases) is the guard.
- **New endpoint:** `POST /api/books/:bookId/replace-manuscript` (multer memory storage, 50 MB cap, mirrors `/api/import`). Writes `manuscript.<ext>` from the parsed format, deletes the old file when the extension changes, updates `state.manuscriptFile`, then delegates to `applyReparse`.
- **Invariant preserved (srv-13 / plan 126):** designed voices survive via the `cast-reuse-carryover.json` snapshot — character-keyed, so it's robust to heavy chapter/sentence restructuring. cast.json itself is cleared (clean chapter-keyed slate); voices rehydrate at the next analysis's `priorCastForMerge` fallback for characters that still match.
- **Book identity preserved:** bookId, dir, title/author/series, cover, and the `ManuscriptRecord` registration are untouched. Parsed title/author from the new file are intentionally ignored — replace is NOT a re-import (it never moves or renames the book).
- **Reversibility:** the feature is additive (new endpoint + menu item). Removing it leaves `reparse` working via the shared core.

## Invariants to preserve

- `applyReparse` must remain the ONLY post-parse path — do not re-inline chapter regen / carryover / cleanup into either route (`server/src/routes/book-state.ts`).
- Replace must keep `state.bookId`, `state.manuscriptId`, `state.title/author/series`, and the cover untouched; only `manuscriptFile`, `chapters`, `chapterTitleParserVersion`, `castConfirmed:false`, `updatedAt` change.
- Old manuscript file is removed only when `oldFile !== newFile && existsSync(oldFile)` — a same-extension replace overwrites in place and must NOT unlink.
- `castConfirmed` is reset to `false` (cast keys to chapters; force re-confirm). The frontend handler must clear the cast + manuscript redux slices so a stale open-book view can't show pre-replace state.

## Test coverage

- **Server:** `server/src/routes/book-state.replace-manuscript.test.ts` — chapter replacement + `castConfirmed` reset; designed-voice carryover snapshot before cast.json clear; extension swap + old-file removal + `manuscriptFile` update; 404 (unknown book); 400 (no file).
- **Server (guard):** `server/src/routes/book-state.reparse.test.ts` (15 cases) stays green — proves the `applyReparse` extraction was behaviour-neutral.
- **Frontend:** `src/components/library/library-table.test.tsx` — menu → "Replace manuscript…" → file upload → confirm → `onReplaceManuscript(book, file)`.
- **E2E:** `e2e/replace-manuscript.spec.ts` — browser golden path (menu → hidden input → confirm → "Manuscript replaced" dialog).

## Manual acceptance walkthrough

1. Open a book that has designed voices (e.g. The Coalfall Commission with its 5 Qwen voices).
2. Library card/row menu → "Replace manuscript…" → pick the revised file → confirm the destructive dialog.
3. The book reopens to the analysing stage; after analysis, the surviving characters (by name/stable-id) still carry their designed voices; new characters come up un-voiced.
4. Confirm the cast and generate — preserved voices render without re-design.

## Ship notes

Shipped 2026-06-11 on branch `feat/fs-replace-manuscript` (Wave 1 of fs-22). Commits: `bd662482` (extract `applyReparse`), `6203001c` + `0aa93bd5` (endpoint + EXT-map hoist), `26f1ef51` (api client), `a3f76154` (menu + confirm + handler), `8dee556b` (e2e).
