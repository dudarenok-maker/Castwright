import { normaliseIdKey } from '../util/character-id.js';
import type { CastIdHistory, RejectedPair } from './cast-id-history.js';

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
  /** #2128 — every RAW `supersededBy` key that matched, for the two history
      tiers. `viaAlias` is deliberately NOT this: it carries the QUERIED id in
      all three non-exact branches, which for a `'normalised-history'` hit is a
      different spelling from the key that actually matched, and it is the key
      that carries the `recordedAtSeq` marker.

      Tier 2 matches exactly one raw key (the queried id itself). Tier 4 can
      match SEVERAL: `byNormHistory` collapses every raw spelling that
      normalises the same onto the same live target into one entry (`put` only
      nulls a slot on DIFFERING targets), so the entry is backed by two or more
      markers with no basis in the map for choosing between them. The resolver
      reports every one of them as fact and `cast-audio-currency.ts` applies the
      fail-closed policy (`max`) — keeping the marker out of the resolver
      entirely, which is why this module needs no widening to read
      `recordedAtSeq`. Absent for `'exact'` and `'normalised-id'`, which have no
      history entry at all. */
  matchedHistoryKeys?: string[];
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
  /* #2128 — the raw `from` keys behind each normalised history slot, which
     `byNormHistory` itself discards. Collected below the liveness `continue`
     in the same loop, so a key whose target is dead never contributes a
     marker, matching exactly what the tier itself will resolve. */
  const normHistoryKeys = new Map<string, string[]>();
  for (const [from, to] of Object.entries(history.supersededBy)) {
    const target = byId.get(to);
    if (!target) continue;
    if (!byHistory.has(from)) byHistory.set(from, target);
    put(byNormHistory, normaliseIdKey(from), target);
    const normKey = normaliseIdKey(from);
    const existing = normHistoryKeys.get(normKey);
    if (existing) existing.push(from);
    else normHistoryKeys.set(normKey, [from]);
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
        return { character: hist, viaAlias: characterId, via: 'history', matchedHistoryKeys: [characterId] };
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
        return {
          character: normHist,
          viaAlias: characterId,
          via: 'normalised-history',
          matchedHistoryKeys: [...(normHistoryKeys.get(key) ?? [])],
        };
      }

      return undefined;
    },
  };
}

/** #2092/#2089 review round 2 (Important 1/2) — the `rejectedPairs` entries
 *  that actually GOVERN a given raw `characterId`, in the same sense
 *  `resolve()` itself would consult them for that id — never a broader
 *  union. Shared by BOTH the read side (`collectOrphanedCharacterFallbacks`'s
 *  `rejectedAgainst`, driving the banner chip) and the write side (the
 *  reject-undo route, finding which pair(s) a DELETE for this raw id
 *  actually removes) — two independent computations that happen to agree
 *  today is exactly the shape this wave keeps reproducing; this is ONE
 *  function, called by both.
 *
 *  Round 1 unioned the raw and normalised keyspaces unconditionally, which
 *  is broader than anything `resolve()` itself does: `resolve()` consults
 *  raw for tier 2 (`history`) and normalised for tiers 3/4
 *  (`normalised-id`/`normalised-history`) — never both for one id. That
 *  broadening is fail-closed and harmless on the repair script's `--apply`
 *  path, but wrong here: a segment resolving cleanly through tier 2 (raw)
 *  could pick up a chip from an UNRELATED pair that only matches after
 *  normalising a DIFFERENT raw spelling — disabling a working reject button
 *  for a reconciliation nothing ever blocked, and offering an Undo that the
 *  DELETE route (keyed by raw `from`) can't actually find.
 *
 *  Two rules, matching `resolve()`'s own per-tier precedence exactly:
 *
 *  1. A pair whose raw `from` EXACTLY equals `characterId` always applies —
 *     it is this id's own literal reject history (recorded by a POST
 *     against this exact raw spelling), valid regardless of which tier
 *     currently resolves it. This is what stays true even in the common
 *     case where the tier-2 `supersededBy` entry it once blocked has since
 *     been forgotten (#2089 D6, `forgetSupersededId`) and there is no live
 *     tier left to attribute the pair to at all — or where the id was
 *     rejected from the needs-your-decision picker with no tier match ever
 *     having existed. Determined by a plain string comparison; no resolver
 *     call needed.
 *  2. A pair whose NORMALISED `from` matches `characterId`'s normalised key
 *     applies ONLY when this id's resolution goes through the
 *     normalised-id/normalised-history tier — decided by resolving
 *     `characterId` against `supersededBy` ALONE (and, since round 3 below,
 *     the LEGACY `rejected` list), ignoring `rejectedPairs` entirely, so a
 *     currently-pair-blocked id still gets credited to whichever tier it
 *     would hit absent the PAIR reject specifically. A tier-2 (raw
 *     `supersededBy`) resolution NEVER consults the normalised keyspace —
 *     exactly like `resolve()`'s own tier 2 never falls through to check
 *     `rejectedTargetsByNormFrom`.
 *
 *  Round 3 (#2092/#2089 review round 3) — two changes from round 2's shape,
 *  both closing the SAME defect class this whole file keeps reproducing (a
 *  guard measuring a different quantity than the thing it protects):
 *
 *  - M-1: the "ignoring rejects" resolver used for rule 2 now takes
 *    `history.rejected` (the LEGACY id-wide list) as well as
 *    `history.supersededBy` — it must ignore PAIR rejects only, not every
 *    reject. Built with `rejected` OMITTED, an id blocked purely by a
 *    legacy `rejected` entry would still resolve past `exact` in the
 *    ignoring-resolver's eyes, land on a normalised tier, and this function
 *    would then wrongly credit an unrelated `rejectedPairs` entry for a
 *    block the legacy list actually caused (Undo would remove the pair,
 *    report `wasRejected: true`, and the row would stay blocked with no
 *    pair left to explain why). Latent on every book in the real workspace
 *    today — no book has ever written a legacy `rejected` entry — but the
 *    fix is unconditional, not gated on that.
 *  - Informational (round 2's own doc comment invited exactly this): the
 *    ignoring-resolver used to be a bare `(id) => CastResolution | undefined`
 *    function callers built themselves, once per book, and passed in.
 *    Nothing in that type distinguishes a rejects-ignoring resolver from a
 *    rejects-honouring one — passing the wrong one (or, per M-1, an
 *    incompletely-ignoring one) fails quiet and narrow. This function now
 *    takes `(cast, history)` and builds its OWN ignoring-resolver inside,
 *    the same way `buildCastResolver` itself is always handed `history`
 *    rather than a caller-assembled subset (see this file's own module doc
 *    comment) — making "the wrong resolver reached this call" structurally
 *    unrepresentable at both call sites, at the cost of rebuilding a
 *    resolver once per call instead of once per book. Accepted deliberately:
 *    `cast` here is a book's live roster (tens of entries), call volume is
 *    one per orphaned SEGMENT within one book (the real workspace's largest
 *    orphaned row is 67), not one per request across a fleet — correctness
 *    is worth more than this data scale's µs-level rebuild cost. */
export function rejectedPairsGoverning<T extends CastRecord>(
  characterId: string,
  cast: readonly T[],
  history: Pick<CastIdHistory, 'supersededBy' | 'rejected' | 'rejectedPairs'>,
): RejectedPair[] {
  const rejectedPairs = history.rejectedPairs ?? [];
  const raw = rejectedPairs.filter((p) => p.from === characterId);
  const resolveIgnoringPairRejects = buildCastResolver(cast, {
    supersededBy: history.supersededBy,
    rejected: history.rejected,
  }).resolve;
  const ignoring = resolveIgnoringPairRejects(characterId);
  const normalisedTierRelevant = ignoring?.via === 'normalised-id' || ignoring?.via === 'normalised-history';
  if (!normalisedTierRelevant) return raw;
  const key = normaliseIdKey(characterId);
  const normalised = rejectedPairs.filter((p) => p.from !== characterId && normaliseIdKey(p.from) === key);
  return [...raw, ...normalised];
}
