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

/** The search term for one cached sentence.

    `text` is the sentence's already-normalized text, searched verbatim —
    byte for byte what pre-#2537 `main` searched for, and the only form used
    when the dash gate is off.

    #2537/#2540 — dash invariance. A leading paragraph-dash is a dialogue
    marker, never content, and the model's cache keeps it on some sentences
    and drops it on others (upstream of this module). Which of the two
    happened must not change where the sentence is located. The two cases are
    deliberately NOT symmetrical:

      - A needle that ALREADY carries its dash is searched AS-IS. `"- да."`
        can only occur at a real dialogue marker, so it is highly selective.
        Stripping the dash would search for `"да."`, which also occurs inside
        `правда`, `когда`, `всегда`, `вода`, `беда`… — selectivity `main`
        already gets right, and which must not be given up.

      - A needle with NO leading dash sets `tryDashPrefix`. Its search prefers
        an occurrence that IS preceded by a paragraph dash and reports the
        match from the head of that dash run — the exact offset the
        dash-carrying form of the same sentence produces — but ONLY when its
        own bare first hit is a false substring match. A false substring match
        is detected two ways: (1) at the LEFT boundary, the "да." inside
        "правда." shape via `isMidWordHit`; (2) in the fuzzy prefix case only,
        at the RIGHT boundary when the continuation DIFFERS from the needle's
        own text (see `isMidWordOnRight` #2608/#2799). A bare hit that already
        lands at a genuine word boundary, or whose right-side continuation
        matches the needle's own text, is an independently valid occurrence and
        is trusted as-is, with no forward walk: otherwise a sentence whose
        exact text legitimately recurs later in the chapter under a
        DIFFERENT line's dash would be discarded in favor of that unrelated
        dash (#2577 pass 4, "Q1"). Only when the bare hit IS a false
        substring match does it walk forward for a dash-prefixed occurrence,
        falling back to the plain (false) hit if none exists anywhere.

    So a dash-led line's two cache forms converge on the paragraph dash when
    the dash-free form's own bare hit is otherwise ambiguous, while a
    dash-free narration sentence — including one whose text happens to recur
    under someone else's dash elsewhere — keeps `main`'s behaviour exactly. */
export interface Needle {
  text: string;
  tryDashPrefix: boolean;
}

export function buildNeedle(normalizedText: string, dashIsDialogueMarker: boolean): Needle {
  return {
    text: normalizedText,
    // `normalizedText` is post-`normalize()`, so every dash glyph this file
    // folds (– — &mdash; &ndash; and a run of 2+ ASCII hyphens) is already a
    // single '-'; testing that one character covers all five spellings.
    tryDashPrefix: dashIsDialogueMarker && normalizedText.length > 0 && normalizedText[0] !== '-',
  };
}

/** True when the paragraph dash at normalized index `dashIdx` belongs to the
    sentence starting at normalized index `textIdx` — i.e. the raw body holds
    no line break between them. Normalization collapses `\n` into the same
    single space as an ordinary gap, so this question can only be answered
    against the RAW body.

    This is what keeps a dash that ends the PREVIOUS line out of the next
    sentence. A dash-rule scene separator ("---", "———") normalizes to a lone
    '-' and sits immediately before the following narration paragraph in the
    normalized haystack; without this check that narration would anchor onto
    the separator and overlap its span. */
type DashAdjacency = (dashIdx: number, textIdx: number) => boolean;

/** Walk back from `at` over a `(?:-\s*)+` run, returning the normalized offset
    of the run's first dash, or null when `at` is not preceded by a dash that
    is `adjacent` to it. Never crosses `floor` — the caller's monotonic cursor —
    so a dash-prefixed match cannot reach behind text the run has already
    consumed, the same bound a dash-carrying needle's own `indexOf` obeys. */
function dashRunStart(haystack: string, at: number, floor: number, adjacent: DashAdjacency): number | null {
  let start = at;
  let found = false;
  for (;;) {
    let j = start;
    while (j > floor && /\s/u.test(haystack[j - 1])) j--;
    if (j > floor && haystack[j - 1] === '-' && adjacent(j - 1, at)) {
      start = j - 1;
      found = true;
    } else {
      return found ? start : null;
    }
  }
}

/** A "word" character for the purposes of `isMidWordHit` below — letters and
    digits in any script, matching what `normalize()` leaves untouched. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** True when `pos` lands INSIDE a word rather than at its start — i.e. the
    character immediately before it is itself a word character. This is the
    "да." inside "правда." shape: the match is a false substring hit, not an
    independently valid occurrence of the needle.

    Anything else — start of haystack, or preceded by whitespace/punctuation/
    a dash — is a genuine word-boundary match and must be trusted as-is. */
function isMidWordHit(haystack: string, pos: number): boolean {
  return pos > 0 && WORD_CHAR.test(haystack[pos - 1]);
}

/** True when `search` ends INSIDE a word at a position where the continuation
    does NOT match the needle's own text — i.e. the character immediately after
    `pos + search.length` is a word character that would form a DIFFERENT word
    than what the needle contains at that position. Only applies when `search`
    is strictly shorter than the full needle (the fuzzy 16-char-prefix case).

    The distinction matters: a search that is truncated by design will often end
    mid-word in correct matches (e.g., "смотрел" ending and the needle continuing
    with "а" from "смотрела"). That's not evidence of a false hit. Only when the
    continuation CHARACTER differs from the needle's own character is it evidence
    of a false prefix match (e.g., "в" inside an unrelated word "вспоминая").
    See #2799 for the regression that occurred when this check was too broad. */
function isMidWordOnRight(haystack: string, pos: number, search: string, needle: string): boolean {
  const end = pos + search.length;
  if (end >= haystack.length) return false; // at or past end, no continuation
  if (!WORD_CHAR.test(haystack[end])) return false; // not a word char, boundary is clean

  // The character after the search is a word character. But only distrust it if
  // it's DIFFERENT from what the needle itself would have at this position.
  // If they match, the search is just truncated and the match is still valid.
  if (search.length < needle.length && haystack[end] === needle[search.length]) {
    return false; // continuation matches needle, it's a legit match
  }

  return true; // continuation differs from needle, it's an unrelated word
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

/** Locate `search` in `haystack` at/after `cursor`. `spanLen` is the extent
    claimed from the located text's own start — it differs from
    `search.length` only for the fuzzy prefix fallback, which locates on a
    16-char prefix but claims the whole sentence.

    With `tryDashPrefix` off this is exactly `findMatch`, i.e. pristine
    pre-#2537 `main`. With it on, an occurrence preceded by that sentence's own
    paragraph dash can win over an earlier bare one, reporting `start` as the
    head of the dash run — but only under the conditions `Needle`'s doc
    comment states; a bare hit that's already independently valid is kept.

    `checkRightBoundary` (#2608) additionally distrusts a bare hit whose
    RIGHT side lands mid-word, on top of the existing left-side check — but
    only when the caller sets it. Fed `true` only by `fillRun`'s fuzzy
    fallback call, whose `search` is a fixed `FUZZY_ANCHOR_LEN`-char PREFIX of
    the needle and so, by construction, almost never ends at a real word
    boundary: without a caller-controlled gate this would make every fuzzy
    bare hit look mid-word, including ones with no ambiguity to resolve — the
    exact-match path's `search` is normally the needle's own full text, whose
    right edge is a real boundary already, so it must keep passing `false`. */
function findNeedleSpan(
  haystack: string,
  search: string,
  spanLen: number,
  tryDashPrefix: boolean,
  cursor: number,
  adjacent: DashAdjacency,
  checkRightBoundary: boolean,
  needle: string = search, // full needle text, for distinguishing truncated-prefix mismatches
): LocatedSpan | null {
  const pos = findMatch(haystack, search, cursor);
  if (!tryDashPrefix || pos === -1) {
    // pos === -1 is decisive for the dash-prefixed search too: a dash-prefixed
    // occurrence contains a bare one, so if the bare text isn't here, neither is it.
    return pos === -1 ? null : { start: pos, end: Math.min(pos + spanLen, haystack.length) };
  }

  const atFirst = dashRunStart(haystack, pos, cursor, adjacent);
  if (atFirst !== null) return { start: atFirst, end: Math.min(pos + spanLen, haystack.length) };

  // The first occurrence is bare and not itself dash-adjacent. If it's ALSO a
  // genuine word-boundary match (not the "да." inside "правда." shape), it is
  // an independently valid occurrence of this sentence's text — trust it, and
  // do NOT walk forward hunting for a dash-prefixed occurrence elsewhere. That
  // walk is only safe when this hit is known-false: otherwise, if the same
  // text legitimately recurs later in the chapter under a DIFFERENT sentence's
  // dash, this occurrence would be discarded in favor of binding to that
  // unrelated dash (#2577 pass 4, "Q1").
  // `isMidWordHit` only checks the LEFT boundary of `pos`. It says nothing
  // about whether `search` also ends cleanly — a `search` that is itself a
  // strict prefix of a longer word can pass this check while still being a
  // false hit on its right side, and would then be wrongly trusted here
  // instead of walking forward to the dash-prefixed occurrence.
  // FIXED for the fuzzy 16-char-prefix fallback (#2608/#2799): its caller passes
  // `checkRightBoundary: true` and the full needle, and `isMidWordOnRight` below
  // catches a false prefix match whose continuation DIFFERS from the needle itself.
  // A correct match where the search is just truncated (e.g., "смотрел" + "а" from
  // "смотрела") is correctly trusted, since the "а" matches the needle's own text.
  // A false match forming an unrelated word (e.g., "в" in "вспоминая") is correctly
  // distrusted, since "в" differs from the needle's continuation character.
  // KNOWN RESIDUAL, scope-limited on purpose: the plain exact-match path
  // (`checkRightBoundary: false`) still has this gap at `search`'s full
  // needle length — e.g. a needle `"Он молчал"` (well under FUZZY_MIN_NEEDLE,
  // fuzzy unreachable) binds to `narration@0` instead of the real dash line
  // when the body also contains `"Он молчаливо…"`. #2608 resolved this only
  // for the fuzzy path; the exact path needs its own decision (a `search`
  // that's the needle's own full text ending mid-word is a different,
  // rarer shape than a fixed-length prefix cut). Not a regression: this
  // exact-path gap already existed on `main`, unrelated to dash-invariance.
  if (!isMidWordHit(haystack, pos) && !(checkRightBoundary && isMidWordOnRight(haystack, pos, search, needle))) {
    return { start: pos, end: Math.min(pos + spanLen, haystack.length) };
  }

  // The first occurrence is a false substring hit (`"да."` inside
  // `"правда."`). A dash-prefixed occurrence further on is the better answer:
  // the dash was dropped by the cache, not by the manuscript. Every
  // dash-prefixed occurrence is also a plain one, so walking the remaining
  // plain hits finds them all; the walk resumes where the previous `indexOf`
  // stopped, so it costs one pass over the haystack however many hits there are.
  for (let at = haystack.indexOf(search, pos + 1); at !== -1; at = haystack.indexOf(search, at + 1)) {
    const runStart = dashRunStart(haystack, at, cursor, adjacent);
    if (runStart !== null) return { start: runStart, end: Math.min(at + spanLen, haystack.length) };
  }
  return { start: pos, end: Math.min(pos + spanLen, haystack.length) };
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
function findAnchors(needles: Needle[], haystack: string, adjacent: DashAdjacency): AnchorHit[] {
  const anchors: AnchorHit[] = [];
  let cursor = 0;
  for (let i = 0; i < needles.length; i++) {
    const needle = needles[i];
    if (needle.text.length < ANCHOR_MIN_LEN) continue;
    const hit = findNeedleSpan(
      haystack,
      needle.text,
      needle.text.length,
      needle.tryDashPrefix,
      cursor,
      adjacent,
      false,
      needle.text,
    );
    if (hit === null) continue;
    anchors.push({ index: i, start: hit.start, end: hit.end });
    cursor = hit.end;
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
  needles: Needle[],
  haystack: string,
  loRun: number,
  hiRun: number,
  from: number,
  to: number,
  fuzzy: boolean,
  adjacent: DashAdjacency,
  results: Array<LocatedSpan | null>,
): void {
  const runHaystack = haystack.slice(from, to);
  // `adjacent` is keyed on whole-haystack indices; this run's search works in
  // slice-relative ones.
  const runAdjacent: DashAdjacency = (dashIdx, textIdx) => adjacent(from + dashIdx, from + textIdx);
  let cursor = 0;
  for (let i = loRun; i < hiRun; i++) {
    const needle = needles[i];
    if (needle.text.length === 0) {
      results[i] = null;
      continue;
    }
    let hit = findNeedleSpan(
      runHaystack,
      needle.text,
      needle.text.length,
      needle.tryDashPrefix,
      cursor,
      runAdjacent,
      false,
      needle.text,
    );
    if (hit === null && fuzzy && needle.text.length >= FUZZY_MIN_NEEDLE) {
      // Exact failed (gemma paraphrased/dropped a word). Anchor on the prefix
      // so the sentence still attaches to its paragraph; approximate the extent.
      // `checkRightBoundary: true` (#2608) — this `search` is a fixed-length
      // prefix, so a bare hit that's a strict prefix of a longer, unrelated
      // word must not be trusted; walk forward for a dash-prefixed occurrence
      // of the same prefix first, same as the existing left-boundary case.
      hit = findNeedleSpan(
        runHaystack,
        needle.text.slice(0, FUZZY_ANCHOR_LEN),
        needle.text.length,
        needle.tryDashPrefix,
        cursor,
        runAdjacent,
        true,
        needle.text, // pass full needle for right-boundary check
      );
    }
    if (hit === null) {
      results[i] = null; // do NOT move the cursor — a bad sentence can't desync its run
      continue;
    }
    results[i] = { start: from + hit.start, end: from + hit.end };
    cursor = hit.end;
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
function locateNeedles(
  needles: Needle[],
  haystack: string,
  fuzzy: boolean,
  adjacent: DashAdjacency,
): Array<LocatedSpan | null> {
  const results: Array<LocatedSpan | null> = new Array(needles.length).fill(null);
  const anchors = findAnchors(needles, haystack, adjacent);

  let from = 0;
  let loRun = 0;
  for (const anchor of anchors) {
    fillRun(needles, haystack, loRun, anchor.index, from, anchor.start, fuzzy, adjacent, results);
    results[anchor.index] = { start: anchor.start, end: anchor.end };
    from = anchor.end;
    loRun = anchor.index + 1;
  }
  fillRun(needles, haystack, loRun, needles.length, from, haystack.length, fuzzy, adjacent, results);

  return results;
}

/** Builds the `DashAdjacency` predicate for one body from its normalized
    offset map: "no line break between the dash and the sentence". */
function dashAdjacencyFor(body: string, rawStart: number[]): DashAdjacency {
  return (dashIdx, textIdx) => !/[\n\r]/.test(body.slice(rawStart[dashIdx], rawStart[textIdx]));
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
  // needle locates. `buildNeedle` decides, per sentence, whether the search may
  // prefer a dash-prefixed occurrence; when the gate is off every needle is the
  // plain normalized text, matching pristine pre-#2537 `main` behavior.
  const needles = sentences.map((s) => buildNeedle(normalize(s.text), dashIsDialogueMarker));
  const located = locateNeedles(needles, normBody, true, dashAdjacencyFor(body, rawStart));

  const aligned: AlignedSentence[] = sentences.map((sentence, i) => {
    const match = located[i];
    if (match === null) return { sentence, spans: [], lumped: false };

    // No dash fix-up here: a dash-stripped needle's match ALREADY starts at the
    // paragraph dash, because the search that found it required one. Extending
    // the raw offset backward after the fact is what let an unrelated dash (a
    // "---" scene rule on the previous line) be absorbed into a plain narration
    // sentence that never had a dash to recover.
    const rawMatchStart = rawStart[match.start];
    const rawMatchEnd = rawEnd[match.end - 1];
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

    #2537/#2540 — dash-invariant needle construction (gated), identical to
    alignSentences: when the gate is on, a needle with no leading dash prefers an
    occurrence that carries the paragraph dash and reports the dash's offset when
    its own bare hit would otherwise be a false substring match (detected via
    left-boundary checks and, for the fuzzy prefix case, right-boundary checks
    that verify the continuation differs from the needle's own text), so the
    dash-stripped and dash-included forms of an ambiguous sentence resolve to the
    identical offset — see `Needle`'s doc comment for the full rule, including
    the #2577 "Q1" carve-out for a bare hit that is already independently valid.
    When the gate is off, the needle is plain normalized text, matching pristine
    pre-#2537 main behavior.

    Unlike alignSentences this needs only the body (no ParagraphEvidence), so it
    runs on every chapter regardless of whether the dialogue-structure engine is
    active. Pure: no I/O, no model calls. */
export function locateSentenceOffsets(
  sentences: Array<{ text: string }>,
  body: string,
  dashIsDialogueMarker: boolean = false,
): Array<number | null> {
  const { text: normBody, rawStart } = buildNormalizedMap(body);
  // #2537/#2540 — dash-invariant needle search, matching alignSentences. The
  // located offset is used as-is: when a dash-stripped needle's match starts
  // at a paragraph dash, the search that found it required one; see
  // `Needle`'s doc comment for when that happens vs. when a bare,
  // already-valid hit is kept instead.
  const needles = sentences.map((s) => buildNeedle(normalize(s.text), dashIsDialogueMarker));
  const located = locateNeedles(needles, normBody, false, dashAdjacencyFor(body, rawStart));

  return located.map((m) => (m === null ? null : rawStart[m.start]));
}
