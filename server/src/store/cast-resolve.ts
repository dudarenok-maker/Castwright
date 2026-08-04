import { normaliseIdKey } from '../util/character-id.js';

/** Minimal shape `buildCastResolver` needs from a cast record: an id, and
    nothing else. `T extends CastRecord` therefore accepts ANY concrete cast
    type (this module never reads a second field), including ones like
    `CastCharacter` that have no index signature of their own — the previous
    `{ id: string } & Record<string, unknown>` bound rejected those at
    compile time despite being safe at runtime, since a type without an
    index signature isn't assignable to one that has it. */
type CastRecord = { id: string };

export interface CastResolution<T extends CastRecord = CastRecord> {
  character: T;
  /** Set when the id matched through the history or a normalised key rather
      than an exact live id — callers may want to report the reconciliation. */
  viaAlias?: string;
  /** Which tier actually matched, in the same precedence order `resolve()`
      checks them (#2040 Wave 3 review round 1 — additive, Wave-1 behaviour
      unchanged). `'exact'` pairs with `viaAlias` being unset; the other three
      always carry a `viaAlias`. Exists so a caller that needs to know WHY an
      id resolved (e.g. the orphan collector's alias-vs-normalised UI tag)
      reads it off the resolver instead of recomputing tier precedence in a
      second place — a second computation can disagree with this one on a
      normalised collision between a live id (tier 3) and an unrelated
      history entry (tier 4), since a normalised KEY match alone doesn't say
      which tier actually won. */
  via: 'exact' | 'history' | 'normalised-id' | 'normalised-history';
}

/** Resolve a `characterId` coming from manuscript attribution or a frozen
    render against the book's cast, reading through superseded ids (#2040).
    IDS ONLY — display names are never consulted; name matching belongs to the
    merge/repair matcher (spec section 4.2).

    Generic over the caller's own cast-record shape (`T`, inferred from
    `cast`) — `synthesise-chapter.ts`'s `CastCharacter`, `revisions.ts`'s cast
    type, etc. each carry different typed fields beyond `id`; a fixed
    `CastRecord` return type would erase them back to `unknown` at every call
    site and force a cast. */
export function buildCastResolver<T extends CastRecord>(
  cast: readonly T[],
  history: Readonly<Record<string, string>> = {},
): { resolve(characterId: string): CastResolution<T> | undefined } {
  const byId = new Map<string, T>();
  /* Normalised maps carry `null` on collision so a tie falls through to the
     orphan path instead of silently rendering one character as another —
     strictly worse than the narrator substitution it would replace. */
  const byNormId = new Map<string, T | null>();

  const put = (m: Map<string, T | null>, k: string, c: T) => {
    if (m.has(k)) { if (m.get(k)?.id !== c.id) m.set(k, null); }
    else m.set(k, c);
  };

  for (const c of cast) {
    if (!byId.has(c.id)) byId.set(c.id, c);
    put(byNormId, normaliseIdKey(c.id), c);
  }

  /* A history entry only counts when its TARGET is still a live cast id — a
     retirement pointing at a character that has since been deleted must not
     resurrect it. */
  const byHistory = new Map<string, T>();
  const byNormHistory = new Map<string, T | null>();
  for (const [from, to] of Object.entries(history)) {
    const target = byId.get(to);
    if (!target) continue;
    if (!byHistory.has(from)) byHistory.set(from, target);
    put(byNormHistory, normaliseIdKey(from), target);
  }

  return {
    resolve(characterId: string): CastResolution<T> | undefined {
      /* `characterId` can originate from untrusted on-disk JSON (a segment
         missing its `characterId` reads as `undefined` at runtime despite the
         `string` type above) — guard at this single entry point rather than
         trusting every caller, so a non-string falls through to the
         orphan/narrator path exactly like a genuine miss instead of throwing
         inside `normaliseIdKey`. */
      if (typeof characterId !== 'string') return undefined;

      const exact = byId.get(characterId);
      if (exact) return { character: exact, via: 'exact' };

      const hist = byHistory.get(characterId);
      if (hist) return { character: hist, viaAlias: characterId, via: 'history' };

      /* `null` in either map means "ambiguous — stop": a tier-3 or tier-4 tie
         must return undefined without consulting the next tier, so `.has()`
         (present vs. absent) — not truthiness — is what decides whether to
         fall through. */
      const key = normaliseIdKey(characterId);
      if (byNormId.has(key)) {
        const normId = byNormId.get(key);
        return normId
          ? { character: normId, viaAlias: characterId, via: 'normalised-id' }
          : undefined;
      }

      if (byNormHistory.has(key)) {
        const normHist = byNormHistory.get(key);
        return normHist
          ? { character: normHist, viaAlias: characterId, via: 'normalised-history' }
          : undefined;
      }

      return undefined;
    },
  };
}
