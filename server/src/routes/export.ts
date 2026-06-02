/* POST /api/books/:bookId/exports        — create an export job
   GET  /api/books/:bookId/exports/:id    — poll job status
   GET  /api/books/:bookId/exports/:id/download — stream the artifact

   The body's `destination` chooses the post-build delivery: `download`
   stages the file under `<bookDir>/exports/<filename>` for the user to
   pull via the download endpoint AND pick up directly from File Explorer;
   `sync-folder` ADDITIONALLY copies the archive into
   `userSettings.exportSyncFolder` (e.g. OneDrive / Drive watch path) so
   it mirrors to the user's phone automatically.

   Plan 79 moved the artifact out of the hidden `.audiobook/exports/<id>/`
   jail into a visible sibling `exports/` folder. Filenames are flat —
   `<slug>.m4b`, `<slug>.zip`, etc. — and a re-export of the same format
   clobbers the previous artifact (newest wins). Per-job JSON manifests
   stay under `.audiobook/export-manifests/<exportId>.json` so the
   exports folder shows only artifacts the user actually picks up. When a
   new same-format build reaches `done`, older manifests of that format
   are revoked so the queue de-dupes naturally. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nanoid } from 'nanoid';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import {
  bookExportManifestsDir,
  bookExportsDir,
  slug as slugify,
} from '../workspace/paths.js';
import { writeJsonAtomic } from '../workspace/state-io.js';
import { readUserSettings } from '../workspace/user-settings.js';
import { buildMp3Zip, ExportIncompleteError, sanitiseForZip } from '../export/build-mp3-zip.js';
import { buildM4b } from '../export/build-m4b.js';
import { buildMp3Folder } from '../export/build-mp3-folder.js';
import { buildCodecZip } from '../export/build-codec-zip.js';
import { writeFolderToSyncFolder, writeToSyncFolder } from '../export/sync-folder.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';

/* Mirrors the OpenAPI BookExportJob schema. Kept in sync by hand — the
   server doesn't import the generated frontend types. */
export interface BookExportJob {
  id: string;
  bookId: string;
  /** Plan 72 widened the union with `aac-m4a-zip` and `opus-ogg-zip` — the
      codec-zip companions to `mp3-zip`. Same per-chapter packing
      contract; no ID3 retag (those containers use different metadata
      systems and the v1 wires straight from the encoded chapter
      files). */
  format: 'mp3-zip' | 'm4b' | 'mp3-folder' | 'aac-m4a-zip' | 'opus-ogg-zip';
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

const ALLOWED_FORMATS: ReadonlySet<BookExportJob['format']> = new Set([
  'mp3-zip',
  'm4b',
  'mp3-folder',
  'aac-m4a-zip',
  'opus-ogg-zip',
]);

export const exportRouter = Router();

/* In-memory job table. Cleared by tests via _resetExportJobs(). */
const jobs = new Map<string, BookExportJob>();

/* Sibling map of AbortControllers keyed by exportId. Populated when a
   POST creates a job, signalled by DELETE, deleted by runExportJob's
   finally. Lets cancellation propagate into the running build without
   the build functions having to know about jobs/jobControllers. */
const jobControllers = new Map<string, AbortController>();

function manifestPath(bookDir: string, exportId: string): string {
  return join(bookExportManifestsDir(bookDir), `${exportId}.json`);
}

/* Lazy rehydrate: on first lookup for a book, scan its manifests dir and
   reload any manifests we don't yet have in memory. Keeps download URLs
   working across server restarts. Per plan 79 we only look at the new
   `.audiobook/export-manifests/` dir; any orphans the user has at the
   old `.audiobook/exports/<id>/manifest.json` path are ignored (their
   queue rows stay gone, the user re-exports if they care). Manifests
   whose referenced artifact no longer exists on disk are dropped during
   the same scan — that keeps stale "Done" rows from pointing at files
   the user deleted from the exports folder. */
async function rehydrateBook(bookDir: string, bookId: string): Promise<void> {
  const dir = bookExportManifestsDir(bookDir);
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const manifest = join(dir, name);
    try {
      const raw = await readFile(manifest, 'utf8');
      const job = JSON.parse(raw) as BookExportJob;
      if (!job.id || job.bookId !== bookId) continue;
      /* Drop any manifest whose artifact has gone missing — keeps the
         queue honest after the user deletes files from the exports
         folder. mp3-folder jobs reference a directory; existsSync handles
         both files and dirs the same way. */
      if (job.status === 'done') {
        const artifact = resolveArtifactPath(bookDir, job);
        if (!existsSync(artifact)) {
          await unlink(manifest).catch(() => {});
          continue;
        }
      }
      if (!jobs.has(job.id)) jobs.set(job.id, job);
    } catch {
      /* Corrupt manifest — skip, don't fail the GET. */
    }
  }
}

/* Resolve the on-disk artifact path for a job. The manifest stores
   `filename` (e.g. `<slug>.m4b` or `<slug>` for mp3-folder); we join it
   against the per-book exports dir at read time so the workspace can
   move between machines without breaking download links. */
function resolveArtifactPath(bookDir: string, job: BookExportJob): string {
  return join(bookExportsDir(bookDir), job.filename);
}

/* Plan 79 — when a new same-format export finishes, revoke any prior
   manifest for the SAME book+format. The queue rail shows one row per
   format; clobber-newest-wins on disk plus this revocation keeps the
   in-memory + persisted state consistent. */
async function revokeStaleSameFormat(
  bookDir: string,
  bookId: string,
  format: BookExportJob['format'],
  keepId: string,
): Promise<void> {
  const dir = bookExportManifestsDir(bookDir);
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = basename(name, '.json');
    if (id === keepId) continue;
    const path = join(dir, name);
    try {
      const raw = await readFile(path, 'utf8');
      const prior = JSON.parse(raw) as BookExportJob;
      if (prior.bookId !== bookId || prior.format !== format) continue;
      jobs.delete(prior.id);
      await unlink(path).catch(() => {});
    } catch {
      /* Corrupt manifest — leave alone; the rehydrate scan will see it. */
    }
  }
}

function bookFilename(state: BookStateJson, format: BookExportJob['format']): string {
  const base = slugify(state.title);
  if (format === 'mp3-zip') return `${base}.zip`;
  if (format === 'm4b') return `${base}.m4b`;
  /* Codec-zip variants (plan 72) — separate slug suffix so a user can hold
     all three zip variants of the same book in the same staging dir
     without name collisions. */
  if (format === 'aac-m4a-zip') return `${base}-aac.zip`;
  if (format === 'opus-ogg-zip') return `${base}-opus.zip`;
  /* mp3-folder: the "filename" is actually the folder name the per-chapter
     MP3s land in (under both the staging dir and the sync target). The
     download endpoint refuses this format so the lack of a single-file
     extension never surfaces to the client. */
  return base;
}

exportRouter.post('/:bookId/exports', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { format?: string; destination?: string };
  if (
    typeof body.format !== 'string' ||
    !ALLOWED_FORMATS.has(body.format as BookExportJob['format'])
  ) {
    return res
      .status(400)
      .json({
        error: 'unsupported_format',
        message: `format must be 'mp3-zip', 'm4b', or 'mp3-folder'; got ${body.format ?? '(missing)'}.`,
      });
  }
  const format = body.format as BookExportJob['format'];
  if (body.destination !== 'download' && body.destination !== 'sync-folder') {
    return res
      .status(400)
      .json({
        error: 'invalid_destination',
        message: `destination must be 'download' or 'sync-folder'.`,
      });
  }
  /* Folder export only makes sense for an app that scans a folder on the
     device — the download endpoint serves a single file, so a folder +
     download combo would either need an inline zip (which is just
     mp3-zip) or a multi-file HTTP response (out of scope). Refuse the
     combo at the route layer so the frontend surfaces a clear error
     rather than a confusing 404 on the download endpoint later. */
  if (format === 'mp3-folder' && body.destination !== 'sync-folder') {
    return res
      .status(400)
      .json({
        error: 'invalid_destination',
        message: `mp3-folder exports require destination='sync-folder'; the folder is mirrored into the configured sync folder, not served via the download endpoint.`,
      });
  }

  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });

  const settings = await readUserSettings();
  if (body.destination === 'sync-folder' && !settings.exportSyncFolder) {
    return res
      .status(400)
      .json({
        error: 'sync_folder_unset',
        message:
          'exportSyncFolder is not configured. Set it under Account before using the sync-folder destination.',
      });
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
  /* Plan 79 — flat layout under the user-visible <bookDir>/exports/.
     Same-format re-exports clobber the prior artifact (newest wins).
     The matching manifest lives under .audiobook/export-manifests/. */
  const exportsRoot = bookExportsDir(located.bookDir);
  await mkdir(exportsRoot, { recursive: true });
  await mkdir(bookExportManifestsDir(located.bookDir), { recursive: true });
  const outPath = join(exportsRoot, filename);

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
  void runExportJob(
    job,
    located.bookDir,
    located.state,
    outPath,
    settings.exportSyncFolder,
    controller.signal,
  );

  return res.status(201).json(job);
});

exportRouter.delete('/:bookId/exports/:exportId', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const job = jobs.get(req.params.exportId);
  if (!job || job.bookId !== located.state.bookId)
    return res.status(404).json({ error: 'export_not_found' });

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

  /* Plan 79 — best-effort cleanup of any partial artifact. For
     single-file formats, runExportJob's catch already unlinks the
     `.partial-<id>` tmp; this clears the final-path file too in case
     the rename had already completed before cancel landed. For
     mp3-folder, the builder writes per-chapter MP3s directly into the
     destination folder so we rm-recursive it. Do NOT rm the exports/
     parent — other completed exports of this book live there. */
  if (job.filename) {
    const artifact = resolveArtifactPath(located.bookDir, job);
    if (job.format === 'mp3-folder') {
      await rm(artifact, { recursive: true, force: true }).catch(() => {});
    } else {
      await unlink(artifact).catch(() => {});
    }
  }

  return res.status(204).end();
});

exportRouter.get('/:bookId/exports/:exportId', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const job = jobs.get(req.params.exportId);
  if (!job || job.bookId !== located.state.bookId)
    return res.status(404).json({ error: 'export_not_found' });
  return res.json(job);
});

exportRouter.get('/:bookId/exports/:exportId/download', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const job = jobs.get(req.params.exportId);
  if (!job || job.bookId !== located.state.bookId)
    return res.status(404).json({ error: 'export_not_found' });
  if (job.status !== 'done')
    return res.status(409).json({ error: 'export_not_ready', status: job.status });
  if (job.format === 'mp3-folder') {
    /* mp3-folder artifacts live as a directory tree; the download
       endpoint serves single files. The route refuses the
       mp3-folder+download combo at create time, but a direct hit on
       this endpoint (e.g. somebody curling a manifest URL from an
       earlier release) gets a clear 409 instead of a 500 from sendFile
       trying to stream a directory. */
    return res
      .status(409)
      .json({
        error: 'format_not_downloadable',
        message:
          'mp3-folder exports are mirrored into the sync folder, not served via the download endpoint.',
      });
  }

  const path = resolveArtifactPath(located.bookDir, job);
  if (!existsSync(path)) return res.status(404).json({ error: 'export_artifact_missing' });
  res.sendFile(
    path,
    {
      headers: {
        'Content-Type': mimeForFormat(job.format),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(job.filename)}"`,
        'Cache-Control': 'no-cache',
      },
    },
    (err) => {
      if (err && !res.headersSent) res.status(500).end();
    },
  );
});

function mimeForFormat(format: BookExportJob['format']): string {
  if (format === 'm4b') return 'audio/mp4';
  /* Every other format (mp3-zip / aac-m4a-zip / opus-ogg-zip) is a zip
     archive. mp3-folder isn't downloadable (the route refuses it) so
     this branch never fires for that format. */
  return 'application/zip';
}

function preflightMissingChapters(state: BookStateJson, bookDir: string): string[] {
  const root = join(bookDir, 'audio');
  const out: string[] = [];
  for (const chapter of state.chapters) {
    if (chapter.excluded) continue;
    /* Plan 72: a chapter is present when *any* recognised encoded file
       (mp3 / m4a / ogg) lives next to it. The per-format builder is the
       gate that surfaces a more specific missing list when the chapter
       exists but in the wrong codec. */
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) out.push(chapter.slug);
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
      const folderResult = await buildMp3Folder({
        bookDir,
        state,
        outDir: outPath,
        onProgress,
        signal,
      });
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
      /* Plan 79 — write to a hidden `.partial-<exportId>` tmp first, then
         atomic-rename to the final flat-named artifact at completion.
         Without this, two concurrent same-format builds would race
         createWriteStream on the same final path; on Windows that surfaces
         as EBUSY/EPERM, on POSIX it interleaves bytes. The partial-then-
         rename pattern matches sync-folder.ts's tmp+renameWithRetry shape
         so the final clobber is atomic for any reader (the download
         endpoint, the user's File Explorer, the sync-folder copy). */
      const buildPath = join(bookExportsDir(bookDir), `.${job.filename}.partial-${job.id}`);
      try {
        const result =
          job.format === 'mp3-zip'
            ? await buildMp3Zip({ bookDir, state, outPath: buildPath, onProgress, signal })
            : job.format === 'm4b'
              ? await buildM4b({ bookDir, state, outPath: buildPath, onProgress, signal })
              : await buildCodecZip({
                  bookDir,
                  state,
                  outPath: buildPath,
                  format: job.format === 'aac-m4a-zip' ? 'aac-m4a' : 'opus',
                  onProgress,
                  signal,
                });
        job.sizeBytes = result.sizeBytes;
        job.progress = 1;
        await renameWithRetry(buildPath, outPath);
      } catch (e) {
        /* On any failure (including cancel) the partial file is dropped
           so a `<bookDir>/exports/` listing never shows half-baked
           artifacts. Best-effort — if the rename above already moved it
           there's nothing to unlink. */
        await unlink(buildPath).catch(() => {});
        throw e;
      }

      if (job.destination === 'sync-folder' && syncFolder) {
        const synced = await writeToSyncFolder(outPath, syncFolder, job.filename);
        job.syncPath = synced.syncPath;
      }
      job.downloadUrl = `/api/books/${encodeURIComponent(job.bookId)}/exports/${encodeURIComponent(job.id)}/download`;
    }
    job.status = 'done';
    job.completedAt = new Date().toISOString();
    /* Plan 79 — clobber-newest-wins on disk PLUS revoke any older
       manifest for the same (book, format). Together they keep the
       queue de-duped: one row per format, always pointing at the
       latest build. Older artifacts on disk were already overwritten
       by this build's atomic-rename; older manifests would otherwise
       linger forever. */
    await revokeStaleSameFormat(bookDir, job.bookId, job.format, job.id);
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
      job.errorReason =
        e instanceof ExportIncompleteError
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
