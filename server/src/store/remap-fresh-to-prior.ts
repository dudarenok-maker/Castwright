/* #2040 §4.4 — stop new drift from being minted at all. A re-analysis
   re-slugs an existing character under a fresh id (analyzer non-determinism,
   `cast-create.ts` vs the analyzer disagreeing on a slug, etc). Every other
   mechanism in this design fixes that up AFTER the fact, once it has already
   diverged; this one runs BEFORE the fresh roster and its sentences are
   persisted anywhere, so the id never gets a chance to drift.

   Matcher: Tier A from §4.2 — `normaliseForMatch`'d display name, widened
   (#3954) to the surname-tolerant join and the voiced-row selection rule
   `mergeCore` already uses (`merge-analysis-cast.ts`): a normalised fresh
   name held by exactly one fresh row chooses a prior candidate from the
   exact-name tier, falling back to a surname-tolerant tier only when the
   exact tier chose no row; in both tiers exactly one voiced row wins, else
   exactly one row in total, and a prior row claimed by more than one pair
   keeps only its exact pair. Ambiguous names, and any pair separated by a
   `notLinkedTo` edge, keep the fresh id: this module never guesses.

   §11 Q2 — composed against the SAME run's dedup→fold cumulative rewrite
   table (`composeRewrites(dd.rewrites, folded.rewrites)`, the table Site 1 —
   `applyRewriteToPriorCast` — later applies to the prior cast at cast.json
   persist time). A prior row is matched by its raw id (names don't change
   through that table) but ADOPTED at where that table says it is heading,
   not its stale current id: when a prior row's id is itself a key in the
   table (this run's own dedup already collapsing it onto a fresh survivor),
   the pair has already converged and this remap must stay out of the way —
   otherwise it fires first and rewrites the fresh survivor's id back onto
   the stale prior one, the opposite direction Site 1 (and Site 3,
   `mergeAnalysisResultWithExistingCast`'s name-fallback) already drive it,
   and whichever runs first would otherwise silently win. Confirmed against a
   real regression, not a hypothetical: the Task 8 end-to-end guard
   (`analysis.test.ts` — "cast id history end-to-end guard (#2040 Task 8)")
   fails without this composition. */

import { normaliseForMatch } from '../util/text-match.js';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import { MALE_BUCKET_ID, FEMALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import { declinesLinkOf, isVoicedOrReused, surnameTolerantMatch } from './merge-analysis-cast.js';
import { notLinkedToId } from './not-linked-to-scope.js';

type PriorCastRow = { id: string } & Record<string, unknown>;

/** Ids this remap must never mint, adopt or retire. Two families, both
    code-reserved rather than analyzer-minted:

    - the narrator (`NARRATOR_CHARACTER_IDS`) — it has its own identity
      mechanism (`applyNarratorIdentity`), and `mergeAnalysisResultWithExistingCast`
      excludes it from the sibling name-fallback on BOTH sides for the same
      reason (`merge-analysis-cast.ts:219` / `:260`, #2040 Task 12), as does
      `dedupePriorCastByName` (`:501`);
    - the two `foldMinorCast` buckets (`unknown-male` / `unknown-female`) —
      shared background-speaker slots, not people. Spec §1.4 records that
      _Exile_'s prior cast really holds `{id:'unknown-male', name:'Timkin'}`,
      so a correctly-slugged fresh `timkin` row genuinely name-matches one; the
      remap runs AFTER `foldMinorCast`, so a rewrite onto the bucket is never
      re-separated by anything downstream.

    Excluded in both directions. Adopting a reserved id (`target`) moves a real
    character's sentences onto a shared slot; retiring one (`freshRow.id`)
    hands every line the reserved row owns to a single character. The prior
    row's RAW id is checked too, not just its post-rewrite destination — a
    reserved id is rewritable (`roster-dedup.ts` exempts only the narrator), so
    a bucket heading elsewhere would otherwise slip through. */
function isReservedId(id: string): boolean {
  return NARRATOR_CHARACTER_IDS.includes(id) || id === MALE_BUCKET_ID || id === FEMALE_BUCKET_ID;
}

/* `Record<string, unknown>` rather than `{ name?: unknown }` deliberately —
   an all-optional object-literal target triggers TS's weak-type check
   against a source typed only via an index signature (PriorCastRow), which
   rejects the call despite the property being safely readable at runtime. */
function nameKeyOf(c: Record<string, unknown>): string {
  return typeof c.name === 'string' ? normaliseForMatch(c.name) : '';
}

/** Rewrite this run's fresh character/sentence ids onto the existing cast's
    ids wherever a normalised display name held by exactly one fresh row
    resolves to exactly one prior candidate — the exact-name tier first, then
    (only when the exact tier chose no row) the surname-tolerant join with the
    same voiced-row selection rule `mergeCore` uses (`merge-analysis-cast.ts`)
    — and no `notLinkedTo` edge separates the pair.

    `priorRewrites` is this run's own cumulative dedup→fold rewrite table
    (§11 Q2 — pass `composeRewrites(dd.rewrites, folded.rewrites)`; defaults
    to `{}` for callers with no such table). A prior candidate is looked up
    by its raw id, but ADOPTED at `priorRewrites[id] ?? id` — the id that
    row's own lineage is heading to this run. When that destination already
    equals the fresh candidate's own id the pair has already converged via
    the mechanisms that consume the same table, and this remap does nothing.

    `currentBookId` (optional) is the id of the book being analysed; it scopes
    the `notLinkedTo` gate by book (see `notLinkedToId`). Omit it to keep the
    bookId-blind behaviour.

    `idHistory` (optional) is the book's `cast-id-history.json` `supersededBy`
    map. A pair whose fresh id is already recorded there as retired to a
    different live prior id is refused (see the guard below). `null` means the
    file EXISTS but could not be read: the remap then makes no name join at
    all, exact or tolerant, for any fresh id. A join made blind to a recorded
    merge is written over that merge by the persist (it records the retirement
    unconditionally), silently, where the unjoined run is flagged downstream
    (`displaced` plus the "affected segments need review" log). The price is
    that a book with an unreadable history keeps drifted fresh ids until the
    next healthy run, which is the same state it was in before the remap
    existed; a silent overwrite of a user's merge is the worse failure.

    Returns new arrays; `fresh`, `sentences` and `priorCast` are not
    mutated. */
export function remapFreshToPriorIds<
  C extends { id: string },
  S extends { characterId: string },
>(
  fresh: C[],
  sentences: S[],
  priorCast: ReadonlyArray<PriorCastRow>,
  priorRewrites: Readonly<Record<string, string>> = {},
  currentBookId?: string,
  idHistory: Readonly<Record<string, string>> | null = {},
): { characters: C[]; sentences: S[]; rewrites: Record<string, string> } {
  if (fresh.length === 0 || priorCast.length === 0 || idHistory === null) {
    return { characters: [...fresh], sentences: [...sentences], rewrites: {} };
  }

  const priorIdAfter = (id: string): string => priorRewrites[id] ?? id;
  const priorLiveIds = new Set(priorCast.map((p) => priorIdAfter(p.id)));

  const freshByName = new Map<string, C[]>();
  for (const f of fresh) {
    const key = nameKeyOf(f as unknown as Record<string, unknown>);
    if (!key) continue;
    const list = freshByName.get(key);
    if (list) list.push(f);
    else freshByName.set(key, [f]);
  }

  const priorByName = new Map<string, PriorCastRow[]>();
  for (const p of priorCast) {
    const key = nameKeyOf(p);
    if (!key) continue;
    const list = priorByName.get(key);
    if (list) list.push(p);
    else priorByName.set(key, [p]);
  }

  const freshIds = new Set(fresh.map((f) => f.id));

  /* #3954 child 1 — candidate selection widened to the surname-tolerant join
     and the voiced-row selection rule `mergeCore` already uses
     (`merge-analysis-cast.ts`). For each normalised fresh name held by
     exactly one fresh row, choose a prior candidate: the exact tier first
     (prior rows with that normalised name), then — only when the exact tier
     chose no row — the tolerant tier (prior rows whose normalised name
     `surnameTolerantMatch`es it; the exact preference rides on that tier
     ordering). In both tiers a candidate must be a row the fresh roster did
     not already take over by id (`!freshIds.has(priorIdAfter(p.id))`, this
     remap's form of mergeCore's "dropped by id"), and the selection rule
     decides among the survivors: exactly one voiced/reused row wins, else
     exactly one row in total, else the name is ambiguous and no row is
     chosen — and a set in which one survivor declines (`notLinkedTo`) the
     series link another carries in `matchedFrom` is ambiguous too, whatever
     the voiced rule would pick (#3965, the same `declinesLinkOf` decision
     `mergeCore` refuses a collapse on: the remap would otherwise hand the
     declined link to the voiced twin's id). Every guard below then runs on
     the chosen pair, unchanged and in the same order as before this widening. */
  const choosePrior = (rows: ReadonlyArray<PriorCastRow>): PriorCastRow | undefined => {
    /* The narrator is never a candidate, and so never a voiced twin either:
       `mergeCore` drops `NARRATOR_CHARACTER_IDS` rows before its own selection
       (`merge-analysis-cast.ts`), so a voiced narrator renamed to a
       character's name must not make that name ambiguous here. The two
       buckets stay in, as in `mergeCore`; `isReservedId` still refuses them
       after selection. */
    const eligible = rows.filter(
      (p) => !freshIds.has(priorIdAfter(p.id)) && !NARRATOR_CHARACTER_IDS.includes(p.id),
    );
    // Over `eligible`, not `rows`: a row the fresh roster already took over by
    // id is not a candidate, so it is not a twin whose decision matters here.
    if (eligible.some((c) => eligible.some((o) => o !== c && declinesLinkOf(c, o)))) {
      return undefined;
    }
    const voiced = eligible.filter(isVoicedOrReused);
    if (voiced.length === 1) return voiced[0];
    if (voiced.length === 0 && eligible.length === 1) return eligible[0];
    return undefined;
  };

  /* Surviving (fresh, prior) pairs — exact-tier pairs flagged — collected
     before `rewrites` is built so the claim-once guard below can count them
     per prior row. */
  const pairs: { freshRow: C; priorRow: PriorCastRow; target: string; exact: boolean }[] = [];

  for (const [key, freshCandidates] of freshByName) {
    if (freshCandidates.length !== 1) continue;
    const freshRow = freshCandidates[0];

    const exactRow = choosePrior(priorByName.get(key) ?? []);
    // Tolerant tier — ONLY because the exact tier chose no row. The `??`
    // short-circuits, so the tolerant scan never even runs when it did.
    const priorRow =
      exactRow ?? choosePrior(priorCast.filter((p) => surnameTolerantMatch(key, nameKeyOf(p))));
    if (!priorRow) continue;
    const exact = exactRow !== undefined;
    const target = priorIdAfter(priorRow.id);
    // Already converged via this run's own dedup→fold rewrite table (Site 1
    // / Site 3 territory) — nothing left for this remap to do.
    if (target === freshRow.id) continue;
    // Never remap onto an id a DIFFERENT fresh character already holds this
    // run — that would silently collapse two distinct people onto one row.
    if (freshIds.has(target)) continue;
    /* Wave 2 final-review finding 1(a) — the mirror of the guard above, and
       the reason it is needed: this rewrite is recorded as a retirement
       (§4.4 call site 4), and `retireCharacterId` unconditionally repoints
       every history entry whose VALUE is `from` (`cast-id-history.ts:123-127`).
       That is only sound when `from` is genuinely dead. Five of the six
       producers guarantee it; this one does not, so check here: if a
       DIFFERENT prior row still holds `freshRow.id` after this run's own
       dedup→fold table is applied to the prior cast (i.e. it survives into
       the cast.json this run writes, either overlaid or carried forward),
       retiring that id would drag unrelated frozen segments onto the wrong
       character — durably, and invisibly, since the end-of-run
       `dropSupersededIdsReclaimedByLiveCast` removes the reclaimed KEY but
       never the collateral repoint. Compared in POST-rewrite id space, the
       same space `target` is already in: a prior row that holds the id but is
       itself collapsing elsewhere this run will not hold it after the persist,
       and must not block a legitimate remap. */
    if (priorCast.some((p) => p !== priorRow && priorIdAfter(p.id) === freshRow.id)) continue;
    // Wave 2 final-review finding 2 — see `isReservedId`. Both directions,
    // and the prior row's raw id as well as its destination.
    if (isReservedId(freshRow.id) || isReservedId(priorRow.id) || isReservedId(target)) continue;
    /* #3954 review finding 4 — the fresh id is already retired in the id
       history to a DIFFERENT live prior id: the user merged that character
       into it, a recorded decision like a `notLinkedTo` edge. Retiring the
       id onto this pair would overwrite that entry (`retireCharacterId` writes
       `supersededBy[from]` unconditionally) and send every line the user
       assigned to the merge target to this row instead. Follow the history:
       refuse the name join. A recorded target that is no longer live is a
       stale entry the persist prunes, and does not block.

       "Refuse" has to mean more than leaving the fresh row alone: a fresh row
       that keeps its own id is a LIVE row, and the resolver is exact-id-first
       (and the persist drops a history key a live row reclaims), so the lines
       would stop resolving to the merge target. The refusal therefore adopts
       the recorded target instead of the name-join one, subject to the same
       reserved / notLinkedTo / held-by-a-fresh-row guards, and the retirement
       it records is the entry already on file. */
    /* The history value is a RAW id; every id this function compares it with
       (`target`, `priorLiveIds`, `freshIds`) is post-rewrite, so translate it
       first or a recorded target that is itself moving this run reads as
       unrecorded and the join overwrites the merge. */
    const recordedRaw = idHistory[freshRow.id];
    const recordedTo = recordedRaw === undefined ? undefined : priorIdAfter(recordedRaw);
    if (recordedTo !== undefined && recordedTo !== target && priorLiveIds.has(recordedTo)) {
      const recordedRow = priorCast.find((p) => priorIdAfter(p.id) === recordedTo);
      if (
        recordedRow &&
        !freshIds.has(recordedTo) &&
        !isReservedId(recordedTo) &&
        !isReservedId(recordedRow.id) &&
        !notLinkedToId(recordedRow, freshRow.id, currentBookId) &&
        !notLinkedToId(freshRow as unknown as Record<string, unknown>, recordedRow.id, currentBookId)
      ) {
        pairs.push({ freshRow, priorRow: recordedRow, target: recordedTo, exact: true });
      }
      continue;
    }
    if (
      notLinkedToId(priorRow, freshRow.id, currentBookId) ||
      notLinkedToId(freshRow as unknown as Record<string, unknown>, priorRow.id, currentBookId)
    ) {
      continue;
    }
    pairs.push({ freshRow, priorRow, target, exact });
  }

  /* Claim-once (#3954, the mirror of mergeCore's `:328-390` guard): a prior
     row claimed by more than one surviving pair loses its TOLERANT pairs; an
     exact pair is never removed (a prior row has exactly one normalised name,
     so at most one exact pair can ever claim it). Only then build `rewrites`. */
  const claims = new Map<PriorCastRow, number>();
  for (const pair of pairs) {
    claims.set(pair.priorRow, (claims.get(pair.priorRow) ?? 0) + 1);
  }
  const rewrites: Record<string, string> = {};
  for (const pair of pairs) {
    if (!pair.exact && (claims.get(pair.priorRow) ?? 0) > 1) continue;
    rewrites[pair.freshRow.id] = pair.target;
  }

  if (Object.keys(rewrites).length === 0) {
    return { characters: [...fresh], sentences: [...sentences], rewrites: {} };
  }

  const characters = fresh.map((c) => {
    const to = rewrites[c.id];
    return to ? { ...c, id: to } : c;
  });
  const remappedSentences = sentences.map((s) => {
    const to = rewrites[s.characterId];
    return to ? { ...s, characterId: to } : s;
  });

  return { characters, sentences: remappedSentences, rewrites };
}
