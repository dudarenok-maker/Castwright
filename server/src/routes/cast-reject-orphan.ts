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
        (`rejectOrphanedId`) — checked by `buildCastResolver` ahead of ALL
        FOUR tiers, so it blocks re-resolution uniformly regardless of which
        tier would otherwise have matched. Any stale `supersededBy` entry
        naming `orphanedId` is also forgotten (`forgetSupersededId`) —
        redundant with `rejected` for resolution purposes, but leaves the
        history file honest rather than carrying a dead alias entry
        `rejected` merely shadows.
     2. A one-sided `notLinkedTo` edge is written onto the LIVE character
        (`:characterId`), naming `orphanedId`. This is what stops §4.4's
        NAME matcher (`remap-fresh-to-prior.ts`, `merge-analysis-cast.ts`)
        from re-recording the same match on the next re-analysis — id
        rejection alone doesn't touch name-based matching. One-sided is
        correct here (unlike the symmetric cross-book pair
        `cast-not-linked-to.ts` writes): the orphaned id has no cast row of
        its own, so there is no reciprocal side to write. Both of
        `remap-fresh-to-prior.ts`'s `notLinkedToId` and
        `merge-analysis-cast.ts`'s `groupHasNotLinkedEdge` match on
        `characterId` alone, ignoring `bookId`, so a same-book edge (this
        book's own `bookId`, naming the orphaned id as the "characterId")
        binds correctly even though `notLinkedTo` was designed for
        cross-book pairs.

   cast.json (the notLinkedTo edge) is written first — it's the authoritative
   record (spec §4.1) and the write cast-merge.ts's own precedent orders
   first. The id-history writes are wrapped in try/catch, same as
   cast-merge.ts's `retireCharacterId` call: the side-table is never
   authoritative for identity, so losing an entry degrades to today's
   behaviour, while losing the notLinkedTo edge would not. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
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

    /* Non-fatal, mirroring cast-merge.ts's retireCharacterId precedent — the
       side-table is never authoritative for identity (spec §4.1), so a
       write failure here degrades to today's behaviour rather than failing
       the whole reject. */
    try {
      await forgetSupersededId(bookDir, orphanedId);
      await rejectOrphanedId(bookDir, orphanedId);
    } catch (historyErr) {
      console.warn('[cast-reject-orphan] failed to record rejection in cast-id-history', historyErr);
    }

    console.log(
      `[cast-reject-orphan] book=${bookId} rejected "${orphanedId}" as ${characterId}` +
        (changed ? '' : ' (notLinkedTo edge already present)'),
    );

    return res.json({ characterId, orphanedId, alreadyPresent: !changed });
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
