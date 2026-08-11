/* Per-book character id history side-table.

   Tracks which character ids have been superseded and what they were
   replaced with. Stored as a separate JSON file under .audiobook/
   so no schema change is needed on Character or openapi.yaml.

   The supersededBy map is transitive: if a→b then b→c, both a and b
   map to c for O(1) resolution without chasing — regardless of which of
   the two retirements is recorded first. */

import { join } from 'node:path';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withKeyLock } from '../workspace/file-lock.js';

export interface CastIdHistory {
  schema: 1;
  supersededBy: Record<string, string>;
  /** #2040 Task 14 review item 2b — ids dropped from `supersededBy` because a
   *  fresh roster reclaimed the KEY as a live cast id
   *  (`dropSupersededIdsReclaimedByLiveCast`), OR because the entry's TARGET
   *  quietly stopped being live (`dropSupersededTargetsNoLongerLive`, #2110)
   *  — keyed the same way `supersededBy` was before the drop (id -> what it
   *  used to resolve to). This is the only surviving record of that pair
   *  once the drop runs — losing it would mean every book that re-analyses
   *  before Wave 3's banner ships loses the pair for good.
   *  Additive and backwards-compatible: optional, never bumps `schema`. An
   *  old reader that doesn't know this key still works — it only ever reads
   *  `supersededBy`, which is unaffected. A file written before this change
   *  simply has no `displaced` key; `loadCastIdHistory` tolerates its
   *  absence. */
  displaced?: Record<string, string>;
  /** #2040 Task 17 — orphaned character ids the user has explicitly said are
   *  NOT the same character as whatever they'd otherwise resolve onto (the
   *  banner's "not the same character" action, spec §4.6). Checked by
   *  `buildCastResolver` AFTER the `exact` tier but ahead of the other
   *  three (history / normalised-id / normalised-history) — fix round 1: an
   *  earlier version of this checked `rejected` before `exact` too, which
   *  reintroduced #2040's original bug for any rejected id a LATER analysis
   *  reclaims as a genuine live cast row (a real risk — an orphaned id is
   *  very often the character's own name, so a re-analysis minting that
   *  exact id again is the expected case, not an edge case). A live exact
   *  match always wins over a stale rejection, mirroring the same principle
   *  `dropSupersededIdsReclaimedByLiveCast` established for `supersededBy`:
   *  liveness beats history. The alias/normalised tiers stay suppressed by
   *  rejection because a plain reject that only deleted a `supersededBy`
   *  entry would be a no-op for the two normalised tiers, which have no
   *  history entry to remove at all (see the controller ruling in
   *  `.superpowers/sdd/2026-08-01-cast-character-identity/progress.md`), so
   *  `rejected` is the only mechanism that stops read-side resolution
   *  through those three. Additive and backwards-compatible, same
   *  shape/strictness as `displaced`: optional, never bumps `schema`. An old
   *  reader that doesn't know this key still works — it only ever reads
   *  `supersededBy`/`displaced`, which are unaffected. */
  rejected?: string[];
  /** #2092/#2089 (design settled 2026-08-05, D1) — the pair-scoped successor
   *  to `rejected`. `rejected` blocks an orphaned id against EVERY tier-2/3/4
   *  candidate; that turned out to cost more than it bought on the auto-
   *  reconciled path (the button's most common correct use), because
   *  `repair-cast-id-drift.mjs` pushes a rejected id to `skipped` before any
   *  candidate is computed — permanently, for every future analysis, even
   *  once a later roster mints the RIGHT target. A pair only blocks the
   *  specific `(from, to)` reconciliation the user actually saw and said no
   *  to; a different, later target for the same `from` id is unaffected.
   *
   *  `rejected` (above) is kept as a LEGACY, READ-ONLY field: still honoured
   *  by `buildCastResolver` for back-compat with any file written before this
   *  change, but no code path writes to it anymore — every new reject goes
   *  through `rejectedPairs` via `rejectOrphanedPair`.
   *
   *  `forgotSupersededTo`, when present, is the `supersededBy[from]` target
   *  `forgetSupersededId` removed at the moment this pair was recorded (D6).
   *  Stashing it here is what makes the undo (`unrejectOrphanedPair`,
   *  #2089) lossless: `forgetSupersededId` returns `Promise<void>` and
   *  nothing else on disk retains the removed mapping, so without this the
   *  alias would be unreconstructible once forgotten. Simply not calling
   *  `forgetSupersededId` at reject time was considered and rejected:
   *  `retireCharacterId`'s repoint loop rewrites every entry whose VALUE is
   *  a retired id, so a shadowed `supersededBy[from]=to` left behind could
   *  silently become `supersededBy[from]=someOtherId` later — the pair no
   *  longer matches what the resolver would actually do, and `from` would
   *  resolve onto a character the user never approved.
   *
   *  Additive and backwards-compatible, same shape/strictness discipline as
   *  `displaced`/`rejected`: optional, never bumps `schema`, validated
   *  INDEPENDENTLY of `rejected` (its own `Array.isArray` check) so a
   *  malformed `rejectedPairs` can't discard a well-formed legacy `rejected`
   *  list or vice versa — validation elsewhere in this file is all-or-
   *  nothing for the WHOLE file, so retyping `rejected` in place instead of
   *  adding a new field would have meant one malformed shape silently
   *  dropping `supersededBy` too. An old reader that doesn't know this key
   *  still works — it only ever reads `supersededBy`/`rejected`, which are
   *  unaffected. */
  rejectedPairs?: RejectedPair[];
  /** #2128 — monotonic per-book counter, incremented on EVERY write to this
   *  file, whether or not a `supersededBy` key changed. The broader rule makes
   *  "seq strictly increases across every write" a testable invariant rather
   *  than an ambiguous one. Additive and backwards-compatible: optional, never
   *  bumps `schema`. `loadCastIdHistory` repairs it upward from
   *  `recordedAtSeq` (see its own doc comment) — without that repair, a file
   *  that loses `seq` while keeping its markers can never clear a row again. */
  seq?: number;
  /** #2128 — the `seq` at which each key's CURRENT target was established.
   *  NOT "when the alias was first recorded": `retireCharacterId`'s repoint
   *  loop can move an alias onto a different cast row, whose voice is whichever
   *  row won the merge, so a render made against the old target is stale even
   *  though the KEY never changed. Restamping on repoint is what closes that.
   *
   *  The authoritative value `isAudioCurrent` compares. FIELD ABSENT means
   *  "this file has never been through the lane" and reads `'unknown'`. A KEY
   *  missing from a PRESENT field is NOT evidence of age and must read
   *  `'unknown'` too, never contribute 0: `bumpSeqAndStamp`'s reconcile loops
   *  guarantee `keys(recordedAtSeq) === keys(supersededBy)` after every write
   *  (Global Constraint 6), so there is no write path that can leave a
   *  `supersededBy` key with no marker — a key missing here despite the field
   *  being present means the file itself is suspect, not merely old. Treating
   *  that as `0` would CLEAR the row against any render stamp >= 0, which is
   *  fail-open and silently reopens #2107 — the one axis this codebase must
   *  not fail on (Global Constraint 4: only an affirmative comparison clears
   *  a row; everything else, including this case, is damage and stays
   *  listed). */
  recordedAtSeq?: Record<string, number>;
  /** #2128 — human-readable companion for operator diagnostics (an operator
   *  hand-inspecting this file mid-repair-run can tell WHEN, not merely in what
   *  order). NEVER compared: the predicate reads `recordedAtSeq` only. The
   *  names carry the rule — `…Seq` is authoritative, `…Iso` is display. */
  recordedAtIso?: Record<string, string>;
}

/** One pair-scoped rejection: `from` (an orphaned id) is NOT the same
 *  character as `to` (a live cast id) — see `rejectedPairs`'s doc comment on
 *  `CastIdHistory` above for why this replaced the id-wide `rejected` list. */
export interface RejectedPair {
  from: string;
  to: string;
  /** The `supersededBy[from]` target `forgetSupersededId` removed at reject
   *  time, if any. Absent when there was nothing to forget (e.g. `from` only
   *  ever matched through a normalised tier, which has no `supersededBy`
   *  entry to begin with). */
  forgotSupersededTo?: string;
}

export function castIdHistoryPath(bookDir: string): string {
  return join(bookDir, '.audiobook', 'cast-id-history.json');
}

/** Load the cast id history from disk. Returns empty history if missing or malformed.
 *  Never throws — a lookup side-table must not be able to break a book's render.
 *  `displaced` is optional (#2040 Task 14 review item 2b) — absent entirely
 *  on a file written before that change, and validated the same way as
 *  `supersededBy` when present so a malformed `displaced` can't sneak a
 *  throw past a caller that only reads `supersededBy`. `rejected` (#2040
 *  Task 17) is validated the same way — absent entirely on a file written
 *  before this change, and required to be an array when present, so a
 *  malformed value falls back to the whole-file empty-history default
 *  instead of reaching a caller as a bad shape. `rejectedPairs` (#2092/#2089,
 *  D1) gets its OWN independent `Array.isArray` check, deliberately not
 *  folded into the `rejected` check above — the two fields are validated
 *  separately so a malformed `rejectedPairs` on an otherwise-fine file can't
 *  collapse the whole file to empty (discarding a well-formed `supersededBy`
 *  along with it) any more than a malformed `rejected` already can, and vice
 *  versa. Neither check bumps `schema`: an old reader that has never heard of
 *  `rejectedPairs` still works, since it only ever reads `supersededBy`/
 *  `rejected`.
 *
 *  A missing file is the common, expected case (most books never retire an
 *  id) and returns the empty default silently. A file that EXISTS but is
 *  unreadable or the wrong shape is different — every caller (including
 *  `buildCastResolver` at render time, srv-86) silently loses history-based
 *  protection when this happens, which must not read as "no protection
 *  needed". That case logs one `console.warn` naming the path and cause, so
 *  the degraded-protection state is operator-visible instead of silent.
 *
 *  This function deliberately COLLAPSES "absent" and "degraded" onto the same
 *  empty value, which is correct for every caller whose worst case is losing
 *  protection for one run. A caller that would DESTROY data on an empty
 *  history must use `loadCastIdHistoryWithStatus` below and refuse to act on
 *  `degraded` — see its doc comment (#2166 final review, Critical). */
export async function loadCastIdHistory(bookDir: string): Promise<CastIdHistory> {
  return (await loadCastIdHistoryWithStatus(bookDir)).history;
}

/** How a `loadCastIdHistoryWithStatus` read went (#2166 final review, Critical).
 *
 *  - `ok` — the file was read and passed the shape check. `history` is it.
 *  - `absent` — no file on disk. `history` is the empty default, and that
 *    emptiness is EVIDENCE: nothing has ever been retired for this book.
 *  - `degraded` — the file exists but could not be read or did not pass the
 *    shape check. `history` is the same empty default, but it is NOT evidence
 *    of anything: it is "could not be determined". */
export type CastIdHistoryStatus = 'ok' | 'absent' | 'degraded';

export interface CastIdHistoryReadResult {
  status: CastIdHistoryStatus;
  history: CastIdHistory;
}

/** The whole-file shape check, extracted so `stampRecordedAtSeqIfAbsent` can
 *  ask the identical question before it writes (a second, hand-rolled copy is
 *  the duplicate-logic shape this lane exists to stop). All-or-nothing BY
 *  DESIGN: a malformed field degrades the whole file to the empty default, so
 *  no id gets alias protection and every affected id is listed as a genuine
 *  miss. Fail-closed, and required by #2128's acceptance. */
function isWellFormedHistory(raw: unknown): raw is CastIdHistory {
  const h = raw as CastIdHistory;
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    h.schema === 1 &&
    typeof h.supersededBy === 'object' &&
    !Array.isArray(h.supersededBy) &&
    h.supersededBy !== null &&
    (h.displaced === undefined ||
      (typeof h.displaced === 'object' && !Array.isArray(h.displaced) && h.displaced !== null)) &&
    (h.rejected === undefined || Array.isArray(h.rejected)) &&
    (h.rejectedPairs === undefined || Array.isArray(h.rejectedPairs)) &&
    /* #2128 — validated the same way, and deliberately inside the same
       all-or-nothing conjunction as everything above it. */
    (h.seq === undefined || (typeof h.seq === 'number' && Number.isFinite(h.seq))) &&
    (h.recordedAtSeq === undefined ||
      (typeof h.recordedAtSeq === 'object' &&
        !Array.isArray(h.recordedAtSeq) &&
        h.recordedAtSeq !== null)) &&
    (h.recordedAtIso === undefined ||
      (typeof h.recordedAtIso === 'object' &&
        !Array.isArray(h.recordedAtIso) &&
        h.recordedAtIso !== null))
  );
}

/** #2128 — `seq` repaired upward from the markers on load. A file that loses
 *  `seq` (hand-edit, merge conflict, truncated write) while keeping
 *  `recordedAtSeq` would otherwise load as 0, every subsequent write would
 *  start again from 1, every existing stamp would stay above it, and the
 *  book's rows could NEVER clear again. Reading the true floor off the markers
 *  themselves costs nothing and makes that unreachable. */
function repairSeq(h: CastIdHistory): number {
  const marks = Object.values(h.recordedAtSeq ?? {}).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  return Math.max(typeof h.seq === 'number' && Number.isFinite(h.seq) ? h.seq : 0, ...marks, 0);
}

/** The discriminated sibling of `loadCastIdHistory` — same read, same
 *  warnings, same returned history, but it also says WHICH of the three
 *  states produced that history (#2166 final review, Critical).
 *
 *  `loadCastIdHistory` collapses `absent` and `degraded` onto the identical
 *  `{ schema: 1, supersededBy: {} }` value, which is exactly right for every
 *  consumer whose worst case is "loses history-based protection this run"
 *  (`buildCastResolver`, `clearNotLinkedEdgesForDroppedRejections`): a
 *  degraded read costs them protection, never data.
 *
 *  `reconcileRejectEdgesOnDisk` is the first consumer for which that collapse
 *  is destructive rather than merely unprotective. It treats an empty history
 *  as proof that every same-book `notLinkedTo` edge is stranded, and DELETES
 *  them — so a transient EPERM/EBUSY from an AV scanner, a cloud-sync client
 *  or the OS indexer (readJson has no retry, so it propagates straight
 *  through) would wipe every reject the user ever made on that book, and log
 *  that it had cleared stranded links while doing it. Recovery on a later good
 *  run is only partial: the add pass rebuilds solely from `rejectedPairs`, so
 *  an edge backed only by the LEGACY id-wide `rejected` list never comes back.
 *
 *  Same spirit as `cast-merge-base.ts`'s `UNREADABLE` sentinel (#2185): a
 *  transient read blip must never be mistaken for evidence.
 *
 *  Never throws, exactly like `loadCastIdHistory` — a lookup side-table must
 *  not be able to break a book's render. See `loadCastIdHistory`'s own doc
 *  comment above for the field-by-field validation rationale. */
export async function loadCastIdHistoryWithStatus(
  bookDir: string,
): Promise<CastIdHistoryReadResult> {
  const path = castIdHistoryPath(bookDir);
  try {
    const raw = await readJson<CastIdHistory>(path);
    if (raw === null) {
      // No file on disk — nothing has ever been retired for this book.
      return { status: 'absent', history: { schema: 1, supersededBy: {} } };
    }
    if (isWellFormedHistory(raw)) {
      return { status: 'ok', history: { ...raw, seq: repairSeq(raw) } };
    }
    console.warn(
      `[cast-id-history] ${path} exists but has an unexpected shape — id-history protection disabled until it is fixed or removed.`,
    );
  } catch (err) {
    console.warn(
      `[cast-id-history] ${path} is unreadable (${(err as Error)?.message ?? err}) — id-history protection disabled until it is fixed or removed.`,
    );
  }
  return { status: 'degraded', history: { schema: 1, supersededBy: {} } };
}

/** Thrown by every mutating helper below when the read that would decide
 *  what to preserve came back `degraded` (#2214) — the file exists but is
 *  unreadable or the wrong shape. Every helper here used to read through the
 *  COLLAPSING `loadCastIdHistory` and write back unconditionally, which
 *  REPLACED the damaged file with a valid, empty one — silently destroying
 *  every retirement, displacement and rejection ever recorded for the book,
 *  with every later read then reporting `ok`. Throwing here instead, before
 *  any inspection or mutation, is the fix: a caller cannot tell a
 *  degraded-read no-op from a genuinely needed write (e.g.
 *  `restoreSupersededId`'s `existing === target` early return, or
 *  `rejectOrphanedPair`'s idempotent-pair return), so nothing below may run
 *  at all once the verdict is `degraded`.
 *
 *  `absent` and `ok` are unaffected — a missing file is the common, expected
 *  case (most books never retire an id) and stays silently writable, exactly
 *  as before. Callers already tolerate a throw from these helpers (the write
 *  itself could always fail — EPERM/ENOSPC — see `loadCastIdHistory`'s own
 *  doc comment above); this is the same contract extended to a degraded
 *  READ. Same spirit as `cast-merge-base.ts`'s `UNREADABLE` sentinel
 *  (#2185): a transient read blip must never be mistaken for evidence. */
export class CastIdHistoryUnreadableError extends Error {
  readonly bookDir: string;
  readonly path: string;

  constructor(bookDir: string) {
    const path = castIdHistoryPath(bookDir);
    super(
      `[cast-id-history] refusing to write ${path} — it exists but could not be read or did not ` +
        `pass the shape check (see the [cast-id-history] warning just above for the cause). Writing ` +
        `through this read would replace it with a valid, empty history, silently losing every ` +
        `recorded retirement, displacement and rejection for this book. Fix or remove the file, then retry.`,
    );
    this.name = 'CastIdHistoryUnreadableError';
    this.bookDir = bookDir;
    this.path = path;
  }
}

/** Read the history for a mutating helper below, refusing to proceed on a
 *  `degraded` verdict (#2214) — see `CastIdHistoryUnreadableError`'s own doc
 *  comment for why. `absent` and `ok` return their history unchanged. */
async function loadHistoryOrThrow(bookDir: string): Promise<CastIdHistory> {
  const { status, history } = await loadCastIdHistoryWithStatus(bookDir);
  if (status === 'degraded') {
    throw new CastIdHistoryUnreadableError(bookDir);
  }
  return history;
}

/** #2128 — the ONE place `seq` advances and markers move. Every writer in this
 *  module calls this immediately BEFORE its `writeJsonAtomic`, whether or not
 *  it touched a `supersededBy` key.
 *
 *  `stampedKeys` are the keys whose TARGET this write established or changed.
 *  Beyond those, the reconcile loops below hold Global Constraint 6's
 *  bidirectional invariant unconditionally: a marker whose key is gone is
 *  destroyed, and a key with no marker (a pre-lane file, a hand-edit that
 *  dropped the field, a merge conflict) is stamped at the new `seq`. That
 *  second loop IS the one-shot back-fill: a legacy alias becomes current only
 *  once a chapter is re-rendered ABOVE this stamp, which is the fail-closed
 *  direction. */
function bumpSeqAndStamp(history: CastIdHistory, stampedKeys: readonly string[]): void {
  const next = (history.seq ?? 0) + 1;
  const iso = new Date().toISOString();
  const seqMap: Record<string, number> = { ...(history.recordedAtSeq ?? {}) };
  const isoMap: Record<string, string> = { ...(history.recordedAtIso ?? {}) };

  for (const k of stampedKeys) {
    seqMap[k] = next;
    isoMap[k] = iso;
  }
  for (const k of Object.keys(seqMap)) {
    if (!(k in history.supersededBy)) {
      delete seqMap[k];
      delete isoMap[k];
    }
  }
  for (const k of Object.keys(history.supersededBy)) {
    if (!(k in seqMap)) {
      seqMap[k] = next;
      isoMap[k] = iso;
    }
  }

  history.seq = next;
  history.recordedAtSeq = seqMap;
  history.recordedAtIso = isoMap;
}

/** Record that characterId `from` has been retired and replaced by `to`.
 *  Updates transitive mappings: whether a→b then b→c is recorded, or b→c
 *  then a→b, both a and b end up pointing to c in the final map (O(1)
 *  resolution). */
/** #2092/#2089 Task 10 — when `retireCharacterId` repoints a `supersededBy`
 *  entry whose VALUE is the id being retired (`from`) onto its live
 *  replacement (`newTarget`), do the same to a `rejectedPairs` entry whose
 *  `to` is that same id. Reasoning: `retireCharacterId` is only ever called
 *  when `from` and `newTarget` (after dereferencing) are the SAME real
 *  character under two ids — that is the invariant the whole
 *  `supersededBy`-repoint loop above already relies on (a rename, a
 *  dedupe, a merge — never two different people). A rejected pair
 *  `{ from: X, to: Y }` records a decision about a PERSON, not a string:
 *  "the orphaned id X is not the character currently addressable as Y."
 *  When Y retires into Y', Y' is still that same person, so "X is not Y"
 *  must keep meaning "X is not [that person]" — i.e. become "X is not Y'"
 *  — or the rejection silently stops applying the moment the character it
 *  was about gets a new id, and the auto-repair pass (or a future banner
 *  render) could re-offer the exact pairing the user already said no to.
 *  Dropping the pair instead was considered and rejected: it would forget
 *  a genuine user decision for no reason tied to that decision itself,
 *  purely because of bookkeeping happening on the OTHER id it references.
 *
 *  Degenerate case (M2, review round 1): if `newTarget === pair.from` (the
 *  retiring id's live replacement is itself the pair's `from` id — a
 *  person's canonical id became the very id that was rejected as "not
 *  them"), the entry is dropped rather than written as a self-referencing
 *  `{from: X, to: X}` pair — mirroring `retireCharacterId`'s own "never
 *  write a self-entry" guard below for `supersededBy`. It would never fire
 *  at read time anyway (`buildCastResolver` checks `exact` before any
 *  rejected pair), but leaving a nonsensical pair on disk serves nothing.
 *  Dropped entries are RETURNED, not merely discarded: this module never
 *  touches `cast.json`, so it cannot itself remove the one-sided
 *  `notLinkedTo` edge the original reject wrote there — a caller with
 *  `cast.json` access is what would need to act on this, if one ever needs
 *  to (no current caller of `retireCharacterId` does).
 *
 *  M1 (review round 1): repointing can make two PREVIOUSLY-distinct pairs
 *  collide onto the same `(from, to)` — reject X against both Y and Y'
 *  (two separate pairs), then retire Y into Y': the first pair's `to`
 *  repoints from Y onto Y', colliding with the second, already-existing
 *  `{from: X, to: Y'}` pair. Deduped by `(from, to)` after repointing,
 *  keeping the first-encountered entry — the same "first write wins"
 *  idempotence `rejectOrphanedPair` itself already applies to a literal
 *  double-reject. Without this, the banner would render two identical
 *  chips (a React duplicate-key warning, since the chip list keys on
 *  `targetId`) and `unrejectOrphanedPair`'s `findIndex`+splice would only
 *  ever remove one, making a second Undo click look like it did nothing.
 *
 *  M3 (review round 1): `forgotSupersededTo` is just another stored id
 *  reference — independent of `pair.to`, but equally capable of pointing
 *  at the id currently retiring (e.g. `from` was rejected against `to`,
 *  but `from` ALSO used to alias via `supersededBy` to the very id that is
 *  now retiring elsewhere). Repointed the same way `to` is, using the same
 *  `from -> newTarget` substitution, so a later Undo restores the CURRENT
 *  live alias rather than a dead intermediate id. */
function repointRejectedPairs(history: CastIdHistory, from: string, newTarget: string): RejectedPair[] {
  if (!history.rejectedPairs?.length) return [];
  const droppedSelfLoops: RejectedPair[] = [];
  const seen = new Set<string>();
  const next: RejectedPair[] = [];
  for (const pair of history.rejectedPairs) {
    const to = pair.to === from ? newTarget : pair.to;
    const forgotSupersededTo = pair.forgotSupersededTo === from ? newTarget : pair.forgotSupersededTo;
    const repointed: RejectedPair =
      forgotSupersededTo === undefined ? { from: pair.from, to } : { from: pair.from, to, forgotSupersededTo };
    if (repointed.from === repointed.to) {
      droppedSelfLoops.push(repointed);
      continue;
    }
    const key = JSON.stringify([repointed.from, repointed.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(repointed);
  }
  history.rejectedPairs = next;
  return droppedSelfLoops;
}

/** #2092/#2089 M2 (review round 1) — self-loop `rejectedPairs` entries
 *  `repointRejectedPairs` had to drop during this call, if any (see its own
 *  doc comment). #2133 — a reject's two writes (this `rejectedPairs` entry
 *  and the one-sided `notLinkedTo` edge the original reject also wrote onto
 *  `cast.json`) are created together and must be destroyed together (see
 *  `docs/features/278-cast-character-identity.md`'s invariant of the same
 *  name) — a dropped pair with its `notLinkedTo` edge left behind would
 *  permanently suppress §4.4's name matcher for a pairing that no longer
 *  exists, invisibly. BOTH production callers now act on this return:
 *  `analysis.ts`'s `recordRetirements` and `cast-merge.ts`'s
 *  `performCastMerge` each locate any surviving `notLinkedTo` entry naming a
 *  dropped pair's `from` id and remove it in the same write. This module
 *  never touches `cast.json` itself (no access to it), so it can only
 *  report the drop — cleanup is necessarily the caller's job. */
export interface RetireCharacterIdResult {
  droppedSelfLoopRejections: RejectedPair[];
}

export async function retireCharacterId(
  bookDir: string,
  from: string,
  to: string,
): Promise<RetireCharacterIdResult> {
  // No-op if from === to
  if (from === to) {
    return { droppedSelfLoopRejections: [] };
  }

  // Serialize writes per-book
  const bookId = bookDir; // Use bookDir as the lock key
  return withKeyLock(`cast-id-history:${bookId}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);

    /* Direct reversal (#2040 Task 8 fix round 1, item 3): `to` is itself
       recorded as having been retired in favour of `from` — an earlier call
       said `to -> from`, and this call says the opposite, `from -> to`. Both
       can't be true; the newer call reflects the newer roster and wins.
       Falling through to the forward-dereference below would instead
       resolve `to` through the stale chain back to `from` and write a dead
       self-loop (`from -> from`), while leaving the stale `to -> from`
       entry live — orphaning BOTH ids, since neither's target is a live
       row. Repro (review round 1): dedupe records "антон"->"anton", a later
       remap records the reverse "anton"->"антон"; without this branch the
       history ends up `{"антон":"anton","anton":"anton"}` and
       buildCastResolver drops both. Invert instead: drop the stale entry,
       repoint anything that targeted `from` at `to`, and write `from -> to`. */
    if (history.supersededBy[to] === from) {
      delete history.supersededBy[to];
      const repointed: string[] = [];
      for (const [key, value] of Object.entries(history.supersededBy)) {
        if (value === from) {
          history.supersededBy[key] = to;
          repointed.push(key);
        }
      }
      history.supersededBy[from] = to;
      const droppedSelfLoopRejections = repointRejectedPairs(history, from, to);
      bumpSeqAndStamp(history, [from, ...repointed]);
      await writeJsonAtomic(castIdHistoryPath(bookDir), history);
      return { droppedSelfLoopRejections };
    }

    // Dereference 'to' through any existing chain first, so the repoint
    // below is order-independent — retiring INTO an already-superseded id
    // must land on its live target, not the stale intermediate.
    const resolvedTo = history.supersededBy[to] ?? to;

    // Never write a self-entry — it would resolve nowhere. The reversal
    // branch above already covers the only way resolvedTo can equal `from`,
    // but keep this as a defensive guard against future changes here.
    if (from === resolvedTo) {
      return { droppedSelfLoopRejections: [] };
    }

    /* #2128 — a retirement that changes nothing must not write. This mirrors
       the idempotent-write discipline every other primitive in this module
       already applies (`rejectOrphanedId`, `rejectOrphanedPair`,
       `unrejectOrphanedPair`, `restoreSupersededId`); `retireCharacterId` was
       the one that didn't, which was invisible until `seq` made a redundant
       write observable. Without it, an analysis re-deriving an
       already-recorded retirement restamps `from` and invalidates every render
       made since the original — re-listing a book the operator just cleared.

       The repoint loop below is included in "changes nothing": if no other
       entry's value is `from`, and `supersededBy[from]` already equals
       `resolvedTo`, the write is a byte-for-byte no-op. */
    const alreadyRecorded =
      history.supersededBy[from] === resolvedTo &&
      !Object.values(history.supersededBy).includes(from);
    if (alreadyRecorded && !history.rejectedPairs?.some((p) => p.to === from)) {
      return { droppedSelfLoopRejections: [] };
    }

    // Find all keys that currently point to 'from' and update them to 'to'
    const repointed: string[] = [];
    for (const [key, value] of Object.entries(history.supersededBy)) {
      if (value === from) {
        repointed.push(key);
        history.supersededBy[key] = resolvedTo;
      }
    }

    // Add/update the new mapping
    history.supersededBy[from] = resolvedTo;

    const droppedSelfLoopRejections = repointRejectedPairs(history, from, resolvedTo);
    bumpSeqAndStamp(history, [from, ...repointed]);

    // Write back
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return { droppedSelfLoopRejections };
  });
}

/** Split a batch of retirements into the ones that may be recorded and the
 *  ones that must not, given the roster that is actually live.
 *
 *  Wave 2 final-review finding 1(b), defence in depth for the Critical the
 *  same review found in `remapFreshToPriorIds`. `retireCharacterId` repoints
 *  every entry whose VALUE is `from` (:123-127) — sound only when `from` is
 *  genuinely dead, which is what the history entry asserts. A retirement whose
 *  `from` is a LIVE cast id is therefore bogus by definition, and recording it
 *  does damage that `dropSupersededIdsReclaimedByLiveCast` cannot undo: that
 *  function removes the reclaimed KEY at the end of the run, after the
 *  collateral repoint has already rewritten unrelated chains onto the wrong
 *  character.
 *
 *  Judged on `from` only. `to` being live is the normal, required case — a
 *  guard that tested `to` would refuse every legitimate retirement and let the
 *  dangerous one through.
 *
 *  Pure and synchronous, like the retirement producers themselves; the caller
 *  (`analysis.ts`'s `recordRetirements`) holds both the persisted roster and
 *  the run log, and is responsible for surfacing anything refused. */
export function refuseRetirementsOfLiveIds<T extends { from: string; to: string }>(
  retirements: ReadonlyArray<T>,
  liveIds: ReadonlyArray<string>,
): { keep: T[]; refused: T[] } {
  const live = new Set(liveIds);
  const keep: T[] = [];
  const refused: T[] = [];
  for (const entry of retirements) {
    if (live.has(entry.from)) refused.push(entry);
    else keep.push(entry);
  }
  return { keep, refused };
}

/** A history entry dropped because a fresh roster reintroduced its key as a
 *  live cast id (`dropSupersededIdsReclaimedByLiveCast`), OR because its
 *  TARGET quietly stopped being live (`dropSupersededTargetsNoLongerLive`,
 *  #2110). `id` is the history key; `supersededBy` is what it used to
 *  resolve to before the drop. */
export interface DisplacedHistoryEntry {
  id: string;
  supersededBy: string;
}

/** §4.4's closing paragraph: resolution is exact-id-first, so a fresh
 *  roster's live row always wins over a history entry keyed to the same id —
 *  silently, with no tie and no warning. Once that happens the entry no
 *  longer protects anything (a segment still carrying the old id resolves
 *  straight to the live row, never through history), so it must be dropped
 *  rather than left to rot and mislead the next read. Called once per
 *  analysis write, after the roster that will be persisted is final.
 *
 *  The dropped pairs are moved into `displaced` (#2040 Task 14 review item
 *  2b), not discarded — once dropped, `supersededBy` is the ONLY place they
 *  lived, and losing them means every book that re-analyses before Wave 3's
 *  banner ships permanently loses the pair (the segments become genuinely
 *  unattributable, not just unreported). `displaced` accumulates across
 *  calls/runs KEY BY KEY: a later drop merges its pairs into the existing map
 *  rather than replacing it, so a key dropped by an earlier run survives a
 *  later drop that does not mention it. It is NOT append-only per key —
 *  dropping the same id twice overwrites the first pair with the second,
 *  keeping only the most recent target. Deliberate: `displaced` records what
 *  an id last resolved to, not its full lineage.
 *
 *  Returns the dropped entries so the caller can also log them immediately
 *  (operator-visible, #2040 Task 14 review item 2a) and so a future banner
 *  can surface what needs review (§4.6, Wave 3); this function only drops,
 *  persists, and reports — it does not decide what happens next.
 *
 *  Always writes, even when nothing was dropped (#2040 Task 14 review item
 *  3) — a prior version skipped the write when `dropped` was empty, which
 *  made "does not write" an untested claim. Never throws on read
 *  (loadCastIdHistory's own guarantee); a throw can still come from the
 *  write — same as retireCharacterId, callers must guard it. */
export async function dropSupersededIdsReclaimedByLiveCast(
  bookDir: string,
  liveIds: ReadonlyArray<string>,
): Promise<DisplacedHistoryEntry[]> {
  const live = new Set(liveIds);
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);
    const dropped: DisplacedHistoryEntry[] = [];
    for (const [key, target] of Object.entries(history.supersededBy)) {
      if (live.has(key)) {
        dropped.push({ id: key, supersededBy: target });
        delete history.supersededBy[key];
      }
    }
    if (dropped.length) {
      const displaced = { ...(history.displaced ?? {}) };
      for (const entry of dropped) {
        displaced[entry.id] = entry.supersededBy;
      }
      history.displaced = displaced;
    }
    bumpSeqAndStamp(history, []);
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return dropped;
  });
}

/** A `supersededBy` entry whose TARGET (`to`, not `from`) is no longer a
 *  live cast id — #2110, the mirror-image failure of
 *  `dropSupersededIdsReclaimedByLiveCast` above (that one prunes an entry
 *  whose KEY was reclaimed; this one prunes an entry whose TARGET died).
 *
 *  The real case: `supersededBy` holds `{anton: 'антон'}` — 'антон' is live
 *  but unvoiced. A later re-analysis's carry-forward only re-adds
 *  voiced/reused survivors (`isVoicedOrReused`,
 *  `merge-analysis-cast.ts`), and the id-drift name-fallback only retires an
 *  id when a same-name fresh row exists to retire it onto; with neither,
 *  'антон' simply vanishes with NO `Retirement` ever recorded — nothing else
 *  notices, and `buildCastResolver` already skips a history entry whose
 *  target isn't live (`cast-resolve.ts:89-90`), so the dangling entry looks
 *  perfectly inert. It is not: `POST /cast/create` only treats a
 *  `supersededBy` KEY as taken, not a value (a live value is already in
 *  `existingIds`, which holds only while the target stays live) — so once
 *  'антон' dies, nothing stops a later mint from producing 'антон' again
 *  (the id is usually the character's own display name, so this is the
 *  expected case, not an edge one). The moment that happens, the dangling
 *  entry's raw key ('anton') resolves via tier 2 straight onto the
 *  brand-new, unrelated, empty row — SILENTLY, with no orphan report at
 *  all, hijacking every segment the original alias covered. That is
 *  strictly worse than those segments sitting orphaned-and-visible.
 *
 *  Dropping the entry out of `supersededBy` does not, by itself, close that
 *  hazard — it relocates it one write later. The moment 'anton' leaves
 *  `supersededBy`, it is free to re-mint again unless something else keeps
 *  it reserved. That something is `displaced` (below): `POST /cast/create`
 *  (`cast-create.ts`, C1 fix round, #2163) treats a `displaced` key as
 *  taken exactly the same way it already treats a `supersededBy` key, so
 *  the id stays reserved across the drop rather than reopening the hijack
 *  window this function exists to close. This is why the drop is written
 *  to move entries into `displaced` instead of discarding them outright —
 *  losing the pair here would mean losing the last thing keeping the key
 *  out of circulation.
 *
 *  MUST be called only against the full, final roster of an AUTHORITATIVE
 *  write — never an interim one. The three mid-run "Cast so far" writes —
 *  two inside `runMainAnalyzerJob` and one inside `runSubsetAnalyzerJob`
 *  (`analysis.ts`, all three the `overlayInterimCastForLiveView` calls in
 *  those two functions — cited by symbol, not line: F2, #2163, a line
 *  citation here was stale the moment it was written twice already) —
 *  go through `overlayInterimCastForLiveView`, never this function,
 *  precisely because `buildInterimCast` has
 *  folded only the chapters analysed so far there: a character who simply
 *  hasn't been reached yet is indistinguishable from one the analyzer
 *  actually dropped, so pruning against an interim roster would destroy a
 *  valid alias for a character who is merely not yet on stage (#2086's
 *  exact hazard). Only the two end-of-run writes that call
 *  `mergeAnalysisResultWithExistingCast` (analysis.ts's main and subset
 *  persist blocks, both already the sole callers of
 *  `dropSupersededIdsReclaimedByLiveCast`) call this too, with the same
 *  `liveIds` binding (`mergedFinal.characters`, the exact roster the write
 *  just persisted).
 *
 *  Dropped pairs move into `displaced`, the same bookkeeping
 *  `dropSupersededIdsReclaimedByLiveCast` already established — once
 *  dropped, `supersededBy` is the only place they lived. Deliberately does
 *  NOT touch `rejectedPairs`' `forgotSupersededTo` (a stashed id on a
 *  DIFFERENT record, restorable later via `restoreSupersededId`, which is
 *  outside this function's write): a dangling `forgotSupersededTo` is a
 *  separate, narrower hazard (only reachable if that specific pair's Undo
 *  is later clicked) that needs its own call-site decision, not a
 *  side-effect of pruning `supersededBy`. */
export async function dropSupersededTargetsNoLongerLive(
  bookDir: string,
  liveIds: ReadonlyArray<string>,
): Promise<DisplacedHistoryEntry[]> {
  const live = new Set(liveIds);
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);
    const dropped: DisplacedHistoryEntry[] = [];
    for (const [key, target] of Object.entries(history.supersededBy)) {
      if (!live.has(target)) {
        dropped.push({ id: key, supersededBy: target });
        delete history.supersededBy[key];
      }
    }
    if (dropped.length) {
      const displaced = { ...(history.displaced ?? {}) };
      for (const entry of dropped) {
        displaced[entry.id] = entry.supersededBy;
      }
      history.displaced = displaced;
    }
    bumpSeqAndStamp(history, []);
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return dropped;
  });
}

/** Remove a single named entry from `supersededBy` — the "forget one alias"
 *  primitive the banner's "not the same character" action needs. Unlike
 *  `retireCharacterId`, this does NOT repoint every entry whose VALUE is
 *  `id` onto anything — that repoint is only sound when `id` is genuinely
 *  dead (`retireCharacterId`'s own documented hazard, above), and this
 *  primitive has no basis for that claim: it only knows the caller wants
 *  this one entry gone, not that `id` itself is retired. It forgets exactly
 *  the key it's asked to and leaves every other entry (including ones that
 *  point AT `id`) untouched.
 *
 *  Returns the removed target (`supersededBy[id]`), or `undefined` when there
 *  was nothing to remove (#2092/#2089 D6) — the caller (the reject-orphan
 *  route) stashes this on the new pair-scoped `rejectedPairs` entry as
 *  `forgotSupersededTo` so a later undo (`unrejectOrphanedPair`) can restore
 *  it. Before D6 this returned `Promise<void>`: once forgotten, the mapping
 *  was unreconstructible and any undo could only ever be partial.
 *
 *  No-op (and no write) when the key isn't present, mirroring the rest of
 *  this module's idempotent-write discipline. Pair with `rejectOrphanedPair`
 *  when the caller also wants to stop the id resolving through the
 *  normalised tiers, which don't have a `supersededBy` entry to remove in
 *  the first place — this primitive alone is not durable against those.
 *
 *  `expectedTarget` (#2092/#2089, review round 2 "Also fix") — when given,
 *  the delete is a no-op unless `supersededBy[id]` still equals it. The
 *  reject-undo route's POST handler reads `supersededBy[orphanedId]` once
 *  (to compute the stash it bakes into `rejectOrphanedPair`), then calls
 *  this function afterwards as a best-effort tidy-up (#2089 fix round 1,
 *  I1's reorder). Between those two steps a CONCURRENT `retireCharacterId`
 *  could repoint `supersededBy[orphanedId]` onto a different, unrelated
 *  target — deleting unconditionally would then discard that fresh entry
 *  instead of the stale one the read actually saw, reproducing C1's own
 *  overwrite-class damage one primitive over, on the POST side instead of
 *  DELETE's. Passing the value the caller already read as `expectedTarget`
 *  closes that window: a mismatch means someone else already changed this
 *  key since the read, so there is nothing of the caller's own to forget. */
export async function forgetSupersededId(
  bookDir: string,
  id: string,
  expectedTarget?: string,
): Promise<string | undefined> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);
    const removed = history.supersededBy[id];
    if (removed === undefined) return undefined;
    if (expectedTarget !== undefined && removed !== expectedTarget) {
      /* Round 3 (M-8) — this branch used to fail closed silently: correct
         (someone else's concurrent write must not be discarded), but
         indistinguishable from "forgotten" in the log with nothing printed
         either way. Named so an operator can tell "someone else moved this
         key since the read" from "nothing needed forgetting" after the
         fact. */
      console.warn(
        `[cast-id-history] forgetSupersededId("${id}") skipped — expected supersededBy["${id}"] to still be ` +
          `"${expectedTarget}" but found "${removed}"; someone else changed this key since the read, so it was ` +
          `left alone rather than discarding their write.`,
      );
      return undefined;
    }
    delete history.supersededBy[id];
    bumpSeqAndStamp(history, []);
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return removed;
  });
}

/** Restore a single `supersededBy[id] = target` entry — the "undo forget"
 *  primitive the reject-undo route needs (#2092/#2089, C1 fix round 1).
 *  Unlike `retireCharacterId`, this does NOT repoint every entry whose
 *  VALUE is `id` onto `target`, and — the defect this primitive exists to
 *  close — it does NOT overwrite an existing `supersededBy[id]` entry that
 *  already points somewhere else. Both of those are sound in
 *  `retireCharacterId` only when `id` is genuinely dead, which an Undo can
 *  no longer assume once a rejection is pair-scoped rather than id-wide.
 *
 *  Failure scenario this closes (C1): reject "mayrin is not Mairin" (the
 *  pair stashes `forgotSupersededTo: 'mairin'`, the removed
 *  `supersededBy['mayrin']`); a LATER, unrelated re-analysis records the
 *  CORRECT alias `supersededBy['mayrin'] = 'mr-marrow'`; the user then
 *  clicks the now-stale "Not Mairin" chip's Undo. Restoring with
 *  `retireCharacterId(bookDir, 'mayrin', 'mairin')` would write
 *  unconditionally, silently overwriting the correct `'mr-marrow'` alias
 *  back to the stale `'mairin'` one, AND repoint anything that targeted
 *  `'mayrin'` — reproducing #2040's own failure mode (a character's lines
 *  ending up in someone else's voice) via the button labelled "Undo". This
 *  primitive instead writes only when the key is absent — the ordinary
 *  case, nothing has re-recorded an alias for `id` since the reject — and
 *  otherwise leaves the newer entry alone and reports that it did, so the
 *  caller can tell the user the alias was superseded rather than silently
 *  restoring nothing (or the wrong thing).
 *
 *  Idempotent: if `supersededBy[id]` already equals `target` (a retried
 *  DELETE after a prior successful restore), no write happens and
 *  `restored: true` is still returned — the desired end state already
 *  holds. */
/** NOTE (#2198): this single-pair primitive has no production caller — the
 *  reject Undo batches through `undoRejectedPairs` instead. It is kept
 *  (exported and tested) as the primitive the batch's applier is shared with.
 *  **Do not reach for it to undo several pairs in a loop**: that is precisely
 *  the split-write shape #2198 removed — each call takes its own lock, read and
 *  write, so a mid-loop failure leaves a half-completed state that blinds the
 *  retry. Batch callers use `undoRejectedPairs`.
 */
export async function restoreSupersededId(
  bookDir: string,
  id: string,
  target: string,
): Promise<{ restored: boolean; supersededByOther?: string }> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);
    const { result, changed, touchedKeys } = applyRestoreSupersededId(history, id, target);
    if (changed) {
      bumpSeqAndStamp(history, touchedKeys);
      await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    }
    return result;
  });
}

/** In-memory-only applier shared by `restoreSupersededId` and the batched
 *  `undoRejectedPairs` below (#2198) — mutates `history` and reports the same
 *  `{ restored, supersededByOther }` shape `restoreSupersededId` returns,
 *  plus whether a mutation actually happened, so a caller batching several of
 *  these under one write knows whether it needs to write at all. Never reads,
 *  never locks, never writes — see this module's `undoRejectedPairs` doc
 *  comment for why sharing the LOCKED wrapper instead would deadlock.
 *
 *  #2128 — also reports `touchedKeys`, the `supersededBy` keys this call
 *  established or changed (empty on both no-op branches). The owning writer
 *  (`restoreSupersededId` alone, or `undoRejectedPairs` accumulating across a
 *  whole batch) folds this into the single `bumpSeqAndStamp` call it makes
 *  immediately before its one write — derived from what the code actually
 *  touched, not hand-transcribed into a table a future PR can outgrow.
 *
 *  Review round 1 (M4) — on THIS applier specifically, `touchedKeys` is
 *  defence-in-depth, not load-bearing: the only branch that sets it
 *  (`changed: true`, below) writes `history.supersededBy[id]` for the first
 *  time, which means `id` had no marker before this call either —
 *  `bumpSeqAndStamp`'s own back-fill loop would stamp it at the same `next`
 *  seq with or without `id` in `stampedKeys`. Kept anyway because the
 *  behaviour is correct BY the explicit list, not by relying on the
 *  self-heal loop as the only mechanism — a future refactor that trims or
 *  reorders `bumpSeqAndStamp`'s reconcile loops must not assume nothing here
 *  depends on the back-fill still running. */
function applyRestoreSupersededId(
  history: CastIdHistory,
  id: string,
  target: string,
): {
  result: { restored: boolean; supersededByOther?: string };
  changed: boolean;
  touchedKeys: string[];
} {
  const existing = history.supersededBy[id];
  if (existing === target) {
    return { result: { restored: true }, changed: false, touchedKeys: [] };
  }
  if (existing !== undefined) {
    return { result: { restored: false, supersededByOther: existing }, changed: false, touchedKeys: [] };
  }
  history.supersededBy[id] = target;
  return { result: { restored: true }, changed: true, touchedKeys: [id] };
}

/** LEGACY (#2040 Task 17) — id-wide reject. Superseded by `rejectOrphanedPair`
 *  (#2092/#2089, D1): this blocks `id` against EVERY tier-2/3/4 candidate
 *  forever, which costs more than it buys on the auto-reconciled path (see
 *  `rejectedPairs`'s doc comment on `CastIdHistory`). No production code path
 *  calls this anymore — `rejected` is now read-only, honoured by
 *  `buildCastResolver` purely for back-compat with a file written before this
 *  change. Kept (rather than deleted) because it's still the primitive that
 *  produces the on-disk shape the back-compat tests exercise. Do not add a
 *  new caller; use `rejectOrphanedPair` instead.
 *
 *  Record that `id` must never again resolve through the history /
 *  normalised-id / normalised-history tiers — NOT the `exact` tier (fix
 *  round 1: a live cast row with this exact id always wins over a stale
 *  rejection; see the `rejected` field's own doc comment on `CastIdHistory`
 *  for the corrected precedence and why). Idempotent: rejecting an id
 *  already in the list is a no-op, no re-write. Does not touch
 *  `supersededBy` itself. */
export async function rejectOrphanedId(bookDir: string, id: string): Promise<void> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);
    const rejected = history.rejected ?? [];
    if (rejected.includes(id)) return;
    history.rejected = [...rejected, id];
    bumpSeqAndStamp(history, []);
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
  });
}

/** Record that `from` (an orphaned id) is NOT the same character as `to` (a
 *  live cast id) — the pair-scoped successor to `rejectOrphanedId`
 *  (#2092/#2089, D1; see `rejectedPairs`'s doc comment on `CastIdHistory`).
 *  Blocks resolution of `from` onto `to` SPECIFICALLY, through the history /
 *  normalised-id / normalised-history tiers (never `exact` — same
 *  live-always-wins precedence as the legacy field, enforced in
 *  `buildCastResolver`). A different, later target for the same `from` is
 *  unaffected — that's the whole point of the pair scope.
 *
 *  `forgotSupersededTo`, when provided, is stashed on the pair (D6) so
 *  `unrejectOrphanedPair` can restore it later. This primitive does NOT call
 *  `forgetSupersededId` itself — the caller (the reject-orphan route) calls
 *  it first and passes through whatever it removed, so the route keeps its
 *  own fatal/non-fatal split across the two writes rather than this
 *  primitive making that call for it.
 *
 *  `withKeyLock`-serialised. Idempotent: rejecting the same `(from, to)`
 *  pair again is a no-op — mirrors this module's idempotent-write
 *  discipline elsewhere (`retireCharacterId`, `rejectOrphanedId`). A repeat
 *  call's `forgetSupersededId` will itself be a no-op by then (the entry is
 *  already gone from the first call), so there is nothing new to stash. */
export async function rejectOrphanedPair(
  bookDir: string,
  from: string,
  to: string,
  forgotSupersededTo?: string,
): Promise<void> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);
    const pairs = history.rejectedPairs ?? [];
    if (pairs.some((p) => p.from === from && p.to === to)) return;
    const entry: RejectedPair =
      forgotSupersededTo === undefined ? { from, to } : { from, to, forgotSupersededTo };
    history.rejectedPairs = [...pairs, entry];
    bumpSeqAndStamp(history, []);
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
  });
}

/** Undo `rejectOrphanedPair` (#2092/#2089, D5/D6) — removes the `(from, to)`
 *  pair from `rejectedPairs` and returns the removed entry's
 *  `forgotSupersededTo`, if any, so the caller can restore it (e.g. via
 *  `retireCharacterId(bookDir, from, forgotSupersededTo)`) and make the undo
 *  lossless. Returns `undefined` both when the pair was absent (nothing to
 *  undo) and when it was present but had no `forgotSupersededTo` (nothing to
 *  restore) — the route treats both cases identically (no further alias
 *  write needed either way), so collapsing them costs nothing.
 *
 *  No-op (and no write) when the pair isn't present, mirroring this module's
 *  idempotent-write discipline — a repeat undo of an already-undone pair is
 *  safe. */
/** NOTE (#2198): this single-pair primitive has no production caller — the
 *  reject Undo batches through `undoRejectedPairs` instead. It is kept
 *  (exported and tested) as the primitive the batch's applier is shared with.
 *  **Do not reach for it to undo several pairs in a loop**: that is precisely
 *  the split-write shape #2198 removed — each call takes its own lock, read and
 *  write, so a mid-loop failure leaves a half-completed state that blinds the
 *  retry. Batch callers use `undoRejectedPairs`.
 */
export async function unrejectOrphanedPair(
  bookDir: string,
  from: string,
  to: string,
): Promise<string | undefined> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);
    const { removed, changed } = applyUnrejectOrphanedPair(history, from, to);
    if (changed) {
      bumpSeqAndStamp(history, []);
      await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    }
    return removed?.forgotSupersededTo;
  });
}

/** In-memory-only applier shared by `unrejectOrphanedPair` and the batched
 *  `undoRejectedPairs` below (#2198) — same split as `applyRestoreSupersededId`
 *  above: mutates `history`, reports the removed pair (if any) and whether a
 *  mutation happened, never reads/locks/writes itself. */
function applyUnrejectOrphanedPair(
  history: CastIdHistory,
  from: string,
  to: string,
): { removed: RejectedPair | undefined; changed: boolean } {
  const pairs = history.rejectedPairs ?? [];
  const idx = pairs.findIndex((p) => p.from === from && p.to === to);
  if (idx < 0) return { removed: undefined, changed: false };
  const removed = pairs[idx];
  history.rejectedPairs = [...pairs.slice(0, idx), ...pairs.slice(idx + 1)];
  return { removed, changed: true };
}

/** Undo a whole BATCH of `rejectOrphanedPair` entries atomically (#2198) —
 *  the transactional replacement for a caller looping `restoreSupersededId`
 *  + `unrejectOrphanedPair` per pair. One `withKeyLock`, one read, one
 *  `writeJsonAtomic` for the WHOLE batch: `writeJsonAtomic` is a
 *  temp-file-plus-rename, so a single write is all-or-nothing for free, and a
 *  batch that fails partway through leaves the file byte-identical to before
 *  the call — no half-restored alias, no half-removed pair.
 *
 *  This closes #2198: the pre-fix DELETE handler ran two SEPARATE loops over
 *  a governing-pairs batch, each primitive taking its own lock/read/write.
 *  Pair 1 fully completing already moves `supersededBy[pair1.from]`, which is
 *  exactly what makes `rejectedPairsGoverning`'s resolution SEE fewer
 *  governing pairs on a retry after pair 2's loop throws — the retry goes
 *  blind to work it hasn't done yet. Per-pair atomicity doesn't fix this
 *  (pair 1 alone still moves `supersededBy`); only batch-scope atomicity
 *  does, which is why this shares appliers with, rather than calls, the two
 *  single-pair primitives above.
 *
 *  MUST NOT call `restoreSupersededId`/`unrejectOrphanedPair` — both take
 *  `withKeyLock('cast-id-history:' + bookDir)` themselves, and this function
 *  already holds that same lock for the whole batch. Re-entering it would
 *  hang forever, with no timeout and no diagnostic. `applyRestoreSupersededId`
 *  / `applyUnrejectOrphanedPair` are the shared, lock-free appliers this
 *  function and the two single-pair primitives both mutate `history` through.
 *
 *  Order within `pairs` does not affect the result: each pair's restore (if
 *  any) and pair-removal are applied to the in-memory `history` in the order
 *  given, but every pair's restore reads/writes only its OWN `from` key, and
 *  every pair's removal only removes its OWN `(from, to)` entry, so two
 *  pairs can never observe or clobber each other's effect.
 *
 *  A pair with `forgotSupersededTo === undefined` contributes no alias
 *  restore (mirrors the pre-#2198 loop's `continue`) — only its
 *  `rejectedPairs` removal happens. `restored` on that pair's result is
 *  `true` (nothing blocked it): the field's only `false` case is a NEWER
 *  alias occupying `supersededBy[from]`, which cannot happen when no restore
 *  was attempted at all.
 *
 *  If nothing in the batch changes anything (every pair already absent, no
 *  alias needed restoring), no write happens at all — same idempotent-write
 *  discipline as every other primitive in this module. */
export interface UndoRejectedPairResult {
  from: string;
  to: string;
  /** false only when a NEWER alias already occupies supersededBy[from]. */
  restored: boolean;
  supersededByOther?: string;
}

export async function undoRejectedPairs(
  bookDir: string,
  pairs: ReadonlyArray<{ from: string; to: string; forgotSupersededTo?: string }>,
): Promise<UndoRejectedPairResult[]> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    // #2214 — throws CastIdHistoryUnreadableError on a degraded read, refusing to
    // launder a damaged file into a valid, empty one.
    const history = await loadHistoryOrThrow(bookDir);
    const results: UndoRejectedPairResult[] = [];
    /* #2128 — the tenth write site (P1). Each pair's `applyRestoreSupersededId`
       reports the `supersededBy` keys IT touched; accumulated here and stamped
       ONCE via `bumpSeqAndStamp` immediately before the single batch write, so
       one `undoRejectedPairs` call is one `seq` bump no matter how many pairs
       it restores — the key list is derived from what the loop actually
       touched, never hand-transcribed. */
    const touchedKeys: string[] = [];
    let changed = false;
    for (const pair of pairs) {
      let restored = true;
      let supersededByOther: string | undefined;
      if (pair.forgotSupersededTo !== undefined) {
        const applied = applyRestoreSupersededId(history, pair.from, pair.forgotSupersededTo);
        restored = applied.result.restored;
        supersededByOther = applied.result.supersededByOther;
        if (applied.changed) changed = true;
        /* Review round 1 (I1 follow-up) — confirmed by mutation testing that
           dropping this accumulation is UNOBSERVABLE by any test today: the
           same reason `applyRestoreSupersededId`'s `touchedKeys` is
           defence-in-depth on the single-pair path (see its own doc comment,
           M4) applies here too — `applied.changed` is only ever true when
           `id` was just added to `supersededBy` for the first time, which
           means it had no marker before this call, which means
           `bumpSeqAndStamp`'s own back-fill loop (the "key with no marker"
           reconcile) stamps it at the same final `seq` regardless of whether
           it is also in `stampedKeys`. Kept for the same reason as M4: an
           explicit list, not reliance on the self-heal loop as the only
           mechanism. This is the SAME deferred self-heal gap the whole-branch
           review is tracking, not a new one. */
        touchedKeys.push(...applied.touchedKeys);
      }
      const { changed: unrejectChanged } = applyUnrejectOrphanedPair(history, pair.from, pair.to);
      if (unrejectChanged) changed = true;
      results.push(
        supersededByOther === undefined
          ? { from: pair.from, to: pair.to, restored }
          : { from: pair.from, to: pair.to, restored, supersededByOther },
      );
    }
    if (changed) {
      bumpSeqAndStamp(history, touchedKeys);
      await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    }
    return results;
  });
}

/** #2128 — perform the one-shot back-fill stamp on a book whose history file
 *  has never been through this lane. Called by `repair-cast-id-drift.mjs
 *  --apply` for EVERY book it scans, not only ones with an alias to record:
 *  the books carrying pre-lane aliases are exactly the ones the A33 repair
 *  workflow already visits, and absence of the field reads `'unknown'` until
 *  it lands.
 *
 *  Returns whether it wrote. Four no-write cases, all deliberate: no file
 *  (nothing to stamp), the file exists but is unreadable — bad JSON, an I/O
 *  error (review round 1, M3: this used to be swallowed identically to "no
 *  file", so an operator sweeping books via `--apply` got no output at all
 *  for a corrupt one — now warned, matching the shape-check branch below),
 *  the marker map already agrees with `supersededBy` key-for-key
 *  (idempotent — see below), and — the one that matters — a file that fails
 *  the shape check. Loading a malformed file returns the EMPTY default, so
 *  stamping that would persist an empty history over whatever `supersededBy`
 *  the operator still has on disk to repair.
 *
 *  The idempotent check tests the KEY SETS, not merely whether `recordedAtSeq`
 *  is present (fold-in fix, follow-up to the original #2128 landing): a file
 *  whose `recordedAtSeq` field exists but is missing entries for some
 *  `supersededBy` keys — reachable by hand-edit or merge damage — used to
 *  read as "already stamped" and stop here forever, with no route back to
 *  Global Constraint 6's bidirectional invariant short of an unrelated write
 *  that happens to touch every missing key. Comparing the key sets gives a
 *  partially-damaged marker map a way to self-heal through this same
 *  `--apply` entry point: `bumpSeqAndStamp`'s own reconcile loops (called
 *  below with an empty `stampedKeys`) already backfill any `supersededBy` key
 *  with no marker and prune any marker with no `supersededBy` key, so once
 *  the write proceeds the repair is automatic — this function only needed to
 *  stop refusing to make the call. Still conservative: a file whose sets
 *  already agree makes no write, exactly as before. */
export async function stampRecordedAtSeqIfAbsent(bookDir: string): Promise<boolean> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    const path = castIdHistoryPath(bookDir);
    let raw: CastIdHistory | null;
    try {
      raw = await readJson<CastIdHistory>(path);
    } catch (err) {
      console.warn(
        `[cast-id-history] ${path} is unreadable (${(err as Error)?.message ?? err}) — skipping the #2128 ` +
          `one-shot stamp rather than overwriting it with an empty history.`,
      );
      return false;
    }
    if (raw === null) return false;
    if (!isWellFormedHistory(raw)) {
      console.warn(
        `[cast-id-history] ${path} has an unexpected shape — skipping the #2128 ` +
          `one-shot stamp rather than overwriting it with an empty history.`,
      );
      return false;
    }
    if (raw.recordedAtSeq !== undefined) {
      const markerKeys = Object.keys(raw.recordedAtSeq);
      const supersededKeys = Object.keys(raw.supersededBy);
      const inSync =
        markerKeys.length === supersededKeys.length &&
        supersededKeys.every((k) => k in raw.recordedAtSeq!);
      if (inSync) return false;
    }
    const history: CastIdHistory = { ...raw, seq: repairSeq(raw) };
    bumpSeqAndStamp(history, []);
    /* Written as `writeJsonAtomic(castIdHistoryPath(bookDir), …)`, NOT via a
       `const path` local. Review round 1 (C2): guard 5 counts write sites by
       matching that literal text, so hoisting the path into a variable makes
       the one new write site this lane adds invisible to the guard that exists
       to see write sites. */
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return true;
  });
}
