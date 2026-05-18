# Upload (paste or file)

> Status: stable
> Key files: `src/views/upload.tsx`, `src/lib/api.ts` (`uploadManuscript`, `inferFormat`)
> URL surface: `#/new`
> OpenAPI ops: `POST /api/manuscripts`

## What this covers

The upload screen accepts either inline pasted text or a binary file drop (`.md/.markdown/.txt/.text/.epub/.pdf/.mobi/.azw3`). Format is inferred from filename extension; word count and byte size are computed locally for previewing. On submit, the server stores the manuscript and the app transitions to the analysing stage.

MOBI / AZW3 parsing is owned by [`52-mobi-parsing.md`](52-mobi-parsing.md) — that
plan covers the parser module, DRM detection, and the extension-preserving
persist path. This plan owns the upload UI surface only.

## Invariants to preserve

- `UploadArgs` requires `text` OR `file`; both real and mock throw "requires either `text` or `file`" if neither is supplied (`src/lib/api.ts:336, 394`).
- `inferFormat` recognises extensions `md|markdown|txt|text|epub|pdf|mobi|azw3` only (`src/lib/api.ts:65-78`). Unknown extensions return `null` and fall through to `'markdown'` default. `.azw3` maps to format `'mobi'` (shared parser identity); the original extension is preserved on persist by `server/src/routes/import.ts`, not by `inferFormat`.
- Word count = `text.trim().split(/\s+/).filter(Boolean).length`. Byte size = `file.size` for files, `new Blob([text]).size` for paste. These are computed client-side for preview; the server may recompute its own canonical value.
- The view never imports `mockXxx`/`realXxx` directly — it goes through `api.uploadManuscript` only (see `23-mock-toggle.md`).
- On successful upload, dispatches `manuscriptUploaded({ bookId, manuscriptId })` which transitions stage `'upload' → 'analysing'` (guarded by `ui-slice.ts:61-64`).

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`. Open `#/new`.

1. **Paste a single paragraph** (e.g. "The morning broke over the cliffs.") → word count "5 words" appears below the textarea. Byte size matches `Blob` length.
2. **Click Continue with no text and no file** → button stays disabled (or surfaces an inline error). API is not called.
3. **Drop a `.txt` file** → format reads "plaintext". Word count populates from file contents (after read). **Drop a `.pdf`** → format reads "pdf". **Drop a `.unknownext` file** → format falls back to `'markdown'`.
4. **Drop a `.md` file containing `# Northern Star\n\nText…`** → preview title shows "Northern Star" (H1 heuristic; `mockUploadManuscript` matches `^#\s+(.+)$` on first line; `src/lib/api.ts:182-184`).
5. **Click Continue** → `POST /api/manuscripts` fires (FormData if file, JSON if text). Response carries `manuscriptId, format, title, wordCount, byteSize, uploadedAt, sourceText`.
6. **Stage transition** → URL becomes `#/books/<bookId>/analysing` (mock generates `bookId` server-side after analysis starts; the immediate transition uses `manuscriptUploaded` with `manuscriptId` only, then analyse → confirm assigns the canonical `bookId`).
7. **Server-side error (force `res.ok = false`)** → frontend throws `Error('Upload failed (<status>): <body>')`. UI surfaces the error inline; user can retry without losing their pasted text.

## Out of scope

- File parsing/extraction (EPUB unzip, PDF text extraction) — that's server-side, covered by the analyser plans implicitly.
- Drag-and-drop visual styling.
- Multi-file uploads — v1 is single-file only.
