import type { ParagraphEvidence, SpanEvidence } from './types.js';
import type { NameIndex } from './name-matcher.js';
import { findRosterName, findSubjectName } from './name-matcher.js';

/* Spec §5.1. Conservative by construction: only two interior-dash patterns
   toggle span state; anything ambiguous degrades to `unanchored` (flag, not
   guess). Paragraph = a body line (the EPUB/MD parsers emit one paragraph per
   line). Pure: no I/O, no model calls. */

const DASH = String.raw`(?:&mdash;|&ndash;|[-–—])`;
// ", — lowercase" / "! — lowercase" → close speech, open tag
const TAG_OPEN = new RegExp(String.raw`([,!?…]|\.{3})\s*${DASH}\s*(?=\p{Ll})`, 'gu');
// ". — Uppercase" (inside a dialogue paragraph) → close tag, resume speech
const SPEECH_RESUME = new RegExp(String.raw`([.!?…])\s*${DASH}\s*(?=\p{Lu})`, 'gu');

function hasStem(text: string, stems: string[]): boolean {
  const lower = text.toLowerCase();
  return stems.some((s) => lower.includes(s));
}

/** Exported for Task 5: the pronoun classification of a tag clause that had
    no roster-name match. Recorded on the anchored span as `pendingPronoun`. */
export interface ParsedTag {
  pronoun?: 'first' | 'male' | 'female';
}

function classifyPronoun(
  text: string,
  pronouns: { firstPerson: RegExp | null; male: RegExp | null; female: RegExp | null },
): ParsedTag {
  if (pronouns.firstPerson?.test(text)) return { pronoun: 'first' };
  if (pronouns.male?.test(text)) return { pronoun: 'male' };
  if (pronouns.female?.test(text)) return { pronoun: 'female' };
  return {};
}

/** Anchor `tag` spans onto adjacent `speech` spans within one paragraph's
    span list (dash-dialogue spans, or a quote-run's interior spans, or the
    top-level quote+narration/tag span list). Two-phase, highest-precedence
    first, so a tag can never claim a span that rightfully belongs to a
    DIFFERENT, later tag in the same paragraph:
      Phase 1: each tag anchors its immediately-PRECEDING speech span (its
      `target`) — this is unambiguous, the tag always belongs to that span.
      Phase 2: each tag anchors FOLLOWING speech spans, but only up to
      (exclusive) the next tag in the paragraph, and only spans phase 1 left
      unanchored (the single-tag continuation case, e.g. "— Привет, —
      сказал Антон. — Как дела?"). */
export function anchorSpansFromTags(spans: SpanEvidence[], line: string, base: number, index: NameIndex): void {
  const conv = index.conventions;
  const applyTag = (tag: SpanEvidence, sp: SpanEvidence | null) => {
    if (!sp || sp.speaker || 'pendingPronoun' in sp) return;
    const text = line.slice(tag.start - base, tag.end - base);
    const name = conv.addresseePrepositions
      ? (findSubjectName(text, index)?.id ?? null)
      : findRosterName(text, index);
    if (name) {
      const weak = 'weakTag' in tag; // set only on beat-only quote-gap tags (parseQuoteParagraph)
      sp.speaker = { characterId: name, source: 'tag-name', ...(weak ? { strength: 'weak' as const } : {}) };
    } else {
      const { pronoun } = classifyPronoun(text, conv.pronouns);
      if (pronoun) (sp as SpanEvidence & { pendingPronoun?: ParsedTag['pronoun'] }).pendingPronoun = pronoun;
    }
  };
  const precedingSpeech = (i: number): SpanEvidence | null => {
    for (let j = i - 1; j >= 0; j--) if (spans[j].kind === 'speech') return spans[j];
    return null;
  };
  const tagIdx = spans.reduce<number[]>((acc, s, i) => {
    if (s.kind === 'tag') acc.push(i);
    return acc;
  }, []);
  for (const i of tagIdx) applyTag(spans[i], precedingSpeech(i));
  for (const i of tagIdx) {
    const nextTagIdx = tagIdx.find((j) => j > i) ?? spans.length;
    const following = spans.slice(i + 1, nextTagIdx).filter((x) => x.kind === 'speech');
    for (const sp of following) applyTag(spans[i], sp);
  }
}

/** Parse a chapter body into per-paragraph span evidence.
    Tiling contract (binds Task 6's aligner too): within a paragraph's
    `spans`, CONTENT spans (`speech`/`tag`/`narration`) tile with no gaps
    BETWEEN them — but a single-character quote/dash delimiter glyph (the
    opening/closing quote mark, or the paragraph-leading dash + its
    trailing space) is intentionally left uncovered by any span. Callers
    must not assume `spans[].start`/`end` sum to the paragraph's full
    length; the aligner is overlap-based and tolerant of these
    micro-gaps. */
export function parseChapterStructure(body: string, index: NameIndex): ParagraphEvidence[] {
  const conv = index.conventions;
  const out: ParagraphEvidence[] = [];
  let offset = 0;
  // Callers pass \n-normalized text; offsets below are absolute into that body.
  for (const line of body.split('\n')) {
    const start = offset;
    offset += line.length + 1; // +1 for the split '\n'
    const trimmed = line.trim();
    if (!trimmed) continue;
    const open = conv.dialogueOpen ? line.match(conv.dialogueOpen) : null;
    if (!open) {
      out.push(parseQuoteParagraph(line, start, index));
      continue;
    }
    out.push(parseDashParagraph(line, start, index, open[0].length));
  }
  return out;
}

/** Cut a dialogue-bearing text (a dash-paragraph body, or a quote-run's
    interior) into alternating speech/tag spans at dash-tag toggle points,
    validate the tag spans carry a speech/beat verb (else downgrade the whole
    text to one unanchored speech span), and anchor via `anchorSpansFromTags`.
    `openLen` skips a leading marker already excluded from the span text (the
    dash-paragraph's opening dash; 0 for a quote-run interior). Degenerates to
    a single speech span when the text has no interior dash-tag pattern —
    this is what makes it safe to call unconditionally on every quote run. */
function parseDialogueSpans(text: string, base: number, openLen: number, index: NameIndex): SpanEvidence[] {
  const conv = index.conventions;
  const spans: SpanEvidence[] = [];
  type Cut = { at: number; to: 'tag' | 'speech' };
  const cuts: Cut[] = [];
  for (const m of text.matchAll(TAG_OPEN)) cuts.push({ at: m.index! + m[1].length, to: 'tag' });
  for (const m of text.matchAll(SPEECH_RESUME)) cuts.push({ at: m.index! + m[1].length, to: 'speech' });
  cuts.sort((a, b) => a.at - b.at);

  let state: 'speech' | 'tag' = 'speech';
  let segStart = openLen;
  const push = (end: number) => {
    if (end <= segStart) return;
    spans.push({ kind: state, start: base + segStart, end: base + end });
  };
  for (const cut of cuts) {
    if (cut.to === 'tag' && state === 'speech') {
      push(cut.at);
      state = 'tag';
      segStart = cut.at;
    } else if (cut.to === 'speech' && state === 'tag') {
      push(cut.at);
      state = 'speech';
      segStart = cut.at;
    }
    /* a cut that doesn't match the current state is ignored — conservative */
  }
  push(text.length);

  /* Validate tag spans: a "tag" with no speech/beat verb was a mis-toggle →
     downgrade: whole text reverts to a single unanchored speech span. */
  const tagSpans = spans.filter((s) => s.kind === 'tag');
  const verbs = [...conv.speechVerbStems, ...conv.beatVerbStems];
  if (tagSpans.some((t) => !hasStem(text.slice(t.start - base, t.end - base), verbs))) {
    return [{ kind: 'speech', start: base + openLen, end: base + text.length }];
  }

  anchorSpansFromTags(spans, text, base, index);
  return spans;
}

function parseDashParagraph(
  line: string,
  base: number,
  index: NameIndex,
  openLen: number,
): ParagraphEvidence {
  const spans = parseDialogueSpans(line, base, openLen, index);
  return { start: base, end: base + line.length, kind: 'dialogue', spans };
}

interface QuoteRun {
  start: number;
  end: number;
  openLen: number;
  closeLen: number;
}

/** Scripts with no inter-word spacing, where a delimiter with letters on both
    sides is ordinary text rather than a mis-read apostrophe.
    FORWARD-COVER, not live protection: `en` is the only shipped table pairing
    an apostrophe-shaped glyph as a closer, so today this branch is never
    reached and removing it leaves 725,066 corpus paragraphs byte-identical.
    It matters when #2286 adds ['‘','’'] to `zh` and `ru`, at which point the
    inner `’` of `“他说‘你好’然后走了”` becomes exactly the both-sides shape the
    first clause rejects. No test can make this fail yet; do not delete it as
    dead code. Hangul is deliberately absent: modern Korean uses inter-word
    spacing like English, so a `’` with Hangul on both sides is not ordinary
    unspaced text — it's exactly the mis-read-apostrophe shape the first
    clause exists to catch. */
const UNSPACED_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}]/u;
/** Only `’` is reachable today: `en` is the sole table pairing an
    apostrophe-shaped glyph as a CLOSER. `'` and `‘` are carried because
    nothing stops a future table pairing them, and because this is the exact
    set the corpus and the sweep were measured against. Do not narrow it
    without re-measuring. */
const APOSTROPHE_SHAPED = new Set(['’', "'", '‘']);

/** `\p{M}` alongside `\p{L}`: this path has no NFC-normalisation guarantee,
    and in decomposed (NFD) form a base letter and its combining mark are two
    separate code points — `André` decomposes to `Andr` + `e` + U+0301. Testing
    `\p{L}` alone misses the mark, so the character immediately before a
    closer reads as "not a letter" and the contraction clause in
    `isRealCloser` never fires for decomposed input — the #2288 bug,
    unfixed, whenever the manuscript arrives NFD. */
function isSpacedLetter(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{M}]/u.test(ch) && !UNSPACED_SCRIPT.test(ch);
}

/** Is `line[k]` really a closing delimiter, or an apostrophe? English writes
    both `’`, and `en`'s table carries ['‘','’'], so without this every
    contraction ends the run early: `‘I don’t know,’ she said.` yields the
    speech "I don" (#2288). Three shapes, all local to the glyph's neighbours:
      don’t / O’Brien   a letter on both sides
      ’em / ’cause      whitespace (or a bracket) then a letter, MID-LINE — a
                        real closer is never preceded by whitespace, it closes
                        onto the last character of the speech it terminates
      ‘’Tis             its own opener, then a letter — accepting it would
                        close on an empty interior and yield NO speech span,
                        destroying the turn rather than truncating it
    The `before === undefined` arm can't fire at the only call site (`k` is
    always `>= start + open.length >= 1`, so `line[k - 1]` always exists) —
    it's kept so the function stays total if that ever changes, not as a
    stand-in for a line-initial `’em`, which isn't reachable either. */
function isRealCloser(line: string, k: number, closer: string, openers: Set<string>): boolean {
  if (!APOSTROPHE_SHAPED.has(closer)) return true;
  const before = line[k - 1];
  const after = line[k + 1];
  if (isSpacedLetter(before) && isSpacedLetter(after)) return false;
  if ((before === undefined || /[\s([{]/u.test(before)) && isSpacedLetter(after)) return false;
  if (before !== undefined && openers.has(before) && isSpacedLetter(after)) return false;
  return true;
}

/** Find non-overlapping quoted runs for any of the language's quote pairs,
    leftmost-match-wins on overlap (conservative: never double-count a run).
    Closers are grouped BY OPENER so a run ends at the nearest closer of ANY
    glyph that pairs with its opener — not at a same-glyph closer sitting past
    a nearer, different-glyph one. Without this, German (the only language
    whose `„` opener maps to several closers — `“`/`”`/`"`) over-merges a
    mixed-closer paragraph: scanning the first `„` all the way to a later ASCII
    `"` while skipping past an intervening `“` would swallow the beat and the
    next turn (#1601). For each opener occurrence, the run ends at the NEAREST
    closer position across that opener's whole closer set; on a tie (two
    closers found at the same position) the earlier entry in the opener's
    closer list wins — so if a future language ever pairs prefix-related
    multi-char closers with one opener, order them longest-first there. A run's
    `closeLen` is the actually-matched closer's length (all current closers are
    one code unit).
    Rejecting an apostrophe-shaped closer (#2288) means the scan may resume
    looking for a LATER occurrence of that same glyph — and that resumed skip
    is bounded to the nearest following opener of ANY class, never crossing
    into a different turn. Without the bound, `Tom said the ‘phone wasn’t
    working. “I agree,” said Mary. It was the boys’ fault.` rejects the
    apostrophe in "wasn't", and with nothing to stop the skip it keeps hunting
    for another `’` straight through Mary's whole turn, landing on the
    "boys’" apostrophe and destroying "I agree," on the way there. The bound
    applies only to that resumed skip — a closer's FIRST occurrence is always
    eligible, unbounded, exactly as it was before #2288. */
function findQuoteRuns(line: string, pairs: Array<[string, string]>): QuoteRun[] {
  const closersByOpener = new Map<string, string[]>();
  for (const [open, close] of pairs) {
    const list = closersByOpener.get(open);
    if (list) list.push(close);
    else closersByOpener.set(open, [close]);
  }
  const openers = new Set(closersByOpener.keys());
  const candidates: QuoteRun[] = [];
  for (const [open, closers] of closersByOpener) {
    let pos = 0;
    for (;;) {
      const start = line.indexOf(open, pos);
      if (start < 0) break;
      const interiorStart = start + open.length;
      /* Bound for a REJECTED closer's resumed skip only (see the doc comment
         above): the nearest occurrence of ANY opener glyph — including this
         opener's own — at or after the interior start, or the line's length
         if none follows. Does not bound a closer's first occurrence. */
      let limit = line.length;
      for (const o of openers) {
        const at = line.indexOf(o, interiorStart);
        if (at >= 0 && at < limit) limit = at;
      }
      /* Nearest closer POSITION across the opener's closer set; ties go to the
         earlier entry in `closers`, matching the old alternation's
         leftmost-alternative rule. */
      let end: { at: number; glyph: string } | null = null;
      let nearestAny: { at: number; glyph: string } | null = null;
      for (const closer of closers) {
        let from = interiorStart;
        let firstOfGlyph = true;
        for (;;) {
          const at = line.indexOf(closer, from);
          if (at < 0) break;
          if (firstOfGlyph) {
            if (nearestAny === null || at < nearestAny.at) nearestAny = { at, glyph: closer };
            firstOfGlyph = false;
          } else if (at >= limit) {
            /* A later occurrence, reached only because an earlier one of the
               same glyph was rejected: past the limit it belongs to a
               different turn. Positions only increase from here, so no
               later occurrence of this closer is eligible either. */
            break;
          }
          if (isRealCloser(line, at, closer, openers)) {
            if (end === null || at < end.at) end = { at, glyph: closer };
            break;
          }
          from = at + closer.length;
        }
      }
      /* NEVER DELETE A RUN. If every closer after this opener is an
         apostrophe, fall back to the nearest one — i.e. exactly what this
         function chose before #2288. Truncating a turn is bad; deleting it
         turns dialogue into narration, which is worse and is the same harm
         class this change exists to fix. Measured: without this fallback the
         change loses speech in 90 real paragraphs, 74 of them entirely. */
      if (end === null) end = nearestAny;
      if (end === null) {
        /* No closer after this opener — and by the same shrinking-window
           argument, none after any LATER occurrence of it either: the
           closer-search window only shrinks as `start` increases, so once one
           occurrence of this opener has no closer, no later one can. Scanning
           still continues rather than stopping outright, so openers of OTHER
           classes still get their turn. */
        pos = start + open.length;
        continue;
      }
      candidates.push({
        start,
        end: end.at + end.glyph.length,
        openLen: open.length,
        closeLen: end.glyph.length,
      });
      /* Scanning resumes at the END of the accepted run: a second opener of
         the same class INSIDE a run yields no candidate. (Task 2 may move that
         end LATER than the old regex would have — the resume point follows the
         run, not the regex.) */
      pos = end.at + end.glyph.length;
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const runs: QuoteRun[] = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue; // overlaps an already-accepted run
    runs.push(c);
    cursor = c.end;
  }
  return runs;
}

/** Quote-language (en, de) + embedded-quote (ru/fr «…») narration branch:
    scan the paragraph for quoted runs → `speech` (recursively re-parsed for
    an interior dash-tag, e.g. ru «…, — сказал X. — …»); gaps → `narration`,
    reclassified `tag` when they carry a speech/beat verb stem, then anchored
    onto adjacent speech spans exactly like the dash path. */
function parseQuoteParagraph(line: string, base: number, index: NameIndex): ParagraphEvidence {
  const conv = index.conventions;
  const runs = findQuoteRuns(line, conv.quotePairs);
  const spans: SpanEvidence[] = [];
  let cursor = 0;
  for (const run of runs) {
    if (run.start > cursor) spans.push({ kind: 'narration', start: base + cursor, end: base + run.start });
    const interiorStart = run.start + run.openLen;
    const interiorEnd = run.end - run.closeLen;
    spans.push(...parseDialogueSpans(line.slice(interiorStart, interiorEnd), base + interiorStart, 0, index));
    cursor = run.end;
  }
  if (cursor < line.length) spans.push({ kind: 'narration', start: base + cursor, end: base + line.length });

  // Only a gap ADJACENT TO A REAL QUOTE RUN may be reclassified `narration`→`tag`.
  // When `runs` is empty, `spans` holds only the whole-paragraph fallback
  // span above (plain prose with no dialogue at all) — it must never be
  // reclassified, however many verb/beat stems ("smiled", "added", …) it
  // happens to contain.
  if (runs.length > 0) {
    for (const s of spans) {
      if (s.kind !== 'narration') continue;
      const gap = line.slice(s.start - base, s.end - base);
      const hasSpeechVerb = hasStem(gap, conv.speechVerbStems);
      const hasBeatVerb = hasStem(gap, conv.beatVerbStems);
      if (!hasSpeechVerb && !hasBeatVerb) continue;
      s.kind = 'tag';
      // A beat-only reclassification is weak evidence: an English "Anton
      // frowned." adjacent to a quote is a plausible beat attribution, but not
      // an authoritative speech tag. A speech-verb tag stays strong.
      if (!hasSpeechVerb) (s as SpanEvidence & { weakTag?: boolean }).weakTag = true;
    }
  }
  anchorSpansFromTags(spans, line, base, index);

  const kind = spans.some((s) => s.kind === 'speech') ? 'dialogue' : 'narration';
  return { start: base, end: base + line.length, kind, spans };
}
