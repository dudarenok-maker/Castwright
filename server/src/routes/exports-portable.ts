/* Routes for the portable-book bundle (plan 75).

   GET  /api/books/:bookId/export/portable
        → 200 application/zip with the bundle bytes.
        → Content-Disposition: attachment; filename="<book-title>.portable.zip"

   POST /api/import/portable
        → multipart/form-data with `file` carrying the bundle.
        → 201 { bookId, targetPath, importedFiles } on success.
        → 400 with { error, reason } on a malformed bundle.
        → 409 with { error: 'bundle_conflict', existingPath } when
              onConflict='fail' and the target already exists.

   The POST honours the same 50 MB multipart limit as /api/import (the
   manuscript-upload route) — see server/src/routes/import.ts:40. Bundles
   larger than 50 MB would be the audio-heavy case; the limit can be
   raised per-deployment via a future env knob. */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { buildPortableBundleByBookId } from '../export/build-portable-book.js';
import {
  BundleConflictError,
  InvalidBundleError,
  importPortableBundle,
  type ConflictStrategy,
} from '../import/scan-import-folder.js';
import { findBookByBookId } from '../workspace/scan.js';
import { slug as slugify } from '../workspace/paths.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

export const portableExportRouter = Router();

/** GET /api/books/:bookId/export/portable — stream the bundle. */
portableExportRouter.get('/:bookId/export/portable', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });

  try {
    const result = await buildPortableBundleByBookId(located.state.bookId);
    const downloadName = `${slugify(located.state.title)}.portable.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', result.buffer.length.toString());
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).send(result.buffer);
  } catch (e) {
    console.error('[portable-export] build failed', e);
    res.status(500).json({ error: 'portable_export_failed', message: (e as Error).message });
  }
});

export const portableImportRouter = Router();

/** POST /api/import/portable — accept a multipart bundle and write it to the
    workspace. The conflict-strategy query/body param defaults to 'rename'. */
portableImportRouter.post(
  '/portable',
  upload.single('file'),
  async (req: Request, res: Response) => {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'missing_file', message: 'multipart `file` is required.' });
    }
    /* onConflict is opt-in. Accept it from either the query string or the
       multipart body; default to 'rename' so a double-click on Import
       never silently overwrites. */
    const raw =
      (req.body?.onConflict as string | undefined) ??
      (req.query?.onConflict as string | undefined);
    const onConflict: ConflictStrategy | undefined =
      raw === 'rename' || raw === 'overwrite' || raw === 'fail' ? raw : undefined;

    try {
      const result = await importPortableBundle(req.file.buffer, { onConflict });
      return res.status(201).json(result);
    } catch (e) {
      if (e instanceof BundleConflictError) {
        return res
          .status(409)
          .json({ error: 'bundle_conflict', existingPath: e.existingPath, message: e.message });
      }
      if (e instanceof InvalidBundleError) {
        return res
          .status(400)
          .json({ error: 'invalid_bundle', reason: e.reason, message: e.message });
      }
      console.error('[portable-import] failed', e);
      return res
        .status(500)
        .json({ error: 'portable_import_failed', message: (e as Error).message });
    }
  },
);
