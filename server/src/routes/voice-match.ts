/* POST /api/books/:bookId/voice-match

   Scores each incoming character against the workspace's voice library —
   every other book whose cast is confirmed (`state.castConfirmed: true`) —
   and returns ranked candidates per character. The library scanner lives
   at workspace/library-cast-scan.ts; this route projects the raw cast
   entries into a scoring shape, runs five MatchFactor scorers, and emits
   the top 5 candidates per character.

   Five factors (weighted in `overallScore`):
     - name_exact   (weight 0.65, via nameScore)  Normalized full-name match
                                                  OR alias hit on either side.
                                                  Score 1.0 when it fires.
     - name_tokens  (weight 0.65, via nameScore)  Jaccard of token sets pulled
                                                  from name + aliases.
                                                  Caps nameScore when no exact.
     - gender       (weight 0.15)                 1.0 if both present & equal;
                                                  0.5 if either absent; 0.0 differ.
     - age_range    (weight 0.10)                 Same rule as gender.
     - attributes   (weight 0.10)                 Jaccard of attribute sets
                                                  (lowercased).
   Floor: nameScore < 0.34 drops the candidate entirely — gender + attribute
   coincidence alone must not surface a "match" badge.

   The frontend voice-state flip (→ 'reused') happens in
   src/store/cast-slice.ts `applyVoiceMatches` and only fires when at least
   one candidate is returned for a character. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import {
  scanLibraryCharacters,
  type LibraryCharacterRecord,
} from '../workspace/library-cast-scan.js';
import { scanSeriesCharactersForBookId } from '../workspace/series-cast-scan.js';
import { jaccard, nameTokens, normaliseForMatch } from '../util/text-match.js';

export const voiceMatchRouter = Router();

/* Generic role-names exist in every book under the same deterministic id
   (the narrator keeps voiceId/id 'narrator' across the whole library), so a
   library-wide exact-name match fires against EVERY book's narrator — a
   Skulduggery narrator claiming a Keeper narrator, with the tie broken by
   arbitrary scan order. Unlike a real recurring character, a narrator is only
   legitimately reused WITHIN its series, where the analysis-time linker
   (series-reuse-link.ts) already handles continuity. So generic-role
   candidates are scoped to the current book's series; everything else keeps
   matching library-wide (designed-voice reuse across books is intentional). */
const GENERIC_ROLE_IDS = new Set(['narrator']);
function isGenericRole(c: CharacterMatchInput): boolean {
  return GENERIC_ROLE_IDS.has(c.id) || normaliseForMatch(c.name) === 'narrator';
}

export interface CharacterMatchInput {
  id: string;
  name: string;
  aliases?: string[];
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  attributes?: string[];
}

export interface MatchFactor {
  id: string;
  label: string;
  score: number;
  detail?: string;
}

export interface Candidate {
  voiceId: string;
  fromBookId: string;
  fromBookTitle: string;
  fromCharacterId: string;
  score: number;
  factors?: MatchFactor[];
}

/* Library voice projection — flattens a LibraryCharacterRecord into the
   exact fields the scorer needs. Keyed by `voiceId ?? id`, the same id the
   TTS pipeline hashes against (see voices.ts). `characterId` is carried so
   the library-cast override endpoint can address the exact record without
   re-walking the books tree. */
export interface LibraryVoice {
  voiceId: string;
  bookId: string;
  bookTitle: string;
  characterId: string;
  name: string;
  aliases: string[];
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  attributes: string[];
}

function projectLibraryVoice(rec: LibraryCharacterRecord): LibraryVoice | null {
  const c = rec.character;
  const voiceId = c.voiceId ?? c.id;
  if (!voiceId) return null;
  return {
    voiceId,
    bookId: rec.bookId,
    bookTitle: rec.bookTitle,
    characterId: c.id,
    name: c.name ?? c.id,
    aliases: Array.isArray(c.aliases) ? c.aliases.filter((a) => typeof a === 'string') : [],
    gender: c.gender,
    ageRange: c.ageRange,
    attributes: Array.isArray(c.attributes)
      ? c.attributes.filter((a) => typeof a === 'string')
      : [],
  };
}

/* All known name forms for a character — the canonical name plus any
   aliases. Used by both the exact and token scorers so "Marlow" hits when
   the library entry is "Wren" with aliases ['Marlow']. */
function nameForms(name: string, aliases: string[]): string[] {
  return [name, ...aliases].filter((s) => typeof s === 'string' && s.length > 0);
}

function exactNameOverlap(aForms: string[], bForms: string[]): boolean {
  const aSet = new Set(aForms.map(normaliseForMatch));
  for (const b of bForms) {
    if (aSet.has(normaliseForMatch(b))) return true;
  }
  return false;
}

/* Token overlap uses only the primary names — pooling aliases into the bag
   inflates the union and crushes the Jaccard for short names ("Marlow" vs
   "Marlow Halden" with a multi-word alias like "Sir Singe" would drop
   from 0.5 to 0.25 and fall through the floor). Alias matches travel the
   exact-overlap path, which is the right precision for them. */
function tokenOverlap(
  aName: string,
  bName: string,
): { score: number; aTokens: number; bTokens: number; shared: number } {
  const aTok = nameTokens(aName);
  const bTok = nameTokens(bName);
  if (aTok.size === 0 || bTok.size === 0)
    return { score: 0, aTokens: aTok.size, bTokens: bTok.size, shared: 0 };
  let shared = 0;
  for (const t of aTok) if (bTok.has(t)) shared++;
  const union = aTok.size + bTok.size - shared;
  return {
    score: union === 0 ? 0 : shared / union,
    aTokens: aTok.size,
    bTokens: bTok.size,
    shared,
  };
}

function identityFactor(
  a: string | undefined,
  b: string | undefined,
): { score: number; detail: string; contributed: boolean } {
  if (!a && !b) return { score: 0.5, detail: 'both unspecified', contributed: false };
  if (!a || !b)
    return {
      score: 0.5,
      detail: `${a ?? 'unspecified'} / ${b ?? 'unspecified'}`,
      contributed: false,
    };
  if (a === b) return { score: 1, detail: `${a} ≡ ${b}`, contributed: true };
  return { score: 0, detail: `${a} ≠ ${b}`, contributed: true };
}

function attributesFactor(a: string[], b: string[]): { score: number; detail: string } {
  const aSet = new Set(a.map((s) => s.toLowerCase()).filter((s) => s && s !== 'narrator'));
  const bSet = new Set(b.map((s) => s.toLowerCase()).filter((s) => s && s !== 'narrator'));
  if (aSet.size === 0 && bSet.size === 0)
    return { score: 0, detail: 'no attributes on either side' };
  let shared = 0;
  for (const x of aSet) if (bSet.has(x)) shared++;
  const score = jaccard(aSet, bSet);
  return { score, detail: `${shared} shared / ${aSet.size + bSet.size - shared} union` };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/* Score one incoming character against one library voice, returning a ranked
   candidate or null when it falls under the name-score floor. Exported so the
   analysis-time auto-link pass (series-reuse-link.ts) agrees byte-for-byte with
   what the client-side voice-match would have picked — same floor, same
   gender/age/attribute factors — instead of re-deriving its own scorer. */
export function scoreOne(input: CharacterMatchInput, voice: LibraryVoice): Candidate | null {
  const aForms = nameForms(input.name, input.aliases ?? []);
  const bForms = nameForms(voice.name, voice.aliases);

  const exact = exactNameOverlap(aForms, bForms);
  const tokens = tokenOverlap(input.name, voice.name);
  const nameScore = exact ? 1 : tokens.score;

  /* Floor: anything below a 1-of-3 token overlap is dropped. Gender + age
     coincidence alone must not produce a match badge on the confirm page. */
  if (nameScore < 0.34) return null;

  const gender = identityFactor(input.gender, voice.gender);
  const age = identityFactor(input.ageRange, voice.ageRange);
  const attrs = attributesFactor(input.attributes ?? [], voice.attributes);

  const overall = clamp01(
    0.65 * nameScore + 0.15 * gender.score + 0.1 * age.score + 0.1 * attrs.score,
  );

  const factors: MatchFactor[] = [];
  if (exact) {
    factors.push({
      id: 'name_exact',
      label: 'Name match',
      score: 1,
      detail: `${input.name} ≡ ${voice.name}${voice.aliases.length ? ` (aliases: ${voice.aliases.join(', ')})` : ''}`,
    });
  } else {
    factors.push({
      id: 'name_tokens',
      label: 'Token overlap',
      score: tokens.score,
      detail: `${tokens.shared} shared token${tokens.shared === 1 ? '' : 's'} of ${tokens.aTokens + tokens.bTokens - tokens.shared}`,
    });
  }
  if (gender.contributed) {
    factors.push({ id: 'gender', label: 'Gender', score: gender.score, detail: gender.detail });
  }
  if (age.contributed) {
    factors.push({ id: 'age_range', label: 'Age range', score: age.score, detail: age.detail });
  }
  if (attrs.score > 0) {
    factors.push({
      id: 'attributes',
      label: 'Attribute overlap',
      score: attrs.score,
      detail: attrs.detail,
    });
  }

  return {
    voiceId: voice.voiceId,
    fromBookId: voice.bookId,
    fromBookTitle: voice.bookTitle,
    fromCharacterId: voice.characterId,
    score: overall,
    factors,
  };
}

function asGender(v: unknown): CharacterMatchInput['gender'] {
  return v === 'male' || v === 'female' || v === 'neutral' ? v : undefined;
}
function asAgeRange(v: unknown): CharacterMatchInput['ageRange'] {
  return v === 'child' || v === 'teen' || v === 'adult' || v === 'elderly' ? v : undefined;
}

voiceMatchRouter.post('/:bookId/voice-match', async (req: Request, res: Response) => {
  const bookId = req.params.bookId;
  const body = (req.body ?? {}) as {
    characters?: unknown;
    libraryVoiceIds?: unknown;
  };
  const characters: CharacterMatchInput[] = Array.isArray(body.characters)
    ? body.characters
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map(
          (c): CharacterMatchInput => ({
            id: String(c.id ?? ''),
            name: String(c.name ?? c.id ?? ''),
            aliases: Array.isArray(c.aliases)
              ? c.aliases.filter((s): s is string => typeof s === 'string')
              : [],
            gender: asGender(c.gender),
            ageRange: asAgeRange(c.ageRange),
            attributes: Array.isArray(c.attributes)
              ? c.attributes.filter((s): s is string => typeof s === 'string')
              : [],
          }),
        )
        .filter((c) => c.id.length > 0)
    : [];

  const allow = Array.isArray(body.libraryVoiceIds)
    ? new Set(body.libraryVoiceIds.filter((v): v is string => typeof v === 'string'))
    : null;

  try {
    const records = await scanLibraryCharacters();
    const voices: LibraryVoice[] = [];
    for (const r of records) {
      /* Exclude self: a book's own confirmed cast must never appear as a
         library candidate for that same book. */
      if (r.bookId === bookId) continue;
      const v = projectLibraryVoice(r);
      if (!v) continue;
      if (allow && !allow.has(v.voiceId)) continue;
      voices.push(v);
    }

    /* Same-series bookIds for generic-role scoping. Resolves the current
       book's (author, series) and lists its confirmed series-mates; empty
       when the book is standalone, earliest, or not yet on disk — in which
       case a narrator legitimately matches nothing. */
    const seriesMateBookIds = new Set(
      (await scanSeriesCharactersForBookId(bookId)).map((r) => r.bookId),
    );

    const matches = characters.map((c) => {
      const generic = isGenericRole(c);
      const scored: Candidate[] = [];
      for (const v of voices) {
        /* A narrator only reuses within its own series; a real character
           keeps matching library-wide. */
        if (generic && !seriesMateBookIds.has(v.bookId)) continue;
        const cand = scoreOne(c, v);
        if (cand) scored.push(cand);
      }
      scored.sort((a, b) => b.score - a.score);
      return { characterId: c.id, candidates: scored.slice(0, 5) };
    });

    return res.json({ bookId, matches });
  } catch (e) {
    console.error('[voice-match] scoring failed', e);
    return res.status(500).json({ error: (e as Error).message || 'Voice match failed.' });
  }
});
