/* POST /api/books/:bookId/cast/add-from-roster

   Add a NEW local character to the source book's cast, populated from a
   character that already exists in a prior series-mate book's cast.json.
   Complements POST /:bookId/cast/link-prior — link-prior aliases an
   EXISTING local character against a prior one. This route handles the
   case where the analyzer missed the character entirely in the current
   book (no local row to link), so the user picks the prior-book entry
   directly from the manuscript-view reassign picker.

   Side effects (durable):

   - Append a new character record to the SOURCE book's cast.json
     (atomic-rename). New id, name + gender + ageRange + role copied from
     target. voiceId preserved from target. voiceState = 'reused'.
     matchedFrom = { bookId: targetBookId, characterId: targetCharacterId,
     bookTitle, confidence: 1 }.
   - No mutation on the TARGET book's cast.json. The user is picking an
     EXISTING prior-book entry by name as-is; we have no new alias info
     to teach the matcher. Different from link-prior where the local
     character's name surfaces as a new alias.

   Response shape: { character: <full new character record> }. The
   frontend dispatches castActions.addCharacter with the response so the
   redux store mirrors disk; immediately follows with
   manuscriptActions.setSentenceCharacter (or setSentencesCharacter) to
   reassign the sentence to the new local id.

   Idempotency: a repeat call with the same target produces a fresh new
   character row each time — the route does NOT dedupe against existing
   matchedFrom on the source side. The frontend is expected to gate the
   call on user intent (one click = one POST). */

import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castAddFromRosterRouter = Router();

type PersistedCharacter = CharacterOutput & {
  voiceId?: string;
  voiceState?: 'generated' | 'tuned' | 'reused' | 'locked';
  matchedFrom?: {
    bookId: string;
    characterId: string;
    bookTitle: string;
    confidence: number;
  } | null;
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
};
interface CastFile {
  characters: PersistedCharacter[];
}

interface AddFromRosterBody {
  targetBookId?: unknown;
  targetCharacterId?: unknown;
}

castAddFromRosterRouter.post(
  '/:bookId/cast/add-from-roster',
  async (req: Request, res: Response) => {
    const sourceBookId = req.params.bookId;
    const body = (req.body ?? {}) as AddFromRosterBody;
    const targetBookId = typeof body.targetBookId === 'string' ? body.targetBookId.trim() : '';
    const targetCharacterId =
      typeof body.targetCharacterId === 'string' ? body.targetCharacterId.trim() : '';

    if (!sourceBookId || !targetBookId || !targetCharacterId) {
      return res.status(400).json({
        error: 'bookId (path), targetBookId, and targetCharacterId are all required.',
      });
    }
    if (sourceBookId === targetBookId) {
      return res.status(400).json({
        error:
          'targetBookId must differ from the path bookId — adding from the same book is a no-op.',
      });
    }

    const sourceLocated = await findBookByBookId(sourceBookId);
    if (!sourceLocated)
      return res.status(404).json({ error: `Source book "${sourceBookId}" not found.` });
    const targetLocated = await findBookByBookId(targetBookId);
    if (!targetLocated)
      return res.status(404).json({ error: `Target book "${targetBookId}" not found.` });

    if (
      sourceLocated.state.author !== targetLocated.state.author ||
      sourceLocated.state.series !== targetLocated.state.series ||
      sourceLocated.state.isStandalone === true ||
      targetLocated.state.isStandalone === true
    ) {
      return res.status(404).json({
        error: 'Target book is not a series-mate of the source book.',
      });
    }

    const sourceCast = await readJson<CastFile>(castJsonPath(sourceLocated.bookDir));
    const targetCast = await readJson<CastFile>(castJsonPath(targetLocated.bookDir));
    if (!sourceCast?.characters) {
      return res
        .status(409)
        .json({ error: 'Source book has no cast.json yet. Confirm cast before adding.' });
    }
    if (!targetCast?.characters?.length) {
      return res.status(409).json({ error: 'Target book has no cast on disk.' });
    }

    const target = targetCast.characters.find((c) => c.id === targetCharacterId);
    if (!target)
      return res.status(404).json({ error: `Target character "${targetCharacterId}" not found.` });

    /* Mint a unique id within the source book's cast. Prefer a readable
       slug derived from the target's id; fall back to a random suffix
       if it would collide. */
    const existingIds = new Set(sourceCast.characters.map((c) => c.id));
    const baseSlug = `${target.id}_from_${targetBookId.slice(0, 8)}`;
    let newId = baseSlug;
    if (existingIds.has(newId)) {
      newId = `${baseSlug}_${randomBytes(3).toString('hex')}`;
    }

    const newCharacter: PersistedCharacter = {
      id: newId,
      name: target.name,
      role: target.role ?? 'character',
      color: target.color ?? 'unset',
      gender: target.gender,
      ageRange: target.ageRange,
      voiceId: target.voiceId,
      voiceState: 'reused',
      matchedFrom: {
        bookId: targetBookId,
        characterId: targetCharacterId,
        bookTitle: targetLocated.state.title,
        confidence: 1,
      },
    };

    const nextCharacters: PersistedCharacter[] = [...sourceCast.characters, newCharacter];
    await writeJsonAtomic(castJsonPath(sourceLocated.bookDir), { characters: nextCharacters });

    console.log(
      `[cast-add-from-roster] ${sourceBookId} ← ${targetBookId}/${targetCharacterId} as "${newId}"`,
    );

    return res.json({ character: newCharacter });
  },
);
