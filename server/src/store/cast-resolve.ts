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
      const exact = byId.get(characterId);
      if (exact) return { character: exact };

      const hist = byHistory.get(characterId);
      if (hist) return { character: hist, viaAlias: characterId };

      const key = normaliseIdKey(characterId);
      const normId = byNormId.get(key);
      if (normId) return { character: normId, viaAlias: characterId };

      const normHist = byNormHistory.get(key);
      if (normHist) return { character: normHist, viaAlias: characterId };

      return undefined;
    },
  };
}
