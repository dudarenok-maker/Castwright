/* Plain text + Markdown parser. Splits chapters on Markdown headings
   (#, ##), `Chapter N` lines, and a broader set of common chapter-equivalent
   markers (Day One, Part I, Prologue, etc.). Falls back to one chapter
   holding everything. */

import type { ChapterHint, ManuscriptFormat } from '../store/manuscripts.js';
import { tagMarkdownEmphasis, tagShoutingDialog } from './audio-tags.js';

/* Heading detection — built from three alternatives:
   1) Markdown H1/H2 (`# Foo` or `## Foo`).
   2) Numbered section: `<keyword> <number>` where number is Arabic, Roman,
      or English ordinal/cardinal up to ninety-nine. Covers `Chapter 3`,
      `Day Two`, `Part IV`, `Book Twenty-One`, `Act V`, etc.
   3) Standalone section markers that don't need a number: `Prologue`,
      `Epilogue`, `Interlude`, `Preface`, `Introduction`, `Afterword`,
      `Foreword`. The `\b` boundary avoids matching `Prologueia` etc.

   Length cap on the calling side (≤120 chars) keeps mid-paragraph lines
   that happen to start with one of these tokens from misfiring. */
const HEADING_KEYWORDS = '(?:chapter|day|part|book|act|section|scene)';
const NUMBER_WORDS = [
  'one','two','three','four','five','six','seven','eight','nine','ten',
  'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen',
  'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety','hundred',
].join('|');
/* Numbered-section number: Arabic digit, Roman numeral, or English word
   form (with optional compound for 21–99: "twenty-one", "thirty two", …). */
const NUMBER_PART = `(?:[ivxlcdm\\d]+|(?:${NUMBER_WORDS})(?:[-\\s](?:${NUMBER_WORDS}))?)`;
const STANDALONE_HEADINGS = '(?:prologue|epilogue|interlude|preface|introduction|afterword|foreword)';
const CHAPTER_HEADING_RE = new RegExp(
  `^(?:#{1,2}\\s+\\S|${HEADING_KEYWORDS}\\s+${NUMBER_PART}\\b|${STANDALONE_HEADINGS}\\b)`,
  'i',
);

/* Heading lines are short. Anything longer than this is almost certainly a
   sentence that just happens to begin with a heading-keyword token (e.g.
   "Day after day, she returned to the lighthouse..."). */
const MAX_HEADING_LEN = 120;

/* Strip cosmetic decoration that plaintext manuscripts often wrap around
   chapter markers: `+ DAY ONE +`, `=== Chapter 3 ===`, `*** Prologue ***`,
   `~~ Part I ~~`. Preserves `#` so markdown H1/H2 still match the regex's
   markdown branch. Symmetric strip on both ends. */
function normaliseHeading(line: string): string {
  return line
    .replace(/^[^A-Za-z0-9#]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');
}

/* Filename pattern used to auto-detect Author / Series / Position / Title.
   Matches `Author - Series 01 - Title.ext` and a few common variants. */
const FILENAME_RE = /^(?<author>.+?)\s+-\s+(?<series>.+?)\s+(?<pos>\d+)\s+-\s+(?<title>.+)$/;

export interface ParsedManuscript {
  format: ManuscriptFormat;
  title: string;
  sourceText: string;
  chapters: ChapterHint[];
  /** Best-effort metadata detected from filename / EPUB OPF. Null when not found. */
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
}

/** Pull `Author - Series N - Title` out of a filename. Returns nulls when the
    filename doesn't match. */
export function parseFilenameMetadata(fileName?: string): {
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
  title: string | null;
} {
  if (!fileName) return { author: null, series: null, seriesPosition: null, title: null };
  const stem = fileName.replace(/\.[^.]+$/, '').trim();
  const m = FILENAME_RE.exec(stem);
  if (!m?.groups) return { author: null, series: null, seriesPosition: null, title: null };
  return {
    author: m.groups.author?.trim() || null,
    series: m.groups.series?.trim() || null,
    seriesPosition: m.groups.pos ? parseInt(m.groups.pos, 10) : null,
    title: m.groups.title?.trim() || null,
  };
}

export function parseText(text: string, opts: { fileName?: string; format: 'markdown' | 'plaintext' }): ParsedManuscript {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const chapters: ChapterHint[] = [];
  let buf: string[] = [];
  let currentTitle = '';

  function flush() {
    const rawBody = buf.join('\n').trim();
    if (rawBody.length > 0) {
      const body = tagShoutingDialog(tagMarkdownEmphasis(rawBody));
      chapters.push({ id: chapters.length + 1, title: currentTitle || `Chapter ${chapters.length + 1}`, body });
    }
    buf = [];
  }

  for (const raw of lines) {
    const line = raw.trim();

    // First H1 captures the book title.
    if (!title && /^#\s+\S/.test(line)) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    /* Test against the decoration-stripped form so `+ DAY ONE +` and
       `=== Chapter 3 ===` are recognised. The original line length still
       gates false-positives (a long sentence wrapped in decoration would
       exceed MAX_HEADING_LEN and be ignored). */
    const norm = normaliseHeading(line);
    if (line.length <= MAX_HEADING_LEN && norm.length > 0 && CHAPTER_HEADING_RE.test(norm)) {
      flush();
      /* Preserve the heading text as the chapter title — the stripped form
         so `+ DAY ONE +` displays as `DAY ONE`, and `## Day One` as
         `Day One`. Falls back to `Chapter N` only when normalisation left
         nothing meaningful behind. */
      currentTitle = norm.replace(/^#{1,2}\s+/, '').trim() || `Chapter ${chapters.length + 1}`;
      continue;
    }

    buf.push(raw);
  }
  flush();

  if (chapters.length === 0) {
    // No headings at all — treat the whole thing as one chapter.
    const body = tagShoutingDialog(tagMarkdownEmphasis(text.trim()));
    chapters.push({ id: 1, title: title || (opts.fileName ?? 'Chapter 1'), body });
  }

  const fileMeta = parseFilenameMetadata(opts.fileName);

  if (!title) {
    title = fileMeta.title || opts.fileName?.replace(/\.[^.]+$/, '') || 'Untitled manuscript';
  }

  const sourceText = chapters.map(c => c.body).join('\n\n');
  return {
    format: opts.format,
    title,
    sourceText,
    chapters,
    author: fileMeta.author,
    series: fileMeta.series,
    seriesPosition: fileMeta.seriesPosition,
  };
}
