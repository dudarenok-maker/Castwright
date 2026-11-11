/* The single re-analysis matcher (#4031, plan 291): the ONLY code that decides
   whether a fresh analyzer row is a prior cast row. Pure, synchronous, total
   and deterministic - no I/O, no locks. Every later step works in the prior
   cast's id space.

   Settlement per fresh row (spec "Settlement"):
     T1 by id (live prior id, or a user/heal supersededBy entry to a live
     survivor), T2 exact display name, T3 surname-tolerant display name.
     The highest tier with any candidate decides: one candidate joins, several
     make a `new` row with suggestions (the open-question row excepted), none
     make a plain `new` row. Aliases are never matched. */

import { normaliseForMatch } from '../util/text-match.js';
import { normaliseNameKey } from '../util/safe-id.js';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import { FEMALE_BUCKET_ID, MALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import { notLinkedToId } from './not-linked-to-scope.js';
import { surnameTolerantMatch, unionNotLinkedTo } from './cast-name-match.js';
import type {
  FreshRow,
  JoinTier,
  MatchDecision,
  MatchHistory,
  MatchInput,
  MatchPlan,
  NotLinkedEntry,
  PriorRow,
  StoredSuggestion,
} from './reanalysis-types.js';

/** Numeric-aware id order (R24): `wren-9` sorts before `wren-10`. */
const byId = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

const isNarratorId = (id: string): boolean => NARRATOR_CHARACTER_IDS.includes(id);
const isCatchAllId = (id: string): boolean => id === MALE_BUCKET_ID || id === FEMALE_BUCKET_ID;

const nameOf = (row: object): string => {
  const name = (row as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
};

/** Every id a `new` row must not take: live prior ids, `supersededBy` and
    `displaced` keys, and (given a plan) every raw id it decided plus every id
    it assigned. The caller adds the raw ids of the run's fresh roster (R6). */
export function buildReservedIds(a: {
  prior: ReadonlyArray<PriorRow>;
  history: MatchHistory;
  plan?: MatchPlan;
}): Set<string> {
  const out = new Set<string>();
  for (const row of a.prior) out.add(row.id);
  for (const k of Object.keys(a.history.supersededBy)) out.add(k);
  for (const k of Object.keys(a.history.displaced)) out.add(k);
  if (a.plan) {
    for (const [raw, d] of Object.entries(a.plan.decisions)) {
      out.add(raw);
      if (d.kind === 'new') out.add(d.id);
    }
  }
  return out;
}

/** `<raw>-n<k>` with the lowest free `k >= 1`; or, in `run` mode,
    `<raw>-r<runToken>` (a run-unique suffix, for degraded history). */
export function mintId(
  raw: string,
  taken: ReadonlySet<string>,
  mode: { kind: 'lowest' } | { kind: 'run'; runToken: string },
): string {
  if (mode.kind === 'lowest') {
    let k = 1;
    while (taken.has(`${raw}-n${k}`)) k++;
    return `${raw}-n${k}`;
  }
  const base = `${raw}-r${mode.runToken}`;
  // `-<k>` mimics the analyzer's suffix shape, but only if `<raw>-r<tok>` is taken, which is unreachable (final review T1:15).
  if (!taken.has(base)) return base;
  let k = 1;
  while (taken.has(`${base}-${k}`)) k++;
  return `${base}-${k}`;
}

/** Same-book entries (a bare string, an entry with no `bookId`, or one naming
    `currentBookId`) are stripped: they are decisions about THIS book's ids and
    must not ride onto a row that may be a different person. Cross-book entries
    stay whatever their `characterId` (item 13). */
function crossBookOnly(entries: unknown[], currentBookId: string | undefined): NotLinkedEntry[] {
  const out: NotLinkedEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const { bookId, characterId } = e as { bookId?: unknown; characterId?: unknown };
    if (typeof characterId !== 'string' || typeof bookId !== 'string') continue;
    if (bookId === currentBookId) continue;
    out.push({ bookId, characterId });
  }
  return out;
}

function decide(input: MatchInput, plan: MatchPlan, rows: ReadonlyArray<FreshRow>): Record<string, MatchDecision> {
  const { prior, history, openSuggestions, reservedIds, runToken, currentBookId } = input;
  const degraded = history.status === 'degraded';
  const priorById = new Map<string, PriorRow>();
  for (const row of prior) if (!priorById.has(row.id)) priorById.set(row.id, row);

  // Name pools: catch-all and narrator rows are never name candidates.
  const namePool = prior
    .filter((row) => !isNarratorId(row.id) && !isCatchAllId(row.id))
    .sort((a, b) => byId(a.id, b.id));
  const narratorPrior = prior.filter((row) => isNarratorId(row.id)).sort((a, b) => byId(a.id, b.id));

  const notSame = new Set<string>();
  for (const rec of history.notSamePerson) {
    notSame.add(`${rec.a}\u0000${rec.b}`);
    notSame.add(`${rec.b}\u0000${rec.a}`);
  }
  // R23: a candidate drops out when the prior row declines the fresh raw id,
  // or a notSamePerson record pairs them. Fresh rows carry no declines.
  const declined = (cand: PriorRow, raw: string): boolean =>
    notLinkedToId(cand, raw, currentBookId) || notSame.has(`${cand.id}\u0000${raw}`);

  // Ids a `new` row may not keep or mint onto: the caller's reserved set, the
  // plan so far, and every raw id of the run (R6, defensive).
  const rawIds = new Set(rows.map((r) => r.id));
  const taken = new Set<string>(reservedIds);
  for (const row of prior) taken.add(row.id);
  for (const k of Object.keys(history.supersededBy)) taken.add(k);
  for (const k of Object.keys(history.displaced)) taken.add(k);
  for (const [raw, d] of Object.entries(plan.decisions)) {
    taken.add(raw);
    if (d.kind === 'new') taken.add(d.id);
  }
  for (const raw of rawIds) taken.add(raw);

  // Ids the input plan's `new` decisions already own (extendPlan).
  const plannedNewIds = new Set<string>();
  for (const d of Object.values(plan.decisions)) if (d.kind === 'new') plannedNewIds.add(d.id);

  /** A row keeps its own raw id unless it is live, superseded, displaced or
      decided. Being in `reservedIds` is not enough: R6 reserves every raw id of
      the run, including this row's own. */
  const keepBlocked = (raw: string, assigned: ReadonlySet<string>): boolean =>
    priorById.has(raw) ||
    raw in history.supersededBy ||
    raw in history.displaced ||
    assigned.has(raw) ||
    plannedNewIds.has(raw);

  /** T1 by history: a user/heal (or untagged) chain to a live survivor. */
  const resolveHistory = (raw: string): string | null => {
    if (degraded) return null;
    const seen = new Set<string>();
    let cur = raw;
    while (!seen.has(cur) && cur in history.supersededBy) {
      seen.add(cur);
      if ((history.supersededByKind[cur] ?? 'user') === 'analyzer') return null;
      cur = history.supersededBy[cur];
      if (priorById.has(cur)) return cur;
    }
    return null;
  };

  const out: Record<string, MatchDecision> = {};
  const assigned = new Set<string>();

  const joinTo = (raw: string, priorId: string, tier: JoinTier): void => {
    out[raw] = { kind: 'join', rawId: raw, priorId, tier };
  };
  const newRow = (raw: string, candidates: ReadonlyArray<PriorRow>): void => {
    let id = raw;
    let minted = false;
    if (degraded || keepBlocked(raw, assigned)) {
      const takenForMint = new Set(taken);
      for (const a of assigned) takenForMint.add(a);
      id = mintId(raw, takenForMint, degraded ? { kind: 'run', runToken } : { kind: 'lowest' });
      minted = true;
    }
    assigned.add(id);
    let declines: unknown[] = [];
    for (const c of candidates) {
      if (Array.isArray(c.notLinkedTo)) declines = unionNotLinkedTo(declines, c.notLinkedTo as unknown[]);
    }
    out[raw] = {
      kind: 'new',
      rawId: raw,
      id,
      minted,
      suggest: candidates.map((c) => c.id).sort(byId),
      inheritedDeclines: crossBookOnly(declines, currentBookId),
    };
  };

  const keepAsNew = (raw: string): void => {
    assigned.add(raw);
    out[raw] = { kind: 'new', rawId: raw, id: raw, minted: false, suggest: [], inheritedDeclines: [] };
  };

  for (const r of [...rows].sort((a, b) => byId(a.id, b.id))) {
    if (typeof r.id !== 'string' || r.id === '' || out[r.id] || plan.decisions[r.id]) continue;
    const name = nameOf(r);

    // Narrator: joins the prior narrator-id row by role (the same id if the
    // prior holds two). Never a name candidate, never matches by name.
    if (isNarratorId(r.id)) {
      const target = narratorPrior.find((n) => n.id === r.id) ?? narratorPrior[0];
      if (target) joinTo(r.id, target.id, target.id === r.id ? 'id' : 'narrator');
      else if (resolveHistory(r.id)) joinTo(r.id, resolveHistory(r.id) as string, 'history');
      else keepAsNew(r.id); // the narrator keeps its id through Phase 1, never minted
      continue;
    }

    // T1 by live id. A same-name row elsewhere with no tie to this row's own
    // names is an id/name conflict: two candidates, no guess.
    const live = priorById.get(r.id);
    if (live) {
      const key = normaliseNameKey(name);
      const own = new Set([normaliseNameKey(nameOf(live))]);
      if (Array.isArray(live.aliases)) {
        for (const a of live.aliases) if (typeof a === 'string') own.add(normaliseNameKey(a));
      }
      const rivals =
        key === '' || own.has(key)
          ? []
          : namePool.filter(
              (c) => c.id !== live.id && normaliseNameKey(nameOf(c)) === key && !declined(c, r.id),
            );
      if (rivals.length > 0) newRow(r.id, [live, ...rivals]);
      else joinTo(r.id, live.id, 'id');
      continue;
    }

    // T1 by history (rule 3): wins over every decline and every name.
    const survivor = resolveHistory(r.id);
    if (survivor) {
      joinTo(r.id, survivor, 'history');
      continue;
    }

    // T2 then T3, highest tier with any candidate.
    const key = normaliseNameKey(name);
    const matchKey = normaliseForMatch(name);
    let tier: JoinTier = 'name';
    let cands: PriorRow[] = [];
    if (key !== '') {
      cands = namePool.filter((c) => normaliseNameKey(nameOf(c)) === key && !declined(c, r.id));
    }
    if (cands.length === 0 && matchKey !== '') {
      tier = 'surname';
      cands = namePool.filter(
        (c) => surnameTolerantMatch(matchKey, normaliseForMatch(nameOf(c))) && !declined(c, r.id),
      );
    }

    if (cands.length === 1) {
      joinTo(r.id, cands[0].id, tier);
    } else if (cands.length > 1) {
      const open = openQuestionRow(cands, openSuggestions);
      if (open) joinTo(r.id, open.id, 'open-question');
      else newRow(r.id, cands);
    } else {
      newRow(r.id, []);
    }
  }
  return out;
}

/** The one candidate an earlier run created as `new` whose open suggestions
    cover every other candidate, so a repeat ambiguous name lands on the open
    question. Only a suggestion that names its `newRow` and `candidate`
    qualifies; a legacy one never does. */
function openQuestionRow(
  cands: ReadonlyArray<PriorRow>,
  suggestions: ReadonlyArray<StoredSuggestion>,
): PriorRow | null {
  const qualifying = cands.filter((q) =>
    cands.every(
      (o) => o.id === q.id || suggestions.some((s) => s.newRow === q.id && s.candidate === o.id),
    ),
  );
  return qualifying.length === 1 ? qualifying[0] : null;
}

export function matchFreshToPrior(input: MatchInput): MatchPlan {
  const plan: MatchPlan = { version: 1, runToken: input.runToken, decisions: {} };
  plan.decisions = decide(input, plan, input.fresh);
  return plan;
}

/** Plans only the rows `plan` does not cover, with the input's own runToken;
    a covered row is never re-decided and the original plan's token is kept. */
export function extendPlan(plan: MatchPlan, input: MatchInput): MatchPlan {
  const added = decide(input, plan, input.fresh);
  return { version: 1, runToken: plan.runToken, decisions: { ...plan.decisions, ...added } };
}
