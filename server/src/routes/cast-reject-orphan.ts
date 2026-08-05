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

   cast.json (the notLinkedTo edge) is written first on both verbs — it's
   the authoritative record (spec §4.1) and the write cast-merge.ts's own
   precedent orders first. The id-history writes are NOT treated alike (fix
   round 2 review, POST): `forgetSupersededId` stays non-fatal, mirroring
   cast-merge.ts's `retireCharacterId` precedent (the side-table is never
   authoritative for identity, so losing a stale alias entry degrades to
   today's behaviour — the pair-scoped `rejectedPairs` write, next, still
   durably blocks resolution regardless). `rejectOrphanedPair` does NOT —
   for the two normalised tiers, where all 188 currently-real orphaned
   segments live, `rejectedPairs` is the ONLY thing that enforces the
   reject; a swallowed write failure there would report success to the user
   while the reject stayed purely cosmetic at render time, the exact
   silent-wrong-outcome shape #2040 exists to eliminate. Its failure is
   surfaced as a 500 instead. POST is safe to retry on that 500: the
   notLinkedTo write already happened (or was already idempotent), and
   `appendNotLinked`/`rejectOrphanedPair` are both no-ops on a repeat call
   once they've actually landed.

   DELETE's write order is the mirror image, but with the two id-history
   writes BOTH fatal (unlike POST's non-fatal `forgetSupersededId`): losing
   EITHER one breaks the #2089 lossless-undo bar (`resolve(orphanedId)`
   after DELETE must equal what it returned before the original POST).
   Skipping the restore leaves the alias tier unresolvable even though the
   reject that blocked it is gone; skipping the pair removal leaves the
   reject blocking resolution even though the caller asked to undo it. The
   restore runs BEFORE the pair removal specifically so a mid-way 500 stays
   retry-safe: the pair (and its `forgotSupersededTo`) is only actually
   consumed by `unrejectOrphanedPair` once the restore it depends on has
   already succeeded — a restore-then-fail retry just re-reads the
   still-present pair; a remove-then-fail-restore retry would have nothing
   left to read `forgotSupersededTo` from. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import {
  forgetSupersededId,
  rejectOrphanedPair,
  unrejectOrphanedPair,
  retireCharacterId,
  loadCastIdHistory,
} from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';
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

    const changed = appendNotLinked(character, bookId, orphanedId);
    if (changed) {
      await writeJsonAtomic(castJsonPath(bookDir), { characters: cast.characters });
    }

    /* Non-fatal (fix round 2 review — see the module doc's closing
       paragraph for why this one stays swallowed while rejectOrphanedPair
       below does not): a stale `supersededBy` entry left behind here is
       redundant-but-harmless for RESOLUTION purposes, since `rejectedPairs`
       (written next) independently blocks it — but it IS the value D6's
       lossless undo needs, so a failure here degrades DELETE to a partial
       (id-unblocked-but-alias-not-restored) undo rather than reporting
       failure now. */
    /* Pair-scope guard (#2092/#2089 D1) — only forget the existing
       `supersededBy[orphanedId]` entry when it targets THIS `characterId`.
       Under the old id-wide reject, forgetting unconditionally was harmless:
       ANY alias for `orphanedId` was about to be blocked by the id-wide
       `rejected` list regardless of its target, so there was nothing left
       to lose. Under pair scope that is no longer true — an entry pointing
       at some OTHER, unrejected character is a live, still-valid alias (D1's
       whole point is that a different target for the same `from` stays
       resolvable), and unconditionally deleting it here would silently
       destroy that unrelated resolution as a side effect of an unrelated
       reject. */
    const historyBeforeForget = await loadCastIdHistory(bookDir);
    let forgotSupersededTo: string | undefined;
    if (historyBeforeForget.supersededBy[orphanedId] === characterId) {
      try {
        forgotSupersededTo = await forgetSupersededId(bookDir, orphanedId);
      } catch (forgetErr) {
        console.warn(
          '[cast-reject-orphan] failed to forget stale supersededBy entry (non-fatal)',
          forgetErr,
        );
      }
    }

    /* FATAL, unlike the above (fix round 2 review, upgraded from non-fatal;
       unchanged by the pair-scope change): for the two normalised tiers —
       where all 188 currently-real orphaned segments live — `rejectedPairs`
       is the ONLY mechanism that enforces this reject. A swallowed failure
       here would report 200/success to the user while the reject stayed
       purely cosmetic at render time. */
    try {
      await rejectOrphanedPair(bookDir, orphanedId, characterId, forgotSupersededTo);
    } catch (rejectErr) {
      console.error(
        '[cast-reject-orphan] failed to record the rejection in cast-id-history.json — surfacing as a failure',
        rejectErr,
      );
      return res.status(500).json({
        error:
          'Failed to durably record the rejection. Retry — the character link update, if any, was already saved.',
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

    /* Same-book removal, keyed on THIS book's id (trap: the matchers on the
       write side ignore `bookId`, which tempts filtering on `characterId`
       alone — that would collaterally delete a cross-book edge written by
       cast-not-linked-to.ts for an unrelated pair that merely shares this
       orphanedId string). */
    const changed = removeNotLinked(character, bookId, orphanedId);
    if (changed) {
      await writeJsonAtomic(castJsonPath(bookDir), { characters: cast.characters });
    }

    /* Peek (read-only) for the pair's forgotSupersededTo BEFORE removing the
       pair — see the module doc's closing paragraph for why this ordering
       (restore, then remove) is what keeps a mid-way 500 retry-safe. */
    const historyBeforeUndo = await loadCastIdHistory(bookDir);
    const pairEntry = (historyBeforeUndo.rejectedPairs ?? []).find(
      (p) => p.from === orphanedId && p.to === characterId,
    );
    const wasRejected = pairEntry !== undefined;

    if (pairEntry?.forgotSupersededTo !== undefined) {
      try {
        await retireCharacterId(bookDir, orphanedId, pairEntry.forgotSupersededTo);
      } catch (restoreErr) {
        console.error(
          '[cast-reject-orphan] failed to restore the forgotten supersededBy entry during undo — surfacing as a failure',
          restoreErr,
        );
        return res.status(500).json({
          error: 'Failed to restore the forgotten alias entry. Retry — nothing else was changed.',
        });
      }
    }

    try {
      await unrejectOrphanedPair(bookDir, orphanedId, characterId);
    } catch (unrejectErr) {
      console.error(
        '[cast-reject-orphan] failed to remove the rejected pair from cast-id-history.json — surfacing as a failure',
        unrejectErr,
      );
      return res.status(500).json({
        error:
          'Failed to durably remove the rejection. Retry — the character link update and alias restore, if any, were already saved.',
      });
    }

    const resolution = await resolveOrphanedId(bookDir, cast.characters, orphanedId);

    console.log(
      `[cast-reject-orphan] (undo) book=${bookId} un-rejected "${orphanedId}" as ${characterId}` +
        (wasRejected ? '' : ' (pair already absent)'),
    );

    return res.json({
      characterId,
      orphanedId,
      wasRejected,
      resolution: resolution?.via ?? null,
      resolvedCharacterId: resolution?.character.id,
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
