---
status: stable
shipped: 2026-05-18
owner: null
---

# MOBI / AZW3 manuscript upload support

> Status: stable
> Key files: `server/src/parsers/mobi.ts`, `server/src/parsers/html-utils.ts`,
> `server/src/parsers/index.ts`, `server/src/routes/import.ts`,
> `src/views/upload.tsx`, `src/lib/api.ts`, `openapi.yaml`
> URL surface: `#/new` (no new routes)
> OpenAPI ops: `POST /api/import`, `POST /api/books` (existing; format enum extended)

## Benefit / Rationale

- **User:** Kindle / Calibre users can drop `.mobi` and `.azw3` files straight
  into the upload screen. Previously they had to round-trip through Calibre
  → EPUB conversion before the analyzer could see the manuscript. One less
  manual step in the onboarding flow.
- **Technical:** Adds `@lingo-reader/mobi-parser` (handles both legacy MOBI
  / PalmDOC and KF8 / AZW3) and a small DRM detector so Kindle-Store
  purchases are rejected up-front with an actionable error message rather
  than producing an opaque parse failure deep inside the library.
- **Architectural:** Hoists `stripHtml` / `extractFirstHeading` /
  `GENERIC_NCX_RE` out of `epub.ts` into a shared `html-utils.ts` module
  so EPUB and MOBI use the same chapter-body normalisation and title-
  fallback logic. Reduces duplicate regex maintenance going forward.

## Architectural impact

- **New parser module.** `server/src/parsers/mobi.ts` mirrors the EPUB
  parser shape (spine → HTML → stripHtml + audio tags → `ChapterHint[]`).
  Dispatch via `server/src/parsers/index.ts` `EXT_TO_FORMAT` — same
  extension-driven pattern already used by EPUB / PDF / markdown.
- **DRM detection runs BEFORE the library is invoked.** The PalmDOC
  encryption byte is read from the buffer directly (no library dep, no
  parse round-trip). `DrmProtectedError` is exported from
  `parsers/index.ts` and mapped to HTTP 415 with
  `{ error: 'drm_protected', message }` body in
  `server/src/routes/import.ts:144`.
- **Original extension preserved on persist.** A `.azw3` upload writes
  to `manuscript.azw3` (not `manuscript.mobi`) so re-parse at hydrate
  time routes to `initKf8File` instead of `initMobiFile`. Logic at
  `server/src/routes/import.ts:208` switches on
  `entry.originalFileName` when format is `'mobi'`.
- **OpenAPI contract extended.** `ImportCandidate.format` and
  `UploadResponse.format` enums gain `mobi` (`.azw3` shares the `mobi`
  format value but persists with its own extension; the wire shape only
  cares about parser identity, not on-disk file type).
- **HTML-utils refactor.** `server/src/parsers/html-utils.ts` is the new
  shared home for `stripHtml`, `extractFirstHeading`, and
  `GENERIC_NCX_RE`. `epub.ts` imports them; `mobi.ts` imports them. This
  is a touch-shared-file refactor — no behaviour change in the EPUB
  path, locked by the existing `epub.test.ts` suite (14 cases).

## Invariants to preserve

- **DRM rejection is library-independent.** The encryption byte at
  PalmDOC header offset `0x0C` must be checked from the raw buffer
  before any `initMobiFile` / `initKf8File` call. Detector lives in
  `server/src/parsers/mobi.ts` (`readMobiEncryptionType`). Non-zero
  values throw `DrmProtectedError` (`server/src/parsers/mobi.ts`).
- **`.azw3` routes to KF8.** `server/src/parsers/mobi.ts` selects
  `initKf8File` when the filename extension is `.azw3`, otherwise
  `initMobiFile`. This decision happens AFTER the DRM check.
- **Original bytes persisted verbatim.** Same regression as EPUB
  (`server/src/routes/import.test.ts` "binary preservation"). Uploaded
  MOBI/AZW3 bytes must round-trip byte-for-byte to
  `manuscript.<ext>`.
- **Format enum sync.** `ManuscriptFormat` in
  `server/src/store/manuscripts.ts:12`, `EXT_TO_FORMAT` value type in
  `server/src/parsers/index.ts:11`, `EXT_BY_FORMAT` keys in
  `server/src/routes/import.ts:44`, the `format` enum in
  `openapi.yaml:1497` / `:1575`, and the `inferFormat` map in
  `src/lib/api.ts:65` all carry `'mobi'`. Any new format must touch all
  five.

## Test plan

### Automated coverage

- **Vitest server (`server/src/parsers/mobi.test.ts`) — 19 cases:**
  - DRM guard: encryption byte 1 / 2 throws `DrmProtectedError`; library
    is never invoked on the DRM path; encryption byte 0 proceeds.
  - Ext routing: `.mobi` → `initMobiFile`, `.azw3` → `initKf8File`,
    missing fileName falls back to `initMobiFile`.
  - Metadata: format `'mobi'`; library title wins over filename
    fallback; filename `Author - Series N - Title.mobi` populates
    author/series/seriesPosition/title; first author from author[]
    array.
  - Chapters: spine → chapter mapping; HTML stripping preserves visible
    text; `<em>` → `[emphatic]` audio tag; TOC labels as titles;
    generic TOC + descriptive `<h1>` merges to "Chapter 1 — Title";
    "Chapter N" fallback when neither TOC nor body heading present;
    empty-HTML spine entries skipped; throws when no chapter has body.
- **Vitest server (`server/src/routes/import.test.ts`) — 1 new case:**
  - `POST /api/import` with a hand-crafted DRM-flagged MOBI buffer →
    HTTP 415, body `{ error: 'drm_protected', message: /DRM-protected/ }`.
- **Vitest server (`server/src/parsers/epub.test.ts`) — unchanged.**
  Locks the html-utils refactor — same 14 cases pass after the move.
- **Frontend (`src/lib/api.ts`):** `inferFormat` is covered indirectly
  by the upload-flow snapshot tests; no new unit test specifically for
  the extension map is added (matches the existing pattern — there is
  no `inferFormat.test.ts` today).
- **E2E:** no Playwright spec added in this plan. Upload flow already
  lacks a dedicated e2e (covered indirectly by the canonical
  manuscript run). A future "E2E for upload flow including binary
  formats" item belongs on the BACKLOG, not this plan.

### Manual acceptance walkthrough

Run with the real server (`cd server && npm run dev`) and frontend
(`npm run dev`), not mocks — mocks bypass the parser entirely.

1. **Download a public-domain MOBI fixture.** Project Gutenberg #1342
   (*Pride and Prejudice*) is a good choice — ~600 KB, 61 chapters,
   well-formed metadata. Direct URL pattern:
   `https://www.gutenberg.org/cache/epub/1342/pg1342.epub` (PG no longer
   ships .mobi directly; use Calibre `ebook-convert pg1342.epub
   pg1342.mobi` to produce one). Same trick for AZW3:
   `ebook-convert pg1342.epub pg1342.azw3`.
2. **Drop the `.mobi`** on `#/new`. Expect: spinner → confirm-metadata
   screen showing title "Pride and Prejudice", author "Jane Austen",
   and 60+ chapters detected (PG MOBIs include a TOC-derived chapter
   tree).
3. **Click Confirm.** Expect: HTTP 201, stage transitions to
   `analysing`. Inspect `workspace/books/Jane Austen/Pride and
   Prejudice/manuscript.mobi` — bytes match the original MOBI
   (SHA-256-equal).
4. **Repeat with the `.azw3`.** Expect: same flow, persists to
   `manuscript.azw3` (extension preserved), chapter list may differ
   slightly because KF8 has its own spine structure.
5. **DRM negative path.** Try uploading a real Kindle-Store-purchased
   `.azw` file if one is available. Expect: HTTP 415 surfaced to the UI
   as "This file is DRM-protected (likely a Kindle Store purchase).
   Convert it with Calibre to a non-DRM format first…". The upload
   screen stays interactive and the file input is cleared.
6. **Unsupported-extension negative path.** Drop a `.docx`. Expect: the
   client-side error "DOCX files aren't supported. Try .md, .txt,
   .pdf, .epub, .mobi, or .azw3."

## Out of scope

- **`.azw` (pre-KF8 Kindle, pre-2012):** Same parser family but rare in
  real-world libraries. Can be added as a one-line `EXT_TO_FORMAT`
  extension if a user surfaces a need.
- **`.kfx` (Kindle's newest format, post-2015):** No Node library
  exists. Calibre needs a paid plugin for KFX itself. Permanently out
  of scope.
- **DRM removal:** Illegal under DMCA, not engineering work. The DRM
  detector explicitly tells the user to convert with Calibre instead.
- **Cover-image extraction:** MOBI carries a cover thumbnail at a
  record offset, but the post-import cover-fetch already uses Open
  Library / Google Books for covers (`server/src/cover/openlibrary.ts`).
  Skipping MOBI cover extraction is not a regression.
- **E2E for the binary-upload flow:** Backlog candidate. None of the
  existing binary formats (EPUB / PDF) has dedicated e2e coverage
  today; MOBI doesn't need to be the exception that sets a new bar.

## Ship notes

**Shipped 2026-05-18** in commit `64c42e4` (`feat(server,frontend,docs): plan 52 — MOBI/AZW3 upload support`), branch `feat/server+frontend-plan-52-mobi-support`, PR [#26](https://github.com/dudarenok-maker/AudioBook-Generator/pull/26).

**Spec deltas vs. the original plan write-up:**

- **Binary fixtures dropped.** The original plan called for a `sample.mobi` / `sample.azw3` / `sample-drm.mobi` checked into `server/src/parsers/__fixtures__/`. Mirrored the `pdf.test.ts` pattern instead — mock `@lingo-reader/mobi-parser` so the wrapper logic is exercised in isolation, and hand-craft DRM-flagged buffers inline. End-to-end MOBI parsing against a real Project Gutenberg file is the manual verification step + the deferred [BACKLOG #38 e2e item](../BACKLOG.md), not unit-test scope.
- **Original-extension preservation moved into the route layer.** `server/src/routes/import.ts:208-216` now switches `manuscript.<ext>` on `entry.originalFileName` when `format === 'mobi'`, so `.azw3` files round-trip as `manuscript.azw3` and re-parse correctly through `initKf8File`. The plan had flagged this as a parser concern; landed it in the route instead because the parser is extension-agnostic by design.
- **OpenAPI `format` enum extended in both `ImportCandidate` and `UploadResponse`.** The original plan only mentioned `ImportCandidate`; `UploadResponse` needed the same enum extension for `inferFormat`'s typed return to flow through `UploadResponse['format']`.

**Follow-ups landed as BACKLOG entries:**

- [Could #38 — E2E coverage for the binary-upload flow](../BACKLOG.md). Covers EPUB / PDF / MOBI / AZW3 in a single Playwright spec; depends on this plan shipping.

**Out-of-scope items NOT promoted to backlog** (documented for future-you so a hallway question doesn't re-litigate):

- `.azw` / `.azw1` (pre-KF8 Kindle): rare in real-world libraries; one-line `EXT_TO_FORMAT` extension if a user surfaces a need.
- `.kfx` (Kindle's newest format): no Node library exists. Permanently parked.
- DRM removal: illegal under DMCA.
- MOBI cover-image extraction: post-import cover-fetch already uses Open Library / Google Books.
