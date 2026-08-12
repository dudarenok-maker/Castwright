/* POST/DELETE /api/books/:bookId/cast/:characterId/reject-orphan-match
   (#2040 Task 17 shipped id-wide; #2092/#2089, design settled 2026-08-05,
   made this PAIR-SCOPED and added the DELETE undo)

   The orphaned-character-fallback banner (src/views/cast.tsx) shows two
   kinds of row: an id that AUTO-RECONCILED onto a live character through
   the id-history side-table or a normalised-key match, and an id that
   didn't resolve at all. Either way, the user can say "that's not the same
   character" — POST is what that action calls. DELETE undoes it.

   PAIR SCOPE (D1, repo owner approved 2026-08-05 over this issue's own
   originally-suggested id-wide one-liner): rejecting "mayrin is not
   Mr. Marrow" must not ALSO permanently block "mayrin is Mairin" once a
   later analysis mints the RIGHT `supersededBy` entry — the id-wide
   `rejected` list (still honoured, read-only, for back-compat with a file
   written before this change) blocks `orphanedId` against every candidate
   forever, which costs more than it buys on the auto-reconciled path (the
   button's most common CORRECT use): `repair-cast-id-drift.mjs` pushes a
   rejected id to `skipped` before any candidate is computed, for every
   future analysis. A pair-scoped reject only blocks THIS `(orphanedId,
   characterId)` reconciliation; a different, later target is unaffected.
   See `rejectedPairs`'s doc comment on `CastIdHistory`
   (`store/cast-id-history.ts`) for the full design writeup.

   Spec §4.6's own original design ("rejecting removes the history entry")
   is a no-op on every book in the real workspace: `buildCastResolver` never
   consulted `notLinkedTo`, and every currently-affected id resolves through
   the NORMALISED tiers, which have no history entry to remove at all (zero
   `cast-id-history.json` files existed anywhere in the 20-book workspace as
   of Wave 3). So POST writes THREE things that actually make a rejection
   durable, and DELETE reverses all three:

     1. `(orphanedId, characterId)` is added to cast-id-history.json's
        `rejectedPairs` (`rejectOrphanedPair`) — checked by
        `buildCastResolver` ahead of the history / normalised-id /
        normalised-history tiers (fix round 1, unchanged by the pair-scope
        change: NOT the `exact` tier — a live cast row with this exact id
        always wins, see `rejectedPairs`'s own doc comment on
        `CastIdHistory`), so it blocks re-resolution of `orphanedId` onto
        `characterId` SPECIFICALLY through every tier a truly orphaned id
        could otherwise match through. An existing `supersededBy` entry
        naming `orphanedId` is also forgotten (`forgetSupersededId`) — but
        ONLY when it targets THIS `characterId`: under the old id-wide
        reject, forgetting unconditionally was harmless, since ANY alias
        for `orphanedId` was about to be blocked outright regardless of its
        target. Under pair scope that stopped being true — an entry
        pointing at some OTHER, unrejected character is a live, still-valid
        alias (D1's whole point), so unconditionally forgetting it would
        silently destroy an unrelated resolution as a side effect of this
        reject. `forgetSupersededId` now RETURNS the removed target (D6),
        which this route stashes on the pair as
        `forgotSupersededTo` so DELETE can restore it later and make the
        undo lossless.
     2. A one-sided `notLinkedTo` edge is written onto the LIVE character
        (`:characterId`), naming `orphanedId`. This is what stops §4.4's
        NAME matcher from re-recording the same match on the next
        re-analysis — id rejection alone doesn't touch name-based matching.
        One-sided is correct here (unlike the symmetric cross-book pair
        `cast-not-linked-to.ts` writes): the orphaned id has no cast row of
        its own, so there is no reciprocal side to write.

        Durability holds via ONE of the two §4.4 matchers, not both — they
        are not equivalent, and this route only needs (and gets) the one
        that fires early enough to matter. `remap-fresh-to-prior.ts`'s
        `notLinkedToId` (fix round 2 review finding) matches on
        `characterId` alone, ignoring `bookId`, so it reads THIS edge
        directly off the live character's own `notLinkedTo` array the
        moment a re-analysis mints a fresh row whose id is `orphanedId`
        again (the common case — the orphaned id is usually the character's
        own name-derived slug) — that's the by-NAME remap this route exists
        to block, and it's blocked at the point the fresh row is considered
        for linking, before any collapse happens. `merge-analysis-cast.ts`'s
        `groupHasNotLinkedEdge` is a narrower, LATER backstop: it only
        blocks a same-normalised-name COLLAPSE once a live row carrying
        `orphanedId` already coexists in the group being deduped — i.e. it
        can't be what stops the initial re-link, only a secondary guard for
        the case where an un-remapped fresh row survives into the same cast.
        Correctness here rests on the first matcher; the second is inert for
        this route's purposes until that later, narrower scenario arises.
     3. D4 — the response (and, via `collectOrphanedCharacterFallbacks`'s
        `rejectedAgainst`, the very next book-state GET) surface `resolution`
        so the frontend can render a persistent "Not <Name> · Undo" chip
        without a second round-trip.

   D3 — the endpoint stays UNCONDITIONAL. There is no
   `if (info.resolvedCharacterId)` branch gating any of this: under pair
   scope there is nothing harmful to skip by always writing all three, and
   section-dependent behaviour (different write set depending on whether the
   id currently resolves) is something the UI cannot explain to the user.

   D5 — DELETE undoes with NO confirmation dialog. The reject's consequence
   is invisible until the next render, so a confirm demands certainty at the
   moment the user has the LEAST information; the row-state surface already
   has to exist for the chip, so Undo is a sibling button in the same pixel
   — strictly less new code than a modal, for strictly more value.

   #2166 — the two writes are ordered by which half is RECOVERABLE, not by
   which file is authoritative. The `rejectedPairs` entry drives
   `rejectedAgainst` -> the chip -> Undo; the `notLinkedTo` edge is invisible
   on its own, with no UI path to remove it. So: the pair is written FIRST and
   removed LAST; the edge is created after it and destroyed before it. POST
   therefore writes pair-then-edge, DELETE writes edge-then-pair, and BOTH
   fail into the same visible state (pair present, edge absent) which the chip
   exposes, a retry completes, and reject-edge-reconcile.ts heals at the next
   authoritative persist. This REPLACES the earlier "cast.json first,
   unconditionally, on BOTH verbs" rule: that symmetry is exactly what
   produced the asymmetric outcome, because the two verbs move in opposite
   directions. Do not re-symmetrise them.

   Both of POST's writes are fatal. Their 500 messages differ deliberately: a
   pair-write failure means NOTHING was written; a cast-write failure means the
   rejection is durable and only the link is missing. Retry is safe after
   either — `rejectOrphanedPair` returns early on an existing pair and
   `appendNotLinked`/`removeNotLinked` are idempotent.

   I5 (fix round 1) still applies to DELETE: its notLinkedTo removal is
   unconditional and first, so its 500 messages must not claim "nothing else
   was changed".

   POST's id-history writes (fix round 2 review; REORDERED again, fix
   round 1 I1): `rejectOrphanedPair` runs FIRST, `forgetSupersededId`
   SECOND — the reverse of this route's original order.
   `rejectOrphanedPair` is FATAL — for the two normalised tiers, where all
   188 currently-real orphaned segments live, `rejectedPairs` is the ONLY
   thing that enforces the reject; a swallowed write failure there would
   report success to the user while the reject stayed purely cosmetic at
   render time, the exact silent-wrong-outcome shape #2040 exists to
   eliminate. Its failure is surfaced as a 500. `forgetSupersededId` stays
   non-fatal FOR A DISK FAULT (mirroring cast-merge.ts's `retireCharacterId`
   precedent: the side-table is never authoritative for identity, and the
   pair-scoped `rejectedPairs` write already durably blocks resolution
   regardless of whether the now-redundant `supersededBy` entry ever actually
   gets cleared) — but NOT for a `LockAcquisitionTimeoutError` (#2292, owner
   decision), which is now a 500. That one exception exists because the
   leftover DOES NOT SELF-HEAL: no analysis pass prunes a `supersededBy` entry
   whose key is a non-live orphan and whose target is live. See the handler's
   own comment for the trace and for why re-POSTing (not a later analysis) is
   the remediation.

   I1 (fix round 1): the ORIGINAL order was forget-then-reject, which made
   this module's own "POST is safe to retry on that 500" claim FALSE for
   the stash specifically. If forget succeeded (removing
   `supersededBy[orphanedId]` and returning it) and `rejectOrphanedPair`
   then threw, a retry re-read history AFTER the forget had already
   landed, so the retry's own guard
   (`historyBeforeForget.supersededBy[orphanedId] === characterId`) was now
   false — `forgotSupersededTo` came back `undefined` on the retry, and the
   pair got durably written WITHOUT the stash. A later Undo would then have
   nothing to restore, silently breaking the #2089 lossless-undo bar with
   no error ever surfaced. Reordering closes this: `forgotSupersededTo` is
   computed once, by a pure READ before any write, and threaded straight
   into `rejectOrphanedPair` so the stash is baked into the FIRST (fatal)
   write; `forgetSupersededId` — now purely a best-effort tidy-up of an
   entry `rejectedPairs` has already made redundant for resolution
   purposes — runs only AFTER that write has durably landed. A retry that
   never gets past the fatal step re-reads the stash fresh from disk every
   time, since nothing has been forgotten yet on that attempt.

   DELETE's id-history side is now (#2198) a SINGLE batched write via
   `undoRejectedPairs` — restore-then-pair-removal is applied to every
   governing pair against one in-memory `history`, then written once. This
   replaces the pre-#2198 shape of two separate loops, each primitive taking
   its own lock/read/write: pair 1's restore fully landing already moved
   `supersededBy[pair1.from]`, and a LATER pair's write throwing then left
   that move in place while `rejectedPairs` still held every pair — a retry's
   own `rejectedPairsGoverning` computed against the now-moved `supersededBy`
   could stop seeing pairs it had not gotten to yet, going permanently blind
   to work still owed (the bug #2198 fixes). A single `writeJsonAtomic` makes
   the whole batch all-or-nothing instead: a mid-batch failure leaves
   cast-id-history.json byte-identical to before this call, so a retry sees
   exactly the same governing pairs it saw the first time.

   The restore itself still doesn't reuse `retireCharacterId` (C1, fix round
   1): see `restoreSupersededId`'s own doc comment in `cast-id-history.ts` for
   why `retireCharacterId`'s unconditional-write-plus-repoint semantics can
   themselves reproduce #2040's own failure mode when a LATER, unrelated
   re-analysis has since recorded the CORRECT alias for `orphanedId` —
   exactly the overwrite-and-repoint `restoreSupersededId` (and
   `undoRejectedPairs`, sharing its applier) refuses to perform. When a
   restore is skipped for that reason, the pair is still removed within the
   same batched write (the user asked to undo the REJECTION, which succeeds
   regardless — the alias restore is a best-effort bonus on top, not the
   primary consequence of Undo) and the response says so via
   `supersededByOther`, so the client can tell the user the alias moved on
   rather than silently doing nothing. The batched write stays fatal on a
   genuine I/O failure (unlike POST's non-fatal forget): losing it breaks the
   #2089 lossless-undo bar (`resolve(orphanedId)` after DELETE must equal what
   it returned before the original POST, MODULO a since-superseded alias,
   which is the one case DELETE is no longer trying to reproduce exactly —
   see C1). The cast.json edge removal above it is unconditional and already
   landed by the time this write is attempted (I5, below), so a failure here
   is retry-safe: the pair (and its `forgotSupersededTo`) is untouched on
   disk, and a retry re-reads it fresh.

   #2161 — the same skip-and-report shape as C1's `supersededByOther`, for a
   second refusal case: `undoRejectedPairs` is passed this handler's own
   `cast.characters` (read above, before any write) as the live roster, and
   refuses to write a `forgotSupersededTo` that no longer names a live id —
   the dangling-`supersededBy`-target hazard #2110 closed, reopened one door
   over by a stale Undo stash. Surfaced via the response's `targetNotLive`,
   not thrown: same reasoning as C1, the pair removal is Undo's primary
   consequence and still happens regardless.

   Important 1/2 (review round 2): DELETE used to find "the" pair by a raw
   `p.from === orphanedId && p.to === characterId` match. Round 1 made the
   READ side (`collectOrphanedCharacterFallbacks`, segments-io.ts) show a
   chip whenever a pair matched EITHER the raw `from` or its normalised
   form — but DELETE still matched raw only, so a chip shown because of a
   normalised-tier collision under a DIFFERENT raw spelling (the repo's own
   `the_torment`/`The-Torment` shape) offered an Undo the route could never
   actually find: 200, `wasRejected: false`, disk unchanged, the chip
   returns on the next hydrate. Both sides now call ONE shared function,
   `rejectedPairsGoverning` (`cast-resolve.ts`) — not two implementations
   that happen to agree — which is also narrower than round 1's plain
   union: it reports a normalised match only when this id's resolution
   actually goes through the normalised-id/normalised-history tier (see its
   own doc comment), closing a SECOND bug round 2 found in the same spot: a
   segment resolving cleanly through tier 2 (raw `supersededBy`) could pick
   up a chip — and have its reject button wrongly disabled — from an
   unrelated pair that only matched after normalising a different raw
   spelling. A pair `rejectedPairsGoverning` returns can carry a DIFFERENT
   `from` than `orphanedId`; every id-history and notLinkedTo write below
   uses the pair's OWN `from`, since that is the raw spelling the original
   POST actually wrote under, not necessarily this row's current one. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';
import {
  forgetSupersededId,
  rejectOrphanedPair,
  undoRejectedPairs,
  loadCastIdHistory,
} from '../store/cast-id-history.js';
import { buildCastResolver, rejectedPairsGoverning } from '../store/cast-resolve.js';
import { isLockAcquisitionTimeout } from '../workspace/file-lock.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castRejectOrphanRouter = Router();

type PersistedCharacter = CharacterOutput & { voiceId?: string };
interface CastFile {
  characters: PersistedCharacter[];
}

interface RejectOrphanMatchBody {
  orphanedId?: unknown;
}

/** How `orphanedId` resolves against the live cast + id history, computed
    AFTER this route's writes have landed. `null` when it doesn't resolve at
    all — the ordinary POST outcome (the pair-scoped block the route just
    wrote applies), and also possible after DELETE if `orphanedId` genuinely
    has nothing left to resolve onto. Non-null after DELETE is the lossless-
    undo happy path; non-null after POST would mean some OTHER, unblocked
    tier still resolves `orphanedId` onto a different live character — not a
    bug, just informative (D3: this endpoint has no branch that hides it). */
type ResolutionTier = 'exact' | 'history' | 'normalised-id' | 'normalised-history';

interface RejectOrphanMatchResponse {
  characterId: string;
  orphanedId: string;
  /** True when the notLinkedTo edge was already present (idempotent
      re-reject) — the cast.json write was a no-op, but the pair rejection
      is still (re-)recorded. */
  alreadyPresent: boolean;
  resolution: ResolutionTier | null;
  resolvedCharacterId?: string;
}

interface UndoRejectOrphanMatchResponse {
  characterId: string;
  orphanedId: string;
  /** True when the `(orphanedId, characterId)` pair was present before this
      call (i.e. there was something to undo). False on a repeat/idempotent
      DELETE. */
  wasRejected: boolean;
  resolution: ResolutionTier | null;
  resolvedCharacterId?: string;
  /** Round 3 (#2092/#2089 review round 3, I-B/M-6) — the raw `from` id(s) of
      every `rejectedPairs` entry this DELETE actually removed, i.e.
      `matchingPairs.map(p => p.from)` deduped. Always present (possibly
      empty). This is the THIRD consumer of `rejectedPairsGoverning`'s
      raw-`from` key the round exists to unify: the read side keys the
      banner chip off it, this route's write side already keyed the
      `notLinkedTo` removal and the `supersededBy` restore off it
      (`matchingPairs`, above) — but until now the RESPONSE never echoed it,
      so the client had no correct value to mirror its own `notLinkedTo`
      removal onto and fell back to `orphanedId` (the row's own raw id),
      which can legitimately differ from a governing pair's `from` (the
      `the_torment`/`The-Torment` shape `rejectedPairsGoverning` exists to
      handle) — leaving a stale edge in redux no later hydrate could correct
      (`cast-slice.ts`'s merge prefers a truthy EXISTING `notLinkedTo` over
      the server's own value). Also closes M-6: a row governing more than
      one pair removes ALL of them (and their `notLinkedTo` edges) in one
      Undo click — necessary, since the resolver treats every one of those
      spellings as the same normalised block — but previously nothing in
      the response, the log line below, or the toast said so; naming every
      removed `from` here is what lets the client render an honest toast
      and the log line name them all. */
  removedFrom: string[];
  /** C1 (fix round 1) — set when a pair had a `forgotSupersededTo` to
      restore but the restore was SKIPPED because `supersededBy[<that pair's
      from>]` already points somewhere else (a later, unrelated re-analysis
      recorded a different, presumably-correct alias since the original
      reject). Each entry is that alias's current target. `resolution`/
      `resolvedCharacterId` above already reflect the real post-undo truth
      regardless of this field — this exists purely so the client can
      explain to the user WHY the alias didn't visibly change, instead of it
      reading as Undo having silently done nothing. Round 3 (M-7) — an
      ARRAY, not a single string: when a row governs more than one pair
      (M-6, above) and more than one of them skips its restore, round 1's
      single field only ever surfaced the LAST one, silently dropping the
      others from both the response and the toast. Absent (never an empty
      array) when nothing was skipped: nothing to restore, or every restore
      that was attempted succeeded. */
  supersededByOther?: string[];
  /** #2161 — same shape/reasoning as `supersededByOther` just above, for the
      sibling refusal case: set when a pair had a `forgotSupersededTo` to
      restore but the restore was SKIPPED because that target has quietly
      stopped being a live cast id since the original reject (the #2110
      hazard, reopened through a stale stash — see
      `applyRestoreSupersededId`'s doc comment in `cast-id-history.ts`).
      Each entry is the dead target id. Absent (never an empty array) when
      nothing was skipped for this reason. */
  targetNotLive?: string[];
}

castRejectOrphanRouter.post(
  '/:bookId/cast/:characterId/reject-orphan-match',
  async (req: Request, res: Response<RejectOrphanMatchResponse | { error: string }>) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as RejectOrphanMatchBody;
    const orphanedId = typeof body.orphanedId === 'string' ? body.orphanedId.trim() : '';

    if (!bookId || !characterId || !orphanedId) {
      return res.status(400).json({
        error: 'bookId (path), characterId (path), and orphanedId are required.',
      });
    }
    /* Fix round 2 review finding 4 — mirrors cast-not-linked-to.ts's self-pair
       400. Without this, characterId === orphanedId would write a self
       notLinkedTo edge that remapFreshToPriorIds' notLinkedToId would later
       honour and use to refuse a legitimate future by-name remap of this
       character onto itself (a no-op that can never fire correctly, since a
       row is never remapped onto its own id) — a dead, misleading edge with
       no benefit. */
    if (characterId === orphanedId) {
      return res.status(400).json({ error: 'characterId and orphanedId must differ (self-pair).' });
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: `Book "${bookId}" not found.` });
    const { bookDir } = located;

    /* #1981 — the read is inside the lock; the 409/404 checks and the
       notLinkedTo mutation below are all decisions derived from it. The
       id-history writes (forgetSupersededId / rejectOrphanedId) are a
       DIFFERENT file — the cast lock doesn't cover them, they're just along
       for the ride inside this span, mirroring cast-merge.ts's
       retireCharacterId precedent. */
    return withCastLock(bookDir, async () => {
      const cast = await readJson<CastFile>(castJsonPath(bookDir));
      if (!cast?.characters?.length) {
        return res.status(409).json({
          error: 'Book has no cast on disk yet. Run analysis before rejecting a match.',
        });
      }
      const character = cast.characters.find((c) => c.id === characterId);
      if (!character) {
        return res.status(404).json({ error: `Character "${characterId}" not found.` });
      }

      /* #2166 — the pair is written FIRST and the edge second. Rationale in
         the module doc; the short version is that the `rejectedPairs` entry
         is what renders the chip and powers Undo, so a half-failure must
         leave THAT half, never the invisible one. */
      const historyBeforeReject = await loadCastIdHistory(bookDir);
      const forgotSupersededTo =
        historyBeforeReject.supersededBy[orphanedId] === characterId
          ? historyBeforeReject.supersededBy[orphanedId]
          : undefined;

      try {
        await rejectOrphanedPair(bookDir, orphanedId, characterId, forgotSupersededTo);
      } catch (rejectErr) {
        console.error(
          '[cast-reject-orphan] failed to record the rejection in cast-id-history.json — surfacing as a failure',
          rejectErr,
        );
        return res.status(500).json({
          error:
            'Failed to durably record the rejection. Retry — nothing was written, so a retry starts clean.',
        });
      }

      /* #2166 — FATAL, where it used to be an unguarded throw into
         errorHandler. The pair above has landed, so the rejection IS durably
         recorded and the chip will render; only the name-match suppression is
         missing, and the next analysis reconciles it (reject-edge-reconcile.ts).
         Retry is safe: `appendNotLinked` is idempotent by construction and
         `rejectOrphanedPair` returns early on an existing pair. */
      const changed = appendNotLinked(character, bookId, orphanedId);
      if (changed) {
        try {
          /* Preserves sibling top-level keys on cast.json (dbcf36c5's fix at
             not-linked-edges.ts:92, same defect, same shape here) — `{
             characters: cast.characters }` would silently drop anything else
             on the object `cast` was read as. */
          await writeJsonAtomic(castJsonPath(bookDir), { ...cast });
        } catch (castErr) {
          console.error(
            '[cast-reject-orphan] failed to write the notLinkedTo edge to cast.json — surfacing as a failure',
            castErr,
          );
          return res.status(500).json({
            error:
              'The rejection was recorded, but saving the character link failed. Retry — the rejection is already durable.',
          });
        }
      }

      /* Non-fatal, and now runs AFTER the durable write above (I1) — see the
         module doc's I1 paragraph. A stale `supersededBy` entry left behind
         here is redundant-but-harmless for RESOLUTION purposes, since
         `rejectedPairs` (already written, above) independently blocks it;
         this is now purely a best-effort tidy-up, not something the stash's
         durability depends on. `expectedTarget: forgotSupersededTo` (review
         round 2 "Also fix") closes the race the reorder opened: a concurrent
         `retireCharacterId` between the read above and this call could have
         repointed `supersededBy[orphanedId]` onto something else entirely,
         and an unconditional delete would discard THAT instead of the value
         actually stashed on the pair — forget only fires when the value
         hasn't moved since the read. */
      /* #2292 (owner decision) — a `LockAcquisitionTimeoutError` on the forget
         is NOT non-fatal, because the leftover it leaves behind DOES NOT SELF-
         HEAL. Traced, not assumed: the entry it fails to delete is
         `supersededBy[orphanedId] = characterId`, and the only two passes that
         ever prune `supersededBy` key on the opposite conditions —
         `dropSupersededIdsReclaimedByLiveCast` drops an entry whose KEY became
         live (an orphaned id is by definition not a cast row) and
         `dropSupersededTargetsNoLongerLive` drops one whose TARGET died
         (`characterId` is the live row this route just validated). Neither
         fires. `reconcileRejectEdgesOnDisk` — what heals `cast-link-orphan`'s
         stale `notLinkedTo` edge, and the reason THAT route can answer "the
         next analysis clears it" — READS this file (`analysis.ts:386`, via
         `loadCastIdHistoryWithStatus`) but only ever REWRITES cast.json's
         edges, so it never removes a `supersededBy` entry either. (An earlier
         version of this said it "never opens this file", which is simply
         false; the load-bearing half is the write, not the read.) So the entry
         survives every future analysis, and saying nothing would be promising
         a cleanup that never comes.

         Deferred, in the shape the six identity sites use: parked in a `let`
         so nothing after it is skipped, acted on once the handler has closed.
         There happens to be no write after it today; the shape is what keeps
         that true if one is ever added between.

         A disk fault keeps its old best-effort treatment exactly — an EPERM
         here is transient and the entry is redundant for RESOLUTION anyway
         (`rejectedPairs`, already durably written above, blocks the alias
         regardless), so failing the request over one would be the regression
         this discrimination exists to avoid. */
      let forgetLockTimeout: unknown;
      if (forgotSupersededTo !== undefined) {
        try {
          await forgetSupersededId(bookDir, orphanedId, forgotSupersededTo);
        } catch (forgetErr) {
          if (isLockAcquisitionTimeout(forgetErr)) {
            forgetLockTimeout = forgetErr;
          } else {
            console.warn(
              '[cast-reject-orphan] failed to forget stale supersededBy entry (non-fatal)',
              forgetErr,
            );
          }
        }
      }
      if (forgetLockTimeout !== undefined) {
        console.error(
          '[cast-reject-orphan] the rejection WAS recorded; clearing the stale supersededBy entry timed out',
          forgetLockTimeout,
        );
        /* The remediation named here is the one that actually works, which is
           the trap `cast-link-orphan`'s message fell into twice. Re-POSTing
           this exact request re-reads the stash from disk (`forgotSupersededTo`
           is still `characterId`, because the forget never landed),
           `rejectOrphanedPair` returns early on the pair it already wrote —
           no duplicate, and the stash on it is untouched — and the forget is
           attempted again. So "retry this same action" ends with the entry
           gone and a 200, which is exactly what it promises.

           Round 5 scoping — the closing clause used to read "no later analysis
           will clear it for you", which is stronger than the trace supports.
           Two later-analysis paths CAN clear this entry, both off the ordinary
           track: `dropSupersededIdsReclaimedByLiveCast` fires if a later
           analysis re-mints `orphanedId` as a LIVE cast row (not exotic —
           analyzer `characterId`s are LLM free text, so an id can come back),
           and `dropSupersededTargetsNoLongerLive` fires if `characterId` later
           leaves the roster. Neither is something a user can rely on or ask
           for, so the remediation is unchanged and the 500 is still right;
           only the promise is scoped down to what is actually true. */
        return res.status(500).json({
          error:
            'The rejection was recorded and is durable — the chip will render and Undo still works. ' +
            'What did not finish is clearing the stale alias that pointed this id at the character, ' +
            'because another operation held the lock too long. Retry this same action to finish it — ' +
            'a later analysis almost certainly will not.',
        });
      }

      const resolution = await resolveOrphanedId(bookDir, cast.characters, orphanedId);

      console.log(
        `[cast-reject-orphan] book=${bookId} rejected "${orphanedId}" as ${characterId}` +
          (changed ? '' : ' (notLinkedTo edge already present)'),
      );

      return res.json({
        characterId,
        orphanedId,
        alreadyPresent: !changed,
        resolution: resolution?.via ?? null,
        resolvedCharacterId: resolution?.character.id,
      });
    });
  },
);

/* DELETE /api/books/:bookId/cast/:characterId/reject-orphan-match
   (#2092/#2089, D5) — undo the POST above. Same path + body shape
   (`{ orphanedId }`) deliberately, so the frontend's Undo control is a
   trivial mirror of the reject call it's undoing.

   Does NOT reuse `cast-not-linked-to.ts`'s DELETE — that route hard-400s a
   same-book pair (`sourceBookId === otherBookId`) and is series-mate gated,
   so it can never serve this same-book, one-sided edge. `removeNotLinked`
   below is this route's own local copy, exactly as POST keeps its own local
   `appendNotLinked` for the same reason. */
castRejectOrphanRouter.delete(
  '/:bookId/cast/:characterId/reject-orphan-match',
  async (req: Request, res: Response<UndoRejectOrphanMatchResponse | { error: string }>) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as RejectOrphanMatchBody;
    const orphanedId = typeof body.orphanedId === 'string' ? body.orphanedId.trim() : '';

    if (!bookId || !characterId || !orphanedId) {
      return res.status(400).json({
        error: 'bookId (path), characterId (path), and orphanedId are required.',
      });
    }
    if (characterId === orphanedId) {
      return res.status(400).json({ error: 'characterId and orphanedId must differ (self-pair).' });
    }

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: `Book "${bookId}" not found.` });
    const { bookDir } = located;

    /* #1981 Task 12 (static guard, caught by the merge with the cast-lock
       sweep): this DELETE does a cast.json read-modify-write just like the
       POST above, so it takes the same per-book lock. It was written before
       withCastLock existed and the guard test is what surfaced it. */
    return withCastLock(bookDir, async () => {
      const cast = await readJson<CastFile>(castJsonPath(bookDir));
      if (!cast?.characters?.length) {
        return res.status(409).json({
          error: 'Book has no cast on disk yet.',
        });
      }
      const character = cast.characters.find((c) => c.id === characterId);
      if (!character) {
        return res.status(404).json({ error: `Character "${characterId}" not found.` });
      }

      /* Important 1/2 (review round 2) — find the pair(s) this row's chip was
         ACTUALLY derived from, via `rejectedPairsGoverning`, the SAME shared
         helper the read side (`collectOrphanedCharacterFallbacks`,
         segments-io.ts) uses to decide whether to show a chip at all. A
         raw-exact match here (round 1's approach) misses a chip that was
         shown because of a normalised-tier collision under a DIFFERENT raw
         spelling (the repo's own `the_torment`/`The-Torment` shape) — the
         DELETE the UI sends for that row would 200 with `wasRejected: false`,
         leave disk unchanged, and the chip would return on the next hydrate.
         See `rejectedPairsGoverning`'s own doc comment for the two-rule
         reasoning. A pair found this way can carry a DIFFERENT `from` than
         `orphanedId` (the row's own raw id) — every id-history and
         notLinkedTo operation below uses the PAIR's own `from`, not
         `orphanedId`, since that is the raw spelling the original POST
         actually wrote under. Round 3 — `rejectedPairsGoverning` now takes
         `(cast, history)` directly and builds its own ignoring-resolver
         internally, so this route no longer builds one itself (see the
         helper's own doc comment for why: it closes M-1, a legacy `rejected`
         block getting mis-attributed to an unrelated pair, and makes passing
         the wrong resolver structurally unrepresentable at this call site). */
      const historyBeforeUndo = await loadCastIdHistory(bookDir);
      const governingPairs = rejectedPairsGoverning(orphanedId, cast.characters, historyBeforeUndo);
      const matchingPairs = governingPairs.filter((p) => p.to === characterId);
      const wasRejected = matchingPairs.length > 0;

      /* Same-book removal, keyed on THIS book's id (trap: the matchers on the
         write side ignore `bookId`, which tempts filtering on `characterId`
         alone — that would collaterally delete a cross-book edge written by
         cast-not-linked-to.ts for an unrelated pair that merely shares this
         orphanedId string) — and on each matching pair's OWN `from`, not
         `orphanedId`: the notLinkedTo edge was written using the pair's
         `from` at reject time (always the row that was actually clicked
         then), which the current row's raw id need not match. */
      let changed = false;
      for (const pair of matchingPairs) {
        if (removeNotLinked(character, bookId, pair.from)) changed = true;
      }
      /* #2133 fold finding A — the abandoned-half-write path: POST's
         `appendNotLinked` can land (writing `{bookId, characterId:
         orphanedId}` onto this character) and then `rejectOrphanedPair`
         500s before the pair itself ever reaches `rejectedPairs`. If the
         user never retries, `governingPairs`/`matchingPairs` above are
         permanently empty for this `(orphanedId, characterId)` — there is
         no pair to loop over, so the edge above never gets cleared. Per the
         same "a reject's two writes are created together and must be
         destroyed together" invariant (`docs/features/
         278-cast-character-identity.md`), clear this edge unconditionally,
         by `orphanedId` directly rather than any pair's `from` — safe even
         when `matchingPairs` already covered it (removeNotLinked is
         idempotent, and a same-book `notLinkedTo` entry can only ever be
         one this route itself wrote; cast-not-linked-to.ts's DELETE 400s on
         a same-book pair, so it never writes this shape).

         What this closes, precisely (I3, fix round, #2163): this endpoint
         now clears the edge for ANY caller that reaches it with the right
         `(bookId, characterId, orphanedId)` triple — that part is real and
         tested. What it does NOT do is give the UI a way to reach it in
         the abandoned-half-write state itself: no chip renders for this
         row (`OrphanRejectedChips` only renders off `info.rejectedAgainst`,
         itself derived from `rejectedPairsGoverning`, which is empty here
         by construction — there is no `rejectedPairs` entry to find), so
         nothing on `src/views/cast.tsx` ever issues this DELETE for it.
         The stranded edge stays invisible until some other pair-scoped
         reject/undo on the same row happens to clear it as a side effect,
         or until it's found by hand. Deciding how to surface an invisible
         stranded edge (a new banner affordance? a raw-id admin action?) is
         a UI design call this fix round deliberately does not make — see
         `docs/features/278-cast-character-identity.md`'s invariant 10 for
         the recorded residual. */
      if (removeNotLinked(character, bookId, orphanedId)) changed = true;
      if (changed) {
        // Preserves sibling top-level keys on cast.json — see the POST
        // handler's identical write above for the fix reference (dbcf36c5).
        await writeJsonAtomic(castJsonPath(bookDir), { ...cast });
      }

      /* #2198 — a single BATCHED call, not two separate loops each taking
         their own lock/read/write. The pre-fix shape (loop 1: restore every
         pair's alias; loop 2: remove every pair) was four-plus independent
         writes with no transaction across them: pair 1's restore fully
         landing already moves `supersededBy[pair1.from]`, and a LATER pair's
         write throwing left that move in place while `rejectedPairs` still
         held every pair — so a retry's own `rejectedPairsGoverning` computed
         against the now-moved `supersededBy` could stop seeing pairs it had
         not gotten to yet, going permanently blind to work still owed. A
         single `writeJsonAtomic` (temp-file-plus-rename) makes the whole
         batch all-or-nothing, so a mid-batch failure leaves the file
         byte-identical to before this call and a retry sees exactly what it
         saw the first time. See `undoRejectedPairs`'s own doc comment in
         `cast-id-history.ts`.

         C1 (fix round 1, Critical), preserved exactly: the batched restore
         is `restoreSupersededId`'s semantics, never `retireCharacterId`'s —
         it does NOT overwrite a NEWER alias a later re-analysis recorded
         since the original reject. When a restore is skipped for that
         reason, the pair's removal still happens (the user asked to undo the
         REJECTION, which succeeds regardless) and the result says so via
         `supersededByOther`.

         Round 3 (M-7), preserved exactly: accumulated into an ARRAY — a row
         governing two pairs that both skip reports BOTH skipped targets, not
         just the last one.

         #2161 — `cast.characters` (read above, before this write) is passed
         as the live roster `undoRejectedPairs` checks each restore's target
         against: a `forgotSupersededTo` naming an id no longer in this list
         is refused rather than written back, closing the dangling-target
         window a stale restore could otherwise reopen (#2110's hazard, one
         door over). */
      let undoResults;
      try {
        undoResults = await undoRejectedPairs(
          bookDir,
          matchingPairs,
          cast.characters.map((c) => c.id),
        );
      } catch (undoErr) {
        console.error(
          '[cast-reject-orphan] failed to undo the rejection in cast-id-history.json — surfacing as a failure',
          undoErr,
        );
        return res.status(500).json({
          /* Collapses the two prior 500 branches (restore-fatal,
             pair-removal-fatal) into one — both described a partial write
             that the batched primitive can no longer produce. Accurate for
             the new behaviour: nothing in cast-id-history.json changed (the
             batch is all-or-nothing), and the cast.json edge removal above
             it already landed (I5, unconditional and first). */
          error:
            'Failed to durably undo the rejection. Nothing in cast-id-history.json changed — retry. The character link removal, if any, was already saved.',
        });
      }

      const supersededByOthers: string[] = [];
      const targetsNotLive: string[] = [];
      matchingPairs.forEach((pair, i) => {
        const result = undoResults[i];
        if (!result.restored && result.supersededByOther !== undefined) {
          supersededByOthers.push(result.supersededByOther);
          console.log(
            `[cast-reject-orphan] (undo) book=${bookId} skipped restoring "${pair.from}" -> ` +
              `"${pair.forgotSupersededTo}" — a newer alias to "${result.supersededByOther}" already exists`,
          );
        }
        if (!result.restored && result.targetNotLive && pair.forgotSupersededTo !== undefined) {
          targetsNotLive.push(pair.forgotSupersededTo);
          console.log(
            `[cast-reject-orphan] (undo) book=${bookId} skipped restoring "${pair.from}" -> ` +
              `"${pair.forgotSupersededTo}" — "${pair.forgotSupersededTo}" is no longer a live cast id (#2161)`,
          );
        }
      });

      const resolution = await resolveOrphanedId(bookDir, cast.characters, orphanedId);

      /* Round 3 (M-6) — deduped, and names every removed spelling when the
         row governed more than one, instead of only ever naming `orphanedId`
         (which, per `rejectedPairsGoverning`, need not be any pair's own
         `from`). */
      const removedFrom = [...new Set(matchingPairs.map((p) => p.from))];
      console.log(
        `[cast-reject-orphan] (undo) book=${bookId} un-rejected "${orphanedId}" as ${characterId}` +
          (wasRejected
            ? removedFrom.length > 1
              ? ` — removed ${removedFrom.length} pairs: ${removedFrom.map((f) => `"${f}"`).join(', ')}`
              : ''
            : ' (pair already absent)'),
      );

      /* Round 4 review, cheap 6 — deduped like `removedFrom` above: two
         skipped restores can legitimately land on the SAME newer alias (two
         differently-spelled pairs both stashed the same forgotten target,
         both since superseded by the same fresher one), and without this the
         client would render that alias's name twice ("Narrator" / "Narrator"). */
      const supersededByOther = [...new Set(supersededByOthers)];
      const targetNotLive = [...new Set(targetsNotLive)];
      return res.json({
        characterId,
        orphanedId,
        wasRejected,
        resolution: resolution?.via ?? null,
        resolvedCharacterId: resolution?.character.id,
        removedFrom,
        supersededByOther: supersededByOther.length ? supersededByOther : undefined,
        targetNotLive: targetNotLive.length ? targetNotLive : undefined,
      });
    });
  },
);

/** Resolve `orphanedId` against the live cast + the CURRENT (post-write)
    cast-id-history.json — a fresh load, not whatever was in scope earlier in
    the handler, since both POST and DELETE call this only after their own
    writes have landed. Shared by both verbs so the response shape (and the
    reasoning behind it, in the module doc comment) stays identical for
    "what does orphanedId resolve to now". */
async function resolveOrphanedId(
  bookDir: string,
  characters: ReadonlyArray<{ id: string }>,
  orphanedId: string,
) {
  const history = await loadCastIdHistory(bookDir);
  return buildCastResolver(characters, history).resolve(orphanedId);
}

/* Append the (bookId, orphanedId) entry to `character.notLinkedTo` in place.
   Returns true when the write changed the array, false when the entry was
   already present — mirrors `cast-not-linked-to.ts`'s helper of the same
   shape, kept as its own small copy here (rather than imported) because that
   module's version is private and this route's semantics differ slightly
   (one-sided, no symmetric other-book write). */
function appendNotLinked(character: PersistedCharacter, bookId: string, orphanedId: string): boolean {
  const existing = character.notLinkedTo ?? [];
  if (existing.some((p) => p.bookId === bookId && p.characterId === orphanedId)) {
    return false;
  }
  character.notLinkedTo = [...existing, { bookId, characterId: orphanedId }];
  return true;
}

/* Remove the (bookId, orphanedId) entry from `character.notLinkedTo` in
   place. Returns true when the write changed the array, false when the
   entry was already absent (keeps the disk write fully idempotent) — the
   DELETE-side mirror of `appendNotLinked` above, same reasoning for being a
   local copy rather than reusing `cast-not-linked-to.ts`'s version. */
function removeNotLinked(character: PersistedCharacter, bookId: string, orphanedId: string): boolean {
  const existing = character.notLinkedTo ?? [];
  const next = existing.filter((p) => !(p.bookId === bookId && p.characterId === orphanedId));
  if (next.length === existing.length) return false;
  character.notLinkedTo = next;
  return true;
}
