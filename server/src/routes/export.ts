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
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { dotAudiobook, slug as slugify } from '../workspace/paths.js';
import { writeJsonAtomic } from '../workspace/state-io.js';
import { readUserSettings } from '../workspace/user-settings.js';
import { buildMp3Zip, ExportIncompleteError, sanitiseForZip } from '../export/build-mp3-zip.js';
import { buildM4b } from '../export/build-m4b.js';
import { buildMp3Folder } from '../export/build-mp3-folder.js';
import { writeFolderToSyncFolder, writeToSyncFolder } from '../export/sync-folder.js';

/* Mirrors the OpenAPI BookExportJob schema. Kept in sync by hand — the
   server doesn't import the generated frontend types. */
export interface BookExportJob {
  id: string;
  bookId: string;
  format: 'mp3-zip' | 'm4b' | 'mp3-folder';
  destination: 'download' | 'sync-folder';
  status: 'queued' | 'in_progress' | 'done' | 'failed' | 'cancelled';
  filename: string;
  sizeBytes: number | null;
  progress: number | null;
  downloadUrl: string | null;
  syncPath: string | null;
  errorReason: string | null;
  createdAt: string;
  completedAt: string | null;
}


const ALLOWED_FORMATS: ReadonlySet<BookExportJob['format']> = new Set(['mp3-zip', 'm4b', 'mp3-folder']);

export const exportRouter = Router();

/* In-memory job table. Cleared by tests via _resetExportJobs(). */
const jobs = new Map<string, BookExportJob>();

/* Sibling map of AbortControllers keyed by exportId. Populated when a
   POST creates a job, signalled by DELETE, deleted by runExportJob's
   finally. Lets cancellation propagate into the running build without
   the build functions having to know about jobs/jobControllers. */
const jobControllers = new Map<string, AbortController>();

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
  const base = slugify(state.title);
  if (format === 'mp3-zip') return `${base}.zip`;
  if (format === 'm4b')     return `${base}.m4b`;
  /* mp3-folder: the "filename" is actually the folder name the per-chapter
     MP3s land in (under both the staging dir and the sync target). The
     download endpoint refuses this format so the lack of a single-file
     extension never surfaces to the client. */
  return base;
}

exportRouter.post('/:bookId/exports', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { format?: string; destination?: string };
  if (typeof body.format !== 'string' || !ALLOWED_FORMATS.has(body.format as BookExportJob['format'])) {
    return res.status(400).json({ error: 'unsupported_format', message: `format must be 'mp3-zip', 'm4b', or 'mp3-folder'; got ${body.format ?? '(missing)'}.` });
  }
  const format = body.format as BookExportJob['format'];
  if (body.destination !== 'download' && body.destination !== 'sync-folder') {
    return res.status(400).json({ error: 'invalid_destination', message: `destination must be 'download' or 'sync-folder'.` });
  }
  /* Folder export only makes sense for an app that scans a folder on the
     device — the download endpoint serves a single file, so a folder +
     download combo would either need an inline zip (which is just
     mp3-zip) or a multi-file HTTP response (out of scope). Refuse the
     combo at the route layer so the frontend surfaces a clear error
     rather than a confusing 404 on the download endpoint later. */
  if (format === 'mp3-folder' && body.destination !== 'sync-folder') {
    return res.status(400).json({ error: 'invalid_destination', message: `mp3-folder exports require destination='sync-folder'; the folder is mirrored into the configured sync folder, not served via the download endpoint.` });
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
  const filename = bookFilename(located.state, format);
  const stagingDir = join(exportsDir(located.bookDir), exportId);
  await mkdir(stagingDir, { recursive: true });
  const outPath = join(stagingDir, filename);

  const job: BookExportJob = {
    id: exportId,
    bookId: located.state.bookId,
    format,
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
  const controller = new AbortController();
  jobControllers.set(exportId, controller);

  /* Fire-and-forget the actual build. The client polls getBookExport for
     progress + completion. */
  void runExportJob(job, located.bookDir, located.state, outPath, settings.exportSyncFolder, controller.signal);

  return res.status(201).json(job);
});

exportRouter.delete('/:bookId/exports/:exportId', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const job = jobs.get(req.params.exportId);
  if (!job || job.bookId !== located.state.bookId) return res.status(404).json({ error: 'export_not_found' });

  /* Idempotent: already-terminal jobs (done / failed / cancelled) reply
     204 without touching state. Lets the frontend retry a cancel click
     without surfacing a spurious error if the job finished in between. */
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    return res.status(204).end();
  }

  /* Mark cancelled BEFORE aborting the controller — runExportJob's
     catch checks `job.status === 'cancelled'` to decide whether to
     overwrite with 'failed', so the order matters. */
  job.status = 'cancelled';
  job.completedAt = new Date().toISOString();
  job.errorReason = 'Cancelled by user.';
  jobs.set(job.id, { ...job });

  const controller = jobControllers.get(job.id);
  controller?.abort();

  /* Best-effort manifest write so a server restart sees the cancelled
     state. If the disk write fails (the staging dir might already be
     gone), the in-memory state is still authoritative. */
  try {
    await writeJsonAtomic(manifestPath(located.bookDir, job.id), job);
  } catch {
    /* swallow */
  }

  /* Best-effort cleanup of the staging dir so cancelled jobs don't
     leak partial artifacts. The build's own finally clauses already
     remove their staging-* tmp dirs; this removes the export-id
     parent (which holds the final-output path that was about to be
     written). */
  const stagingDir = join(exportsDir(located.bookDir), job.id);
  await rm(stagingDir, { recursive: true, force: true }).catch(() => { /* leave it for next rehydrate */ });

  return res.status(204).end();
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
  if (job.format === 'mp3-folder') {
    /* mp3-folder artifacts live as a directory tree; the download
       endpoint serves single files. The route refuses the
       mp3-folder+download combo at create time, but a direct hit on
       this endpoint (e.g. somebody curling a manifest URL from an
       earlier release) gets a clear 409 instead of a 500 from sendFile
       trying to stream a directory. */
    return res.status(409).json({ error: 'format_not_downloadable', message: 'mp3-folder exports are mirrored into the sync folder, not served via the download endpoint.' });
  }

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
  signal: AbortSignal,
): Promise<void> {
  try {
    const onProgress = (ratio: number) => {
      job.progress = ratio;
      jobs.set(job.id, { ...job });
    };
    if (job.format === 'mp3-folder') {
      /* outPath is actually the staging folder for this format (one
         sub-directory per book under the export id). The builder writes
         per-chapter MP3s into it; the sync-folder branch then mirrors
         each file into the user's target via writeFolderToSyncFolder. */
      const folderResult = await buildMp3Folder({ bookDir, state, outDir: outPath, onProgress, signal });
      job.sizeBytes = folderResult.totalBytes;
      job.progress = 1;

      if (syncFolder) {
        const bookSubfolder = sanitiseForZip(state.title);
        const synced = await writeFolderToSyncFolder(outPath, syncFolder, bookSubfolder);
        job.syncPath = synced.syncPath;
      }
      /* No downloadUrl for folder exports — the route-layer guard
         already refuses the format + download combo, so leaving the
         field null is the honest signal that the artifact lives under
         the sync folder, not behind a single-file download. */
      job.downloadUrl = null;
    } else {
      const result = job.format === 'mp3-zip'
        ? await buildMp3Zip({ bookDir, state, outPath, onProgress, signal })
        : await buildM4b({ bookDir, state, outPath, onProgress, signal });
      job.sizeBytes = result.sizeBytes;
      job.progress = 1;

      if (job.destination === 'sync-folder' && syncFolder) {
        const synced = await writeToSyncFolder(outPath, syncFolder, job.filename);
        job.syncPath = synced.syncPath;
      }
      job.downloadUrl = `/api/books/${encodeURIComponent(job.bookId)}/exports/${encodeURIComponent(job.id)}/download`;
    }
    job.status = 'done';
    job.completedAt = new Date().toISOString();
  } catch (e) {
    /* Cancellation: the DELETE handler already flipped status to
       'cancelled' before signalling abort. Honour that — don't
       overwrite it with 'failed'. Same guard for races where the
       signal trips for any reason while DELETE hasn't run yet. */
    if (job.status === 'cancelled' || signal.aborted || (e as Error)?.name === 'AbortError') {
      if (job.status !== 'cancelled') {
        job.status = 'cancelled';
        job.completedAt = new Date().toISOString();
        job.errorReason = (e as Error)?.message || 'Cancelled.';
      }
    } else {
      job.status = 'failed';
      job.errorReason = e instanceof ExportIncompleteError
        ? `Export incomplete: ${e.missing.length} chapter(s) missing MP3 audio.`
        : (e as Error).message;
      job.completedAt = new Date().toISOString();
    }
  } finally {
    jobs.set(job.id, { ...job });
    jobControllers.delete(job.id);
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
  jobControllers.clear();
}
