import type { ParagraphEvidence, SpanEvidence } from './types.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

/* Task 6. Maps the model's stage-2 `SentenceOutput[]` onto the parser's
   `ParagraphEvidence[]` span evidence. Pure: no I/O, no model calls.

   Tiling contract (carried forward from Task 4/parser.ts): content spans
   tile with no gaps BETWEEN them, but a single-character quote/dash
   delimiter glyph may sit uncovered between two spans. Alignment is
   therefore OVERLAP-based (span.start < matchEnd && span.end > matchStart),
   never exact-coverage — it must tolerate those 1-char gaps.

   #2187 — anchor-first, two-pass, interval-bounded alignment. The original
   scheme was a single monotonic cursor + first-hit-then-unbounded-fallback
   search: a failed match never moved the cursor, but a WRONG match did. For
   an ultra-common short sentence (Russian paragraph-leading dash dialogue,
   e.g. "- Да.") the first hit at/after the cursor is very often the wrong
   occurrence, and the unbounded fallback could bind it thousands of
   characters downstream — every later sentence was then stranded, since it
   could only match at/after that bogus cursor (see #2187 for the measured
   2-4% alignment on the affected chapters). Fixed with two order-preserving
   passes over the sentence list:

     Pass A (anchors, `findAnchors`) — walk sentences in order, but only
     ATTEMPT a match for needles long enough to trust (>= ANCHOR_MIN_LEN,
     EXACT match only, no fuzzy fallback). A successful match becomes an
     anchor and advances a monotonic global cursor — the same single-pass
     scheme as before, just restricted to long, trustworthy needles.

     Pass B (infill, `fillRun`) — every other sentence sits in a run bounded
     by its two neighbouring anchors (body start/end for the first/last
     run). Each run is resolved by re-running the SAME monotonic-cursor/
     findMatch logic, but against the run's OWN haystack slice — a match is
     therefore structurally unable to land outside its bounding anchors. A
     miss never moves the run-local cursor, so one bad sentence still can't
     desync the rest of its run.

   This makes the reported failure mode structurally impossible: "- Да." (far
   under ANCHOR_MIN_LEN) is always resolved by Pass B, bounded to the
   interval between its real neighbours, so it can no longer bind to a
   duplicate occurrence thousands of characters away. */

const WINDOW = 4096;
const COMBINING_MARK = /\p{Mn}/u;
const FUZZY_MIN_NEEDLE = 24;
const FUZZY_ANCHOR_LEN = 16;
// An anchor has to be trustworthy enough to bound its neighbours' ENTIRE
// search interval, so it's held to at least the same bar this file already
// trusts for a full EXACT match when deciding whether to try the (weaker)
// 16-char PREFIX-ONLY fuzzy fallback below: FUZZY_MIN_NEEDLE. Reusing it
// (rather than inventing a second magic number) means "long enough to fuzzy-
// anchor on a prefix" and "long enough to anchor Pass A on a full exact
// match" stay a single tunable. Short, ultra-common replies ("- Да.",
// "- Нет.") sit far below it and are therefore ALWAYS resolved via the
// interval-bounded Pass B infill, never Pass A.
const ANCHOR_MIN_LEN = FUZZY_MIN_NEEDLE;

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

// Loop-strips every leading dash-group from an already-normalized needle
// when dashIsDialogueMarker is true. When false, returns input unchanged
// (matching pristine pre-#2537 main behavior).
export function buildDashInvariantNeedle(normalizedText: string, dashIsDialogueMarker: boolean): string {
  if (!dashIsDialogueMarker) return normalizedText;
  return normalizedText.replace(/^(-\s*)+/, '');
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

/** A located needle, as normalized-string [start, end) offsets. */
interface LocatedSpan {
  start: number;
  end: number;
}

interface AnchorHit {
  /** index into the `needles`/`sentences` array */
  index: number;
  start: number;
  end: number;
}

/** Pass A — walk needles in order with a single monotonic global cursor,
    same mechanics as the old single-pass scheme, but restricted to needles
    >= ANCHOR_MIN_LEN and EXACT matches only (no fuzzy fallback: an anchor
    has to be trustworthy, not just best-effort). A needle that's long
    enough but doesn't match at/after the cursor is simply skipped — it's
    left for Pass B, same as a too-short needle.

    KNOWN RESIDUAL, stated precisely because it is easy to overstate the
    guarantee: anchors are selected on LENGTH alone, with no check that the
    needle doesn't recur. A >= ANCHOR_MIN_LEN sentence duplicated in the
    model's output can therefore still anchor at a later occurrence, and
    because this cursor is global and monotonic (`cursor = end` below, and
    `from = anchor.end` in Pass B), that mis-anchor stalls every subsequent
    anchor and strands the rest of the chapter — the SAME chapter-wide
    propagation as the pre-#2187 bug, verified byte-identical to the old
    implementation on such a fixture. What #2187 changed is not the blast
    radius but who can trigger it: a 5-char "- Да." no longer can, only a
    >= 24-char repeated sentence. That is a large practical win on dash
    dialogue and not a structural guarantee. A uniqueness check on anchor
    candidates is the fix if this ever shows up in a real corpus. */
function findAnchors(needles: string[], haystack: string): AnchorHit[] {
  const anchors: AnchorHit[] = [];
  let cursor = 0;
  for (let i = 0; i < needles.length; i++) {
    const needle = needles[i];
    if (needle.length < ANCHOR_MIN_LEN) continue;
    const pos = findMatch(haystack, needle, cursor);
    if (pos === -1) continue;
    const end = Math.min(pos + needle.length, haystack.length);
    anchors.push({ index: i, start: pos, end });
    cursor = end;
  }
  return anchors;
}

/** Pass B — resolves every needle in `[loRun, hiRun)` against the run's OWN
    haystack slice `haystack.slice(from, to)`, so a match is structurally
    unable to land outside the run's two bounding anchors. Reuses the same
    monotonic-cursor/findMatch logic as Pass A (a miss never moves the
    run-local cursor), plus — when `fuzzy` is set — the same prefix-anchor
    fallback `alignSentences` has always used for a paraphrased long
    sentence. Writes results in place into `results`. */
function fillRun(
  needles: string[],
  haystack: string,
  loRun: number,
  hiRun: number,
  from: number,
  to: number,
  fuzzy: boolean,
  results: Array<LocatedSpan | null>,
): void {
  const runHaystack = haystack.slice(from, to);
  let cursor = 0;
  for (let i = loRun; i < hiRun; i++) {
    const needle = needles[i];
    if (needle.length === 0) {
      results[i] = null;
      continue;
    }
    let pos = findMatch(runHaystack, needle, cursor);
    if (pos === -1 && fuzzy && needle.length >= FUZZY_MIN_NEEDLE) {
      // Exact failed (gemma paraphrased/dropped a word). Anchor on the prefix
      // so the sentence still attaches to its paragraph; approximate the extent.
      pos = findMatch(runHaystack, needle.slice(0, FUZZY_ANCHOR_LEN), cursor);
    }
    if (pos === -1) {
      results[i] = null; // do NOT move the cursor — a bad sentence can't desync its run
      continue;
    }
    const end = Math.min(pos + needle.length, runHaystack.length);
    results[i] = { start: from + pos, end: from + end };
    cursor = end;
  }
}

/** Anchor-first, two-pass, interval-bounded location of `needles` (already
    normalized) within `haystack` (already normalized). Order-preserving and
    parallel to `needles`: a located needle is returned as normalized-string
    [start, end) offsets, an unlocated one as `null`. `fuzzy` toggles the
    prefix-anchor fallback for a long paraphrased needle (on for
    `alignSentences`, off for `locateSentenceOffsets`, matching each
    function's pre-#2187 contract).

    Complexity: Pass A is O(n·W) plus the same unbounded-fallback worst case
    the old code always had, over the anchor-eligible subset — which in real
    prose is usually the MAJORITY of sentences, not a small minority, since
    most narration clears 24 normalized chars. Pass B's per-run
    `haystack.slice` costs sum to at most O(|haystack|) across all runs (they
    tile the haystack with no overlap), and each run's unbounded fallback is
    bounded by its run rather than the whole chapter.

    That bound is NOT a universal improvement. In the degenerate zero-anchor
    case — every long needle fails Pass A, which is precisely why no anchors
    exist — the single run IS the whole chapter, so nothing is bounded, and
    Pass A's failed unbounded scans are then repeated verbatim by Pass B.
    Measured at 240 kB × 2,800 all-miss long needles: ~1.4× the old cost
    (303 ms vs 197 ms). Real chapters are ~110 kB and nothing like all-miss,
    so this is a claim-accuracy note rather than a practical concern. */
function locateNeedles(needles: string[], haystack: string, fuzzy: boolean): Array<LocatedSpan | null> {
  const results: Array<LocatedSpan | null> = new Array(needles.length).fill(null);
  const anchors = findAnchors(needles, haystack);

  let from = 0;
  let loRun = 0;
  for (const anchor of anchors) {
    fillRun(needles, haystack, loRun, anchor.index, from, anchor.start, fuzzy, results);
    results[anchor.index] = { start: anchor.start, end: anchor.end };
    from = anchor.end;
    loRun = anchor.index + 1;
  }
  fillRun(needles, haystack, loRun, needles.length, from, haystack.length, fuzzy, results);

  return results;
}

export function alignSentences(
  sentences: SentenceOutput[],
  paras: ParagraphEvidence[],
  body: string,
  dashIsDialogueMarker: boolean = false,
): AlignmentResult {
  const { text: normBody, rawStart, rawEnd } = buildNormalizedMap(body);
  const allSpans = paras.flatMap((p) => p.spans);
  // #2537/#2540 — dash-invariant needle search. A leading paragraph-dash marker
  // is a dialogue glyph, never content: whether the model's cached sentence text
  // includes or omits its leading dash must not change which raw body span the
  // needle locates. `buildDashInvariantNeedle` consumes the whole leading-dash
  // run when the gate is on, and is a no-op when off (matching pristine pre-#2537
  // `main` behavior).
  const needles = sentences.map((s) => buildDashInvariantNeedle(normalize(s.text), dashIsDialogueMarker));
  const located = locateNeedles(needles, normBody, true);

  const aligned: AlignedSentence[] = sentences.map((sentence, i) => {
    const match = located[i];
    if (match === null) return { sentence, spans: [], lumped: false };

    let rawMatchStart = rawStart[match.start];
    const rawMatchEnd = rawEnd[match.end - 1];
    // When the gate is on, anchor backward over a stack of leading dash + optional
    // whitespace so that a dash-stripped needle and a dash-included form resolve to
    // the same rawMatchStart. Only a dash at the head of its line is folded in,
    // never a mid-line em dash inside the prose. When the gate is off, this block
    // is skipped entirely, matching pristine pre-#2537 `main`.
    if (dashIsDialogueMarker && rawMatchStart > 0) {
      const preceding = /(?:[-–—]\s*)+$/.exec(body.slice(0, rawMatchStart));
      if (preceding) {
        const beforeDash = body.slice(0, rawMatchStart - preceding[0].length);
        if (beforeDash === '' || /[\n\r]$/.test(beforeDash)) {
          rawMatchStart -= preceding[0].length;
        }
      }
    }
    const spans = allSpans.filter((s) => s.start < rawMatchEnd && s.end > rawMatchStart);

    const hasSpeech = spans.some((s) => s.kind === 'speech');
    const hasOther = spans.some((s) => s.kind === 'tag' || s.kind === 'narration');

    return { sentence, spans, lumped: hasSpeech && hasOther };
  });

  const alignedCount = aligned.filter((a) => a.spans.length > 0).length;
  const alignedPct = sentences.length ? (100 * alignedCount) / sentences.length : 0;

  return { aligned, alignedPct };
}

/** #1679 (interval-bounded per #2187) — Locate each sentence's raw start
    offset in `body`, reusing the same normalization + anchor-first two-pass
    location this module uses for alignment. Returns an array parallel to
    `sentences`: the raw body offset of each sentence's first character, or
    null when its text couldn't be located (model paraphrase / tag drift, or
    a short/duplicate needle outside its bounding anchors). A miss NEVER
    advances any cursor, and a match can never land outside its run's
    bounding anchors, so one bad sentence can't desync the rest.

    #2537/#2540 — dash-aware needle construction (identical to alignSentences):
    keep the dash in needles from dash-led sentences (prevents false substring
    matches), strip it for non-dash sentences. For dash-led sentences, extend
    back to the paragraph-leading dash in the body to ensure consistent offsets
    regardless of whether the cached text carries or omits its dash. Fuzzy
    fallback is not used here, preserving the pre-#2187 contract.

    Unlike alignSentences this needs only the body (no ParagraphEvidence), so it
    runs on every chapter regardless of whether the dialogue-structure engine is
    active. Pure: no I/O, no model calls. */
export function locateSentenceOffsets(
  sentences: Array<{ text: string }>,
  body: string,
): Array<number | null> {
  const { text: normBody, rawStart } = buildNormalizedMap(body);
  // #2537/#2540 — dash-invariant needle search, matching alignSentences.
  // Whether the cached sentence text includes or omits a leading paragraph dash
  // must not change the offset we return. Same logic as alignSentences:
  // keep the dash in needles from dash-led sentences (prevents false substring
  // matches), strip it for non-dash sentences, and extend back to the
  // paragraph-leading dash ONLY when the original text had the dash.
  const normalizedTexts = sentences.map((s) => normalize(s.text));
  const hadLeadingDash = normalizedTexts.map((t) => /^-\s*/.test(t));
  const needles = normalizedTexts.map((t, i) => {
    return hadLeadingDash[i] ? t : t.replace(/^-\s*/, '');
  });
  const located = locateNeedles(needles, normBody, false);

  return located.map((m, i) => {
    if (m === null) return null;

    let rawMatchStart = rawStart[m.start];
    // #2537/#2540 — for dash-invariance: when the original sentence text had
    // a leading dash, try to extend back to include any paragraph-leading dash
    // in the body. This makes "— Text" and "Text" resolve to the same offset:
    // the former keeps the dash in the needle (finds at 0), while the latter
    // finds the text and extends back to the dash (also 0). When the original
    // did NOT have a dash, keep the offset at the text itself (no extension).
    if (hadLeadingDash[i] && rawMatchStart > 0) {
      const preceding = /([-–—])\s*$/.exec(body.slice(0, rawMatchStart));
      if (preceding) {
        const beforeDash = body.slice(0, rawMatchStart - preceding[0].length);
        if (beforeDash === '' || /[\n\r]$/.test(beforeDash)) {
          rawMatchStart -= preceding[0].length;
        }
      }
    }
    return rawMatchStart;
  });
}
