/* srv-2 — per-book state.json backup API. Mounted at /api/books, so:
     GET  /:bookId/backups          → list snapshots (newest first)
     POST /:bookId/backups/now      → force a snapshot right now
     POST /:bookId/backups/restore  → swap a chosen snapshot back over state.json
   The scheduled sweep + the on-disk shape live in workspace/auto-backup.ts. */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { findBookByBookId } from '../workspace/scan.js';
import { listBackups, backupBook, restoreBackup, BackupRestoreError } from '../workspace/auto-backup.js';
import { getResolvedBackupConfig } from '../workspace/user-settings.js';

export const backupRouter = Router();

backupRouter.get('/:bookId/backups', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  if (!(await findBookByBookId(bookId))) return res.status(404).json({ error: 'book not found' });
  res.json({ backups: await listBackups(bookId) });
});

backupRouter.post('/:bookId/backups/now', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const found = await findBookByBookId(bookId);
  if (!found) return res.status(404).json({ error: 'book not found' });
  const { retention } = getResolvedBackupConfig();
  /* No minIntervalMs → force a snapshot regardless of cadence. */
  const file = await backupBook(
    { bookId, bookDir: found.bookDir },
    { keep: retention, now: new Date() },
  );
  if (!file) return res.status(409).json({ error: 'no state.json to back up' });
  res.json({ ok: true, file });
});

backupRouter.post('/:bookId/backups/restore', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const file = (req.body as { backupFile?: unknown })?.backupFile;
  if (typeof file !== 'string') return res.status(400).json({ error: 'backupFile required' });
  try {
    await restoreBackup(bookId, file);
    res.json({ ok: true });
  } catch (err) {
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
