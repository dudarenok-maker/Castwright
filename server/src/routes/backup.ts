/* srv-2 — per-book state.json backup API. Mounted at /api/books, so:
     GET  /:bookId/backups          → list snapshots (newest first)
     POST /:bookId/backups/now      → force a snapshot right now
     POST /:bookId/backups/restore  → swap a chosen snapshot back over state.json
   The scheduled sweep + the on-disk shape live in workspace/auto-backup.ts. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { BOOK_GONE, BookBusyError, bookJobKinds, withBookOp } from '../workspace/book-op-lock.js';
import { listBackups, backupBook, restoreBackup, BackupRestoreError } from '../workspace/auto-backup.js';
import { getResolvedBackupConfig } from '../workspace/user-settings.js';
import { busySentence } from './book-state.js';

export const backupRouter = Router();

backupRouter.get('/:bookId/backups', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  if (!(await findBookByBookId(bookId))) return res.status(404).json({ error: 'book not found' });
  res.json({ backups: await listBackups(bookId) });
});

backupRouter.post('/:bookId/backups/now', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const { retention } = getResolvedBackupConfig();
  /* #3711 — under the book's `book-op` lock, resolved UNDER it, so the snapshot
     reads the folder the book is in NOW (a rename queued ahead of it has landed). */
  const file = await withBookOp(bookId, (found) =>
    /* No minIntervalMs → force a snapshot regardless of cadence. */
    backupBook({ bookId, bookDir: found.bookDir }, { keep: retention, now: new Date() }),
  );
  if (file === BOOK_GONE) return res.status(404).json({ error: 'book not found' });
  if (!file) return res.status(409).json({ error: 'no state.json to back up' });
  res.json({ ok: true, file });
});

backupRouter.post('/:bookId/backups/restore', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const file = (req.body as { backupFile?: unknown })?.backupFile;
  if (typeof file !== 'string') return res.status(400).json({ error: 'backupFile required' });
  try {
    /* #3711 — the restore overwrites state.json, so it runs under the book's
       `book-op` lock and a folder rename can't interleave (`restoreBackup`
       resolves the folder itself, now under the lock). */
    const outcome = await withBookOp(bookId, () => {
      /* PR #3966 review pass 2 -- refused while ANY long job is registered, as
         the bundle overwrite is (scan-import-folder.ts): a running analysis
         re-saves the cache this restore clears, rebuilds the chapters from the
         record it drops and deletes the marker it stamps. `runBookJob`
         registers inside `withBookOp`, so this check cannot race one. */
      const kinds = bookJobKinds(bookId);
      if (kinds.length > 0) throw new BookBusyError(kinds);
      return restoreBackup(bookId, file);
    });
    if (outcome === BOOK_GONE) return res.status(404).json({ error: 'book not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof BookBusyError) {
      return res.status(409).json({ error: busySentence(err.kinds, 'restore'), code: 'book_busy' });
    }
    if (err instanceof BackupRestoreError) {
      const status =
        err.message === 'book not found' || err.message === 'backup not found'
          ? 404
          : err.message === 'backup is corrupt'
            ? 409
            : 400;
      return res.status(status).json({ error: err.message });
    }
    throw err;
  }
});
