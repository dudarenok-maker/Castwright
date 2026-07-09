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
      // Quote-language + embedded-quote handling is Task 4; here: narration.
      out.push({
        start,
        end: start + line.length,
        kind: 'narration',
        spans: [{ kind: 'narration', start, end: start + line.length }],
      });
      continue;
    }
    out.push(parseDashParagraph(line, start, index, open[0].length));
  }
  return out;
}

function parseDashParagraph(
  line: string,
  base: number,
  index: NameIndex,
  openLen: number,
): ParagraphEvidence {
  const conv = index.conventions;
  const spans: SpanEvidence[] = [];
  /* Walk the paragraph after the opening dash, cutting at toggle points. */
  type Cut = { at: number; to: 'tag' | 'speech' };
  const cuts: Cut[] = [];
  for (const m of line.matchAll(TAG_OPEN)) cuts.push({ at: m.index! + m[1].length, to: 'tag' });
  for (const m of line.matchAll(SPEECH_RESUME)) cuts.push({ at: m.index! + m[1].length, to: 'speech' });
  cuts.sort((a, b) => a.at - b.at);

  let state: 'speech' | 'tag' = 'speech';
  let segStart = openLen;
  let lastSpeech: SpanEvidence | null = null;
  const push = (end: number) => {
    if (end <= segStart) return;
    const span: SpanEvidence = { kind: state, start: base + segStart, end: base + end };
    spans.push(span);
    if (state === 'speech') lastSpeech = span;
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
  push(line.length);

  /* Validate tag spans: a "tag" with no speech/beat verb was a mis-toggle →
     downgrade: whole paragraph reverts to a single unanchored speech span. */
  const tagSpans = spans.filter((s) => s.kind === 'tag');
  const verbs = [...conv.speechVerbStems, ...conv.beatVerbStems];
  if (tagSpans.some((t) => !hasStem(line.slice(t.start - base, t.end - base), verbs))) {
    return {
      start: base,
      end: base + line.length,
      kind: 'dialogue',
      spans: [{ kind: 'speech', start: base + openLen, end: base + line.length }],
    };
  }

  /* Anchor speech spans from their adjacent tag: name > pronoun-pending.
     Two-phase, highest-precedence first, so a tag can never claim a span
     that rightfully belongs to a DIFFERENT, later tag in the same paragraph:
       Phase 1: each tag anchors its immediately-PRECEDING speech span (its
       `target`) — this is unambiguous, the tag always belongs to that span.
       Phase 2: each tag anchors FOLLOWING speech spans, but only up to
       (exclusive) the next tag in the paragraph, and only spans phase 1
       left unanchored (the single-tag continuation case, e.g. "— Привет, —
       сказал Антон. — Как дела?"). */
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
  const tagIdx = spans.reduce<number[]>((acc, s, i) => {
    if (s.kind === 'tag') acc.push(i);
    return acc;
  }, []);
  for (const i of tagIdx) {
    const target = (spans[i - 1]?.kind === 'speech' ? spans[i - 1] : null) ?? lastSpeech;
    applyTag(spans[i], target);
  }
  for (const i of tagIdx) {
    const nextTagIdx = tagIdx.find((j) => j > i) ?? spans.length;
    const following = spans.slice(i + 1, nextTagIdx).filter((x) => x.kind === 'speech');
    for (const sp of following) applyTag(spans[i], sp);
  }
  return { start: base, end: base + line.length, kind: 'dialogue', spans };
}
