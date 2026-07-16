import type { ParagraphEvidence, SpanEvidence } from './types.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

/* Task 6. Maps the model's stage-2 `SentenceOutput[]` onto the parser's
   `ParagraphEvidence[]` span evidence. Pure: no I/O, no model calls.

   Tiling contract (carried forward from Task 4/parser.ts): content spans
   tile with no gaps BETWEEN them, but a single-character quote/dash
   delimiter glyph may sit uncovered between two spans. Alignment is
   therefore OVERLAP-based (span.start < matchEnd && span.end > matchStart),
   never exact-coverage — it must tolerate those 1-char gaps.

   Two-pointer with a bounded look-ahead window keeps a single bad/duplicate
   sentence from desyncing every sentence after it: a failed match NEVER
   moves the cursor. */

const WINDOW = 4096;
const COMBINING_MARK = /\p{Mn}/u;
const FUZZY_MIN_NEEDLE = 24;
const FUZZY_ANCHOR_LEN = 16;

export interface AlignedSentence {
  sentence: SentenceOutput;
  /** spans the sentence text overlaps, in order; empty = unaligned */
  spans: SpanEvidence[];
  /** true when it overlaps BOTH a speech span and a tag/narration span */
  lumped: boolean;
}

export interface AlignmentResult {
  aligned: AlignedSentence[];
  alignedPct: number;
}

// Quote/dash glyphs the model may substitute with an ASCII look-alike.
const QUOTE_CHARS = new Set(['«', '»', '„', '“', '”', '"', "'", '‘', '’']);
const DASH_CHARS = new Set(['–', '—']); // – —

/** Normalize-with-offset-map: builds the normalized form of `raw` alongside,
    for every output character, the raw [start,end) span it came from. That
    map is what lets a match found in normalize(body) be translated back to
    the RAW body offsets the spans are keyed on — normalization changes
    string lengths (whitespace collapse, `…`→`...`, `&mdash;`→`-`, a run of
    ASCII hyphens → `-`), so a normalized-string index is never itself a raw
    offset. */
function buildNormalizedMap(raw: string): { text: string; rawStart: number[]; rawEnd: number[] } {
  const chars: string[] = [];
  const rawStart: number[] = [];
  const rawEnd: number[] = [];

  let i = 0;
  const n = raw.length;
  while (i < n) {
    let atomLen = 1;
    let out: string;
    if (raw.startsWith('&mdash;', i) || raw.startsWith('&ndash;', i)) {
      atomLen = 7;
      out = '-';
    } else if (raw[i] === '-' && raw[i + 1] === '-') {
      // A run of 2+ ASCII hyphens is the model's typewriter-style em dash.
      let j = i + 1;
      while (raw[j] === '-') j++;
      atomLen = j - i;
      out = '-';
    } else if (DASH_CHARS.has(raw[i])) {
      out = '-';
    } else if (QUOTE_CHARS.has(raw[i])) {
      out = '"';
    } else if (raw[i] === '…') {
      out = '...';
    } else {
      out = raw[i].toLowerCase();
      // RU: models routinely swap ё↔е. Fold to е so a single ё/е divergence
      // doesn't orphan the whole sentence (which would drag the chapter under
      // the 80% alignment floor and suppress ALL structure corrections).
      // 1:1 char replacement — preserves the offset map exactly.
      if (out === 'ё') out = 'е';
      else if (COMBINING_MARK.test(out)) out = ''; // drop decomposed diacritics (offset-safe)
    }
    const atomStart = i;
    const atomEnd = i + atomLen;
    for (const c of out) {
      chars.push(c);
      rawStart.push(atomStart);
      rawEnd.push(atomEnd);
    }
    i += atomLen;
  }

  // Collapse whitespace runs to a single ' ', spanning the raw run's offsets.
  const collChars: string[] = [];
  const collStart: number[] = [];
  const collEnd: number[] = [];
  let j = 0;
  while (j < chars.length) {
    if (/\s/u.test(chars[j])) {
      const start = rawStart[j];
      let end = rawEnd[j];
      let k = j + 1;
      while (k < chars.length && /\s/u.test(chars[k])) {
        end = rawEnd[k];
        k++;
      }
      collChars.push(' ');
      collStart.push(start);
      collEnd.push(end);
      j = k;
    } else {
      collChars.push(chars[j]);
      collStart.push(rawStart[j]);
      collEnd.push(rawEnd[j]);
      j++;
    }
  }

  // Trim leading/trailing whitespace.
  let start = 0;
  let end = collChars.length;
  while (start < end && collChars[start] === ' ') start++;
  while (end > start && collChars[end - 1] === ' ') end--;

  return {
    text: collChars.slice(start, end).join(''),
    rawStart: collStart.slice(start, end),
    rawEnd: collEnd.slice(start, end),
  };
}

function normalize(s: string): string {
  return buildNormalizedMap(s).text;
}

/** Search `needle` in `haystack` starting at `cursor`, bounded to a
    look-ahead window; falls back to one unbounded re-search from the SAME
    cursor (tolerates a legitimately out-of-order match farther ahead). A
    duplicate sentence whose text doesn't recur at/after the cursor fails
    both attempts and is reported unaligned. */
function findMatch(haystack: string, needle: string, cursor: number): number {
  const windowEnd = Math.min(haystack.length, cursor + WINDOW);
  const windowed = haystack.slice(cursor, windowEnd).indexOf(needle);
  if (windowed !== -1) return cursor + windowed;
  return haystack.indexOf(needle, cursor);
}

export function alignSentences(
  sentences: SentenceOutput[],
  paras: ParagraphEvidence[],
  body: string,
): AlignmentResult {
  const { text: normBody, rawStart, rawEnd } = buildNormalizedMap(body);
  const allSpans = paras.flatMap((p) => p.spans);

  let cursor = 0;
  const aligned: AlignedSentence[] = [];

  for (const sentence of sentences) {
    const needle = normalize(sentence.text);
    let matchStart = needle.length > 0 ? findMatch(normBody, needle, cursor) : -1;
    if (matchStart === -1 && needle.length >= FUZZY_MIN_NEEDLE) {
      // Exact failed (gemma paraphrased/dropped a word). Anchor on the prefix so
      // the sentence still attaches to its paragraph; approximate the extent.
      const anchorPos = findMatch(normBody, needle.slice(0, FUZZY_ANCHOR_LEN), cursor);
      if (anchorPos !== -1) matchStart = anchorPos;
    }

    if (matchStart === -1) {
      aligned.push({ sentence, spans: [], lumped: false });
      continue; // do NOT move the cursor — a single bad sentence can't desync the rest
    }

    const matchEnd = Math.min(matchStart + needle.length, normBody.length);
    cursor = matchEnd;

    const rawMatchStart = rawStart[matchStart];
    const rawMatchEnd = rawEnd[matchEnd - 1];
    const spans = allSpans.filter((s) => s.start < rawMatchEnd && s.end > rawMatchStart);

    const hasSpeech = spans.some((s) => s.kind === 'speech');
    const hasOther = spans.some((s) => s.kind === 'tag' || s.kind === 'narration');

    aligned.push({ sentence, spans, lumped: hasSpeech && hasOther });
  }

  const alignedCount = aligned.filter((a) => a.spans.length > 0).length;
  const alignedPct = sentences.length ? (100 * alignedCount) / sentences.length : 0;

  return { aligned, alignedPct };
}
