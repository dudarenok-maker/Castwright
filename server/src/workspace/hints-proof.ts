/* Parse-fallback hints pairing, checked against the saved sentences (#3837,
   plan 290 "The check"). Pure: no I/O, no lock.

   A parse fallback (`hintsSource: 'parse'`) carries no chapter identity, so
   count/id alone cannot tell a same-count reorder from before #3703 from a
   healthy book. The saved analysis sentences can: each analysed chapter's
   longer sentences should be found in its own parse piece, not in another one.

   All score arithmetic is integer and every tie-break is by index, so the check
   is deterministic. File order of the sentences is never used (A5): a split
   sentence's later pieces get a book-wide `maxId + 1` id and sort to the
   chapter's end. Calibrated read-only on every analysed book in the operator's
   workspace; see the plan's "Calibration". */

import { AUDIO_TAGS } from '../parsers/audio-tags.js';
import { titlePairsAt } from './restructure.js';

export interface PairingInput {
  /** state.chapters in order; the caller has asserted ids 1..n in order. */
  stateChapters: ReadonlyArray<{ id: number; title: string; titleOverridden?: boolean }>;
  /** manuscript-edits.json sentences, any order (sentencesOf(value)). */
  sentences: ReadonlyArray<{ chapterId: number; text?: unknown; vocalization?: boolean }>;
  /** The record's pure-parse pieces in order: title = record.parseTitles[j] (null where the parser
      made it up), body = record.chapterHints[j].body. Same length as stateChapters (count/id passed);
      a length mismatch throws (a programming error). */
  parse: ReadonlyArray<{ title: string | null; body: string }>;
  /** What an evidence-less position needs: nothing (analysis start) or today's title check (restructure). */
  evidenceLess: 'count-id' | 'title';
}

export type PairingResult =
  | { paired: true; evidenceChapters: number }
  | {
      paired: false;
      evidenceChapters: number;
      reason: 'score';
      chapterId: number;
      own: number;
      alt: number;
      evidence: number;
    }
  | { paired: false; evidenceChapters: number; reason: 'displaced-block'; chapterId: number; intoChapterId: number }
  | { paired: false; evidenceChapters: number; reason: 'title'; chapterId: number };

/** A chapter pairs when at least 2/5 (40%) of its evidence is in its own piece... */
export const PROOF_OWN_MIN_NUM = 2,
  PROOF_OWN_MIN_DEN = 5;
/** ...and its own count is at least 4x the best other piece's. */
export const PROOF_MARGIN = 4;
/** Shorter sentences ("Yes.", "okay,") match anywhere and are not evidence. The
    same floor as `analyzer/dialogue-structure/aligner.ts` `ANCHOR_MIN_LEN` (a
    needle long enough to trust), declared here so this module imports nothing
    from analyzer/. */
export const PROOF_EVIDENCE_MIN_LEN = 24;
/** This many evidence items found only in the same one other piece, adjacent by
    parse position, refuse even when the score passes (a merge-then-split before
    #3703 that moved a run of lines across a boundary). */
export const DISPLACED_BLOCK_LEN = 3;

/* -- normalisation --------------------------------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  mdash: '-',
  ndash: '-',
  hellip: '...',
  amp: '&',
  nbsp: ' ',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
};

const fromCodePointOr = (cp: number, original: string) => (cp <= 0x10ffff ? String.fromCodePoint(cp) : original);

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => fromCodePointOr(parseInt(h, 16), m))
    .replace(/&#([0-9]+);/g, (m, d: string) => fromCodePointOr(parseInt(d, 10), m))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/* Only the analyzer's own tag vocabulary, anywhere, with the whitespace after it.
   Manuscript text in brackets ("[FILE INACCESSIBLE]") survives. Applied after
   lower-casing. */
const AUDIO_TAG_RE = new RegExp(`\\[(?:${AUDIO_TAGS.join('|')})\\]\\s*`, 'g');

/** The content side, and the first step of the sentence side. `util/text-match.ts`
    `normaliseForMatch` is a subset of this; it is deliberately left alone (the
    evidence verifier depends on it). */
export function normaliseForProof(s: string): string {
  return decodeEntities(s)
    .normalize('NFC')
    .replace(/[‘’‚‛‹›′]/g, "'")
    .replace(/[“”„‟«»″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[ёЁ]/g, (c) => (c === 'ё' ? 'е' : 'Е'))
    .toLowerCase()
    .replace(AUDIO_TAG_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A saved sentence: also strip a leading and a trailing run of whitespace and
    quotes, since the model re-wraps each piece of a re-split quotation. */
export function normaliseSentenceForProof(s: string): string {
  return normaliseForProof(s).replace(/^[\s"'`]+/, '').replace(/[\s"'`]+$/, '');
}

/* -- the check -------------------------------------------------------- */

const SEP = '\u0001';
const GRAM = 8;
const NO_TARGET = -1;

interface Occurrences {
  /** Offsets into the concatenation, ascending. */
  offsets: number[];
  /** The pieces those offsets fall in. */
  pieces: Set<number>;
}

interface Item {
  pos: number;
  own: boolean;
  /** The one other piece holding a displaced item, or NO_TARGET when several do. */
  target: number;
  text: string;
}

export function checkParseHintsPairing(input: PairingInput): PairingResult {
  const { stateChapters, sentences, parse, evidenceLess } = input;
  const n = stateChapters.length;
  if (parse.length !== n) {
    throw new Error(`checkParseHintsPairing: ${parse.length} parse pieces for ${n} state chapters`);
  }

  /* Evidence: every counted saved sentence of 24+ normalised characters, one item
     per saved sentence (duplicates included). Vocalizations are analyzer text, not
     manuscript text; orphans (a chapterId not in state) are ignored. */
  const indexOf = new Map(stateChapters.map((c, i) => [c.id, i]));
  const evidence: string[][] = stateChapters.map(() => []);
  for (const s of sentences) {
    if (s.vocalization === true) continue;
    const i = indexOf.get(s.chapterId);
    if (i === undefined) continue;
    const text = normaliseSentenceForProof(String(s.text ?? ''));
    if (text.length >= PROOF_EVIDENCE_MIN_LEN) evidence[i]!.push(text);
  }
  const evidenceChapters = evidence.filter((e) => e.length > 0).length;

  /* Occurrence index: the candidate contents joined by a separator, every 8-char
     window without one indexed by offset. An evidence item looks up its first 8
     characters and verifies each candidate with startsWith. */
  const starts: number[] = [];
  let concat = '';
  for (const p of parse) {
    starts.push(concat.length);
    concat += normaliseForProof((p.title ?? '') + '\n' + p.body) + SEP;
  }
  const grams = new Map<string, number[]>();
  if (evidenceChapters > 0) {
    for (let x = 0; x + GRAM <= concat.length; x++) {
      const g = concat.slice(x, x + GRAM);
      if (g.includes(SEP)) continue;
      const at = grams.get(g);
      if (at) at.push(x);
      else grams.set(g, [x]);
    }
  }
  const pieceOf = (x: number): number => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const memo = new Map<string, Occurrences>();
  const occurrences = (text: string): Occurrences => {
    const hit = memo.get(text);
    if (hit) return hit;
    const offsets = (grams.get(text.slice(0, GRAM)) ?? []).filter((x) => concat.startsWith(text, x));
    const found = { offsets, pieces: new Set(offsets.map(pieceOf)) };
    memo.set(text, found);
    return found;
  };

  for (let i = 0; i < n; i++) {
    const chapterId = stateChapters[i]!.id;
    const items = evidence[i]!;
    const E = items.length;

    if (E === 0) {
      if (evidenceLess === 'title' && !titlePairsAt(stateChapters[i]!, parse[i]!.title)) {
        return { paired: false, evidenceChapters, reason: 'title', chapterId };
      }
      continue;
    }

    /* Score. `alt` counts only items absent from the own piece, so a recap
       chapter quoting its neighbour is not held against it. */
    let own = 0;
    const altCount = new Int32Array(n);
    const placed: Item[] = [];
    for (const text of items) {
      const { offsets, pieces } = occurrences(text);
      if (offsets.length === 0) continue;
      if (pieces.has(i)) {
        own++;
        placed.push({ pos: offsets.find((x) => pieceOf(x) === i)!, own: true, target: i, text });
      } else {
        for (const j of pieces) altCount[j]!++;
        const target = pieces.size === 1 ? [...pieces][0]! : NO_TARGET;
        placed.push({ pos: offsets[0]!, own: false, target, text });
      }
    }
    let alt = 0;
    for (let j = 0; j < n; j++) if (j !== i && altCount[j]! > alt) alt = altCount[j]!;
    if (!(own * PROOF_OWN_MIN_DEN >= E * PROOF_OWN_MIN_NUM && own >= PROOF_MARGIN * alt)) {
      return { paired: false, evidenceChapters, reason: 'score', chapterId, own, alt, evidence: E };
    }

    /* Block walk, by parse position (own first on a tie, then by text). An own
       item resets the streak; a displaced item extends it only when it targets
       the streak's one other piece. Items found nowhere were left out above. */
    placed.sort((a, b) =>
      a.pos !== b.pos ? a.pos - b.pos : a.own !== b.own ? (a.own ? -1 : 1) : a.text < b.text ? -1 : a.text > b.text ? 1 : 0,
    );
    let streak = 0;
    let streakTarget = NO_TARGET;
    for (const item of placed) {
      if (item.own) {
        streak = 0;
        streakTarget = NO_TARGET;
        continue;
      }
      if (item.target !== NO_TARGET && item.target === streakTarget) streak++;
      else {
        streak = 1;
        streakTarget = item.target;
      }
      if (streak >= DISPLACED_BLOCK_LEN) {
        return {
          paired: false,
          evidenceChapters,
          reason: 'displaced-block',
          chapterId,
          intoChapterId: stateChapters[streakTarget]!.id,
        };
      }
    }
  }

  return { paired: true, evidenceChapters };
}
