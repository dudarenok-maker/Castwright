import { normaliseIdKey } from '../util/character-id.js';
import type { CastIdHistory } from './cast-id-history.js';

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
    site and force a cast.

    `history` takes the LOADED `CastIdHistory` object itself (or a `Pick` of
    its `supersededBy`/`rejected`/`rejectedPairs` fields), not a bare
    `supersededBy` map with `rejected` threaded separately (#2040 Task 17 fix
    round 1). The two used to be independent parameters, which let five of
    this function's six call sites pass `supersededBy` alone and silently
    default `rejected` to `[]` — a rejection that updated the banner and the
    analyzer's future matching but did nothing at synth/QA/splice/revision
    time, the one place it was supposed to matter (the same shared-consumer-
    contract defect shape as Wave 2's Critical on this issue). Taking one
    object makes that unrepresentable: every caller that loads `CastIdHistory`
    at all now passes the same object to every field at once. See each call
    site for how it obtains the object (`loadCastIdHistory(bookDir)` locally,
    or threaded through as a parameter from a caller that already loaded it).

    `rejected` (#2040 Task 17, spec §4.6, now LEGACY — see its own doc
    comment on `CastIdHistory`) and `rejectedPairs` (#2092/#2089 D1/D2, the
    pair-scoped successor) are both checked AFTER `exact` but ahead of the
    other three tiers — see the fields' own doc comments on `CastIdHistory`
    (`store/cast-id-history.ts`) for the fix-round-1 history: checking either
    before `exact` reintroduced #2040's original bug for any rejected id a
    later analysis reclaims as a genuine live cast row (common, not an edge
    case — the orphaned id is very often the character's own name). A live
    exact match always wins over a stale rejection.

    `rejectedPairs` differs from `rejected` in WHAT it blocks, not WHEN: a
    pair only blocks the tier-2/3/4 candidate whose id matches the pair's
    `to`, so a different, later target for the same `from` id is unaffected
    — `rejected` blocks `from` against every candidate, forever. A rejected
    pair whose tier candidate does NOT match returns undefined too (D2 — no
    fall-through to the next tier once a tier's candidate IS the rejected
    target), exactly like `rejected` does; it just doesn't preempt a tier
    whose candidate is a DIFFERENT character. */
export function buildCastResolver<T extends CastRecord>(
  cast: readonly T[],
  history: Pick<CastIdHistory, 'supersededBy' | 'rejected' | 'rejectedPairs'> = {
    supersededBy: {},
  },
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
  for (const [from, to] of Object.entries(history.supersededBy)) {
    const target = byId.get(to);
    if (!target) continue;
    if (!byHistory.has(from)) byHistory.set(from, target);
    put(byNormHistory, normaliseIdKey(from), target);
  }

  const rejectedSet = new Set(history.rejected ?? []);

  /* #2092/#2089 (D1, task 2) — `from -> Set<to>` for the pair-scoped reject,
     built in TWO keyspaces because the tiers it guards match in two
     different keyspaces, and each tier's rejection check must compare like
     with like against what that tier itself matched on (character ids are
     LLM free text — a raw-string comparison guarding a normalised-matching
     consumer is its own defect shape, independent of this one).

       - Tier 2 (`byHistory`, below) is keyed by the RAW `from` string in
         `supersededBy` and looked up with the raw `characterId` (see the
         `for (const [from, to] of history.supersededBy)` loop above) — so
         the rejection check for tier 2 is raw-keyed too.
       - Tiers 3/4 (`byNormId`/`byNormHistory`) are keyed by NORMALISED id and
         looked up with `normaliseIdKey(characterId)` — so a pair recorded
         against one raw spelling of `from` must still block a differently-
         punctuated/-cased id that normalises to the same key, since that's
         the identity those two tiers actually match on. Keying the
         tier-3/4 check by raw `from` instead would silently fail to block a
         reject the moment the manuscript's next mention of the same
         orphaned name uses different punctuation — invisible until a user
         re-clicks reject on what looks like the same row.

     `to` is compared raw in both maps: it's always a live cast id (an exact
     key in `byId`), never something normalised — normalising it would let an
     unrelated live id that merely normalises the same as the rejected
     target slip past the block. */
  const rejectedTargetsByRawFrom = new Map<string, Set<string>>();
  const rejectedTargetsByNormFrom = new Map<string, Set<string>>();
  for (const pair of history.rejectedPairs ?? []) {
    if (!rejectedTargetsByRawFrom.has(pair.from)) rejectedTargetsByRawFrom.set(pair.from, new Set());
    rejectedTargetsByRawFrom.get(pair.from)!.add(pair.to);

    const normFrom = normaliseIdKey(pair.from);
    if (!rejectedTargetsByNormFrom.has(normFrom)) rejectedTargetsByNormFrom.set(normFrom, new Set());
    rejectedTargetsByNormFrom.get(normFrom)!.add(pair.to);
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

      /* #2040 Task 17 fix round 1 — checked AFTER `exact`, not before (see
         the doc comment above): a live exact id must always win over a
         stale rejection. Trap (design review, repeated four times across
         this wave): `rejectedPairs`/`rejected` must never be consulted
         before this point — that's what reintroduces #2040's original bug. */
      if (rejectedSet.has(characterId)) return undefined;

      const hist = byHistory.get(characterId);
      if (hist) {
        /* #2092/#2089 D2 — a rejected pair returns undefined HERE, ending
           resolve() outright, rather than falling through to try tier 3/4
           for a different match. Falling through would resolve `characterId`
           onto a character the user never approved for it. */
        if (rejectedTargetsByRawFrom.get(characterId)?.has(hist.id)) return undefined;
        return { character: hist, viaAlias: characterId, via: 'history' };
      }

      /* `null` in either map means "ambiguous — stop": a tier-3 or tier-4 tie
         must return undefined without consulting the next tier, so `.has()`
         (present vs. absent) — not truthiness — is what decides whether to
         fall through. */
      const key = normaliseIdKey(characterId);
      if (byNormId.has(key)) {
        const normId = byNormId.get(key);
        if (!normId) return undefined;
        if (rejectedTargetsByNormFrom.get(key)?.has(normId.id)) return undefined;
        return { character: normId, viaAlias: characterId, via: 'normalised-id' };
      }

      if (byNormHistory.has(key)) {
        const normHist = byNormHistory.get(key);
        if (!normHist) return undefined;
        if (rejectedTargetsByNormFrom.get(key)?.has(normHist.id)) return undefined;
        return { character: normHist, viaAlias: characterId, via: 'normalised-history' };
      }

      return undefined;
    },
  };
}
