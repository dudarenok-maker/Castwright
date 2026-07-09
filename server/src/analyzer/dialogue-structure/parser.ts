import type { ParagraphEvidence, SpanEvidence } from './types.js';
import type { NameIndex } from './name-matcher.js';
import { findRosterName } from './name-matcher.js';

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
    const name = findRosterName(text, index);
    if (name) {
      sp.speaker = { characterId: name, source: 'tag-name' };
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

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

interface QuoteRun {
  start: number;
  end: number;
  openLen: number;
  closeLen: number;
}

/** Find non-overlapping quoted runs for any of the language's quote pairs,
    leftmost-match-wins on overlap (conservative: never double-count a run). */
function findQuoteRuns(line: string, pairs: Array<[string, string]>): QuoteRun[] {
  const candidates: QuoteRun[] = [];
  for (const [open, close] of pairs) {
    const re = new RegExp(`${escapeRegExp(open)}[\\s\\S]*?${escapeRegExp(close)}`, 'gu');
    for (const m of line.matchAll(re)) {
      candidates.push({ start: m.index!, end: m.index! + m[0].length, openLen: open.length, closeLen: close.length });
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

  const verbs = [...conv.speechVerbStems, ...conv.beatVerbStems];
  for (const s of spans) {
    if (s.kind === 'narration' && hasStem(line.slice(s.start - base, s.end - base), verbs)) s.kind = 'tag';
  }
  anchorSpansFromTags(spans, line, base, index);

  const kind = spans.some((s) => s.kind === 'speech') ? 'dialogue' : 'narration';
  return { start: base, end: base + line.length, kind, spans };
}
