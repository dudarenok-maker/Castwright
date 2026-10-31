/* POST /api/books/:bookId/cast/:characterId/decline-voice-link  (#3992)

   "Don't reuse": the user declined the series voice link a character was given
   from an earlier book. Redux clears `matchedFrom`, but the row keeps the earlier
   book's `voiceUuid` (so both share one `qwen-<uuid>.pt`) and nothing on disk says
   it was declined. This route records that, durably, as `declinedVoiceFrom`:
   the ids of the books whose voice the row declined.

   The marker is deliberately NARROWER than `notLinkedTo`. It says "not THIS
   voice", never "not the same person", so it does not feed the same-book join
   gates in the analysis merge or the duplicate detector. It is honoured by the
   series linker and the merge (never re-linked to a declined book) and by the
   voice-design fork (only a row carrying it forks the shared uuid).

   Single-book write, so one book-op + one cast lock. The read and the decision
   derived from it live inside the lock. The whole-roster cast PUT takes the field
   from disk (preserveDeclinedVoiceFromOnCastWrite), so this route is its only
   writer. `fromBookId` is NOT resolved against the library: a deleted earlier
   book's id is still a real decline. Idempotent. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { BOOK_GONE, withBookOp } from '../workspace/book-op-lock.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';

export const castDeclineVoiceLinkRouter = Router();

interface CastRow {
  id: string;
  declinedVoiceFrom?: string[];
}
interface CastFile {
  characters: CastRow[];
}

castDeclineVoiceLinkRouter.post(
  '/:bookId/cast/:characterId/decline-voice-link',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as { fromBookId?: unknown };
    const fromBookId = typeof body.fromBookId === 'string' ? body.fromBookId.trim() : '';
    if (!fromBookId) {
      return res.status(400).json({ error: 'fromBookId is required.' });
    }
    if (fromBookId === bookId) {
      return res.status(400).json({ error: 'fromBookId must name a different book.' });
    }

    const outcome = await withBookOp(bookId, ({ bookDir }) =>
      withCastLock(bookDir, async () => {
        const cast = await readJson<CastFile>(castJsonPath(bookDir));
        if (!cast?.characters?.length) {
          return res.status(409).json({ error: 'Book has no cast on disk yet.' });
        }
        const idx = cast.characters.findIndex((c) => c.id === characterId);
        if (idx === -1) {
          return res.status(404).json({ error: `Character "${characterId}" not found.` });
        }
        const existing = cast.characters[idx].declinedVoiceFrom ?? [];
        if (!existing.includes(fromBookId)) {
          cast.characters[idx] = {
            ...cast.characters[idx],
            declinedVoiceFrom: [...existing, fromBookId],
          };
          await writeJsonAtomic(castJsonPath(bookDir), cast);
          console.log(`[cast-decline-voice-link] ${bookId}/${characterId} declined the voice of ${fromBookId}`);
        }
        return res.json({ declinedVoiceFrom: cast.characters[idx].declinedVoiceFrom ?? [fromBookId] });
      }),
    );
    if (outcome === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    return outcome;
  },
);
