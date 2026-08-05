/* POST /api/books/:bookId/cast/:characterId/reject-orphan-match  (#2040 Task 17)

   The orphaned-character-fallback banner (src/views/cast.tsx) shows two
   kinds of row: an id that AUTO-RECONCILED onto a live character through
   the id-history side-table or a normalised-key match, and an id that
   didn't resolve at all. Either way, the user can say "that's not the same
   character" — this route is what that action calls.

   Spec §4.6's own design ("rejecting removes the history entry") is a no-op
   on every book in the real workspace: buildCastResolver never consulted
   `notLinkedTo`, and every currently-affected id resolves through the
   NORMALISED tiers, which have no history entry to remove at all (zero
   cast-id-history.json files exist anywhere in the 20-book workspace as of
   Wave 3). So this route writes BOTH of the things that actually make a
   rejection durable:

     1. `orphanedId` is added to cast-id-history.json's `rejected` list
        (`rejectOrphanedId`) — checked by `buildCastResolver` ahead of the
        history / normalised-id / normalised-history tiers (fix round 1: NOT
        the `exact` tier — a live cast row with this exact id always wins,
        see `rejected`'s own doc comment on `CastIdHistory`), so it blocks
        re-resolution for every tier a truly orphaned id could otherwise
        match through. Any stale `supersededBy` entry naming `orphanedId` is
        also forgotten (`forgetSupersededId`) — redundant with `rejected` for
        resolution purposes, but leaves the history file honest rather than
        carrying a dead alias entry `rejected` merely shadows.
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

   cast.json (the notLinkedTo edge) is written first — it's the authoritative
   record (spec §4.1) and the write cast-merge.ts's own precedent orders
   first. The two id-history writes are NOT treated alike (fix round 2
   review): `forgetSupersededId` stays non-fatal, mirroring cast-merge.ts's
   `retireCharacterId` precedent (the side-table is never authoritative for
   identity, so losing a stale alias entry degrades to today's behaviour).
   `rejectOrphanedId` does NOT — for the two normalised tiers, where all 188
   currently-real orphaned segments live, `rejected` is the ONLY thing that
   enforces the reject (see point 1 above); a swallowed write failure there
   would report success to the user while the reject stayed purely cosmetic
   at render time, the exact silent-wrong-outcome shape #2040 exists to
   eliminate. Its failure is surfaced as a 500 instead. The route is safe to
   retry on that 500: the notLinkedTo write already happened (or was already
   idempotent), and `appendNotLinked`/`rejectOrphanedId` are both no-ops on
   a repeat call once they've actually landed. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { forgetSupersededId, rejectOrphanedId } from '../store/cast-id-history.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castRejectOrphanRouter = Router();

type PersistedCharacter = CharacterOutput & { voiceId?: string };
interface CastFile {
  characters: PersistedCharacter[];
}

interface RejectOrphanMatchBody {
  orphanedId?: unknown;
}

interface RejectOrphanMatchResponse {
  characterId: string;
  orphanedId: string;
  /** True when the notLinkedTo edge was already present (idempotent
      re-reject) — the cast.json write was a no-op, but the id-history
      rejection is still (re-)recorded. */
  alreadyPresent: boolean;
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

      const changed = appendNotLinked(character, bookId, orphanedId);
      if (changed) {
        await writeJsonAtomic(castJsonPath(bookDir), { characters: cast.characters });
      }

      /* Non-fatal (fix round 2 review — see the module doc's closing
         paragraph for why this one stays swallowed while rejectOrphanedId
         below does not): a stale `supersededBy` entry left behind here is
         redundant-but-harmless, since `rejected` (written next) independently
         blocks resolution through every tier that entry could have mattered
         for. */
      try {
        await forgetSupersededId(bookDir, orphanedId);
      } catch (forgetErr) {
        console.warn(
          '[cast-reject-orphan] failed to forget stale supersededBy entry (non-fatal)',
          forgetErr,
        );
      }

      /* FATAL, unlike the above (fix round 2 review, upgraded from non-fatal):
         for the two normalised tiers — where all 188 currently-real orphaned
         segments live — `rejected` is the ONLY mechanism that enforces this
         reject. A swallowed failure here would report 200/success to the user
         while the reject stayed purely cosmetic at render time. */
      try {
        await rejectOrphanedId(bookDir, orphanedId);
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

      console.log(
        `[cast-reject-orphan] book=${bookId} rejected "${orphanedId}" as ${characterId}` +
          (changed ? '' : ' (notLinkedTo edge already present)'),
      );

      return res.json({ characterId, orphanedId, alreadyPresent: !changed });
    });
  },
);

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
