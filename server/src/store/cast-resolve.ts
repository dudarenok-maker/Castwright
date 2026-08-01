import { normaliseIdKey } from '../util/character-id.js';

type CastRecord = { id: string } & Record<string, unknown>;

export interface CastResolution {
  character: CastRecord;
  /** Set when the id matched through the history or a normalised key rather
      than an exact live id — callers may want to report the reconciliation. */
  viaAlias?: string;
}

/** Resolve a `characterId` coming from manuscript attribution or a frozen
    render against the book's cast, reading through superseded ids (#2040).
    IDS ONLY — display names are never consulted; name matching belongs to the
    merge/repair matcher (spec section 4.2). */
export function buildCastResolver(
  cast: readonly CastRecord[],
  history: Readonly<Record<string, string>> = {},
): { resolve(characterId: string): CastResolution | undefined } {
  const byId = new Map<string, CastRecord>();
  /* Normalised maps carry `null` on collision so a tie falls through to the
     orphan path instead of silently rendering one character as another —
     strictly worse than the narrator substitution it would replace. */
  const byNormId = new Map<string, CastRecord | null>();

  const put = (m: Map<string, CastRecord | null>, k: string, c: CastRecord) => {
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
  const byHistory = new Map<string, CastRecord>();
  const byNormHistory = new Map<string, CastRecord | null>();
  for (const [from, to] of Object.entries(history)) {
    const target = byId.get(to);
    if (!target) continue;
    if (!byHistory.has(from)) byHistory.set(from, target);
    put(byNormHistory, normaliseIdKey(from), target);
  }

  return {
    resolve(characterId: string): CastResolution | undefined {
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
