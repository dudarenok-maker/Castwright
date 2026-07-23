import type { LanguageConventions } from './types.js';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex } from './name-matcher.js';
import { parseChapterStructure } from './parser.js';
import { resolveWindows, type WindowRoster } from './windows.js';
import { alignSentences, type AlignedSentence } from './aligner.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

/* srv-59 Task 10 — recompute structural evidence fresh at script-review time
   and project it to a per-sentence annotation, rendered ONLY where structure
   disagrees with the current attribution or the line is unanchored speech.
   Pure (conventionsFor is a table lookup, not config/IO). Returns an EMPTY map
   for an unsupported language or a below-floor chapter — the review inbox then
   renders byte-identically to today. Keyed by SentenceOutput.id. */

export interface EvidenceRosterChar {
  id: string;
  name: string;
  gender?: 'male' | 'female' | 'neutral';
  aliases?: string[];
}

const NARRATOR_ID = 'narrator';

/* Mirrors analysis.ts findFirstPersonCharacter — a roster char whose aliases
   include the language's first-person pronoun. Reimplemented locally (not
   imported) since analysis.ts doesn't export it. */
function firstPersonId(roster: EvidenceRosterChar[], conv: LanguageConventions): string | null {
  if (!conv.pronouns.firstPerson) return null;
  const hit = roster.find((c) => (c.aliases ?? []).some((a) => conv.pronouns.firstPerson!.test(` ${a} `)));
  return hit?.id ?? null;
}

/* Mirrors analysis.ts rosterGenderMap. Defaults an ungendered character to
   'neutral' (never guessed). */
function genderMapOf(roster: EvidenceRosterChar[]): WindowRoster {
  return Object.fromEntries(roster.map((c) => [c.id, c.gender ?? 'neutral']));
}

/* Below this alignment floor the engine corrects nothing chapter-wide (mirrors
   the hardcoded `alignmentFloorPct: 80` at the crossExamine call site in
   analysis.ts) — so we must surface no hints either. */
const ALIGNMENT_FLOOR_PCT = 80;

/** Pure classifier: returns exactly one of the three annotation strings, or
    null when structure agrees with the current attribution (or the sentence
    didn't align at all, or is a lumped speech+tag sentence — the plan defines
    no annotation string for either case). */
function classifySentence(
  as: AlignedSentence,
  currentId: string,
  nameById: Map<string, string>,
  anchoredIds: Set<string>,
): string | null {
  if (as.spans.length === 0) return null; // unaligned — skip
  if (as.lumped) return null; // mixed speech+tag — no annotation string defined
  const speech = as.spans.find((s) => s.kind === 'speech');
  if (speech) {
    if (speech.speaker) {
      const x = speech.speaker.characterId;
      if (x === currentId) return null; // agreement
      // #1768 — never NAME a redirect target that has no strong name anchor
      // anywhere in the chapter. A derived speaker whose only footing is a weak
      // beat-gap tag-name (or a pronoun/alternation fill seeded by one) is a
      // phantom: a bad roster alias — e.g. the pronoun "her" tokenized out of an
      // alias like "her mother" — can name-match a character who isn't in the
      // chapter at all. Downgrade to the same "unproven" annotation an
      // unanchored speech line already gets, rather than point the review at a
      // speaker who isn't there.
      if (!anchoredIds.has(x)) return '[structure: speech, speaker unproven]';
      return `[structure: speech, tag→${nameById.get(x) ?? x}]`;
    }
    return '[structure: speech, speaker unproven]'; // unanchored speech — surfaces even if id matches
  }
  // only tag and/or narration spans → structure says narrator voice
  if (currentId === NARRATOR_ID) return null; // agreement
  return '[structure: narration]';
}

export function buildStructureEvidence(
  body: string,
  sentences: SentenceOutput[],
  roster: EvidenceRosterChar[],
  language: string | undefined,
): Map<number, string> {
  const conventions = conventionsFor(language);
  if (!conventions) return new Map();

  const index = buildNameIndex(roster, conventions);
  const paras = parseChapterStructure(body, index);
  resolveWindows(paras, genderMapOf(roster), firstPersonId(roster, conventions));
  const alignment = alignSentences(sentences, paras, body);
  if (alignment.alignedPct < ALIGNMENT_FLOOR_PCT) return new Map();

  const nameById = new Map(roster.map((c) => [c.id, c.name]));
  // #1768 — the chapter's strongly-anchored speaker set: characters carried by
  // at least one STRONG name tag (`source: 'tag-name'` that isn't a weak
  // beat-gap match). Only these may be NAMED as a `tag→X` redirect target;
  // see classifySentence. Computed over ALL paragraphs, so a character anchored
  // in a paragraph that didn't itself align to a sentence still counts present.
  const anchoredIds = new Set<string>();
  for (const p of paras)
    for (const s of p.spans)
      if (s.kind === 'speech' && s.speaker?.source === 'tag-name' && s.speaker.strength !== 'weak')
        anchoredIds.add(s.speaker.characterId);
  const out = new Map<number, string>();
  // The map is built purely from `sentences`' own ids (as.sentence.id, where
  // `as` ranges over `alignment.aligned`, itself derived 1:1 from the
  // `sentences` argument) — it can NEVER contain an id belonging to another
  // chapter's sentence set. This is the §4.6-style cross-chapter guard;
  // covered by script-review.test.ts test (c).
  for (const as of alignment.aligned) {
    const annotation = classifySentence(as, as.sentence.characterId, nameById, anchoredIds);
    if (annotation !== null) out.set(as.sentence.id, annotation);
  }
  return out;
}
