/* /api/books/:bookId/cover{,/candidates}

   Four endpoints:
   - GET  /:bookId/cover/candidates → up to 6 OpenLibrary candidates for the
     picker modal. Used by the manual "Find cover image" flow on the
     library card and the Listen header.
   - POST /:bookId/cover            → download the picked candidate and patch
     state.json. Body: `{ openLibraryId }`.
   - GET  /:bookId/cover            → serve the cached JPEG bytes off disk.
   - DELETE /:bookId/cover          → remove the cached file and clear the
     state.json metadata; UI falls back to the procedural gradient.

   The auto-fetch on import lives in routes/import.ts and bypasses this
   router — it calls backgroundFetchCover directly. */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { findBookByBookId } from '../workspace/scan.js';
import { coverImagePath } from '../workspace/paths.js';
import {
  OpenLibraryError,
  clearStateCover,
  downloadCover,
  findCandidateById,
  patchStateCover,
  searchCovers,
} from '../cover/openlibrary.js';

export const coverRouter = Router();

coverRouter.get('/:bookId/cover/candidates', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { state } = located;
    const candidates = await searchCovers(state.title, state.author);
    res.json({ candidates });
  } catch (e) {
    if (e instanceof OpenLibraryError) {
      console.warn('[cover] candidates failed', e);
      return res.status(502).json({ error: e.message, kind: e.kind });
    }
    console.error('[cover] candidates failed', e);
    res.status(500).json({ error: (e as Error).message || 'Cover lookup failed.' });
  }
});

coverRouter.post('/:bookId/cover', async (req: Request, res: Response) => {
  try {
    const openLibraryId = (req.body as { openLibraryId?: unknown })?.openLibraryId;
    if (typeof openLibraryId !== 'string' || !openLibraryId.trim()) {
      return res.status(400).json({ error: '`openLibraryId` is required.' });
    }

    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir, state } = located;

    const candidate = await findCandidateById(state.title, state.author, openLibraryId);
    if (!candidate) {
      return res.status(404).json({ error: 'Selected cover is no longer available — try a fresh search.' });
    }

    await downloadCover(candidate.coverUrl, coverImagePath(bookDir));
    await patchStateCover(bookDir, candidate);

    res.json({ coverImageUrl: `/api/books/${state.bookId}/cover` });
  } catch (e) {
    if (e instanceof OpenLibraryError) {
      console.warn('[cover] POST failed', e);
      return res.status(502).json({ error: e.message, kind: e.kind });
    }
    console.error('[cover] POST failed', e);
    res.status(500).json({ error: (e as Error).message || 'Cover save failed.' });
  }
});

coverRouter.get('/:bookId/cover', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const path = coverImagePath(located.bookDir);
    if (!existsSync(path)) return res.status(404).json({ error: 'No cover cached for this book.' });

    /* sendFile sets Content-Type from the path extension. Pin it
       explicitly since cover.jpg is always JPEG and we want a stable
       Cache-Control header on the response. The 1-hour max-age matches
       the workspace /audio static cache (see server/src/index.ts:56). */
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path, { headers: { 'Content-Type': 'image/jpeg' } }, (err) => {
      if (err) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to send cover.' });
        }
      }
    });
  } catch (e) {
    console.error('[cover] GET failed', e);
    if (!res.headersSent) {
      res.status(500).json({ error: (e as Error).message || 'Cover read failed.' });
    }
  }
});

coverRouter.delete('/:bookId/cover', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;
    const path = coverImagePath(bookDir);
    await rm(path, { force: true }).catch(() => { /* best-effort */ });
    await clearStateCover(bookDir);
    res.status(204).end();
  } catch (e) {
    console.error('[cover] DELETE failed', e);
    res.status(500).json({ error: (e as Error).message || 'Cover delete failed.' });
  }
});
