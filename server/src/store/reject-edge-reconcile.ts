/* #2166 — reconcile a book's same-book `notLinkedTo` edges against the
   durable rejection records in cast-id-history.json.

   A reject writes two records of one decision: a `rejectedPairs` entry (the
   visible half — it renders the chip and powers Undo) and a one-sided
   `notLinkedTo` edge on cast.json (the invisible half — it suppresses the
   §4.4 name matcher and has no UI path of its own). cast-reject-orphan.ts now
   orders those writes so a half-failure always leaves the VISIBLE half; this
   module is the other side of that bargain, completing a half-written reject
   at the next authoritative persist and clearing an edge whose durable half
   is gone.

   PURE by design — no fs, no locking. analysis.ts owns the read, the
   `withCastLock`, and the write, because `cast-lock.guard.test.ts` is
   syntactic and call-graph-blind: a `writeJsonAtomic(castJsonPath(` inside
   THIS module would read as an unlocked write no matter how its caller is
   wrapped, and analysis.ts's allowlist entry is keyed on file AND count.

   PRECONDITION on `history` (final-review Critical, #2166): it must be a
   history that was actually READ, not one that degraded to empty because the
   file was unreadable or malformed. This function cannot tell the two apart —
   an empty history makes pass 1 classify every same-book edge as unbacked and
   delete it — and, being pure, it has no way to find out. The caller enforces
   this: `reconcileRejectEdgesOnDisk` reads via `loadCastIdHistoryWithStatus`
   and skips the call entirely on `degraded`. Do not add a second caller that
   passes a collapsed `loadCastIdHistory` result.

   That read alone is not enough from inside the analysis persist, because
   several steps there rewrite cast-id-history.json unconditionally and so
   replace a degraded file with a valid, empty one before the read happens (PR
   #2202 gate review, Critical). Those callers decide the verdict BEFORE the
   first rewriting step and hand it to `reconcileRejectEdgesOnDisk` as
   `statusBeforePersist`. A future caller that sits downstream of any
   always-writing history step owes the same.

   BACKING. An edge is legitimate when the decision it encodes is recorded
   durably somewhere. Two places count:
     - a `rejectedPairs` entry with `from === edge.characterId`;
     - the LEGACY id-wide `rejected` list containing `edge.characterId`.
   The second is not optional. Books rejected between aa6616d8 and f6074ca8
   recorded the decision there, and `buildCastResolver` still honours it
   (cast-resolve.ts:108 builds `rejectedSet` from it, :164 consults it).
   Treating those edges as unbacked would delete real user decisions.

   MATCHING. Removal is BOOK-scoped on `edge.characterId`, never row-scoped on
   `pair.to`: merge-analysis-cast.ts:473-480 copies `old.notLinkedTo` onto a
   fresh row matched by NAME, so a legitimate edge can legitimately sit on a
   row whose id is not the pair's `to`. Row-scoped removal would delete it.

   ADDITION is per-pair on `pair.to`, unconditionally — because D1 pair scope
   lets one `from` be rejected against two different live characters and the
   original POSTs wrote an edge on each, a blanket "no edge anywhere for this
   `from`" rule heals only the first (#2200). A RELOCATED edge — one sitting
   on a row that is NOT `to` for any pair with that `from`, per the MATCHING
   paragraph above — is no longer consulted here: it is orthogonal to whether
   `pair.to` itself needs healing, and suppressing every add for `from` on its
   account left a second, edgeless pair unhealed forever whenever a relocated
   edge for the same `from` also existed. The `existing.some(...)` dedupe
   below is the only anti-duplication mechanism now. Be precise about what it
   does and does not buy: it refuses a duplicate on the row that would receive
   the write — ROW-scoped — and that is sufficient here, NOT because a
   book-scoped duplicate is impossible, but because it is not a harm. It is in
   fact now the expected steady state: a relocated copy on one row plus the
   healed edge on `p.to` means two rows carry the same `{bookId, from}` pair,
   which is exactly what [R7] asserts. Plan 281 framed duplication book-scoped
   and treated avoiding it as a fail-safe precaution; it never named a harm for
   it, and every consumer reads a same-book edge as "this pair was rejected",
   which is true on both rows. The named harm was only ever for row-scoped
   REMOVAL — see the MATCHING paragraph above, which is untouched. Do not
   "restore" a book-scoped duplicate check on the strength of this dedupe's
   existence. Full reasoning:
   docs/superpowers/specs/2026-08-07-reject-edge-per-pair-heal-design.md. */

import type { CastIdHistory } from './cast-id-history.js';

export interface RejectEdge {
  /** The live cast row carrying (or receiving) the edge. */
  characterId: string;
  /** The orphaned id the edge names. */
  orphanedId: string;
}

export interface RejectEdgeReconcileResult<T> {
  adds: RejectEdge[];
  removes: RejectEdge[];
  /** The reconciled roster. Structurally equal to `characters` when both
      `adds` and `removes` are empty — the caller writes only when they are
      not, so an already-consistent book performs no disk write. */
  next: T[];
}

type NotLinked = { bookId: string; characterId: string };
type CastRow = { id: string; notLinkedTo?: NotLinked[] };

export function reconcileRejectEdges<T extends CastRow>(
  bookId: string,
  characters: ReadonlyArray<T>,
  history: CastIdHistory,
): RejectEdgeReconcileResult<T> {
  const pairs = history.rejectedPairs ?? [];
  const legacyRejected = new Set(history.rejected ?? []);
  const backedFroms = new Set(pairs.map((p) => p.from));

  const adds: RejectEdge[] = [];
  const removes: RejectEdge[] = [];

  /* Pass 1 — drop unbacked same-book edges. */
  const next = characters.map((c) => {
    const existing = c.notLinkedTo;
    if (!existing?.length) return c;
    const kept = existing.filter((e) => {
      if (e.bookId !== bookId) return true; // cross-book: never ours to judge
      if (backedFroms.has(e.characterId) || legacyRejected.has(e.characterId)) return true;
      removes.push({ characterId: c.id, orphanedId: e.characterId });
      return false;
    });
    return kept.length === existing.length ? c : ({ ...c, notLinkedTo: kept } as T);
  });

  /* Pass 2 — write back a pair whose edge is missing. */
  const byId = new Map(next.map((c, i) => [c.id, i]));
  for (const p of pairs) {
    const idx = byId.get(p.to);
    if (idx === undefined) continue; // `to` is not a live row — nothing to carry the edge
    const row = next[idx];
    const existing = row.notLinkedTo ?? [];
    if (existing.some((e) => e.bookId === bookId && e.characterId === p.from)) continue;
    next[idx] = { ...row, notLinkedTo: [...existing, { bookId, characterId: p.from }] } as T;
    adds.push({ characterId: p.to, orphanedId: p.from });
  }

  return { adds, removes, next };
}
