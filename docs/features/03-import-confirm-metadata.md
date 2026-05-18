# Import & confirm metadata

> Status: stable
> Key files: `src/views/confirm-metadata.tsx`, `src/modals/confirm-dialog.tsx`, `src/lib/api.ts` (`importManuscript`, `confirmBook`), `server/src/parsers/{epub,pdf,text}.ts`, `server/src/parsers/version.ts`, `server/src/routes/book-state.ts` (`refreshChapterTitles`)
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

## Chapter title extraction

Three parser improvements feed the chapter list shown in the confirm
dialog (and every "CH NN · {title}" surface downstream). All run
server-side; the client just consumes the resulting `chapters[].title`.

- **Text / Markdown** (`server/src/parsers/text.ts`): when a heading is
  a bare `Chapter 3` / `Day Two` / `Prologue` (no descriptive text),
  the parser looks ahead to the next non-empty line. If it passes the
  `looksLikeTitle` heuristic (title-case-with-stopwords, ≤ 80 chars, no
  terminal `.`/`!`), the title is merged as `Chapter 3 — The
Beginning` and the subtitle line is consumed so it doesn't bleed
  into the chapter body. Headings already carrying descriptive text
  (`Chapter 3: The Beginning`, `## Day One`) are left alone.

- **EPUB** (`server/src/parsers/epub.ts`): NCX/spine `entry.title`
  remains the primary source, but the parser also extracts the first
  `<h1>`/`<h2>`/`<h3>` from the chapter HTML before stripping tags.
  When NCX is empty → body heading wins. When NCX is generic (regex
  `/^chapter\s+\w+\s*$/`) and the body heading is descriptive → merge
  as `Chapter 1 — The Berth at Liverpool`. Descriptive NCX always
  wins (authored metadata is trusted).

- **PDF** (`server/src/parsers/pdf.ts`): in addition to the text-based
  pipeline (pdf-parse → parseText, with the subtitle merge above), the
  parser reads the PDF's top-level outline via `pdfjs-dist`. Front-
  matter entries (Copyright, Acknowledgements, …) are filtered via
  `front-matter.ts`. When the filtered outline count equals the
  parseText chapter count, titles are replaced in order. Count
  mismatches keep the parseText titles — better an imperfect title
  than misalignment.

### Backfill for existing books — non-destructive title refresh

Books imported before the parser version bumped continue to show their
old "Chapter 1" labels until something touches them. To avoid forcing
users through the destructive re-parse path (which wipes cast,
revisions, audio, and analysis), the book-state GET handler runs
`refreshChapterTitles` transparently when
`state.chapterTitleParserVersion < CHAPTER_TITLE_PARSER_VERSION`:

1. Read the saved source from `bookDir/state.manuscriptFile`.
2. Run `parseManuscript`.
3. If the new chapter count matches the existing count, replace ONLY
   `chapters[i].title` (slug, excluded, audioModelKey, audioRenderedAt
   stay put). Audio files, cast.json, revisions.json, analysis cache,
   and manuscript-edits.json are all untouched.
4. Bump `chapterTitleParserVersion` and atomic-write state.json.

Skips refresh silently (no crash, no version bump) when source is
missing, parsing throws, or chapter counts differ. Mismatched counts
preserve titles AND leave the version field as-is so a future fix can
retry. Fresh imports stamp the current version in `import.ts` so they
short-circuit on first read.

### Render-side dedupe

Stored titles now sometimes carry the chapter number ("Chapter 3 —
The Beginning"). UI sites that prefix their own "CH NN" should run the
title through `stripChapterPrefix` from
`src/lib/format-chapter-title.ts` so the user doesn't see "CH 03 ·
Chapter 3 — The Beginning". Adopted in mini-player, regenerate,
revision-diff, drift-report, character-regenerate, generation (two
sites), preview-listener, listen, and manuscript (two sites).

## Out of scope

- Cover art selection — covers are auto-generated gradients (`Voice.gradient` tuple), no upload UI.
- Author/series renaming after confirm — handled by re-parse flow, not import.
- Bulk import — v1 is single-file.
