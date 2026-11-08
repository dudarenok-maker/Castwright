/* Plan application and the cast overlay for the single re-analysis matcher
   (#4031, plan 291). Pure: no I/O, no locks. It never compares names for
   identity - every decision comes from the `MatchPlan`; this module only
   applies it. */

import { createHash } from 'node:crypto';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import { unionNotLinkedTo } from './cast-name-match.js';
import type {
  DedupConstraints,
  HistoryStatus,
  LedgerEntry,
  MatchDecision,
  MatchHistory,
  MatchPlan,
  NotLinkedEntry,
  PlannedRowInfo,
  PriorRow,
  RunAddedLedger,
} from './reanalysis-types.js';

/** Fields the analyzer owns; everything else on a cast row is user-owned. */
export const ANALYSIS_OWNED = ['lines', 'scenes', 'evidence', 'attributes', 'detectionSource'] as const;

type Rec = Record<string, unknown>;

const isNarratorId = (id: string): boolean => NARRATOR_CHARACTER_IDS.includes(id);
// `''` counts as absent: older writers persisted empty-string placeholders, and the spec
// says a joined row keeps "the prior value when present".
const isAbsent = (v: unknown): boolean => v === undefined || v === null || v === '';
const outputIdOf = (d: MatchDecision): string => (d.kind === 'join' ? d.priorId : d.id);

/** Sorted keys, recursively, so key order never changes the hash. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Rec = {};
    for (const k of Object.keys(v as Rec).sort()) {
      const x = (v as Rec)[k];
      if (x !== undefined) out[k] = canonical(x);
    }
    return out;
  }
  return v;
}

/** sha256 of the canonical JSON of a row's user-owned fields. */
export function userOwnedFingerprint(row: Record<string, unknown>): string {
  const owned: Rec = {};
  for (const [k, v] of Object.entries(row)) {
    if ((ANALYSIS_OWNED as readonly string[]).includes(k)) continue;
    owned[k] = v;
  }
  return createHash('sha256').update(JSON.stringify(canonical(owned))).digest('hex');
}

/** Cross-book entries only: a same-book entry (bare string, no `bookId`, or the
    current book) is a decision about THIS book's ids and must not ride onto a
    row that may be a different person. */
function crossBookOnly(entries: unknown[] | undefined, currentBookId: string | undefined): NotLinkedEntry[] {
  const out: NotLinkedEntry[] = [];
  for (const e of entries ?? []) {
    if (!e || typeof e !== 'object') continue;
    const { bookId, characterId } = e as { bookId?: unknown; characterId?: unknown };
    if (typeof characterId !== 'string' || typeof bookId !== 'string') continue;
    if (bookId === currentBookId) continue;
    out.push({ bookId, characterId });
  }
  return out;
}

/** `base` plus the names it lacks, never the display name itself. */
function addAliases(display: unknown, base: unknown, names: unknown[]): string[] {
  const out: string[] = Array.isArray(base) ? (base as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  for (const n of names) {
    if (typeof n !== 'string' || n === '' || n === display || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

/** Fold a second roster row that maps to the same output id into the first:
    lines add, scenes union, evidence concatenates, aliases union (its name
    included). Every other field keeps the first row's value. */
function collapseInto(base: Rec, other: Rec): Rec {
  const out: Rec = { ...base };
  if (typeof base.lines === 'number' && typeof other.lines === 'number') out.lines = base.lines + other.lines;
  if (Array.isArray(base.scenes) || Array.isArray(other.scenes)) {
    const seen = new Set<string>();
    const scenes: unknown[] = [];
    for (const s of [...((base.scenes as unknown[]) ?? []), ...((other.scenes as unknown[]) ?? [])]) {
      const k = JSON.stringify(s);
      if (seen.has(k)) continue;
      seen.add(k);
      scenes.push(s);
    }
    out.scenes = scenes;
  }
  if (Array.isArray(base.evidence) || Array.isArray(other.evidence)) {
    out.evidence = [...((base.evidence as unknown[]) ?? []), ...((other.evidence as unknown[]) ?? [])];
  }
  out.aliases = addAliases(base.name, base.aliases, [other.name, ...((other.aliases as unknown[]) ?? [])]);
  return out;
}

/** Decisions grouped by the id their row carries after `applyMatchPlan` (R29): the
    prior id of a join, the final id of a `new` row. The narrator is the one raw
    fallback - its row keeps `'narrator'` through Phase 1. */
function decisionsByOutput(plan: MatchPlan): Map<string, MatchDecision[]> {
  const out = new Map<string, MatchDecision[]>();
  for (const d of Object.values(plan.decisions)) {
    const key = isNarratorId(d.rawId) ? d.rawId : outputIdOf(d);
    const list = out.get(key);
    if (list) list.push(d);
    else out.set(key, [d]);
  }
  return out;
}

/** Every cross-book entry the `new` decisions inherited, unioned. */
function inheritedOf(ds: ReadonlyArray<MatchDecision>): NotLinkedEntry[] {
  let acc: unknown[] = [];
  for (const d of ds) if (d.kind === 'new') acc = unionNotLinkedTo(acc, d.inheritedDeclines);
  return acc as NotLinkedEntry[];
}

/** Apply the plan to the analyzer roster: each row takes its output id, rows that
    map to one output id collapse, and a joined row takes the prior id and display
    name with `aliases` = prior ∪ analyzer names. A `new` row gets no
    `notLinkedTo` from the plan. The narrator keeps its own id through Phase 1:
    its join is applied at persist, by `overlayPlanOntoCast`. */
export function applyMatchPlan<C extends { id: string; name: string; aliases?: string[] }>(
  roster: C[],
  plan: MatchPlan,
  prior: ReadonlyArray<PriorRow>,
): { characters: C[]; idMap: Record<string, string> } {
  const priorById = new Map(prior.map((p) => [p.id, p]));
  const characters: C[] = [];
  const at = new Map<string, number>();
  const idMap: Record<string, string> = {};
  for (const c of roster) {
    const d = plan.decisions[c.id];
    const row: Rec = { ...c };
    if (d && !isNarratorId(c.id)) {
      const oid = outputIdOf(d);
      if (oid !== c.id) idMap[c.id] = oid;
      row.id = oid;
      if (d.kind === 'join') {
        const p = priorById.get(oid);
        const display = typeof p?.name === 'string' ? p.name : c.name;
        row.name = display;
        row.aliases = addAliases(display, p?.aliases ?? [], [c.name, ...(c.aliases ?? [])]);
        // Identity links come from the prior row alone (R28), never the fresh row.
        delete row.matchedFrom;
        delete row.notLinkedTo;
        if (p?.matchedFrom !== undefined) row.matchedFrom = p.matchedFrom;
        if (p?.notLinkedTo !== undefined) row.notLinkedTo = p.notLinkedTo;
      }
    }
    const i = at.get(row.id as string);
    if (i === undefined) {
      at.set(row.id as string, characters.length);
      characters.push(row as unknown as C);
    } else {
      characters[i] = collapseInto(characters[i] as unknown as Rec, row) as unknown as C;
    }
  }
  return { characters, idMap };
}

/** Rewrite sentence speaker ids through the id map. */
export function remapSentenceIds<S extends { characterId: string }>(s: S[], idMap: Readonly<Record<string, string>>): S[] {
  return s.map((x) => (Object.hasOwn(idMap, x.characterId) ? { ...x, characterId: idMap[x.characterId] } : x));
}

/** Per roster row, what the plan says about it - the dedup's constraints. A `new`
    row's `declinedIds` are the ids X a same-book decline (a `notLinkedTo` edge on
    a prior row, or a `notSamePerson` record) pairs with its raw/output id or any
    of its candidates (item 1). The roster is the plan-applied one (R29): `planned`
    is keyed by output id, and decisions sharing an output id are unioned. */
export function planConstraintsFor(a: {
  roster: ReadonlyArray<{ id: string; matchedFrom?: unknown }>;
  plan: MatchPlan;
  prior: ReadonlyArray<PriorRow>;
  history: MatchHistory;
  currentBookId?: string;
}): DedupConstraints {
  const { roster, plan, prior, history, currentBookId } = a;
  const adj = new Map<string, Set<string>>();
  const link = (x: string, y: string): void => {
    if (x === y) return;
    for (const [p, q] of [[x, y], [y, x]] as const) {
      const set = adj.get(p) ?? new Set<string>();
      set.add(q);
      adj.set(p, set);
    }
  };
  for (const p of prior) {
    if (!Array.isArray(p.notLinkedTo)) continue;
    for (const e of p.notLinkedTo as unknown[]) {
      if (typeof e === 'string') link(p.id, e);
      else if (e && typeof e === 'object') {
        const { bookId, characterId } = e as { bookId?: unknown; characterId?: unknown };
        if (typeof characterId !== 'string') continue;
        if (typeof bookId === 'string' && bookId !== currentBookId) continue;
        link(p.id, characterId);
      }
    }
  }
  for (const rec of history.notSamePerson) link(rec.a, rec.b);

  const byOutput = decisionsByOutput(plan);
  const planned = new Map<string, PlannedRowInfo>();
  for (const row of roster) {
    const ds = byOutput.get(row.id);
    if (!ds) continue;
    const joined = ds.find((d) => d.kind === 'join');
    if (joined && joined.kind === 'join') {
      planned.set(row.id, { kind: 'join', priorId: joined.priorId });
      continue;
    }
    const news = ds.filter((d): d is Extract<MatchDecision, { kind: 'new' }> => d.kind === 'new');
    const candidates = [...new Set(news.flatMap((d) => d.suggest))];
    const declined = new Set<string>();
    for (const s of [...news.flatMap((d) => [d.rawId, d.id]), ...candidates]) {
      for (const x of adj.get(s) ?? []) if (x !== s) declined.add(x);
    }
    planned.set(row.id, {
      kind: 'new',
      minted: news.some((d) => d.minted),
      candidates,
      inheritedDeclines: inheritedOf(news),
      declinedIds: [...declined].sort(),
      matchedFrom: row.matchedFrom,
    });
  }
  return { planned, currentBookId };
}

/** Overlay the plan-applied roster onto the cast as re-read under the lock. Every
    `current` row is carried forward. A row the roster writes takes its user-owned
    fields from `current` (filled from the analyzer when absent) and its
    analysis-owned fields from the roster; aliases are unioned. The rule-11 ledger
    (invariant 6) records the fingerprint of the job's last write of each row it
    added. */
export function overlayPlanOntoCast<C extends { id: string }>(input: {
  current: ReadonlyArray<PriorRow>;
  roster: ReadonlyArray<C>;
  plan: MatchPlan;
  resolve: (id: string) => string | null;
  historyStatus: HistoryStatus;
  ledger: RunAddedLedger;
  currentBookId?: string;
  mode: 'snapshot' | 'persist';
  /** Ids ANOTHER job's ledger knows as run rows (the subset job's view of the main
      run's `addedRows`, R2). They count as run rows for the identity/collision and
      "gone, never re-added" decisions only; drops and fingerprint bookkeeping
      stay on `ledger` (the subset never deletes by `addedRows`, invariant 6). */
  knownRunIds?: ReadonlySet<string>;
}): {
  characters: Array<C | PriorRow>;
  ledger: RunAddedLedger;
  deletedTargets: string[];
  droppedRunAdded: string[];
  unresolved: string[];
  collisions: string[];
  carriedForward: Array<{ id: string; name?: string }>;
} {
  const { current, roster, plan, resolve, historyStatus, currentBookId, mode } = input;
  const isRunRow = (id: string): boolean => !!input.ledger[id] || !!input.knownRunIds?.has(id);
  const ledger: RunAddedLedger = { ...input.ledger };
  const currentById = new Map(current.map((r) => [r.id, r]));
  const deletedTargets: string[] = [];
  const unresolved: string[] = [];
  const collisions: string[] = [];
  const gone = (id: string): void => {
    const into = historyStatus === 'degraded' ? unresolved : deletedTargets;
    if (!into.includes(id)) into.push(id);
  };

  // Group the roster rows by the cast row they land on.
  const byOutput = decisionsByOutput(plan);
  const groups = new Map<string, { row: Rec; fresh: boolean; declines: NotLinkedEntry[] }>();
  for (const c of roster) {
    const ds = byOutput.get(c.id);
    if (!ds) {
      if (mode === 'snapshot') continue;
      // Persist plans any row created since Phase 0b first (spec persist step 2), so an
      // undecided row here is a caller bug; writing it would risk re-creating a retired id.
      throw new Error(`overlayPlanOntoCast: persist roster row "${c.id}" has no plan decision`);
    }
    const d = ds.find((x) => x.kind === 'join') ?? ds[0];
    let target: string;
    let fresh = false;
    if (d.kind === 'join') {
      const t = resolve(d.priorId);
      if (t === null || !currentById.has(t)) {
        gone(d.priorId);
        continue;
      }
      target = t;
    } else if (currentById.has(c.id)) {
      if (!isRunRow(c.id)) {
        if (!collisions.includes(c.id)) collisions.push(c.id);
        continue;
      }
      target = c.id;
    } else if (isRunRow(c.id)) {
      // Added by this run, since gone: merged away resolves to its survivor,
      // otherwise it stays gone and is never re-added. A run-owned entry becomes
      // added-once so clearing the ledger can never let a later run re-add it.
      const t = resolve(c.id);
      if (t === null || t === c.id || !currentById.has(t)) {
        if (ledger[c.id]?.state === 'run-owned') ledger[c.id] = { state: 'added-once' };
        gone(c.id);
        continue;
      }
      target = t;
    } else {
      target = c.id;
      fresh = true;
    }
    const prev = groups.get(target);
    const row = { ...(c as unknown as Rec) };
    const declines = inheritedOf(ds);
    if (prev) {
      groups.set(target, {
        ...prev,
        row: collapseInto(prev.row, row),
        declines: unionNotLinkedTo(prev.declines, declines) as NotLinkedEntry[],
      });
    } else groups.set(target, { row, fresh, declines });
  }

  const written = new Map<string, Rec>();
  const added: Rec[] = [];
  for (const [target, { row, fresh, declines }] of groups) {
    if (fresh) {
      const out: Rec = { ...row, id: target };
      const nl = unionNotLinkedTo(
        crossBookOnly(out.notLinkedTo as unknown[] | undefined, currentBookId),
        crossBookOnly(declines, currentBookId),
      );
      if (nl.length > 0) out.notLinkedTo = nl;
      else delete out.notLinkedTo;
      added.push(out);
      ledger[target] = { state: 'run-owned', fp: userOwnedFingerprint(out) };
      continue;
    }
    const cur = currentById.get(target) as Rec;
    const entry = ledger[target];
    if (entry?.state === 'run-owned' && userOwnedFingerprint(cur) !== entry.fp) {
      ledger[target] = { state: 'added-once' };
    }
    const out: Rec = { ...cur };
    for (const k of ANALYSIS_OWNED) if (k in row) out[k] = row[k];
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id' || k === 'name' || k === 'aliases' || k === 'notLinkedTo' || k === 'matchedFrom') continue;
      if ((ANALYSIS_OWNED as readonly string[]).includes(k)) continue;
      if (isAbsent(out[k]) && !isAbsent(v)) out[k] = v;
    }
    out.aliases = addAliases(cur.name, cur.aliases, [row.name, ...((row.aliases as unknown[]) ?? [])]);
    written.set(target, out);
    const after = ledger[target];
    if (after?.state === 'run-owned') ledger[target] = { state: 'run-owned', fp: userOwnedFingerprint(out) };
  }

  const characters: Array<C | PriorRow> = [];
  const droppedRunAdded: string[] = [];
  const carriedForward: Array<{ id: string; name?: string }> = [];
  for (const cur of current) {
    const w = written.get(cur.id);
    if (w) {
      characters.push(w as PriorRow);
      continue;
    }
    const entry: LedgerEntry | undefined = ledger[cur.id];
    if (mode === 'persist' && entry?.state === 'run-owned') {
      if (userOwnedFingerprint(cur) === entry.fp) {
        droppedRunAdded.push(cur.id);
        delete ledger[cur.id];
        continue;
      }
      ledger[cur.id] = { state: 'added-once' };
    }
    characters.push(cur);
    carriedForward.push(typeof cur.name === 'string' ? { id: cur.id, name: cur.name } : { id: cur.id });
  }
  for (const a of added) characters.push(a as unknown as C);

  return { characters, ledger, deletedTargets, droppedRunAdded, unresolved, collisions, carriedForward };
}

/** Lines whose speaker was a deleted target go to the narrator (`narratorId`, the
    book's own narrator row - `'narrator'` unless the cast holds `char-narrator`),
    with the id they overwrote recorded in `priorCharacterId`. */
export function rerouteDeletedTargets<S extends { characterId: string; priorCharacterId?: string }>(
  s: S[],
  deleted: ReadonlySet<string>,
  narratorId = 'narrator',
): S[] {
  return s.map((x) =>
    deleted.has(x.characterId) ? { ...x, characterId: narratorId, priorCharacterId: x.characterId } : x,
  );
}

/** After a user merge of `sourceId` into `targetId`: every decision landing on the
    source takes the target's `new` decision (so the rows collapse onto it), or,
    when the target is a prior row, joins it with tier `merge`. */
export function retargetPlanForMerge(plan: MatchPlan, sourceId: string, targetId: string): MatchPlan {
  const targetNew = Object.values(plan.decisions).find((d) => d.kind === 'new' && d.id === targetId);
  const decisions: Record<string, MatchDecision> = {};
  for (const [k, d] of Object.entries(plan.decisions)) {
    if (outputIdOf(d) !== sourceId) {
      decisions[k] = d;
    } else if (targetNew && targetNew.kind === 'new') {
      decisions[k] = { ...targetNew, rawId: d.rawId };
    } else {
      decisions[k] = { kind: 'join', rawId: d.rawId, priorId: targetId, tier: 'merge' };
    }
  }
  return { ...plan, decisions };
}
