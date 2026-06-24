/* Deterministic recovery of dialogue lines that stage-2 left on the narrator.

   The roster-coverage guard (plan 182) ensures a tagged speaker is in the
   roster, but stage-2 attribution still sometimes leaves their quoted lines on
   `narrator` (observed: The Drowning Bell ch16 Behnam — `"…," Behnam noted.` with the
   quote stuck on narrator even though Behnam was in the cast). Those 0-line
   speakers are then deleted by the minor-cast fold, so a found character never
   persists (#537) and never speaks (#529).

   This post-stage-2 pass closes that gap with the same conservative heuristic as
   `scripts/recover-missing-character.mjs`: for a `<Name> <speech-verb>` tag
   sentence (the narrator action beat), the IMMEDIATELY-PRECEDING sentence is the
   speaker's quote — if it's currently `narrator` and `<Name>` resolves
   unambiguously to one rostered character, flip it to that character. It only
   ever moves a line OFF narrator onto a real, prose-named speaker, so a
   correctly-attributed book is a no-op (the quote before `"…," Wren said` is
   already `wren`, not narrator).

   `taggedSpeakerIds` exposes the same name-tag detection so `foldMinorCast` can
   keep a 0-line speaker that the prose clearly tags (backstop for speakers whose
   quote isn't narrator-adjacent and so can't be flipped). Pure — no I/O. */

import { grammarFor, tagRegexesFor, verbBeatRegexFor, isQuoteBearing } from './tag-grammar.js';

interface Sentence {
  id: number;
  chapterId: number;
  characterId: string;
  text: string;
}
interface RosterChar {
  id: string;
  name: string;
  aliases?: string[];
}

const NARRATOR_ID = 'narrator';

/* Pronoun / article / generic openers that look like a name before a verb but
   aren't — kept in sync with roster-coverage.ts's intent (a tag name is only
   accepted if it resolves to a rostered character, so this is a light guard). */
const STOPWORDS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'them',
  'who', 'that', 'this', 'the', 'a', 'an', 'and', 'but', 'so', 'then', 'there',
  'here', 'what', 'well', 'no', 'yes', 'his', 'their', 'its',
]);

/** Module STOPWORDS unioned with a grammar’s language stopwords. Returns the
    shared set unchanged when there are no extras (English path stays identical). */
function stopwordsFor(extra?: readonly string[]): Set<string> {
  return extra && extra.length ? new Set([...STOPWORDS, ...extra]) : STOPWORDS;
}

function stripPossessive(name: string): string {
  return name.replace(/['’]s$/i, '');
}

/* Build a token → characterId map for matching a bare prose name to a roster
   character. Each character contributes their full lowercased name plus every
   whitespace/dot/hyphen sub-token (len ≥ 2): "Behnam Aria" → "behnam aria",
   "behnam", "aria". A token that maps to MORE THAN ONE id is marked ambiguous
   (value null) so we never guess between two characters who share a name. */
function buildNameToId(roster: RosterChar[], stop: Set<string> = STOPWORDS): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const add = (tok: string, id: string) => {
    if (!tok || stop.has(tok)) return;
    if (!map.has(tok)) map.set(tok, id);
    else if (map.get(tok) !== id) map.set(tok, null); // ambiguous
  };
  for (const c of roster) {
    if (c.id === NARRATOR_ID) continue;
    for (const raw of [c.name, ...(c.aliases ?? [])]) {
      const n = stripPossessive((raw || '').trim()).toLowerCase();
      if (!n) continue;
      add(n, c.id);
      for (const tok of n.split(/[\s.-]+/).filter((t) => t.length >= 2)) add(tok, c.id);
    }
  }
  return map;
}

/** Resolve a captured prose name to a single roster id, or null if unknown /
    ambiguous / a stopword. */
function resolveNameToId(rawName: string, nameToId: Map<string, string | null>, stop: Set<string> = STOPWORDS): string | null {
  const key = stripPossessive(rawName).toLowerCase();
  if (stop.has(key)) return null;
  return nameToId.get(key) ?? null;
}

/** Ids of rostered characters the prose tags with a `<Name> <speech-verb>` beat
    somewhere in `sentences`. Used by the fold to keep a 0-line tagged speaker.
    §4.3 — mapped languages (en/es/ru) are detected; unmapped languages return an
    empty set. */
export function taggedSpeakerIds(
  sentences: Sentence[],
  roster: RosterChar[],
  language: string = 'en',
): Set<string> {
  const g = grammarFor(language);
  if (!g) return new Set<string>(); // unmapped language → stay gated
  const stop = stopwordsFor(g.stopwords);
  const nameToId = buildNameToId(roster, stop);
  const tagRes = tagRegexesFor(g);
  const ids = new Set<string>();
  for (const s of sentences) {
    for (const tagRe of tagRes) {
      const m = tagRe.exec(s.text);
      if (!m) continue;
      const id = resolveNameToId(m[1], nameToId, stop);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Flip narrator quotes that sit immediately before (or around) a `<Name> <speech-verb>`
    tag onto the resolved speaker. Returns a new sentence array (input not
    mutated), the number flipped, and a per-id breakdown.
    English uses the preceding-only strategy; es/ru use a guarded adjacency rule. */
export function recoverTaggedNarratorLines<T extends Sentence>(
  sentences: T[],
  roster: RosterChar[],
  language: string = 'en',
): { sentences: T[]; flipped: number; byId: Map<string, number> } {
  const g = grammarFor(language);
  if (!g) return { sentences, flipped: 0, byId: new Map() }; // unmapped → no-op
  const stop = stopwordsFor(g.stopwords);
  const nameToId = buildNameToId(roster, stop);
  const tagRes = tagRegexesFor(g);
  const out = sentences.map((s) => ({ ...s }));
  const byId = new Map<string, number>();
  let flipped = 0;

  // helper local to recoverTaggedNarratorLines:
  const firstTagMatch = (text: string): RegExpExecArray | null => {
    for (const tagRe of tagRes) {
      const m = tagRe.exec(text);
      if (m) return m;
    }
    return null;
  };

  const flipQ = (q: T, id: string) => {
    if (q.characterId !== NARRATOR_ID || q.characterId === id) return;
    q.characterId = id;
    byId.set(id, (byId.get(id) ?? 0) + 1);
    flipped += 1;
  };

  if (g.flipStrategy === 'preceding') {
    // English — UNCHANGED behaviour: the tag is its own beat; flip the prior sentence.
    for (let i = 1; i < out.length; i++) {
      const m = firstTagMatch(out[i].text);
      if (!m) continue;
      const id = resolveNameToId(m[1], nameToId, stop);
      if (!id) continue;
      const prev = out[i - 1];
      if (prev.chapterId !== out[i].chapterId) continue;
      flipQ(prev, id);
    }
    return { sentences: out, flipped, byId };
  }

  // 'adjacent' (es/ru) — preceding-first; following only under the interrupted
  // signature (S+1 not itself immediately followed by its own tag). Never flip S.
  const verbBeat = verbBeatRegexFor(g);
  const qualifies = (q: T | undefined, chapterId: number): boolean =>
    !!q &&
    q.chapterId === chapterId &&
    q.characterId === NARRATOR_ID &&
    isQuoteBearing(q.text) &&
    !verbBeat.test(q.text); // a neighbour that is itself a tag is never stolen

  for (let i = 0; i < out.length; i++) {
    const m = firstTagMatch(out[i].text);
    if (!m) continue;
    const id = resolveNameToId(m[1], nameToId, stop);
    if (!id) continue;
    const chapterId = out[i].chapterId;
    const prev = out[i - 1];
    const next = out[i + 1];
    if (qualifies(prev, chapterId)) flipQ(prev, id);
    if (qualifies(next, chapterId)) {
      const after = out[i + 2];
      const afterIsTag = !!after && after.chapterId === chapterId && verbBeat.test(after.text);
      if (!afterIsTag) flipQ(next, id);
    }
  }
  return { sentences: out, flipped, byId };
}
