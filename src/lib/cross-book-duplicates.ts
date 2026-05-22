/* Cross-book duplicate detection (plan 101).

   Surfaces voice-library rows that *might* be the same character across
   two books in the same series — the case the Phase-0a name matcher can
   miss because token-level Jaccard between "Wren" and "Wren Sparrow"
   is low.

   The predicate is intentionally cheap (pure derivation off the voice
   library + per-book Character maps) and conservative: same base voice,
   same series, different book, name dedup hit, NOT already linked via
   aliases, NOT already marked as variant via notLinkedTo. Anything more
   speculative belongs in a separate "fuzzy match" surface that we don't
   ship in v1.

   Mirrors `server/src/workspace/series-prior-dedup.ts::normaliseToken` —
   keep the two byte-for-byte in sync. */

import type { Character, Voice } from './types';

/* Normalisation: lowercase + strip everything except a-z0-9. Matches
   `server/src/workspace/series-prior-dedup.ts:normaliseToken`. */
export function normaliseDuplicateToken(s: string | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Are two normalised tokens a likely "same character" match?

   Rule:
   - Identical → match
   - One is a strict, non-empty substring of the other → match (e.g.
     'Wren' ⊂ 'Wrenfoster')
   - Otherwise no match. Token-Jaccard, edit-distance, etc. are
     deliberately out of scope — false positives erode trust faster than
     a missed pair. */
export function looksLikeSameName(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && a.length !== b.length) {
    if (a.length > b.length && a.includes(b)) return true;
    if (b.length > a.length && b.includes(a)) return true;
  }
  return false;
}

/* Bucket / narrator ids that never participate in duplicate detection.
   Mirrors `src/views/voices.tsx::UNMERGEABLE_IDS` — keep in sync. */
const UNMERGEABLE_IDS = new Set(['narrator', 'unknown-male', 'unknown-female']);

export interface DuplicateCandidate {
  voiceKey: string; // provider|name (the family key)
  seriesKey: string; // author|series — both voices share this
  a: { voice: Voice; character: Character | null };
  b: { voice: Voice; character: Character | null };
}

/* Each library Voice carries (bookId, character, ttsVoice). Building
   duplicate candidates needs ONE more thing: the (author, series) tuple
   per bookId, so we know which voices are series-mates. The
   `seriesByBookId` map is hydrated from the library response server-
   side and from MOCK_BOOK_STATES under mocks. */
export interface BookSeriesInfo {
  author: string;
  series: string;
  isStandalone: boolean;
}

/* Per-book Character maps so the alias / notLinkedTo filters can apply.
   When a book's cast hasn't been fetched yet, the helper still emits the
   candidate (better mild false-positive than silent miss); when the cast
   IS loaded, the filter kicks in and suppresses already-resolved pairs. */
export interface DuplicateDetectionContext {
  library: Voice[];
  seriesByBookId: Map<string, BookSeriesInfo>;
  charactersByBookId: Map<string, Character[]>;
}

export function detectDuplicateCandidates(
  ctx: DuplicateDetectionContext,
): DuplicateCandidate[] {
  /* Bucket library voices by (provider, name) — the family axis. Skip
     voices without a ttsVoice (legacy / library-only rows pre-engine). */
  const byFamily = new Map<string, Voice[]>();
  for (const v of ctx.library) {
    if (!v.ttsVoice) continue;
    const key = `${v.ttsVoice.provider}|${v.ttsVoice.name}`;
    const arr = byFamily.get(key) ?? [];
    arr.push(v);
    byFamily.set(key, arr);
  }

  const out: DuplicateCandidate[] = [];
  for (const [voiceKey, members] of byFamily) {
    if (members.length < 2) continue;
    /* Pair-wise scan. Quadratic, but voice families rarely exceed ~10
       members; this is rendered eagerly on the voices view's main render
       path, not in a hot loop. */
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i];
        const b = members[j];
        if (a.bookId === b.bookId) continue;
        const seriesA = ctx.seriesByBookId.get(a.bookId);
        const seriesB = ctx.seriesByBookId.get(b.bookId);
        if (!seriesA || !seriesB) continue;
        if (seriesA.isStandalone || seriesB.isStandalone) continue;
        if (seriesA.author !== seriesB.author) continue;
        if (seriesA.series !== seriesB.series) continue;
        if (!looksLikeSameName(normaliseDuplicateToken(a.character), normaliseDuplicateToken(b.character)))
          continue;

        const charA = resolveCharacter(a, ctx.charactersByBookId.get(a.bookId));
        const charB = resolveCharacter(b, ctx.charactersByBookId.get(b.bookId));

        if (charA && UNMERGEABLE_IDS.has(charA.id)) continue;
        if (charB && UNMERGEABLE_IDS.has(charB.id)) continue;

        /* Alias filter: if either side already lists the other's name as
           an alias, the link is already in place — suppress. */
        if (charA && hasAliasMatching(charA, b.character)) continue;
        if (charB && hasAliasMatching(charB, a.character)) continue;

        /* notLinkedTo filter: if either side has marked the pair as
           intentional variant, suppress. When the other side's Character
           isn't loaded yet we fall back to its voice id — for cast
           members linked via `Character.voiceId === Voice.id` (or where
           `id` is identical), the on-disk `notLinkedTo.characterId`
           equals one of those two, so the fallback catches typical
           cases without requiring both casts to be loaded. */
        if (charA && hasNotLinkedTo(charA, b.bookId, charB?.id ?? b.id)) continue;
        if (charB && hasNotLinkedTo(charB, a.bookId, charA?.id ?? a.id)) continue;

        out.push({
          voiceKey,
          seriesKey: `${seriesA.author}|${seriesA.series}`,
          a: { voice: a, character: charA },
          b: { voice: b, character: charB },
        });
      }
    }
  }
  return out;
}

function resolveCharacter(v: Voice, characters: Character[] | undefined): Character | null {
  if (!characters) return null;
  const explicit = characters.find((c) => c.voiceId === v.id);
  if (explicit) return explicit;
  return characters.find((c) => c.id === v.id) ?? null;
}

function hasAliasMatching(c: Character, otherName: string | undefined): boolean {
  if (!otherName) return false;
  const target = otherName.trim().toLowerCase();
  if (!target) return false;
  if (c.name.trim().toLowerCase() === target) return true;
  return (c.aliases ?? []).some((a) => a.trim().toLowerCase() === target);
}

function hasNotLinkedTo(c: Character, otherBookId: string, otherCharacterId: string): boolean {
  if (!otherBookId || !otherCharacterId) return false;
  return (c.notLinkedTo ?? []).some(
    (p) => p.bookId === otherBookId && p.characterId === otherCharacterId,
  );
}
