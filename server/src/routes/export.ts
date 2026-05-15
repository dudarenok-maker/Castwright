/* POST /api/books/:bookId/exports        — create an export job
   GET  /api/books/:bookId/exports/:id    — poll job status
   GET  /api/books/:bookId/exports/:id/download — stream the artifact

   Phase A ships `format: 'mp3-zip'` only. The body's `destination` chooses
   the post-build delivery: `download` stages the file under the book's
   `.audiobook/exports/<id>/<filename>` for the user to pull via the
   download endpoint; `sync-folder` ADDITIONALLY copies the archive into
   `userSettings.exportSyncFolder` (e.g. OneDrive watch path) so it mirrors
   to the user's phone automatically.

   Jobs are tracked in an in-memory Map keyed by exportId. A small manifest
   sits next to the artifact (`manifest.json`) so a server restart can
   re-hydrate the index — the download URL keeps working across reboots
   because the bytes never moved. */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { dotAudiobook, slug as slugify } from '../workspace/paths.js';
import { writeJsonAtomic } from '../workspace/state-io.js';
import { readUserSettings } from '../workspace/user-settings.js';
import { buildMp3Zip, ExportIncompleteError } from '../export/build-mp3-zip.js';
import { writeToSyncFolder } from '../export/sync-folder.js';

/* Mirrors the OpenAPI BookExportJob schema. Kept in sync by hand — the
   server doesn't import the generated frontend types. */
export interface BookExportJob {
  id: string;
  bookId: string;
  format: 'mp3-zip' | 'm4b';
  destination: 'download' | 'sync-folder';
  status: 'queued' | 'in_progress' | 'done' | 'failed';
  filename: string;
  sizeBytes: number | null;
  progress: number | null;
  downloadUrl: string | null;
  syncPath: string | null;
  errorReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const exportRouter = Router();

/* In-memory job table. Cleared by tests via _resetExportJobs(). */
const jobs = new Map<string, BookExportJob>();

function exportsDir(bookDir: string): string {
  return join(dotAudiobook(bookDir), 'exports');
}
function manifestPath(bookDir: string, exportId: string): string {
  return join(exportsDir(bookDir), exportId, 'manifest.json');
}

/* Lazy rehydrate: on first lookup for a book, scan its exports dir and
   reload any manifests we don't yet have in memory. Keeps download URLs
   working across server restarts. */
async function rehydrateBook(bookDir: string, bookId: string): Promise<void> {
  const dir = exportsDir(bookDir);
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try { entries = await readdir(dir); } catch { return; }
  for (const name of entries) {
    const manifest = manifestPath(bookDir, name);
    if (!existsSync(manifest)) continue;
    try {
      const raw = await readFile(manifest, 'utf8');
      const job = JSON.parse(raw) as BookExportJob;
      if (job.id && !jobs.has(job.id) && job.bookId === bookId) {
        jobs.set(job.id, job);
      }
    } catch {
      /* Corrupt manifest — skip, don't fail the GET. */
    }
  }
}

function bookFilename(state: BookStateJson, format: BookExportJob['format']): string {
  const ext = format === 'mp3-zip' ? 'zip' : 'm4b';
  const base = slugify(state.title);
  return `${base}.${ext}`;
}

exportRouter.post('/:bookId/exports', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { format?: string; destination?: string };
  if (body.format !== 'mp3-zip') {
    return res.status(400).json({ error: 'unsupported_format', message: `Phase A only supports format=mp3-zip; got ${body.format ?? '(missing)'}.` });
  }
  if (body.destination !== 'download' && body.destination !== 'sync-folder') {
    return res.status(400).json({ error: 'invalid_destination', message: `destination must be 'download' or 'sync-folder'.` });
  }

  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });

  const settings = await readUserSettings();
  if (body.destination === 'sync-folder' && !settings.exportSyncFolder) {
    return res.status(400).json({ error: 'sync_folder_unset', message: 'exportSyncFolder is not configured. Set it under Account before using the sync-folder destination.' });
  }

  /* Pre-flight on missing audio so we 409 before allocating an exportId.
     Re-running the same check inside buildMp3Zip is harmless — it's the
     authoritative gate. */
  const missing = preflightMissingChapters(located.state, located.bookDir);
  if (missing.length > 0) {
    return res.status(409).json({ error: 'export_incomplete', missing });
  }

  const exportId = `exp_${nanoid(10)}`;
  const filename = bookFilename(located.state, 'mp3-zip');
  const stagingDir = join(exportsDir(located.bookDir), exportId);
  await mkdir(stagingDir, { recursive: true });
  const outPath = join(stagingDir, filename);

  const job: BookExportJob = {
    id: exportId,
    bookId: located.state.bookId,
    format: 'mp3-zip',
    destination: body.destination,
    status: 'in_progress',
    filename,
    sizeBytes: null,
    progress: 0,
    downloadUrl: null,
    syncPath: null,
    errorReason: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  jobs.set(exportId, job);

  /* Fire-and-forget the actual build. The client polls getBookExport for
     progress + completion. */
  void runExportJob(job, located.bookDir, located.state, outPath, settings.exportSyncFolder);

  return res.status(201).json(job);
});

exportRouter.get('/:bookId/exports/:exportId', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const job = jobs.get(req.params.exportId);
  if (!job || job.bookId !== located.state.bookId) return res.status(404).json({ error: 'export_not_found' });
  return res.json(job);
});

exportRouter.get('/:bookId/exports/:exportId/download', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const job = jobs.get(req.params.exportId);
  if (!job || job.bookId !== located.state.bookId) return res.status(404).json({ error: 'export_not_found' });
  if (job.status !== 'done') return res.status(409).json({ error: 'export_not_ready', status: job.status });

  const path = join(exportsDir(located.bookDir), job.id, job.filename);
  if (!existsSync(path)) return res.status(404).json({ error: 'export_artifact_missing' });
  res.sendFile(path, {
    headers: {
      'Content-Type': mimeForFormat(job.format),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(job.filename)}"`,
      'Cache-Control': 'no-cache',
    },
  }, err => {
    if (err && !res.headersSent) res.status(500).end();
  });
});

function mimeForFormat(format: BookExportJob['format']): string {
  return format === 'mp3-zip' ? 'application/zip' : 'audio/mp4';
}

function preflightMissingChapters(state: BookStateJson, bookDir: string): string[] {
  const root = join(bookDir, 'audio');
  const out: string[] = [];
  for (const chapter of state.chapters) {
    if (chapter.excluded) continue;
    const mp3Path = join(root, `${chapter.slug}.mp3`);
    if (!existsSync(mp3Path)) out.push(chapter.slug);
  }
  return out;
}

async function runExportJob(
  job: BookExportJob,
  bookDir: string,
  state: BookStateJson,
  outPath: string,
  syncFolder: string | null,
): Promise<void> {
  try {
    const result = await buildMp3Zip({
      bookDir,
      state,
      outPath,
      onProgress: (ratio) => {
        job.progress = ratio;
        jobs.set(job.id, { ...job });
      },
    });
    job.sizeBytes = result.sizeBytes;
    job.progress = 1;

    if (job.destination === 'sync-folder' && syncFolder) {
      const synced = await writeToSyncFolder(outPath, syncFolder, job.filename);
      job.syncPath = synced.syncPath;
    }
    job.downloadUrl = `/api/books/${encodeURIComponent(job.bookId)}/exports/${encodeURIComponent(job.id)}/download`;
    job.status = 'done';
    job.completedAt = new Date().toISOString();
  } catch (e) {
    job.status = 'failed';
    job.errorReason = e instanceof ExportIncompleteError
      ? `Export incomplete: ${e.missing.length} chapter(s) missing MP3 audio.`
      : (e as Error).message;
    job.completedAt = new Date().toISOString();
  } finally {
    jobs.set(job.id, { ...job });
    try {
      await writeJsonAtomic(manifestPath(bookDir, job.id), job);
    } catch {
      /* Manifest write is best-effort — failure to persist the manifest
         doesn't invalidate the artifact on disk. Next rehydrate will just
         miss this job; the artifact is still downloadable if the user
         still has the URL. */
    }
  }
}

/** Test-only: drop the in-memory job table. */
export function _resetExportJobs(): void {
  jobs.clear();
}
