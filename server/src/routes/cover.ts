/* /api/books/:bookId/cover{,/candidates,/upload,/framing}

   Six endpoints (plan 36 shipped the first four; plan 40 adds upload + framing):
   - GET  /:bookId/cover/candidates → up to 6 OpenLibrary candidates for the
     picker modal. Used by the manual "Find cover image" flow on the
     library card and the Listen header.
   - POST /:bookId/cover            → download the picked candidate and patch
     state.json. Body: `{ candidateId }`.
   - GET  /:bookId/cover            → serve the cached JPEG bytes off disk.
   - DELETE /:bookId/cover          → remove the cached file and clear the
     state.json metadata; UI falls back to the procedural gradient.
   - POST /:bookId/cover/upload     → (plan 40) multipart upload of local
     cover JPEG/PNG (every upload re-encoded to a clean JPEG server-side),
     atomic write, patches state.json with `source: 'local'`.
   - PATCH /:bookId/cover/framing   → (plan 40) persist render-time pan +
     zoom onto state.json.coverImage.framing.

   The auto-fetch on import lives in routes/import.ts and bypasses this
   router — it calls backgroundFetchCover directly. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import multer from 'multer';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { findBookByBookId } from '../workspace/scan.js';
import { BOOK_GONE, peekBook, withBookOp } from '../workspace/book-op-lock.js';
import { coverImagePath } from '../workspace/paths.js';
import { CoverSourceError } from '../cover/sources/types.js';
import { findCandidateById, aggregateCovers } from '../cover/search.js';
import {
  CoverDownloadError,
  clearStateCover,
  fetchCoverJpeg,
  patchStateCover,
  writeCoverFile,
} from '../cover/store.js';
import {
  MAX_UPLOAD_BYTES,
  UploadError,
  encodeUploadedCover,
  patchStateFraming,
  patchStateLocalCover,
  validateUpload,
  type UploadMimeType,
} from '../cover/upload.js';

export const coverRouter = Router();

const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

coverRouter.get('/:bookId/cover/candidates', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const candidates = await aggregateCovers(located.state.title, located.state.author);
    res.json({ candidates });
  } catch (e) {
    console.error('[cover] candidates failed', e);
    res.status(500).json({ error: (e as Error).message || 'Cover lookup failed.' });
  }
});

coverRouter.post('/:bookId/cover', async (req: Request, res: Response) => {
  try {
    const candidateId = (req.body as { candidateId?: unknown })?.candidateId;
    if (typeof candidateId !== 'string' || !candidateId.trim()) {
      return res.status(400).json({ error: '`candidateId` is required.' });
    }

    /* #3711 two-span: the candidate search + download are slow and write nothing,
       so they run off a lock-free `peekBook` (nothing it returns feeds a write);
       only the commit below holds book-op, on the freshly resolved folder. */
    const peeked = await peekBook(req.params.bookId);
    if (!peeked) return res.status(404).json({ error: 'Book not found.' });
    const { state } = peeked;

    const candidate = await findCandidateById(state.title, state.author, candidateId);
    if (!candidate) {
      return res
        .status(404)
        .json({ error: 'Selected cover is no longer available — try a fresh search.' });
    }

    /* #3700 review pass 3 — fetch first, write the file inside the state-json
       lock only once state.json is confirmed present: a book moved or deleted
       while this request queued answers 404 with nothing written. */
    const jpeg = await fetchCoverJpeg(candidate.coverUrl);
    const committed = await withBookOp(req.params.bookId, async ({ bookDir }) => {
      const dest = coverImagePath(bookDir);
      return patchStateCover(bookDir, candidate, () => writeCoverFile(dest, jpeg));
    });
    if (committed === BOOK_GONE || !committed) {
      return res.status(404).json({ error: 'Book not found.' });
    }

    res.json({ coverImageUrl: `/api/books/${state.bookId}/cover` });
  } catch (e) {
    if (e instanceof CoverSourceError || e instanceof CoverDownloadError) {
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
       the workspace /audio static cache (see server/src/index.ts:56).
       dotfiles:'allow' — cover.jpg lives under the book's `.audiobook/`
       dir; Express 5's send defaults dotfiles:'ignore', which would 404 any
       path with a dot-segment (Express 4's res.sendFile served it). */
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path, { headers: { 'Content-Type': 'image/jpeg' }, dotfiles: 'allow' }, (err) => {
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
    /* #3711 — book-op outermost: the removal hits the folder resolved under it. */
    const ok = await withBookOp(req.params.bookId, async ({ bookDir }) => {
      const path = coverImagePath(bookDir);
      /* #3700 review pass 3 — the file removal runs inside the state-json lock,
         and only if state.json is still there (404 otherwise, nothing touched). */
      return clearStateCover(bookDir, () =>
        rm(path, { force: true }).catch(() => {
          /* best-effort */
        }),
      );
    });
    if (ok === BOOK_GONE || !ok) return res.status(404).json({ error: 'Book not found.' });
    res.status(204).end();
  } catch (e) {
    console.error('[cover] DELETE failed', e);
    res.status(500).json({ error: (e as Error).message || 'Cover delete failed.' });
  }
});

coverRouter.post(
  '/:bookId/cover/upload',
  (req: Request, res: Response, next: (err?: unknown) => void) => {
    uploadMw.single('image')(req, res, (err: unknown) => {
      if (err) {
        /* multer 2.x still raises MulterError with the same `.code`
           strings as 1.x (LIMIT_FILE_SIZE, LIMIT_UNEXPECTED_FILE …).
           Gate on the instanceof so a non-multer middleware error can't
           masquerade as an upload-limit response, then branch on the
           stable code. */
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
              error: `Cover must be under ${MAX_UPLOAD_BYTES} bytes.`,
              kind: 'oversize',
            });
          }
          if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
              error: `Unexpected upload field "${err.field ?? ''}" — use the "image" field.`,
              kind: 'unexpected_field',
            });
          }
        }
        return res.status(400).json({ error: (err as Error).message || 'Upload error.' });
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    try {
      /* #3711 two-span: validate + re-encode run off a lock-free `peekBook`; only
         the commit below holds book-op. */
      const peeked = await peekBook(req.params.bookId);
      if (!peeked) return res.status(404).json({ error: 'Book not found.' });
      const { state } = peeked;

      const file = req.file;
      let sniffedMime: UploadMimeType;
      try {
        sniffedMime = validateUpload(file?.buffer, file?.mimetype);
      } catch (e) {
        if (e instanceof UploadError) {
          const status = e.kind === 'oversize' ? 413 : e.kind === 'invalid_mime' ? 415 : 400;
          return res.status(status).json({ error: e.message, kind: e.kind });
        }
        throw e;
      }

      let jpeg: Buffer;
      try {
        jpeg = await encodeUploadedCover(file!.buffer, sniffedMime);
      } catch (e) {
        if (e instanceof UploadError && e.kind === 'transcode_failed') {
          return res.status(502).json({ error: e.message, kind: e.kind });
        }
        throw e;
      }

      const originalFilename = file!.originalname || null;
      /* #3700 review pass 3 — write the file inside the state-json lock only
         once state.json is confirmed present (404 + nothing written otherwise). */
      const committed = await withBookOp(req.params.bookId, async ({ bookDir }) => {
        const dest = coverImagePath(bookDir);
        return patchStateLocalCover(bookDir, originalFilename, () => writeCoverFile(dest, jpeg));
      });
      if (committed === BOOK_GONE || !committed) {
        return res.status(404).json({ error: 'Book not found.' });
      }

      res.json({
        coverImageUrl: `/api/books/${state.bookId}/cover`,
        originalFilename,
      });
    } catch (e) {
      console.error('[cover] upload failed', e);
      res.status(500).json({ error: (e as Error).message || 'Cover upload failed.' });
    }
  },
);

coverRouter.patch('/:bookId/cover/framing', async (req: Request, res: Response) => {
  try {
    const body = req.body as { offsetX?: unknown; offsetY?: unknown; zoom?: unknown };
    const offsetX = Number(body?.offsetX);
    const offsetY = Number(body?.offsetY);
    const zoom = Number(body?.zoom);
    if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY) || !Number.isFinite(zoom)) {
      return res
        .status(400)
        .json({ error: '`offsetX`, `offsetY`, `zoom` are required and must be numbers.' });
    }

    /* #3711 — book-op outermost. */
    const ok = await withBookOp(req.params.bookId, ({ bookDir }) =>
      patchStateFraming(bookDir, { offsetX, offsetY, zoom }),
    );
    if (ok === BOOK_GONE) return res.status(404).json({ error: 'Book not found.' });
    if (!ok)
      return res.status(404).json({ error: 'No cover pinned for this book — set a cover first.' });

    res.status(204).end();
  } catch (e) {
    console.error('[cover] framing PATCH failed', e);
    res.status(500).json({ error: (e as Error).message || 'Cover framing save failed.' });
  }
});
