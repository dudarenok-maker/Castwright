/* Bumped when the title-extraction parsers change in a way that could
   produce different chapter titles for an existing manuscript.

   Books on disk carry their last-seen version in
   `BookStateJson.chapterTitleParserVersion`. When that field is missing
   or lower than `CHAPTER_TITLE_PARSER_VERSION`, the book-state GET
   handler runs a non-destructive title refresh: parses the saved
   source file, replaces chapter titles (preserving slug, excluded
   flag, audio, analysis, etc.), and bumps the version. See
   `server/src/routes/book-state.ts` → `refreshChapterTitles`.

   History:
   - 1: pre-improvement (NCX-only EPUB titles, parseText-only PDF
        titles, no subtitle merge). Implicit when the field is absent.
   - 2: subtitle merge in text/markdown, EPUB <h1>/<h2> body fallback,
        PDF outline-based title replacement. */
export const CHAPTER_TITLE_PARSER_VERSION = 2;

/* Which extraction a manuscript's source file is read with (#4217). Unlike
   `CHAPTER_TITLE_PARSER_VERSION` this stamp PINS: a book keeps the extraction
   it was imported with, because persisted sentence offsets index into the
   extracted text. The value is threaded as the `extractorVersion` option from
   `parseManuscript` down to `stripHtml` and the raw-zip EPUB reader.

   History:
   - 1: the extraction before #4217. Implicit when the field is absent: only
        `</p>`, `<br>` and `<hr>` break, and raw-zip EPUB `href`/`src` values
        are not entity-decoded.
   - 2: #4217: the named block closers break paragraphs; raw-zip `href`/`src`
        are XML-entity-decoded (child 3). */
export const LEGACY_EXTRACTOR_VERSION = 1;
export const MANUSCRIPT_EXTRACTOR_VERSION = 2;

/* The extractor version a book's source file is implicitly re-read with: its
   `state.json` stamp, or 1 when the stamp is absent (every pre-#4217 book). */
export function extractorVersionOf(state: { manuscriptExtractorVersion?: number }): number {
  return state.manuscriptExtractorVersion ?? LEGACY_EXTRACTOR_VERSION;
}
