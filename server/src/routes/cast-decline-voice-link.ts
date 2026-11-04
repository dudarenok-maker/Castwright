/* POST /api/books/:bookId/cast/:characterId/decline-voice-link  (#3992)

   "Don't reuse": the user declined the series voice link a character was given
   from an earlier book. The linker hands a linked row the earlier book's
   `voiceUuid`, so both books share one `qwen-<uuid>.pt`, and a later redesign of
   the row would overwrite the earlier book's voice. This route establishes the
   invariant every design relies on, in ONE locked step:

     After "Don't reuse" succeeds, the row is on its own voice that no other
     book's row holds, other than its DIRECT followers, which move with it.

   So a design never decides anything about a shared voice: it writes the row's
   own key. The step (qwen-voice.ts separateVoiceLocked) records the marker
   (`declinedVoiceFrom`, plus `declinedVoiceUuids` for the voice it left), clears
   `matchedFrom`, and, when the row's voice is held by another book's row that is
   not a direct follower (or a book cannot be read: copying writes no other book's
   file, so not knowing separates), mints a fresh uuid, copies the base family with
   COPYFILE_EXCL and stamps it onto the row and its direct followers, dropping
   their `variants`. A row with no uuid always gets one (a series mint would move
   the earlier book's legacy key). Any failure rolls every write back and removes
   the copies; the route answers a curated error and nothing changes, so the
   client keeps the link and shows its failure toast.

   The marker is deliberately NARROWER than `notLinkedTo`. It says "not THIS
   voice", never "not the same person", so it does not feed the same-book join
   gates in the analysis merge or the duplicate detector. It is honoured by the
   series linker and the merge (never re-linked to a declined book or voice).

   Locks, in CLAUDE.md's global order: the book's design lock (so no design of
   this book reads its uuid mid-step), then `withBookOps` over the row's book and
   its direct followers' books, then `withCastLocks` over all of them. The book is
   peeked lock-free only to key the design lock; the locked handle must resolve to
   the same folder. The whole-roster cast PUT takes the marker from disk
   (preserveDeclinedVoiceFromOnCastWrite) and keeps disk's voice slot when the
   uuids differ, so a client autosave cannot undo the step. `fromBookId` is NOT
   resolved against the library: a deleted earlier book's id is still a real
   decline. Idempotent: a repeated decline of a row already on its own voice
   changes nothing. */

import { Router } from 'express';
import { resolve } from 'node:path';
import type { Request, Response } from '../http.js';
import { BOOK_GONE, peekBook, withBookOps } from '../workspace/book-op-lock.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLocks } from '../workspace/cast-lock.js';
import { requestFailureMessageFs } from '../workspace/file-lock.js';
import { RetryableForkError } from '../workspace/voice-uuid-fork.js';
import { withDesignLock } from '../tts/design-lock.js';
import { CharacterGoneError, separationPlan, separateVoiceLocked } from './qwen-voice.js';

export const castDeclineVoiceLinkRouter = Router();

interface CastFile {
  characters?: Array<{ id: string }>;
}

type Answer = { status: number; body: Record<string, unknown> };

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

    let answer: Answer;
    try {
      const peeked = await peekBook(bookId);
      if (!peeked) return res.status(404).json({ error: 'Book not found.' });
      const bookDir = peeked.bookDir;
      answer = await withDesignLock(bookDir, async (): Promise<Answer> => {
        const cast = await readJson<CastFile>(castJsonPath(bookDir));
        if (!cast?.characters?.length) {
          return { status: 409, body: { error: 'Book has no cast on disk yet.' } };
        }
        if (!cast.characters.some((c) => c.id === characterId)) {
          return { status: 404, body: { error: `Character "${characterId}" not found.` } };
        }
        const plan = await separationPlan(bookDir, characterId);
        const out = await withBookOps(plan.bookIds, (books) => {
          const own = books.find((b) => b.bookId === bookId);
          if (!own || resolve(own.bookDir) !== resolve(bookDir)) {
            throw new RetryableForkError('This book moved while "Don\'t reuse" was being saved; try again.');
          }
          const dirs = books.map((b) => b.bookDir);
          return withCastLocks(dirs, () =>
            separateVoiceLocked(
              bookDir,
              characterId,
              dirs,
              plan.followers,
              (dir, cast) => writeJsonAtomic(castJsonPath(dir), cast),
              { fromBookId },
            ),
          );
        });
        if (out === BOOK_GONE) {
          throw new RetryableForkError('A book in this series was removed while "Don\'t reuse" was being saved; try again.');
        }
        console.log(
          `[cast-decline-voice-link] ${bookId}/${characterId} declined the voice of ${fromBookId}` +
            (out.separated ? ` and moved to its own voice ${out.voiceUuid}` : ''),
        );
        return {
          status: 200,
          body: {
            declinedVoiceFrom: out.row.declinedVoiceFrom ?? [fromBookId],
            declinedVoiceUuids: out.row.declinedVoiceUuids ?? [],
            voiceUuid: out.voiceUuid ?? null,
          },
        };
      });
    } catch (e) {
      if (e instanceof CharacterGoneError) {
        return res.status(404).json({ error: `Character "${characterId}" not found.` });
      }
      console.error('[cast-decline-voice-link] failed', e);
      /* A fixed, path-free sentence that says a retry can work. */
      if (e instanceof RetryableForkError) return res.status(500).json({ error: e.message });
      return res
        .status(500)
        .json({ error: requestFailureMessageFs(e, 'Could not record the decline.') });
    }
    return res.status(answer.status).json(answer.body);
  },
);
