import type { LanguageConventions } from './types.js';
import type { NameIndex } from './name-matcher.js';
import { findRosterName } from './name-matcher.js';

/* Opt-in, conservative recovery for DEGRADED manuscripts — where a source
   conversion (most commonly a Calibre TXT→EPUB) collapsed many dialogue turns
   into a single <p>, so dash-dialogue no longer opens a line and the parser's
   paragraph-start detection can't see it.

   This is a BODY TRANSFORMATION on narration-open lines: it inserts a line break
   before a mid-paragraph dash ONLY when the turned-out segment carries ending
   dialogue EVIDENCE — an interior tag clause that anchors a SPEAKER. The tag
   must (a) contain a speech/beat verb AND (b) carry a roster NAME or a
   first-person pronoun (я) — the same attribution bar parseDialogueSpans uses.
   That combined gate keeps fabrication structurally impossible:

     • a genuine turn like “. — Речь, — сказал Антон.” splits      (named tag)
     • a first-person turn like “. — Возьми, — сказал я.” splits    (я tag)
     • a bare narration tail “. — Толик отличался запасливостью…” never splits
       (no tag) → stays glued, never mis-detected;
     • a beat/pronoun narration interruption, e.g. “. — Картина, — воскликнул он
       мысленно…” does NOT split — the tag is neither named nor first-person, so
       an un-attributable beat verb can never promote narration to speech;
     • an apposition dash (X — это Y) is never preceded by a sentence end, so it
       is not even a candidate.

   TRADEOFF, explicit: evidence requires a SPEAKER ANCHOR, so a genuine turn
   whose tag is only a bare third-person pronoun (“. — Нет, — ответил он.”) is
   NOT recovered — the ambiguity (could be narration: «он покачал головой») is
   deliberately resolved against recovery. Recovery restores COVERAGE only for
   turns it can attribute (named or first-person); everything else is left glued
   rather than fabricated.

   OFFSET GUARANTEE: this transformation is STRICTLY LENGTH-PRESERVING — it only
   replaces the single whitespace char before an evidenced dash with '\n' (1:1)
   and never removes/trims anything else. The returned body has the SAME LENGTH
   and IDENTICAL span offsets as the input, so recovery can run ON BY DEFAULT
   without disturbing the aligner/model: structure spans, the aligner, and
   downstream all stay in the original body's coordinate space. (The only
   change is whitespace type at recovered boundaries, which the aligner's
   whisper-normalization treats as equivalent.)

   The inserted break makes the turn a line-starting dash, which the existing
   parseChapterStructure / parseDashParagraph machinery then handles normally
   (interior spans, anchoring, windows). Default OFF — a caller must opt in, so
   every existing corpus/test is byte-identical unless recovery is requested. */

const DASH = String.raw`(?:&mdash;|&ndash;|[-–—])`;

/** Candidate turn start: a sentence end followed by a dash (excludes the
    apposition “X — это Y”, which follows a word, not a period). */
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

/** true when `segment` (a candidate turn, starting after its leading dash) is a
    real attributed dialogue turn: it must contain a tag clause that BOTH carries
    a speech/beat verb AND anchors a speaker (a roster name or first-person я).
    A beat/pronoun narration interruption has neither → it is left as narration,
    never fabricated as speech. */
function hasTurnEvidence(segment: string, index: NameIndex): boolean {
  const conv = index.conventions;
  for (const m of segment.matchAll(TAG_OPEN)) {
    // tag text runs from just past the dash to the next clause end (or end).
    const tagStart = (m.index ?? 0) + m[0].length;
    const tail = segment.slice(tagStart);
    const end = tail.search(CLAUSE_END);
    const tagText = (end === -1 ? tail : tail.slice(0, end)).trim();
    if (!hasSpeechOrBeatVerb(tagText, conv)) continue;
    // evidence must anchor a speaker: a roster name OR first-person pronoun.
    // Third-person pronouns are NOT evidence (он/она appear in narration beats).
    if (findRosterName(tagText, index)) return true;
    if (conv.pronouns.firstPerson?.test(tagText)) return true;
  }
  return false;
}

/** Insert a line break before each evidenced mid-paragraph dash turn in a
    narration-open line. Returns the transformed body (paras joined by '\n').
    Pure; never mutates the input. */
export function splitEvidencedInteriorTurns(body: string, index: NameIndex): string {
  const conv = index.conventions;
  if (!conv.dialogueOpen) return body; // only dash-dialogue languages
  const out: string[] = [];
  let changed = false;
  for (const line of body.split('\n')) {
    if (!line.trim()) { out.push(line); continue; }
    // skip lines that already open dialogue (nothing hidden to recover there)
    if (conv.dialogueOpen.test(line)) { out.push(line); continue; }
    // collect ALL candidate turn-start dash offsets first, so each candidate is
    // evidenced only against ITS OWN turn (up to the next candidate or end),
    // never the whole remainder (a later turn's verb tag must not promote an
    // earlier narration segment).
    const candidates: { dash: number; start: number }[] = [];
    for (const m of line.matchAll(CANDIDATE)) {
      const punctLen = m[1].length;
      const dashRel = m[0].slice(punctLen).search(/(?:&mdash;|&ndash;|[-–—])/);
      candidates.push({ dash: (m.index ?? 0) + punctLen + dashRel, start: (m.index ?? 0) + m[0].length });
    }
    const cuts: number[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const segEnd = i + 1 < candidates.length ? candidates[i + 1].start : line.length;
      const seg = line.slice(candidates[i].start, segEnd);
      if (hasTurnEvidence(seg, index)) cuts.push(candidates[i].dash);
    }
    if (cuts.length === 0) { out.push(line); continue; }
    changed = true;
    /* LENGTH-PRESERVING split: replace the single whitespace char immediately
       before each evidenced dash with '\n' (1:1), and NOTHING else. This keeps
       the body the SAME LENGTH and every span offset UNCHANGED, so recovery can
       run by default without the aligner/model seeing shifted offsets even when
       the whole pipeline is fed the original body. A dash with no whitespace
       before it (rare) is skipped rather than risking a length change. */
    const chars = [...line];
    for (const c of cuts) {
      if (c > 0 && /\s/u.test(chars[c - 1])) chars[c - 1] = '\n';
    }
    out.push(chars.join(''));
  }
  return changed ? out.join('\n') : body;
}