/* POST /api/books/:bookId/voice-match
   Stub for first slice — library is empty until book 2 ships. Returning an
   empty matches array makes the cast confirmation view render every character
   as a new (un-matched) voice, which is the correct UX for an empty library. */

import { Router, type Request, type Response } from 'express';

export const voiceMatchRouter = Router();

voiceMatchRouter.post('/:bookId/voice-match', (req: Request, res: Response) => {
  const bookId = req.params.bookId;
  return res.json({ bookId, matches: [] });
});
