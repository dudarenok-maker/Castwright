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
