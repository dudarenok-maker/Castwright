/* The analysis jobs' ONLY cast.json writer (#4031, plan 291 Task 8).

   Every function here takes the cast lock itself and does its whole
   read -> decide -> write inside it (CLAUDE.md cast rules 1 and 2): the cast is
   re-read under the lock and the plan is overlaid onto THAT, never onto the
   snapshot the run took at its start, so a merge, delete, dismissal or edit a
   route made mid-run is never reverted. Nothing slow runs under the lock - the
   library scan behind the stale-link prune is precomputed
   (`staleReuseLinkKeys`), the dedup/fold/model calls all happen before the
   caller gets here.

   Lock order: `cast` -> `book` (the persist's manuscript-edits write nests
   `withBookLock` inside `withCastLock`; no `book` holder takes `cast`). No
   function here nests `withCastLock`, and none records a retirement: the
   persist RETURNS them and the caller records them after this lock is
   released (`cast` -> `cast-id-history` is allowed, but the history write is
   deliberately outside the cast span, as it always was).

   A `LockAcquisitionTimeoutError` from the cast lock propagates untouched; the
   caller parks it and finishes its other writes before surfacing it.

   Rule 11 (invariant 6): a row the job added is ledgered with the fingerprint
   of the job's LAST write of it. Before a write the re-read disk row is
   compared with that fingerprint (a mismatch is a user change -> `added-once`,
   sticky) and after it the fingerprint of what was just written is recorded. */

import { randomBytes } from 'node:crypto';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import { FEMALE_BUCKET_ID, MALE_BUCKET_ID } from '../analyzer/fold-minor-cast.js';
import type { CharacterOutput, SentenceOutput } from '../handoff/schemas.js';
import { readJson, writeJsonAtomic } from './state-io.js';
import { writeJsonAtomicOrdered } from './ordered-write.js';
import { withCastLock } from './cast-lock.js';
import { withBookLock } from './book-lock.js';
import { ABSENT, UNREADABLE, readJsonWithStatus } from './cast-fingerprint.js';
import { PriorCastUnreadableError } from './prior-cast-error.js';
import { applyStaleLinkPrune, type LinkableCharacter } from './series-reuse-link.js';
import { castJsonPath, castReuseCarryoverJsonPath, manuscriptEditsJsonPath } from './paths.js';
import { dropStaleVariants } from './variant-base-rev.js';
import {
  followableHistory,
  loadCastIdHistoryWithStatus,
  toMatchHistory,
  type CastIdHistoryReadResult,
} from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';
import {
  loadStoredSuggestions,
  pairKey,
  reconcileSuggestionsLocked,
  removeSuggestionPairsLocked,
} from '../store/cast-merge-suggestions.js';
import { dedupePriorCastByName, type DedupeHealOpts, type Retirement } from '../store/merge-analysis-cast.js';
import { buildReservedIds, extendPlan, mintId } from '../store/match-fresh-to-prior.js';
import {
  applyMatchPlan,
  overlayPlanOntoCast,
  remapSentenceIds,
  rerouteDeletedTargets,
  userOwnedFingerprint,
} from '../store/plan-overlay.js';
import type {
  MatchHistory,
  MatchPlan,
  NotSamePersonRecord,
  PriorRow,
  RunAddedLedger,
  StoredSuggestion,
} from '../store/reanalysis-types.js';

type Rows = PriorRow[];
type CastSource = 'cast' | 'carryover' | 'none';

export interface PriorCastSnapshot {
  rows: Rows;
  source: CastSource;
}

export { PriorCastUnreadableError };

/** The prior cast: cast.json, otherwise the reuse-carryover a Re-parse left - but
    the carryover is used ONLY when cast.json is absent or has `characters: []`;
    an unreadable, unparseable or wrong-shape cast.json throws
    `PriorCastUnreadableError` (reason `unreadable` | `corrupt`).
    CALLER HOLDS THE CAST LOCK - this is the lock-free inner read (it moved here
    from `readPriorCastForMerge`, which wraps it in the lock). */
export async function readPriorCastLockFree(bookDir: string): Promise<PriorCastSnapshot> {
  const cast = await readJsonWithStatus<{ characters?: Rows }>(castJsonPath(bookDir));
  if (cast.status === UNREADABLE) throw new PriorCastUnreadableError('unreadable');
  if (cast.status !== ABSENT) {
    // Read, but not a cast: truncated, not JSON, or no `characters` array.
    if (cast.value === null || typeof cast.value !== 'object' || !Array.isArray(cast.value.characters)) {
      throw new PriorCastUnreadableError('corrupt');
    }
  }
  const fromCast = cast.value?.characters;
  if (fromCast?.length) {
    return { rows: fromCast, source: 'cast' };
  }
  const carry = await readJsonWithStatus<{ characters?: Rows }>(castReuseCarryoverJsonPath(bookDir));
  const fromCarryover = carry.value?.characters;
  /* #4040 — a reparse carries no emotion variant whose base was redesigned
     since: the merge would write it back into the fresh cast.json. */
  if (fromCarryover) return { rows: await dropStaleVariants(fromCarryover), source: 'carryover' };
  return { rows: [], source: 'none' };
}

/* #4031 A11 - what the run-start identical-name heal must not settle: the
   book's open merge suggestions and its "not the same person" dismissals. An
   unreadable suggestions file switches the heal OFF for the run (logged
   server-side only - the error text can carry the workspace path): a heal must
   never merge across a decision it cannot read. A degraded history read yields
   no dismissals ("undetermined", not evidence) rather than refusing every heal.
   Called INSIDE the cast lock by `materialisePriorAtRunStart`, the run start of
   both analysis jobs. */
export async function readHealOpts(
  bookDir: string | undefined,
  skipIds: ReadonlySet<string> = new Set(),
): Promise<DedupeHealOpts> {
  if (!bookDir) return { openSuggestions: [], notSamePerson: [], skipIds };
  let openSuggestions: StoredSuggestion[];
  try {
    openSuggestions = await loadStoredSuggestions(bookDir);
  } catch (err) {
    console.warn(
      `[analysis] run-start name heal skipped - cast-merge-suggestions.json could not be read: ${(err as Error)?.message ?? err}`,
    );
    return { openSuggestions: [], notSamePerson: [], skipIds, healDisabled: true };
  }
  const history = await loadCastIdHistoryWithStatus(bookDir);
  return { openSuggestions, notSamePerson: toMatchHistory(history).notSamePerson, skipIds };
}

/* #4031 - "has the user declined this pair?" for the dedup suggestions, read off
   cast.json's `notLinkedTo` edges (a dismissal writes one on each row). SAME-BOOK
   ONLY: an edge naming `bookId` counts, a cross-book edge never does (a series'
   other book can carry a row with the same slug id). A legacy string entry, or
   an object entry with no `bookId`, counts as same-book (Task 1's
   `inheritedDeclines` convention). */
export function sameBookDeclinePredicate(
  characters: ReadonlyArray<{ id: string; notLinkedTo?: Array<string | { bookId?: string; characterId: string }> }>,
  bookId: string | undefined,
): (a: string, b: string) => boolean {
  const linked = new Set<string>();
  for (const c of characters) {
    for (const e of c.notLinkedTo ?? []) {
      if (typeof e !== 'string' && e.bookId !== undefined && e.bookId !== bookId) continue;
      linked.add(`${c.id}\u0000${typeof e === 'string' ? e : e.characterId}`);
    }
  }
  return (a, b) => linked.has(`${a}\u0000${b}`) || linked.has(`${b}\u0000${a}`);
}

const isNarratorId = (id: string): boolean => NARRATOR_CHARACTER_IDS.includes(id);

/* The mid-run re-read (snapshot and persist). Absent is an empty cast; a file
   that parses but has no `characters` array is shape-corrupt and throws, the same
   refusal as the run start's (`readPriorCastLockFree`) - overlaying onto `[]`
   would overwrite every user row (#4031 final review I1). Bytes that do not
   parse (a zero-byte or torn file) are the same `corrupt`, so the snapshot's
   early stop and the curated terminal apply to them too (PR #4103 pass 1 M1). */
async function readCurrentCast(bookDir: string): Promise<Rows> {
  let cast: { characters?: Rows } | null;
  try {
    cast = await readJson<{ characters?: Rows }>(castJsonPath(bookDir));
  } catch (err) {
    if (err instanceof SyntaxError) throw new PriorCastUnreadableError('corrupt', { midRun: true });
    throw err;
  }
  if (cast === null) return [];
  if (typeof cast !== 'object' || !Array.isArray(cast.characters)) {
    throw new PriorCastUnreadableError('corrupt', { midRun: true });
  }
  return cast.characters;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Rule 11 for a ledger the overlay does not maintain itself. Three callers:
    `materialise`'s own, the other job's `mainLedger` (snapshot and persist), and the
    reject-edge heal after a persist (analysis.ts `applyPlannedPersistOutcome`). Per
    `run-owned` entry whose row was on
    disk: a row that no longer matches the fingerprint of the job's last write was
    changed by the user -> `added-once`; a row this write dropped -> `added-once`
    (never re-added); a row this write changed keeps `run-owned` (its `by` tag too) with the
    fingerprint of what was just written. A row this write leaves alone keeps its
    entry. Returns a new ledger. */
export function refreshLedger(ledger: RunAddedLedger, before: Rows, after: Rows): RunAddedLedger {
  const out: RunAddedLedger = { ...ledger };
  const was = new Map(before.map((r) => [r.id, r]));
  const now = new Map(after.map((r) => [r.id, r]));
  for (const [id, entry] of Object.entries(ledger)) {
    if (entry.state !== 'run-owned') continue;
    const prev = was.get(id);
    if (!prev) continue;
    const next = now.get(id);
    if (!next || userOwnedFingerprint(prev) !== entry.fp) {
      out[id] = { state: 'added-once' };
      continue;
    }
    const fp = userOwnedFingerprint(next);
    if (fp !== entry.fp) out[id] = { ...entry, fp };
  }
  return out;
}

/** Exact id, or a user/heal/analyzer `supersededBy` chain to a live survivor;
    never a normalised-id guess, and never through a catch-all key (R53,
    `followableHistory`). `null` = not on disk and not merged away. */
function makeResolve(current: Rows, history: CastIdHistoryReadResult): (id: string) => string | null {
  const resolver = buildCastResolver(current, followableHistory(history.history));
  return (id) => {
    const r = resolver.resolve(id);
    return r && (r.via === 'exact' || r.via === 'history') ? r.character.id : null;
  };
}

function declinedPredicate(
  characters: ReadonlyArray<{ id: string; notLinkedTo?: Array<string | { bookId?: string; characterId: string }> }>,
  bookId: string | undefined,
  notSamePerson: ReadonlyArray<NotSamePersonRecord>,
): (a: string, b: string) => boolean {
  const edges = sameBookDeclinePredicate(characters, bookId);
  const records = new Set(notSamePerson.map((r) => `${r.a}\u0000${r.b}`));
  return (a, b) => {
    const k = pairKey(a, b);
    return edges(a, b) || records.has(`${k.a}\u0000${k.b}`);
  };
}

/* Item 12 (defence in depth): a `new` decision whose id is live on disk but not
   in the run's ledger would overwrite a row some route created after the plan
   was made. Re-mint it (`<raw>-n<k>`, or the run-unique form on a degraded
   history) and report the id change. Pure. */
function remintCollisions<C extends { id: string }>(a: {
  plan: MatchPlan;
  roster: ReadonlyArray<C>;
  current: Rows;
  ledger: RunAddedLedger;
  /** The other job's ledger (R2): its keys are run rows, not strangers. */
  mainLedger?: RunAddedLedger;
  history: MatchHistory;
}): { plan: MatchPlan; roster: C[]; idMap: Record<string, string> } {
  const live = new Set(a.current.map((r) => r.id));
  const colliding = new Map<string, string>(); // live new id -> a raw id to mint from
  for (const d of Object.values(a.plan.decisions)) {
    if (d.kind === 'new' && live.has(d.id) && !a.ledger[d.id] && !a.mainLedger?.[d.id] && !colliding.has(d.id)) {
      colliding.set(d.id, d.rawId);
    }
  }
  if (colliding.size === 0) return { plan: a.plan, roster: [...a.roster], idMap: {} };
  const taken = buildReservedIds({ prior: a.current, history: a.history, plan: a.plan });
  for (const c of a.roster) taken.add(c.id);
  const mode = a.history.status === 'degraded' ? ({ kind: 'run', runToken: a.plan.runToken } as const) : ({ kind: 'lowest' } as const);
  const idMap: Record<string, string> = {};
  for (const [oldId, raw] of [...colliding].sort(([x], [y]) => x.localeCompare(y))) {
    const fresh = mintId(raw, taken, mode);
    taken.add(fresh);
    idMap[oldId] = fresh;
  }
  const decisions = Object.fromEntries(
    Object.entries(a.plan.decisions).map(([k, d]) =>
      d.kind === 'new' && Object.hasOwn(idMap, d.id) ? [k, { ...d, id: idMap[d.id], minted: true }] : [k, d],
    ),
  );
  return {
    plan: { ...a.plan, decisions },
    roster: a.roster.map((c) => (Object.hasOwn(idMap, c.id) ? { ...c, id: idMap[c.id] } : c)),
    idMap,
  };
}

/** The suggestions with every id run through `idMap` (a re-mint). */
function remapSuggestions(list: ReadonlyArray<StoredSuggestion>, idMap: Readonly<Record<string, string>>): StoredSuggestion[] {
  if (Object.keys(idMap).length === 0) return [...list];
  const m = (id: string): string => (Object.hasOwn(idMap, id) ? idMap[id] : id);
  return list.map((s) => {
    const { a, b } = pairKey(m(s.sourceId), m(s.targetId));
    return {
      ...s,
      sourceId: m(s.sourceId),
      targetId: m(s.targetId),
      a,
      b,
      ...(s.newRow !== undefined ? { newRow: m(s.newRow) } : {}),
      ...(s.candidate !== undefined ? { candidate: m(s.candidate) } : {}),
    };
  });
}

/** Run start. Under the cast lock: re-read the prior (cast.json, else the
    carryover) -> prune the stale reuse links named by `staleLinkKeys` -> heal
    identical-name duplicates (re-reading the open suggestions and the dismissals
    HERE, inside the lock) -> write once. A carryover is materialised into
    cast.json in the same write, so every later re-read has a file. Returns the
    healed prior, the heal's retirements (the caller records them, kind `heal`,
    after the lock) and the refreshed rule-11 ledger (R1). */
export async function materialisePriorAtRunStart(a: {
  bookDir: string;
  bookId?: string;
  staleLinkKeys: ReadonlySet<string>;
  runOwnedIds: ReadonlySet<string>;
  ledger: RunAddedLedger;
}): Promise<{
  prior: Rows;
  healRetirements: Retirement[];
  healDropped: Array<{ id: string; name?: string; voiceState?: string }>;
  source: CastSource;
  ledger: RunAddedLedger;
}> {
  return withCastLock(a.bookDir, async () => {
    const snap = await readPriorCastLockFree(a.bookDir);
    const before = snap.rows;
    let rows: Rows = JSON.parse(JSON.stringify(before));
    // cast.json rows are JSON cast records, a superset of the linker's slice.
    applyStaleLinkPrune(rows as unknown as LinkableCharacter[], a.staleLinkKeys);
    let healRetirements: Retirement[] = [];
    let healDropped: Array<{ id: string; name?: string; voiceState?: string }> = [];
    if (rows.length > 1) {
      const healed = dedupePriorCastByName(rows, a.bookId, await readHealOpts(a.bookDir, a.runOwnedIds));
      rows = healed.cast;
      healRetirements = healed.retirements;
      healDropped = healed.dropped;
    }
    const changed = snap.source === 'carryover' ? rows.length > 0 : !sameJson(rows, before);
    if (changed) await writeJsonAtomic(castJsonPath(a.bookDir), { characters: rows });
    return {
      prior: rows,
      healRetirements,
      healDropped,
      source: snap.source,
      ledger: refreshLedger(a.ledger, before, rows),
    };
  });
}

/** An interim snapshot. Under the cast lock: re-read cast.json and the history
    -> re-reserve against that cast and re-mint any `new` id that went live on
    disk since the plan was made (item 12) -> overlay (`snapshot`) -> write
    cast.json -> add the run's suggestions. `roster` is the PLAN-APPLIED roster
    (R29). The caller patches the cache `{ ledger, runAddedPairs, decisions }`
    (and, for a re-mint, `remapCharacterIds: idMap`) AFTER this returns: cast.json
    is written first. `mainLedger` (R2, the subset job) is the stopped main run's
    cached `addedRows`; rule 11 is applied to it for every row this write
    touches and the refreshed copy is returned. */
export async function writePlanSnapshot<C extends { id: string }>(a: {
  bookDir: string;
  bookId?: string;
  roster: ReadonlyArray<C>;
  plan: MatchPlan;
  ledger: RunAddedLedger;
  runSuggestions: StoredSuggestion[];
  mainLedger?: RunAddedLedger;
}): Promise<{
  ledger: RunAddedLedger;
  mainLedger?: RunAddedLedger;
  plan: MatchPlan;
  idMap: Record<string, string>;
  addedPairs: Array<[string, string]>;
}> {
  return withCastLock(a.bookDir, async () => {
    const current = await readCurrentCast(a.bookDir);
    const historyRead = await loadCastIdHistoryWithStatus(a.bookDir);
    const history = toMatchHistory(historyRead);
    const re = remintCollisions({
      plan: a.plan,
      roster: a.roster,
      current,
      ledger: a.ledger,
      mainLedger: a.mainLedger,
      history,
    });
    const ov = overlayPlanOntoCast({
      current,
      roster: re.roster,
      plan: re.plan,
      resolve: makeResolve(current, historyRead),
      historyStatus: history.status,
      ledger: a.ledger,
      knownRunIds: new Set(Object.keys(a.mainLedger ?? {})),
      currentBookId: a.bookId,
      mode: 'snapshot',
    });
    const characters = ov.characters as Rows;
    if (!sameJson(characters, current)) await writeJsonAtomic(castJsonPath(a.bookDir), { characters });

    /* Advisory, like the persist's: cast.json has already landed, so a suggestions
       fault must not throw away the ledger/plan/idMap the caller patches into the
       cache (the next snapshot would re-mint this run's rows). */
    let addedPairs: Array<[string, string]> = [];
    try {
      const storedBefore = new Set((await loadStoredSuggestions(a.bookDir)).map((s) => `${s.a}\u0000${s.b}`));
      await reconcileSuggestionsLocked(a.bookDir, {
        add: remapSuggestions(a.runSuggestions, re.idMap),
        liveIds: new Set(characters.map((c) => c.id)),
        supersededBy: history.supersededBy,
        declined: declinedPredicate(characters, a.bookId, history.notSamePerson),
      });
      addedPairs = (await loadStoredSuggestions(a.bookDir))
        .filter((s) => !storedBefore.has(`${s.a}\u0000${s.b}`))
        .map((s) => [s.a, s.b]);
    } catch (err) {
      console.warn('[analysis] failed to write merge suggestions at the plan snapshot', err);
    }

    return {
      ledger: ov.ledger,
      ...(a.mainLedger ? { mainLedger: refreshLedger(a.mainLedger, current, characters) } : {}),
      plan: re.plan,
      idMap: re.idMap,
      addedPairs,
    };
  });
}

export interface PersistOutcome {
  characters: Array<{ id: string } & Record<string, unknown>>;
  sentences: SentenceOutput[];
  /** Join retirements (`raw -> target`, kind `analyzer`) for the caller to record
      AFTER the cast lock is released. Empty for a drift-refused persist. */
  retirements: Retirement[];
  plan: MatchPlan;
  deletedTargets: string[];
  unresolved: string[];
  carriedForward: Array<{ id: string; name?: string }>;
  ledger: RunAddedLedger;
  mainLedger?: RunAddedLedger;
  droppedRunAdded: string[];
  /** This run's id changes (item 12 re-mints and the plan application), for the
      caller's cache patch (`remapCharacterIds`). */
  idMap: Record<string, string>;
}

/** What `persistPlannedCast` throws when the manuscript-edits write fails AFTER
    cast.json landed: the computed outcome rides on the error so the caller can
    still record the retirements and patch the cache. */
export type PersistOutcomeError = Error & { persistOutcome?: PersistOutcome };

/** The run's terminal write. A `LockAcquisitionTimeoutError` from the cast lock
    propagates untouched (nothing was written); a failed edits write rethrows with
    `persistOutcome` attached (see `PersistOutcomeError`). Under the cast lock:
    1. re-read cast.json and the history;
    2. re-mint colliding `new` ids (item 12), then `extendPlan` over every roster
       row the plan does not cover (rows created after Phase 0b, e.g. the fold's
       buckets) - the WHOLE roster handed in is planned, so the persist-mode
       overlay never meets an undecided row;
    3. re-resolve every plan target through the current history (exact | history);
    4. overlay (`persist`), remap this run's sentences (narrator -> the prior
       narrator id, a merged-away target -> its survivor, a re-mint -> its new id;
       a narrator-id speaker with no live target -> the narrator row the overlay
       wrote, #4100: the narrator is exempt from rule 13),
       reroute lines of a deleted target to the book's narrator, recount, write
       cast.json;
    5. write manuscript-edits.json under the `book` lock, nested;
    6. reconcile the suggestions.
    `driftRefused`: only step 5 runs (cast.json is left byte-for-byte alone) and
    the run's added suggestion pairs are removed. `roster` is the PLAN-APPLIED
    roster (R29). `mainLedger` (R2) is the other job's ledger, refreshed for every
    row this write touches. */
export async function persistPlannedCast(a: {
  bookDir: string;
  bookId?: string;
  plan: MatchPlan;
  roster: CharacterOutput[];
  sentences: SentenceOutput[];
  ledger: RunAddedLedger;
  runSuggestions: StoredSuggestion[];
  runAddedPairs: Array<[string, string]>;
  driftRefused: boolean;
  mainLedger?: RunAddedLedger;
}): Promise<PersistOutcome> {
  return withCastLock(a.bookDir, async () => {
    const current = await readCurrentCast(a.bookDir);
    const historyRead = await loadCastIdHistoryWithStatus(a.bookDir);
    const history = toMatchHistory(historyRead);
    const resolve = makeResolve(current, historyRead);

    const re = remintCollisions({
      plan: a.plan,
      roster: a.roster,
      current,
      ledger: a.ledger,
      mainLedger: a.mainLedger,
      history,
    });
    const covered = new Set<string>();
    const outputs = new Set<string>();
    for (const [raw, d] of Object.entries(re.plan.decisions)) {
      covered.add(raw);
      outputs.add(d.kind === 'join' ? d.priorId : d.id);
    }
    for (const id of outputs) covered.add(id);
    // R49 (PR #4103 pass 2 P2-1): a fold bucket is covered only by a decision that outputs
    // its own id. Its raw key decided for another id (a merge's re-target in an older
    // cache) is stale, and `extendPlan` re-plans it under its own id.
    const uncovered = re.roster.filter((c) =>
      c.id === MALE_BUCKET_ID || c.id === FEMALE_BUCKET_ID ? !outputs.has(c.id) : !covered.has(c.id),
    );
    const uncoveredIds = new Set(uncovered.map((c) => c.id));
    let plan = re.plan;
    if ([...uncoveredIds].some((id) => Object.hasOwn(plan.decisions, id))) {
      const decisions = { ...plan.decisions };
      for (const id of uncoveredIds) delete decisions[id];
      plan = { ...plan, decisions };
    }
    if (uncovered.length > 0) {
      let openSuggestions: StoredSuggestion[] = [];
      try {
        openSuggestions = await loadStoredSuggestions(a.bookDir);
      } catch (err) {
        // Unreadable: carry on without open questions (a row can then only be planned
        // as a new one), but say so - same as the run-start heal. Server-side only.
        console.warn(
          `[analysis] persist planned new rows without the open suggestions - cast-merge-suggestions.json could not be read: ${(err as Error)?.message ?? err}`,
        );
      }
      plan = extendPlan(plan, {
        fresh: uncovered.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
        prior: current,
        history,
        openSuggestions,
        reservedIds: buildReservedIds({ prior: current, history, plan }),
        runToken: randomBytes(4).toString('hex'),
        currentBookId: a.bookId,
      });
    }

    /* Apply the plan ONLY to the rows `extendPlan` just planned. The covered rows
       are already in plan-applied ids, and re-applying the whole plan to them is
       wrong: a joined row's id is a PRIOR id that can also be the raw key of a
       different `new` decision, which would collapse the two rows. */
    const addedDecisions = Object.fromEntries(
      Object.entries(plan.decisions).filter(([raw]) => uncoveredIds.has(raw)),
    );
    const applied = applyMatchPlan(uncovered, { ...plan, decisions: addedDecisions }, current);
    const finalRoster = [...re.roster.filter((c) => !uncoveredIds.has(c.id)), ...applied.characters];
    const idMap: Record<string, string> = { ...re.idMap, ...applied.idMap };
    let sentences = remapSentenceIds(remapSentenceIds(a.sentences, re.idMap), applied.idMap);

    const ov = overlayPlanOntoCast({
      current,
      roster: finalRoster,
      plan,
      resolve,
      historyStatus: history.status,
      ledger: a.ledger,
      knownRunIds: new Set(Object.keys(a.mainLedger ?? {})),
      currentBookId: a.bookId,
      mode: 'persist',
    });

    if (ov.unresolved.length > 0) {
      // Server-side only: ids, never a path. A merge cannot be told from a delete without the history.
      console.warn(
        `[analysis] ${ov.unresolved.length} plan target(s) are gone from the cast (merged or deleted mid-run) and cast-id-history.json could not be read, so their lines stay on those ids: ${ov.unresolved.join(', ')}`,
      );
    }

    // Sentence ids -> the ids the cast now holds. A row this write adds is live after
    // it, so its lines stay on it: a stale history key on its id never moves them (PR
    // #4103 pass 1 O1; a legacy fold-bucket key is not followed at all, R53).
    const currentIds = new Set(current.map((r) => r.id));
    const addedNow = new Set(ov.characters.map((c) => c.id).filter((id) => !currentIds.has(id)));
    const narratorId = ov.characters.map((c) => c.id).find(isNarratorId) ?? 'narrator';
    const toFinal: Record<string, string> = {};
    for (const id of new Set(sentences.map((s) => s.characterId))) {
      if (addedNow.has(id)) continue;
      const d = isNarratorId(id) ? plan.decisions[id] : undefined;
      const target = d?.kind === 'join' ? resolve(d.priorId) : resolve(id);
      if (target && target !== id) toFinal[id] = target;
      // A narrator-id speaker with no live target goes to the narrator row the overlay wrote (#4100).
      else if (!target && isNarratorId(id) && narratorId !== id) toFinal[id] = narratorId;
    }
    sentences = remapSentenceIds(sentences, toFinal);
    sentences = rerouteDeletedTargets(sentences, new Set(ov.deletedTargets), narratorId);

    const carried = new Set(ov.carriedForward.map((c) => c.id));
    const finalChars = (a.driftRefused ? current : (ov.characters as Rows)).map((c) => {
      if (a.driftRefused || carried.has(c.id) || sentences.length === 0) return c;
      const mine = sentences.filter((s) => s.characterId === c.id);
      return { ...c, lines: mine.length, scenes: new Set(mine.map((s) => s.chapterId)).size };
    });

    const retirements: Retirement[] = [];
    if (!a.driftRefused) {
      if (!sameJson(finalChars, current)) {
        await writeJsonAtomic(castJsonPath(a.bookDir), { characters: finalChars });
      }
      const live = new Set([...current.map((r) => r.id), ...finalChars.map((r) => r.id)]);
      const seen = new Set<string>();
      const candidates: Retirement[] = [];
      for (const d of Object.values(plan.decisions)) {
        // The narrator join is structural ('narrator' -> the prior narrator id), never a retirement.
        if (d.kind !== 'join' || d.rawId === d.priorId || isNarratorId(d.rawId)) continue;
        if (live.has(d.rawId) || seen.has(d.rawId) || Object.hasOwn(history.supersededBy, d.rawId)) continue;
        const to = resolve(d.priorId);
        if (!to || to === d.rawId) continue;
        seen.add(d.rawId);
        candidates.push({ from: d.rawId, to });
      }
      if (history.status === 'degraded') {
        // Spec: with an unreadable history, retirements are skipped and logged.
        if (candidates.length) {
          console.warn(
            `[analysis] ${candidates.length} character-id retirement(s) skipped - cast-id-history.json could not be read`,
          );
        }
      } else {
        retirements.push(...candidates);
      }
    }

    /* A failed edits write must not discard what the caller needs after cast.json
       has landed (retirements, ledger, idMap): park it, finish the suggestions step,
       and rethrow it carrying the outcome (`persistOutcome`). */
    let editsErr: unknown = null;
    const writeEdits = (): Promise<void> =>
      writeJsonAtomicOrdered(manuscriptEditsJsonPath(a.bookDir), { sentences });
    try {
      await (a.bookId ? withBookLock(a.bookId, writeEdits) : writeEdits());
    } catch (err) {
      editsErr = err ?? new Error('manuscript-edits.json write failed');
    }

    try {
      if (a.driftRefused) {
        await removeSuggestionPairsLocked(a.bookDir, a.runAddedPairs);
      } else {
        await reconcileSuggestionsLocked(a.bookDir, {
          add: remapSuggestions(a.runSuggestions, idMap),
          liveIds: new Set(finalChars.map((c) => c.id)),
          supersededBy: history.supersededBy,
          declined: declinedPredicate(finalChars, a.bookId, history.notSamePerson),
        });
      }
    } catch (err) {
      // Advisory: the cast and the edits already landed; a suggestions-file fault
      // must not fail a completed persist (and no lock is taken here to time out).
      console.warn('[analysis] failed to write merge suggestions', err);
    }

    const outcome: PersistOutcome = {
      characters: finalChars,
      sentences,
      retirements,
      plan,
      deletedTargets: ov.deletedTargets,
      unresolved: ov.unresolved,
      carriedForward: ov.carriedForward,
      ledger: a.driftRefused ? a.ledger : ov.ledger,
      ...(a.mainLedger
        ? { mainLedger: a.driftRefused ? a.mainLedger : refreshLedger(a.mainLedger, current, finalChars) }
        : {}),
      droppedRunAdded: a.driftRefused ? [] : ov.droppedRunAdded,
      idMap,
    };
    if (editsErr !== null) {
      if (typeof editsErr === 'object') (editsErr as PersistOutcomeError).persistOutcome = outcome;
      throw editsErr;
    }
    return outcome;
  });
}
