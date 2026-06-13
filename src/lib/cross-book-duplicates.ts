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
     'wren' ⊂ 'sophiefoster')
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

/* A character's identity for cross-book "same person?" matching: home book
   + id (for the notLinkedTo guard) plus the name/alias surface forms. */
export interface CharacterIdentity {
  bookId: string;
  characterId: string;
  name: string;
  aliases?: string[];
  notLinkedTo?: Array<{ bookId: string; characterId: string }>;
}

/* A character's normalised name + alias tokens (empty tokens dropped). */
function identityTokens(x: { name: string; aliases?: string[] }): string[] {
  const out: string[] = [];
  const n = normaliseDuplicateToken(x.name);
  if (n) out.push(n);
  for (const a of x.aliases ?? []) {
    const t = normaliseDuplicateToken(a);
    if (t) out.push(t);
  }
  return out;
}

/* Are two same-series characters the same person, judged by name/alias?
   True when any pair of their normalised name/alias tokens `looksLikeSameName`
   (exact or strict-substring — e.g. "wren" ⊂ "sophiefoster", "Castor" ≡
   "bron-te"). Returns FALSE when either side has marked the other
   `notLinkedTo` — the user's "intentionally different" escape hatch — or when
   the two refer to the same (book, character) row. A bucket id on either side
   never matches (those are catch-alls, not a person).

   Same normalisation the analyzer's series-prior dedup uses
   (`server/src/workspace/series-prior-dedup.ts`) and the
   `voice-override-linked` route mirrors on the write side — keep the three
   in sync. */
export function sameCharacterByNameAlias(a: CharacterIdentity, b: CharacterIdentity): boolean {
  if (a.bookId === b.bookId && a.characterId === b.characterId) return false;
  if (UNMERGEABLE_IDS.has(a.characterId) || UNMERGEABLE_IDS.has(b.characterId)) return false;
  if ((a.notLinkedTo ?? []).some((p) => p.bookId === b.bookId && p.characterId === b.characterId))
    return false;
  if ((b.notLinkedTo ?? []).some((p) => p.bookId === a.bookId && p.characterId === a.characterId))
    return false;
  const ta = identityTokens(a);
  const tb = identityTokens(b);
  for (const x of ta) {
    for (const y of tb) {
      if (looksLikeSameName(x, y)) return true;
    }
  }
  return false;
}

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

        /* Suppression reads from a "resolved view" that prefers the hydrated
           Character (fresher — reflects in-session optimistic patches) and
           falls back to the library Voice's own aliases / notLinkedTo when
           no cast is loaded. The fallback is the fix for the global
           `#/voices` tab + any fresh load: foreign casts aren't hydrated
           there, so charA/charB are null and these filters used to be
           skipped entirely — re-flagging an already-linked pair on every
           reload (plan 101 bug fix 2026-05-26). The Voice carries the
           fields from the server (routes/voices.ts). NOTE: `candidate.*.character`
           below stays the resolved Character (or null) — the modal still
           gates its link/variant buttons on a genuinely-hydrated cast. */
        const supA = suppressionView(a, charA);
        const supB = suppressionView(b, charB);

        if (UNMERGEABLE_IDS.has(supA.id)) continue;
        if (UNMERGEABLE_IDS.has(supB.id)) continue;

        /* Alias filter: if either side already lists the other's name as
           an alias, the link is already in place — suppress. */
        if (hasAliasMatching(supA, b.character)) continue;
        if (hasAliasMatching(supB, a.character)) continue;

        /* notLinkedTo filter: if either side has marked the pair as
           intentional variant, suppress. The id fallback (resolved
           character id, else the voice id) catches cast members linked
           via `Character.voiceId === Voice.id` or where the two ids are
           identical — the typical case — without requiring both casts to
           be loaded. */
        if (hasNotLinkedTo(supA, b.bookId, supB.id)) continue;
        if (hasNotLinkedTo(supB, a.bookId, supA.id)) continue;

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

/* fs-11 — the INVERSE of detectDuplicateCandidates' notLinkedTo suppression.
   Returns the same-base-voice same-series cross-book pairs that ARE marked
   "different on purpose" (a notLinkedTo relation on either side), so the
   voices view can list them under an "Ignored duplicate suggestions" section
   with an Unmark button. Name-similarity is NOT required here — the user may
   have intentionally separated two genuinely same-named-but-different
   characters, OR the notLinkedTo was written for a pair the name heuristic
   would also have flagged; either way the stored relation is the source of
   truth for what to show. The same UNMERGEABLE / series-mate guards apply. */
export function detectIgnoredDuplicatePairs(
  ctx: DuplicateDetectionContext,
): DuplicateCandidate[] {
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

        const charA = resolveCharacter(a, ctx.charactersByBookId.get(a.bookId));
        const charB = resolveCharacter(b, ctx.charactersByBookId.get(b.bookId));
        const supA = suppressionView(a, charA);
        const supB = suppressionView(b, charB);
        if (UNMERGEABLE_IDS.has(supA.id)) continue;
        if (UNMERGEABLE_IDS.has(supB.id)) continue;

        /* Emit only when the pair is actually marked notLinkedTo on either
           side — that's what "ignored" means. */
        const ignored =
          hasNotLinkedTo(supA, b.bookId, supB.id) || hasNotLinkedTo(supB, a.bookId, supA.id);
        if (!ignored) continue;

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

/* The minimal shape the suppression filters read. A resolved Character
   satisfies it directly; so does a library Voice via `suppressionView`. */
interface ResolvedView {
  id: string;
  name: string;
  aliases?: string[];
  notLinkedTo?: Array<{ bookId: string; characterId: string }>;
}

/* Prefer the hydrated Character (fresher); fall back to the Voice's own
   carried fields (correct on a fresh load where casts aren't hydrated). */
function suppressionView(v: Voice, c: Character | null): ResolvedView {
  if (c) return { id: c.id, name: c.name, aliases: c.aliases, notLinkedTo: c.notLinkedTo };
  return { id: v.id, name: v.character, aliases: v.aliases, notLinkedTo: v.notLinkedTo };
}

function hasAliasMatching(c: ResolvedView, otherName: string | undefined): boolean {
  if (!otherName) return false;
  const target = otherName.trim().toLowerCase();
  if (!target) return false;
  if (c.name.trim().toLowerCase() === target) return true;
  return (c.aliases ?? []).some((a) => a.trim().toLowerCase() === target);
}

function hasNotLinkedTo(c: ResolvedView, otherBookId: string, otherCharacterId: string): boolean {
  if (!otherBookId || !otherCharacterId) return false;
  return (c.notLinkedTo ?? []).some(
    (p) => p.bookId === otherBookId && p.characterId === otherCharacterId,
  );
}

/* Optimistic foreign-cast cache reconciliation (bug fix on plan 101).

   The voices view reads cross-book casts from two sources: the redux cast
   slice (the open book) and a `globalCastCache` Map (foreign books,
   hydrated on demand). After a link / variant action the SERVER mutates a
   foreign book's cast.json, but the response doesn't carry the updated
   character — so the in-memory cache goes stale and `detectDuplicateCandidates`
   re-flags the pair the moment its memo re-runs. These two helpers reflect
   the server's write into the cache immediately, with guards byte-identical
   to the redux reducers (`applyAddAlias`, `applyNotLinked`) so the open-book
   and foreign-book branches can never diverge.

   Both return the SAME Map reference when nothing changes (book not cached,
   dedup hit, self-alias) so callers' `setGlobalCastCache(prev => fn(prev))`
   is a no-op render when there's nothing to do. */
export function appendAliasToCachedCharacter(
  cache: Map<string, Character[]>,
  bookId: string,
  characterId: string,
  aliasName: string,
): Map<string, Character[]> {
  const cached = cache.get(bookId);
  if (!cached) return cache;
  const trimmed = aliasName.trim();
  if (!trimmed) return cache;
  const key = trimmed.toLowerCase();
  let changed = false;
  const next = cached.map((c) => {
    if (c.id !== characterId) return c;
    if (c.name.trim().toLowerCase() === key) return c; // self-alias guard
    const existing = c.aliases ?? [];
    if (existing.some((a) => a.trim().toLowerCase() === key)) return c; // case-insensitive dedup
    changed = true;
    return { ...c, aliases: [...existing, trimmed] };
  });
  if (!changed) return cache;
  const map = new Map(cache);
  map.set(bookId, next);
  return map;
}

export function appendNotLinkedToCachedCharacter(
  cache: Map<string, Character[]>,
  bookId: string,
  characterId: string,
  otherBookId: string,
  otherCharacterId: string,
): Map<string, Character[]> {
  const cached = cache.get(bookId);
  if (!cached) return cache;
  if (!otherBookId || !otherCharacterId) return cache;
  let changed = false;
  const next = cached.map((c) => {
    if (c.id !== characterId) return c;
    const existing = c.notLinkedTo ?? [];
    if (existing.some((p) => p.bookId === otherBookId && p.characterId === otherCharacterId)) {
      return c; // pair already recorded
    }
    changed = true;
    return {
      ...c,
      notLinkedTo: [...existing, { bookId: otherBookId, characterId: otherCharacterId }],
    };
  });
  if (!changed) return cache;
  const map = new Map(cache);
  map.set(bookId, next);
  return map;
}

/* fs-11 counterpart to appendNotLinkedToCachedCharacter — reflect a DELETE
   not-linked-to (undo "different on purpose") into the foreign-cast cache by
   stripping the (otherBookId, otherCharacterId) entry from the cached
   character's notLinkedTo. Same no-op-returns-same-reference contract: book
   not cached / character missing / pair already absent → original Map back. */
export function removeNotLinkedToCachedCharacter(
  cache: Map<string, Character[]>,
  bookId: string,
  characterId: string,
  otherBookId: string,
  otherCharacterId: string,
): Map<string, Character[]> {
  const cached = cache.get(bookId);
  if (!cached) return cache;
  if (!otherBookId || !otherCharacterId) return cache;
  let changed = false;
  const next = cached.map((c) => {
    if (c.id !== characterId) return c;
    const existing = c.notLinkedTo ?? [];
    const filtered = existing.filter(
      (p) => !(p.bookId === otherBookId && p.characterId === otherCharacterId),
    );
    if (filtered.length === existing.length) return c; // pair already absent
    changed = true;
    return { ...c, notLinkedTo: filtered };
  });
  if (!changed) return cache;
  const map = new Map(cache);
  map.set(bookId, next);
  return map;
}
