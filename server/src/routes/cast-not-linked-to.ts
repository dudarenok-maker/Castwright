/* POST /api/books/:bookId/cast/:characterId/not-linked-to  (plan 101)

   "These two cross-book characters look like duplicates to the voices-view
   detector, but they ARE intentionally separate people (e.g. teenage
   Wren vs adult Wren)." Writes a symmetric pair record to BOTH books'
   cast.json so the duplicate-candidate predicate stops surfacing this
   pair on either side.

   Same series-scope guard as cast-link-prior.ts: same author + series,
   neither side standalone. Cross-series rejection is intentional — a
   global "ignore this pair forever" list is out of scope.

   Idempotent: if the pair is already present on either side, that side
   is a no-op; the other side still gets the write so both ends settle
   into agreement on retry. Self-pair (same book + same character id)
   is rejected with 400. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castNotLinkedToRouter = Router();

type PersistedCharacter = CharacterOutput & { voiceId?: string };
interface CastFile {
  characters: PersistedCharacter[];
}

interface NotLinkedToBody {
  otherBookId?: unknown;
  otherCharacterId?: unknown;
}

castNotLinkedToRouter.post(
  '/:bookId/cast/:characterId/not-linked-to',
  async (req: Request, res: Response) => {
    const sourceBookId = req.params.bookId;
    const sourceCharacterId = req.params.characterId;
    const body = (req.body ?? {}) as NotLinkedToBody;
    const otherBookId = typeof body.otherBookId === 'string' ? body.otherBookId.trim() : '';
    const otherCharacterId =
      typeof body.otherCharacterId === 'string' ? body.otherCharacterId.trim() : '';

    if (!sourceBookId || !sourceCharacterId || !otherBookId || !otherCharacterId) {
      return res.status(400).json({
        error: 'bookId (path), characterId (path), otherBookId, and otherCharacterId are required.',
      });
    }
    if (sourceBookId === otherBookId && sourceCharacterId === otherCharacterId) {
      return res.status(400).json({
        error: 'otherBookId + otherCharacterId must differ from the source (self-pair).',
      });
    }
    if (sourceBookId === otherBookId) {
      return res.status(400).json({
        error:
          'not-linked-to is for CROSS-book pairs; use cast/merge for same-book duplicates.',
      });
    }

    const sourceLocated = await findBookByBookId(sourceBookId);
    if (!sourceLocated)
      return res.status(404).json({ error: `Source book "${sourceBookId}" not found.` });
    const otherLocated = await findBookByBookId(otherBookId);
    if (!otherLocated)
      return res.status(404).json({ error: `Other book "${otherBookId}" not found.` });

    if (
      sourceLocated.state.author !== otherLocated.state.author ||
      sourceLocated.state.series !== otherLocated.state.series ||
      sourceLocated.state.isStandalone === true ||
      otherLocated.state.isStandalone === true
    ) {
      return res.status(404).json({
        error: 'Other book is not a series-mate of the source book.',
      });
    }

    const sourceCast = await readJson<CastFile>(castJsonPath(sourceLocated.bookDir));
    const otherCast = await readJson<CastFile>(castJsonPath(otherLocated.bookDir));
    if (!sourceCast?.characters?.length)
      return res.status(409).json({ error: 'Source book has no cast on disk yet.' });
    if (!otherCast?.characters?.length)
      return res.status(409).json({ error: 'Other book has no cast on disk yet.' });

    const sourceCharacter = sourceCast.characters.find((c) => c.id === sourceCharacterId);
    if (!sourceCharacter)
      return res
        .status(404)
        .json({ error: `Source character "${sourceCharacterId}" not found.` });
    const otherCharacter = otherCast.characters.find((c) => c.id === otherCharacterId);
    if (!otherCharacter)
      return res.status(404).json({ error: `Other character "${otherCharacterId}" not found.` });

    /* Pair-write: add (otherBookId, otherCharacterId) to source.notLinkedTo,
       and (sourceBookId, sourceCharacterId) to other.notLinkedTo. Each side
       deduped — if the entry already exists on a given side, that side is
       a no-op. Symmetric write avoids stale half-state on retry. */
    const sourceChanged = appendNotLinked(sourceCharacter, otherBookId, otherCharacterId);
    const otherChanged = appendNotLinked(otherCharacter, sourceBookId, sourceCharacterId);

    if (sourceChanged) {
      await writeJsonAtomic(castJsonPath(sourceLocated.bookDir), { characters: sourceCast.characters });
    }
    if (otherChanged) {
      await writeJsonAtomic(castJsonPath(otherLocated.bookDir), { characters: otherCast.characters });
    }

    console.log(
      `[cast-not-linked-to] ${sourceBookId}/${sourceCharacterId} ↮ ${otherBookId}/${otherCharacterId}` +
        (sourceChanged || otherChanged ? '' : ' (no-op: already recorded on both sides)'),
    );

    return res.json({
      pair: {
        a: { bookId: sourceBookId, characterId: sourceCharacterId },
        b: { bookId: otherBookId, characterId: otherCharacterId },
      },
    });
  },
);

/* DELETE /api/books/:bookId/cast/:characterId/not-linked-to  (fs-11)

   Undo a prior "different on purpose" decision — removes the symmetric
   `notLinkedTo` pair from BOTH books' cast.json so the voices-view duplicate
   detector starts surfacing the pair again. Same guards + body shape as the
   POST (cross-book only, series-mate scope, self-pair rejected). Fully
   idempotent: an absent pair on either side is a no-op for that side; the
   route still 200s so an over-eager double-unmark doesn't error. */
castNotLinkedToRouter.delete(
  '/:bookId/cast/:characterId/not-linked-to',
  async (req: Request, res: Response) => {
    const sourceBookId = req.params.bookId;
    const sourceCharacterId = req.params.characterId;
    const body = (req.body ?? {}) as NotLinkedToBody;
    const otherBookId = typeof body.otherBookId === 'string' ? body.otherBookId.trim() : '';
    const otherCharacterId =
      typeof body.otherCharacterId === 'string' ? body.otherCharacterId.trim() : '';

    if (!sourceBookId || !sourceCharacterId || !otherBookId || !otherCharacterId) {
      return res.status(400).json({
        error: 'bookId (path), characterId (path), otherBookId, and otherCharacterId are required.',
      });
    }
    if (sourceBookId === otherBookId && sourceCharacterId === otherCharacterId) {
      return res.status(400).json({
        error: 'otherBookId + otherCharacterId must differ from the source (self-pair).',
      });
    }
    if (sourceBookId === otherBookId) {
      return res.status(400).json({
        error: 'not-linked-to is for CROSS-book pairs; nothing same-book to unmark.',
      });
    }

    const sourceLocated = await findBookByBookId(sourceBookId);
    if (!sourceLocated)
      return res.status(404).json({ error: `Source book "${sourceBookId}" not found.` });
    const otherLocated = await findBookByBookId(otherBookId);
    if (!otherLocated)
      return res.status(404).json({ error: `Other book "${otherBookId}" not found.` });

    if (
      sourceLocated.state.author !== otherLocated.state.author ||
      sourceLocated.state.series !== otherLocated.state.series ||
      sourceLocated.state.isStandalone === true ||
      otherLocated.state.isStandalone === true
    ) {
      return res.status(404).json({
        error: 'Other book is not a series-mate of the source book.',
      });
    }

    const sourceCast = await readJson<CastFile>(castJsonPath(sourceLocated.bookDir));
    const otherCast = await readJson<CastFile>(castJsonPath(otherLocated.bookDir));
    if (!sourceCast?.characters?.length)
      return res.status(409).json({ error: 'Source book has no cast on disk yet.' });
    if (!otherCast?.characters?.length)
      return res.status(409).json({ error: 'Other book has no cast on disk yet.' });

    const sourceCharacter = sourceCast.characters.find((c) => c.id === sourceCharacterId);
    if (!sourceCharacter)
      return res
        .status(404)
        .json({ error: `Source character "${sourceCharacterId}" not found.` });
    const otherCharacter = otherCast.characters.find((c) => c.id === otherCharacterId);
    if (!otherCharacter)
      return res.status(404).json({ error: `Other character "${otherCharacterId}" not found.` });

    /* Pair-remove: drop (otherBookId, otherCharacterId) from source.notLinkedTo
       and (sourceBookId, sourceCharacterId) from other.notLinkedTo. Each side
       a no-op when the entry is already absent — symmetric so retry settles
       both ends. */
    const sourceChanged = removeNotLinked(sourceCharacter, otherBookId, otherCharacterId);
    const otherChanged = removeNotLinked(otherCharacter, sourceBookId, sourceCharacterId);

    if (sourceChanged) {
      await writeJsonAtomic(castJsonPath(sourceLocated.bookDir), {
        characters: sourceCast.characters,
      });
    }
    if (otherChanged) {
      await writeJsonAtomic(castJsonPath(otherLocated.bookDir), {
        characters: otherCast.characters,
      });
    }

    console.log(
      `[cast-not-linked-to] (delete) ${sourceBookId}/${sourceCharacterId} ↮ ${otherBookId}/${otherCharacterId}` +
        (sourceChanged || otherChanged ? '' : ' (no-op: pair absent on both sides)'),
    );

    return res.json({
      pair: {
        a: { bookId: sourceBookId, characterId: sourceCharacterId },
        b: { bookId: otherBookId, characterId: otherCharacterId },
      },
    });
  },
);

/* Append the (bookId, characterId) entry to `character.notLinkedTo` in place.
   Returns true when the write changed the array, false when the entry was
   already present (keeps the disk write fully idempotent). */
function appendNotLinked(
  character: PersistedCharacter,
  bookId: string,
  characterId: string,
): boolean {
  const existing = character.notLinkedTo ?? [];
  if (existing.some((p) => p.bookId === bookId && p.characterId === characterId)) {
    return false;
  }
  character.notLinkedTo = [...existing, { bookId, characterId }];
  return true;
}

/* Remove the (bookId, characterId) entry from `character.notLinkedTo` in
   place. Returns true when the write changed the array, false when the entry
   was already absent (keeps the disk write fully idempotent). */
function removeNotLinked(
  character: PersistedCharacter,
  bookId: string,
  characterId: string,
): boolean {
  const existing = character.notLinkedTo ?? [];
  const next = existing.filter((p) => !(p.bookId === bookId && p.characterId === characterId));
  if (next.length === existing.length) return false;
  character.notLinkedTo = next;
  return true;
}
