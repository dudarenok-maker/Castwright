/* #2040 §4.4 — stop new drift from being minted at all. A re-analysis
   re-slugs an existing character under a fresh id (analyzer non-determinism,
   `cast-create.ts` vs the analyzer disagreeing on a slug, etc). Every other
   mechanism in this design fixes that up AFTER the fact, once it has already
   diverged; this one runs BEFORE the fresh roster and its sentences are
   persisted anywhere, so the id never gets a chance to drift.

   Matcher: Tier A from §4.2 — `normaliseForMatch`'d display name, exactly one
   candidate on each side. Ambiguous names, and any pair separated by a
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

/** True when `row.notLinkedTo` names `targetId` in either entry shape the
    field is written in: a bare string (a hypothetical within-book edge this
    module accepts defensively, though nothing mints it today) or the real
    on-disk `{ bookId, characterId }` shape `POST /not-linked-to` writes
    (`server/src/routes/cast-not-linked-to.ts:238`; typed in `voices.ts:104`
    / `voice-override-linked.ts:65`). Matches on `characterId` alone,
    ignoring `bookId` — so a cross-book "not the same person" decision also
    blocks a within-book remap sharing that character id. That is
    deliberately fail-safe, not a bug: `merge-analysis-cast.ts:377-388`
    (`groupHasNotLinkedEdge`) makes the identical trade for the same
    reason — a false "linked" is silent data corruption (two people
    collapsed into one), a false "not linked" only costs a remap that a
    user can still do by hand. */
function notLinkedToId(row: Record<string, unknown>, targetId: string): boolean {
  const nl = row.notLinkedTo;
  if (!Array.isArray(nl)) return false;
  return nl.some((entry) => {
    if (typeof entry === 'string') return entry === targetId;
    if (entry && typeof entry === 'object') {
      return (entry as { characterId?: unknown }).characterId === targetId;
    }
    return false;
  });
}

/** Rewrite this run's fresh character/sentence ids onto the existing cast's
    ids wherever exactly one fresh row and exactly one prior row share a
    normalised display name, and no `notLinkedTo` edge separates them.

    `priorRewrites` is this run's own cumulative dedup→fold rewrite table
    (§11 Q2 — pass `composeRewrites(dd.rewrites, folded.rewrites)`; defaults
    to `{}` for callers with no such table). A prior candidate is looked up
    by its raw id, but ADOPTED at `priorRewrites[id] ?? id` — the id that
    row's own lineage is heading to this run. When that destination already
    equals the fresh candidate's own id the pair has already converged via
    the mechanisms that consume the same table, and this remap does nothing.

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
): { characters: C[]; sentences: S[]; rewrites: Record<string, string> } {
  if (fresh.length === 0 || priorCast.length === 0) {
    return { characters: [...fresh], sentences: [...sentences], rewrites: {} };
  }

  const priorIdAfter = (id: string): string => priorRewrites[id] ?? id;

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
  const rewrites: Record<string, string> = {};

  for (const [key, freshCandidates] of freshByName) {
    if (freshCandidates.length !== 1) continue;
    const priorCandidates = priorByName.get(key);
    if (!priorCandidates || priorCandidates.length !== 1) continue;

    const freshRow = freshCandidates[0];
    const priorRow = priorCandidates[0];
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
    if (
      notLinkedToId(priorRow, freshRow.id) ||
      notLinkedToId(freshRow as unknown as Record<string, unknown>, priorRow.id)
    ) {
      continue;
    }
    rewrites[freshRow.id] = target;
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
