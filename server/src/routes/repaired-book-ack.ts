/* POST /api/repaired-books/ack/:bookId  (#3713, PR #4004 pass 4)

   "This tab applied a full read of a repaired book as its snapshot, and holds the token." The client sends
   it from `commitBookReadToken`, and ONLY then does the server forget the book's PERSISTED gate entry (this
   process keeps gating a tab that sends no token, the next restart does not). A bare `GET /state` no
   longer clears it: most reads of that endpoint (a revisions-only reopen, a Voices peek at a series-mate,
   the rebaseline modal) apply nothing to the book's slices, and an old-bundle tab never acks, so its book
   stays gated for the full 7 days.

   The route proves possession itself: the echoed token must be the book's current one. A request without it
   is the same 409 the gate gives, and clears nothing. An id that is not gated is a quiet 204. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { BOOK_READ_TOKEN_HEADER, BOOK_REPAIRED_RELOAD, markRepairedBookRead, repairedReadToken } from '../workspace/repaired-book-gate.js';

export const repairedBookAckRouter = Router();

repairedBookAckRouter.post('/ack/:bookId', async (req: Request, res: Response) => {
  const bookId = String(req.params.bookId);
  const token = repairedReadToken(bookId);
  if (token === undefined) return res.status(204).end();
  const echoed = (req.get(BOOK_READ_TOKEN_HEADER) ?? '').split(',').map((t) => t.trim());
  if (!echoed.includes(token)) {
    return res.status(409).json({
      error: 'The acknowledgement did not carry this book\'s read token.',
      code: BOOK_REPAIRED_RELOAD,
      bookId,
    });
  }
  await markRepairedBookRead(bookId);
  return res.status(204).end();
});
