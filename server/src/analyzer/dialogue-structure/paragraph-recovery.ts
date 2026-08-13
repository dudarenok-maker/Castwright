import type { LanguageConventions } from './types.js';

/* Opt-in, conservative recovery for DEGRADED manuscripts — where a source
   conversion (most commonly a Calibre TXT→EPUB) collapsed many dialogue turns
   into a single <p>, so dash-dialogue no longer opens a line and the parser's
   paragraph-start detection can't see it.

   This is a BODY TRANSFORMANCE on narration-open lines: it inserts a line break
   before a mid-paragraph dash ONLY when the turned-out segment carries ending
   dialogue EVIDENCE — i.e. a tag clause with a speech/beat verb (the same bar
   parseDialogueSpans applies, parser.ts). That single gate makes fabrication
   impossible rather than merely rare:

     • a genuine turn like “. — Речь, — сказал Антон.” splits  (has a verb tag)
     • a bare narration tail like “. — Толик отличался запасливостью…” does NOT
       split (no tag, no verb) → it stays glued and is never mis-detected;
     • an apposition dash (X — это Y) is never preceded by a sentence end, so it
       is not even a candidate.

   The inserted break makes the turn a line-starting dash, which the existing
   parseChapterStructure / parseDashParagraph machinery then handles normally
   (interior spans, anchoring, windows). Default OFF — a caller must opt in, so
   every existing corpus/test is byte-identical unless recovery is requested. */

const DASH = String.raw`(?:&mdash;|&ndash;|[-–—])`;

/** Candidate turn start: a sentence end followed by a dash (excludes the
    apposition “X — это Y”, which follows a word, not a period). */
// eslint-disable-next-line no-control-regex
const CANDIDATE = new RegExp(String.raw`([.!?…]|\.{3})\s*${DASH}\s*`, 'gu');

/** Interior tag opener: punctuation + dash + lowercase, same as parser.TAG_OPEN. */
const TAG_OPEN = new RegExp(String.raw`([,!?…]|\.{3})\s*${DASH}\s*(?=\p{Ll})`, 'gu');

/** Terminal punctuation that ends a clause/segment (a tag runs to the next one). */
const CLAUSE_END = /[.!?…]\s*/u;

function hasSpeechOrBeatVerb(text: string, conv: LanguageConventions): boolean {
  const lower = text.toLowerCase();
  const verbs = [...conv.speechVerbStems, ...conv.beatVerbStems];
  return verbs.some((s) => lower.includes(s));
}

/** true when `segment` (text of a candidate turn, starting after its leading
    dash) carries genuine dialogue evidence: it must contain a verb-bearing tag
    clause. A bare speech-like line with no tag fails this gate and is left as
    narration — never fabricated as speech. */
function hasTurnEvidence(segment: string, conv: LanguageConventions): boolean {
  for (const m of segment.matchAll(TAG_OPEN)) {
    // tag text runs from just past the dash to the next clause end (or end).
    const tagStart = (m.index ?? 0) + m[0].length;
    const tail = segment.slice(tagStart);
    const end = tail.search(CLAUSE_END);
    const tagText = (end === -1 ? tail : tail.slice(0, end)).trim();
    if (hasSpeechOrBeatVerb(tagText, conv)) return true;
  }
  return false;
}

/** Insert a line break before each evidenced mid-paragraph dash turn in a
    narration-open line. Returns the transformed body (paras joined by '\n').
    Pure; never mutates the input. */
export function splitEvidencedInteriorTurns(body: string, conv: LanguageConventions): string {
  if (!conv.dialogueOpen) return body; // only dash-dialogue languages
  const out: string[] = [];
  let changed = false;
  for (const line of body.split('\n')) {
    if (!line.trim()) { out.push(line); continue; }
    // skip lines that already open dialogue (nothing hidden to recover there)
    if (conv.dialogueOpen.test(line)) { out.push(line); continue; }
    // collect candidate turn-start dash offsets (at the DASH GLYPH, so the new
    // line begins with the dash and the prior piece ends cleanly before it)
    const cuts: number[] = [];
    for (const m of line.matchAll(CANDIDATE)) {
      const seg = line.slice((m.index ?? 0) + m[0].length);
      if (!hasTurnEvidence(seg, conv)) continue;
      const punctLen = m[1].length;
      const dashRel = m[0].slice(punctLen).search(/(?:&mdash;|&ndash;|[-–—])/);
      cuts.push((m.index ?? 0) + punctLen + dashRel);
    }
    if (cuts.length === 0) { out.push(line); continue; }
    changed = true;
    let cursor = 0;
    const pieces: string[] = [];
    for (const c of cuts) { pieces.push(line.slice(cursor, c)); cursor = c; }
    pieces.push(line.slice(cursor));
    out.push(pieces.map((p, i) => (i < pieces.length - 1 ? p.trimEnd() : p)).join('\n'));
  }
  return changed ? out.join('\n') : body;
}