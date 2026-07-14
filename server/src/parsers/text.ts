/* Plain text + Markdown parser. Splits chapters on Markdown headings
   (#, ##), `Chapter N` lines, and a broader set of common chapter-equivalent
   markers (Day One, Part I, Prologue, etc.). Falls back to one chapter
   holding everything. */

import type { ChapterHint, ManuscriptFormat } from '../store/manuscripts.js';
import {
  tagExcitedDialog,
  tagHesitantDialog,
  tagMarkdownEmphasis,
  tagShoutingDialog,
} from './audio-tags.js';
import { nonEnglishHeadingLexicon } from '../tts/language-registry.js';
import { hasCjkChar } from '../util/cjk.js';

/* Heading detection — built from three alternatives:
   1) Markdown H1/H2 (`# Foo` or `## Foo`).
   2) Numbered section: `<keyword> <number>` where number is Arabic, Roman,
      or English ordinal/cardinal up to ninety-nine. Covers `Chapter 3`,
      `Day Two`, `Part IV`, `Book Twenty-One`, `Act V`, etc.
   3) Standalone section markers that don't need a number: `Prologue`,
      `Epilogue`, `Interlude`, `Preface`, `Introduction`, `Afterword`,
      `Foreword`. The `\b` boundary avoids matching `Prologueia` etc.

   Length cap on the calling side (≤120 chars) keeps mid-paragraph lines
   that happen to start with one of these tokens from misfiring.

   Non-English keywords from the language registry are unioned in so that
   Capítulo/Kapitel/Глава etc. split chapters without knowing the language
   at parse time. */

/* Union of English + non-English alternatives for language-agnostic parsing. */
const NE_LEX = nonEnglishHeadingLexicon();
const ALL_HEADING_KEYWORDS = [
  ...['chapter', 'day', 'part', 'book', 'act', 'section', 'scene'],
  ...NE_LEX.keywords,
].join('|');
const ALL_NUMBER_WORDS = [
  'one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen',
  'fifteen','sixteen','seventeen','eighteen','nineteen','twenty','thirty','forty','fifty','sixty','seventy',
  'eighty','ninety','hundred',
  ...NE_LEX.numberWords,
].join('|');

/* `ALL_STANDALONE_TERMS` is every standalone-heading word across every
   registry language (Latin/Cyrillic AND CJK) — used as-is by
   `BARE_STANDALONE_HEADING_RE` below, which anchors on `\s*$` and so has no
   trouble with CJK codepoints. `CHAPTER_HEADING_RE`'s standalone alternative
   is different: it anchors with `\b`, and `\b` is ASCII-\w-based — it never
   borders a Han/Kana codepoint, so a CJK term placed there can never match
   (issue #1576). Split the union in two: `ALL_STANDALONE` (Latin/Cyrillic
   only) feeds the `\b`-bounded alternative; the CJK subset is folded into
   the whole-line-anchored `CJK_STANDALONE` alternative instead, which uses
   `CJK_SEP` (whitespace/separator/end-of-line) rather than `\b`. */
const ALL_STANDALONE_TERMS = [
  'prologue','epilogue','interlude','preface','introduction','afterword','foreword',
  ...NE_LEX.standalone,
];
const ALL_STANDALONE = ALL_STANDALONE_TERMS.filter((s) => !hasCjkChar(s)).join('|');

/* Numbered-section number: Arabic digit, Roman numeral, or English/non-English word
   form (with optional compound for 21–99: "twenty-one", "thirty two", …). */
const NUMBER_PART = `(?:[ivxlcdm\\d]+|(?:${ALL_NUMBER_WORDS})(?:[-\\s](?:${ALL_NUMBER_WORDS}))?)`;

/* CJK (zh/ja) chapter headings are the CIRCUMFIX `第<number>章` — keyword
   *after* the number, no whitespace between them, and kanji/fullwidth
   numerals that NUMBER_PART doesn't cover. The Latin `KEYWORD \s NUMBER`
   shape above can never match this, so it needs its own alternative.

   MUST be whole-line anchored: the number+ender must be followed by
   end-of-line or a separator, never arbitrary prose. A naive prefix match
   (`^第[…]+[章話…]`) also matches mid-sentence text like `第三章で述べたよう
   に…` ("as stated in chapter 3…") and compounds like `第二部隊が丘を…`
   (第N部隊 = "the Nth squad") — and parseText deletes a matched line as the
   chapter title, silently eating prose. The lookahead below caps the whole
   line at CJK_HEADING_MAX_LEN chars (a real CJK heading is short) and the
   trailing group only allows a separator or end-of-string right after the
   ender character, so a continuation like `で`/`が`/`隊` fails the match. */
const CJK_HEADING_MAX_LEN = 20;
const CJK_NUMBER = '[0-9０-９〇一二三四五六七八九十百千]+';
const CJK_ENDER = '[章話回節部幕巻]'; // 章話回節部幕巻
const CJK_SEP = '(?:[\\s：:—-]|$)'; // whitespace, fullwidth/halfwidth colon, em-dash, hyphen, or end-of-line
/* Base full-form CJK standalone headings, unioned with the CJK subset of
   the registry's per-language `headingLexicon.standalone` (issue #1576) —
   single-token terms like 序/跋 (zh) and あとがき/前書き (ja) that can only
   ever reach a chapter split through this whole-line-anchored alternative,
   never the `\b`-bounded `ALL_STANDALONE` above. */
const CJK_STANDALONE_TERMS = [
  ...new Set(['序章', '終章', 'プロローグ', 'エピローグ', ...ALL_STANDALONE_TERMS.filter(hasCjkChar)]),
];
const CJK_STANDALONE = CJK_STANDALONE_TERMS.join('|'); // 序章|終章|プロローグ|エピローグ|序|跋|あとがき|前書き
const CJK_HEADING_ALT = `(?=.{1,${CJK_HEADING_MAX_LEN}}$)(?:第${CJK_NUMBER}${CJK_ENDER}${CJK_SEP}|(?:${CJK_STANDALONE})${CJK_SEP})`; // 第<number><ender>

const CHAPTER_HEADING_RE = new RegExp(
  `^(?:#{1,2}\\s+\\S|(?:${ALL_HEADING_KEYWORDS})\\s+${NUMBER_PART}\\b|(?:${ALL_STANDALONE})\\b|${CJK_HEADING_ALT})`,
  'iu',
);

/* "Bare" heading detection — used to decide whether to look ahead for a
   subtitle on the next non-empty line. A bare heading is just `Chapter 3`,
   `Day Two`, or `Prologue` with no descriptive text; books commonly put
   the chapter name on a separate line below. A heading like
   `Chapter 3: The Beginning` is already self-descriptive — no merge. */
const BARE_NUMBERED_HEADING_RE = new RegExp(
  `^(?:${ALL_HEADING_KEYWORDS})\\s+${NUMBER_PART}\\s*$`,
  'iu',
);
/* Uses the FULL (Latin/Cyrillic + CJK) term union, not the `\b`-bounded
   `ALL_STANDALONE` above — this pattern anchors on `\s*$`, which has no
   CJK boundary problem, so a CJK bare heading (`序`, `跋`, …) still needs
   to be recognised here. */
const BARE_STANDALONE_HEADING_RE = new RegExp(
  `^(?:${ALL_STANDALONE_TERMS.join('|')})\\s*$`,
  'iu',
);

/* Cap on subtitle line length. Real chapter names rarely exceed 80 chars;
   anything longer is almost certainly a body sentence. Re-used by the
   first-line-promotion path in chapters/refresh-titles (plan 70b). */
export const MAX_SUBTITLE_LEN = 80;

/* Words that are conventionally lowercased mid-title. A title-cased
   candidate is allowed to drop these without disqualifying. */
const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'at',
  'in',
  'on',
  'by',
  'to',
  'for',
  'but',
  'with',
  'from',
  'into',
  'over',
  'under',
  'as',
  'vs',
  'via',
]);

/* A subtitle must "look like a title" — first word capitalised, every
   subsequent word either capitalised or a known stopword. Rules out body
   prose like "First body" (capital + lowercase non-stopword) without
   rejecting real titles like "The Cook's Particular Soup" or "Storms,
   In Practice". Numeric/punctuation-only tokens are skipped. */
export function looksLikeTitle(s: string): boolean {
  const words = s.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
    if (word.length === 0) continue;
    const first = word[0];
    if (/\p{Lu}/u.test(first)) continue; // uppercase letter (any script)
    if (/\p{Nd}/u.test(first)) continue; // decimal digit
    if (i === 0) return false;
    if (TITLE_STOPWORDS.has(word.toLowerCase())) continue;
    return false;
  }
  return true;
}

/* Heading lines are short. Anything longer than this is almost certainly a
   sentence that just happens to begin with a heading-keyword token (e.g.
   "Day after day, she returned to the lighthouse..."). */
const MAX_HEADING_LEN = 120;

/* Strip cosmetic decoration that plaintext manuscripts often wrap around
   chapter markers: `+ DAY ONE +`, `=== Chapter 3 ===`, `*** Prologue ***`,
   `~~ Part I ~~`. Preserves `#` so markdown H1/H2 still match the regex's
   markdown branch. Symmetric strip on both ends. */
function normaliseHeading(line: string): string {
  return line.replace(/^[^\p{L}\p{N}#]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
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
  /** True when series / seriesPosition came from a title-parenthetical
      heuristic (parseSeriesFromTitle) rather than authoritative metadata
      (Calibre OPF tags or filename). The frontend surfaces this as a
      "auto-extracted from title — verify" chip on the confirm screen so
      the user knows the value is a guess and can override. */
  seriesFromTitle: boolean;
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

/* Conservative title-parenthetical heuristic for series extraction.
   Matches `(<series> Book N)` or `(<series> #N)` at the end of a title,
   case-insensitive, decimal positions allowed for novellas (e.g. 1.5).
   Anything else passes through untouched — keeps false-positives low on
   ordinary subtitles like "(Revised Edition)" or "(A Novel)". */
const SERIES_FROM_TITLE_RE =
  /^(?<title>.+?)\s*\((?<series>.+?)\s+(?:Book|#)\s*(?<pos>\d+(?:\.\d+)?)\)\s*$/i;

/** Try to split a `(Series Book N)` / `(Series #N)` suffix off the title.
    Returns the cleaned title and the extracted series/seriesPosition on
    a hit; otherwise the input title passes through and series is null. */
export function parseSeriesFromTitle(rawTitle: string): {
  title: string;
  series: string | null;
  seriesPosition: number | null;
} {
  const trimmed = rawTitle.trim();
  const m = SERIES_FROM_TITLE_RE.exec(trimmed);
  if (!m?.groups) return { title: trimmed, series: null, seriesPosition: null };
  return {
    title: m.groups.title!.trim(),
    series: m.groups.series!.trim(),
    seriesPosition: parseFloat(m.groups.pos!),
  };
}

/* Look ahead from `startIdx` for a line that looks like a chapter
   subtitle following a bare numbered/standalone heading. Skips blank
   lines, then validates the next non-empty line.

   Returns { text, consumedIndex } on hit (caller advances past
   consumedIndex so the subtitle doesn't bleed into the chapter body),
   or null when no subtitle is detected.

   Heuristics — a candidate qualifies as a subtitle when it is:
   - ≤ MAX_SUBTITLE_LEN chars
   - Not itself a chapter heading (don't eat the next chapter)
   - Doesn't end with `.` or `!` (those signal a full sentence). `?`
     and `:` are allowed — chapter titles like "Who Killed Roger
     Ackroyd?" and "An Encounter: First Light" are legitimate.
   - Looks like a title (title-case-with-stopwords rule — see
     `looksLikeTitle`). This is the key filter that distinguishes a
     real subtitle from a sentence that happens to be short. */
function findSubtitle(
  lines: string[],
  startIdx: number,
): { text: string; consumedIndex: number } | null {
  let i = startIdx;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return null;
  const candidate = lines[i].trim();
  if (candidate.length === 0 || candidate.length > MAX_SUBTITLE_LEN) return null;
  const norm = normaliseHeading(candidate);
  if (norm.length > 0 && CHAPTER_HEADING_RE.test(norm)) return null;
  if (/[.!]$/.test(candidate)) return null;
  if (!looksLikeTitle(candidate)) return null;
  return { text: candidate, consumedIndex: i };
}

export function parseText(
  text: string,
  opts: { fileName?: string; format: 'markdown' | 'plaintext' },
): ParsedManuscript {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const chapters: ChapterHint[] = [];
  let buf: string[] = [];
  let currentTitle = '';

  function flush() {
    const rawBody = buf.join('\n').trim();
    if (rawBody.length > 0) {
      const body = tagHesitantDialog(
        tagExcitedDialog(tagShoutingDialog(tagMarkdownEmphasis(rawBody))),
      );
      chapters.push({
        id: chapters.length + 1,
        title: currentTitle || `Chapter ${chapters.length + 1}`,
        body,
      });
    }
    buf = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
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
      const headingText = norm.replace(/^#{1,2}\s+/, '').trim() || `Chapter ${chapters.length + 1}`;
      /* Subtitle merge: when the heading is a "bare" numbered or
         standalone form (just `Chapter 3` or `Prologue` with nothing
         after), look at the next non-empty line. If it passes the
         subtitle heuristics, merge into `Chapter 3 — The Beginning`
         and consume the subtitle line so it doesn't show up in body.
         Headings that already carry descriptive text
         (`Chapter 3: The Beginning`, markdown `## Day One`) are left
         alone. */
      if (
        BARE_NUMBERED_HEADING_RE.test(headingText) ||
        BARE_STANDALONE_HEADING_RE.test(headingText)
      ) {
        const subtitle = findSubtitle(lines, i + 1);
        if (subtitle) {
          currentTitle = `${headingText} — ${subtitle.text}`;
          i = subtitle.consumedIndex;
          continue;
        }
      }
      currentTitle = headingText;
      continue;
    }

    buf.push(raw);
  }
  flush();

  if (chapters.length === 0) {
    // No headings at all — treat the whole thing as one chapter.
    const body = tagHesitantDialog(
      tagExcitedDialog(tagShoutingDialog(tagMarkdownEmphasis(text.trim()))),
    );
    chapters.push({ id: 1, title: title || (opts.fileName ?? 'Chapter 1'), body });
  }

  const fileMeta = parseFilenameMetadata(opts.fileName);

  if (!title) {
    title = fileMeta.title || opts.fileName?.replace(/\.[^.]+$/, '') || 'Untitled manuscript';
  }

  /* Series-extraction priority (Bug B): authoritative filename metadata
     wins; otherwise try the title-parenthetical heuristic so a markdown
     H1 like "The Tidewatcher’s Oath (The Hollow Tide Book 3)" still yields
     series + seriesPosition. Strips the parenthetical off the title on
     a hit so the saved manuscript title is clean. */
  let resolvedSeries = fileMeta.series;
  let resolvedSeriesPosition = fileMeta.seriesPosition;
  let seriesFromTitle = false;
  if (!resolvedSeries) {
    const fromTitle = parseSeriesFromTitle(title);
    if (fromTitle.series) {
      title = fromTitle.title;
      resolvedSeries = fromTitle.series;
      resolvedSeriesPosition = fromTitle.seriesPosition;
      seriesFromTitle = true;
    }
  }

  const sourceText = chapters.map((c) => c.body).join('\n\n');
  return {
    format: opts.format,
    title,
    sourceText,
    chapters,
    author: fileMeta.author,
    series: resolvedSeries,
    seriesPosition: resolvedSeriesPosition,
    seriesFromTitle,
  };
}
