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

type PriorCastRow = { id: string } & Record<string, unknown>;

/* `Record<string, unknown>` rather than `{ name?: unknown }` deliberately —
   an all-optional object-literal target triggers TS's weak-type check
   against a source typed only via an index signature (PriorCastRow), which
   rejects the call despite the property being safely readable at runtime. */
function nameKeyOf(c: Record<string, unknown>): string {
  return typeof c.name === 'string' ? normaliseForMatch(c.name) : '';
}

/** True when `row.notLinkedTo` names `targetId` — either as a bare string
    (this module's own within-book edge) or as the cross-book `{ characterId
    }` shape `POST /not-linked-to` writes (`server/src/routes/
    cast-not-linked-to.ts`). Both are honoured so a user's "these two are NOT
    the same person" decision blocks the auto-remap regardless of which path
    recorded it. */
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
