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
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { nanoid } from 'nanoid';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { BOOK_GONE, withBookOp } from '../workspace/book-op-lock.js';
import { runBookJob, type BookJobLease } from '../workspace/book-jobs.js';
import { requestFailureMessage, requestFailureMessageFs } from '../workspace/file-lock.js';
import {
  bookExportManifestsDir,
  bookExportsDir,
  slug as slugify,
} from '../workspace/paths.js';
import { writeJsonAtomicOrdered } from '../workspace/ordered-write.js';
import { readUserSettings } from '../workspace/user-settings.js';
import { buildMp3Zip, ExportIncompleteError, sanitiseForZip } from '../export/build-mp3-zip.js';
import { buildM4b } from '../export/build-m4b.js';
import { buildMp3Folder } from '../export/build-mp3-folder.js';
import { buildCodecZip } from '../export/build-codec-zip.js';
import { buildCaptions } from '../export/build-captions.js';
import {
  commitSyncStage,
  discardSyncStage,
  stageToSyncFolder,
  writeFolderToSyncFolder,
  type SyncStage,
} from '../export/sync-folder.js';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findChapterAudio } from '../workspace/chapter-take.js';
import { sanitizeIdSegment } from '../util/safe-path.js';
import { pathForClientOrNull } from '../lan-paths.js';
import {
  AVG_CHAPTER_BYTES,
  diskGuardMode,
  evaluateDiskGuard,
} from '../workspace/disk-guard.js';

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
  format: 'mp3-zip' | 'm4b' | 'mp3-folder' | 'aac-m4a-zip' | 'opus-ogg-zip' | 'captions';
  /** fs-52 — only set (and only meaningful) when format === 'captions'.
      Persisted on the job record (not just the request) so revokeStaleSameFormat's
      de-dupe key survives a server restart via rehydrateBook. */
  captionFileFormat?: 'srt' | 'vtt';
  captionGranularity?: 'line' | 'sentence' | 'word';
  captionScope?: 'whole-book' | 'per-chapter';
  destination: 'download' | 'sync-folder';
  /** `cancelling` is non-terminal: DELETE asked the job to stop and its work is
      still running; `cancelled` is set only once that work has stopped. */
  status: 'queued' | 'in_progress' | 'cancelling' | 'done' | 'failed' | 'cancelled';
  filename: string;
  sizeBytes: number | null;
  progress: number | null;
  downloadUrl: string | null;
  syncPath: string | null;
  /** True while an un-cancellable sync-folder copy is in flight (the mp3-folder
      copy, or a single-file commit rename). A client that cancelled keeps
      following the job until this clears, then reads `syncPath` to learn
      whether the copy landed anyway (#4228). */
  syncCopyInFlight?: boolean | null;
  errorReason: string | null;
  createdAt: string;
  completedAt: string | null;
  /** Round-2-of-plan-review decision (fs-52): a non-fatal, PERSISTED
      heads-up — distinct from the disk-guard's ad-hoc POST-response-only
      `warning` (bolted onto the 201 body via object spread, never stored
      on `job`). This one is set on the job object itself once the async
      build completes, so it survives into the manifest and the polling
      `GET`. Currently only `buildCaptions` sets it (unverifiable
      pre-#1105 staleness); `null`/absent otherwise. */
  warning?: string | null;
}

const ALLOWED_FORMATS: ReadonlySet<BookExportJob['format']> = new Set([
  'mp3-zip',
  'm4b',
  'mp3-folder',
  'aac-m4a-zip',
  'opus-ogg-zip',
  'captions',
]);

export const exportRouter = Router();

/* In-memory job table. Cleared by tests via _resetExportJobs(). */
const jobs = new Map<string, BookExportJob>();

/* Sibling map of AbortControllers keyed by exportId. Populated when a
   POST creates a job, signalled by DELETE, deleted by runExportJob's
   finally. Lets cancellation propagate into the running build without
   the build functions having to know about jobs/jobControllers. */
const jobControllers = new Map<string, AbortController>();

/* Sibling map of the fire-and-forget runExportJob promise itself, keyed by
   exportId. Populated alongside jobControllers, self-removes once the job
   settles. Exists so a caller (today: only test teardown, via
   _awaitInFlightExportJobs) can wait for every in-flight job to fully
   finish — including its own `finally` (manifest write) — before doing
   anything destructive to the workspace those jobs are still reading/
   writing. Nothing in production code awaits this map; runExportJob is
   still fire-and-forget from the route's point of view. */
const jobPromises = new Map<string, Promise<void>>();

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
        /* An mp3-folder swap moves the previous folder to a dot-prefixed
           `.<slug>.old-<id>` before moving the new one in, so the flat name is
           briefly absent mid-swap (a GET can land there) and stays absent after
           a crash between the two renames. That manifest still describes a
           real export: keep it rather than dropping the previous `done` row
           (#4228). */
        if (!existsSync(artifact) && !(await hasSwapAside(bookDir, job))) {
          await unlink(manifest).catch(() => {});
          continue;
        }
      }
      /* A restart means no sync copy is in flight, whatever the manifest says
         (a DELETE during the copy persisted `true`). */
      if (job.syncCopyInFlight) job.syncCopyInFlight = false;
      /* Likewise `cancelling`: the process doing that work is gone, so the work
         has stopped. A job still running here is already in the map, which wins
         below. The manifest is not rewritten. */
      if (job.status === 'cancelling') markCancelled(job, cancelReason(job.syncPath));
      if (!jobs.has(job.id)) jobs.set(job.id, job);
    } catch {
      /* Corrupt manifest — skip, don't fail the GET. */
    }
  }
}

/* True when the exports folder holds a `.<filename>.old-<id>` swap-aside for
   this job's flat name (see swapFolderIntoPlace). */
async function hasSwapAside(bookDir: string, job: BookExportJob): Promise<boolean> {
  const prefix = `.${sanitizeIdSegment(job.filename)}.old-`;
  try {
    return (await readdir(bookExportsDir(bookDir))).some((n) => n.startsWith(prefix));
  } catch {
    return false;
  }
}

/* Resolve the on-disk artifact path for a job. The manifest stores
   `filename` (e.g. `<slug>.m4b` or `<slug>` for mp3-folder); we join it
   against the per-book exports dir at read time so the workspace can
   move between machines without breaking download links. */
function resolveArtifactPath(bookDir: string, job: BookExportJob): string {
  /* `job.filename` is derived from the book title (slugified) but can also be
     rehydrated from an on-disk manifest, so sanitise it as a single path
     segment at every join. sanitizeIdSegment is a no-op on real export
     filenames (`<slug>.zip`, `<slug>.sentence.srt`) — no separators, no `..`
     runs — but neutralises any `..`/separator a tampered manifest could carry. */
  return join(bookExportsDir(bookDir), sanitizeIdSegment(job.filename));
}

/* Plan 79 — when a new same-format export finishes, revoke any prior
   manifest for the SAME book+format. The queue rail shows one row per
   format; clobber-newest-wins on disk plus this revocation keeps the
   in-memory + persisted state consistent. */
async function revokeStaleSameFormat(
  bookDir: string,
  bookId: string,
  job: BookExportJob,
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
      if (prior.bookId !== bookId || prior.format !== job.format) continue;
      if (
        job.format === 'captions' &&
        (prior.captionFileFormat !== job.captionFileFormat ||
          prior.captionGranularity !== job.captionGranularity ||
          prior.captionScope !== job.captionScope)
      ) {
        continue; // different caption variant — not stale, don't revoke.
      }
      jobs.delete(prior.id);
      await unlink(path).catch(() => {});
    } catch {
      /* Corrupt manifest — leave alone; the rehydrate scan will see it. */
    }
  }
}

function bookFilename(
  state: BookStateJson,
  format: BookExportJob['format'],
  captionOpts?: {
    captionFileFormat?: 'srt' | 'vtt';
    captionGranularity?: 'line' | 'sentence' | 'word';
    captionScope?: 'whole-book' | 'per-chapter';
  },
): string {
  const base = slugify(state.title);
  if (format === 'mp3-zip') return `${base}.zip`;
  if (format === 'm4b') return `${base}.m4b`;
  /* Codec-zip variants (plan 72) — separate slug suffix so a user can hold
     all three zip variants of the same book in the same staging dir
     without name collisions. */
  if (format === 'aac-m4a-zip') return `${base}-aac.zip`;
  if (format === 'opus-ogg-zip') return `${base}-opus.zip`;
  if (format === 'captions') {
    const { captionFileFormat, captionGranularity, captionScope } = captionOpts ?? {};
    const variant = `${captionGranularity}.${captionFileFormat}`;
    return captionScope === 'per-chapter' ? `${base}.${variant}.zip` : `${base}.${variant}`;
  }
  /* mp3-folder: the "filename" is actually the folder name the per-chapter
     MP3s land in (under both the staging dir and the sync target). The
     download endpoint refuses this format so the lack of a single-file
     extension never surfaces to the client. */
  return base;
}

/* Nit (c) (independent review): `_awaitInFlightExportJobs()` snapshots
   `jobPromises` atomically, but a POST parked on the pre-flight work below
   (mkdir / disk-guard probe, both awaited BEFORE a job exists) hasn't
   registered into `jobPromises` yet — it would do so AFTER the snapshot,
   escaping the drain entirely. `pendingPostCreations` closes that window:
   every POST call registers itself here for its own full duration (via
   the wrapper below) and `_awaitInFlightExportJobs` waits for all
   currently-registered ones to finish BEFORE taking its `jobPromises`
   snapshot, so a request that's mid-preflight when the drain starts is
   guaranteed to have either responded with no job created, or registered
   its job, by the time the snapshot happens. */
const pendingPostCreations = new Set<Promise<void>>();

/** How `createExportJob` registers its `export` job. Injected by the route handler so the
    registration token sits in the handler itself (the book-op guard reads handlers
    lexically and cannot follow a helper -- see book-op-lock.guard.test.ts). */
type RegisterExportJob = <T>(
  bookId: string,
  fn: (lease: BookJobLease) => Promise<T>,
) => Promise<typeof BOOK_GONE | { done: Promise<T> }>;

async function createExportJob(
  req: Request,
  res: Response,
  register: RegisterExportJob,
): Promise<Response | void> {
  const body = (req.body ?? {}) as {
    format?: string;
    destination?: string;
    captionFileFormat?: string;
    captionGranularity?: string;
    captionScope?: string;
  };
  if (
    typeof body.format !== 'string' ||
    !ALLOWED_FORMATS.has(body.format as BookExportJob['format'])
  ) {
    return res
      .status(400)
      .json({
        error: 'unsupported_format',
        message: `format must be 'mp3-zip', 'm4b', 'mp3-folder', 'aac-m4a-zip', 'opus-ogg-zip', or 'captions'; got ${body.format ?? '(missing)'}.`,
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
  const captionFileFormat = body.captionFileFormat as 'srt' | 'vtt' | undefined;
  const captionGranularity = body.captionGranularity as 'line' | 'sentence' | 'word' | undefined;
  const captionScope = body.captionScope as 'whole-book' | 'per-chapter' | undefined;
  if (format === 'captions') {
    if (captionFileFormat !== 'srt' && captionFileFormat !== 'vtt') {
      return res.status(400).json({
        error: 'invalid_caption_file_format',
        message: `captionFileFormat must be 'srt' or 'vtt'; got ${captionFileFormat ?? '(missing)'}.`,
      });
    }
    if (
      captionGranularity !== 'line' &&
      captionGranularity !== 'sentence' &&
      captionGranularity !== 'word'
    ) {
      return res.status(400).json({
        error: 'invalid_caption_granularity',
        message: `captionGranularity must be 'line', 'sentence', or 'word'; got ${captionGranularity ?? '(missing)'}.`,
      });
    }
    if (captionScope !== 'whole-book' && captionScope !== 'per-chapter') {
      return res.status(400).json({
        error: 'invalid_caption_scope',
        message: `captionScope must be 'whole-book' or 'per-chapter'; got ${captionScope ?? '(missing)'}.`,
      });
    }
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

  /* #3711 — the export is a registered `export` job (it archives the whole book): a
     folder move/delete is refused (409 book_busy) from the start of this pre-flight
     until the build settles. The book and its CURRENT folder come from the lease,
     resolved under book-op. Detached: `fn` runs the pre-start checks, sends the
     response, then awaits the build; this handler waits only for the registration and
     for `fn` to have responded (so `pendingPostCreations` still means "this POST has
     either created no job or registered it in `jobPromises`"). */
  const destination: 'download' | 'sync-folder' = body.destination;
  let markResponded: () => void = () => {};
  const responded = new Promise<void>((resolve) => {
    markResponded = resolve;
  });
  let registered;
  try {
    registered = await register(req.params.bookId, async (located) => {
  try {
  const settings = await readUserSettings();
  if (destination === 'sync-folder' && !settings.exportSyncFolder) {
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

  /* srv-28 — pre-flight disk-space guard. An export packs the existing chapter
     audio into a single archive/container, so the output is roughly the sum of
     the chapter files plus a small temp/metadata overhead. BLOCK mode 409s
     before the job is created; WARN mode attaches a `warning` to the 201 body
     so the export modal can surface it; OFF skips. Best-effort: a probe failure
     never blocks the export. */
  const diskMode = diskGuardMode();
  let diskWarning: string | undefined;
  if (diskMode !== 'off') {
    try {
      const exportsRootForProbe = bookExportsDir(located.bookDir);
      await mkdir(exportsRootForProbe, { recursive: true });
      const verdict = await evaluateDiskGuard(
        exportsRootForProbe,
        { estimatedBytes: estimateExportBytes(located.state, located.bookDir, format), basis: 'export' },
        { mode: diskMode },
      );
      if (verdict.status === 'block') {
        return res.status(409).json({ error: 'disk_full', message: verdict.message });
      }
      if (verdict.status === 'warn') {
        diskWarning = verdict.message;
      }
    } catch (e) {
      console.warn('[export] disk guard probe failed (continuing):', (e as Error).message);
    }
  }

  const exportId = `exp_${nanoid(10)}`;
  const filename = bookFilename(located.state, format, { captionFileFormat, captionGranularity, captionScope });
  /* Plan 79 — flat layout under the user-visible <bookDir>/exports/.
     Same-format re-exports clobber the prior artifact (newest wins).
     The matching manifest lives under .audiobook/export-manifests/. */
  const exportsRoot = bookExportsDir(located.bookDir);
  await mkdir(exportsRoot, { recursive: true });
  await mkdir(bookExportManifestsDir(located.bookDir), { recursive: true });
  const outPath = join(exportsRoot, sanitizeIdSegment(filename));

  const job: BookExportJob = {
    id: exportId,
    bookId: located.state.bookId,
    format,
    captionFileFormat: format === 'captions' ? captionFileFormat : undefined,
    captionGranularity: format === 'captions' ? captionGranularity : undefined,
    captionScope: format === 'captions' ? captionScope : undefined,
    destination,
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
     progress + completion. runExportJob's own try/catch/finally already
     turns every failure it knows about into a 'failed' job — the .catch
     here is a backstop for anything that ever slips past that (a future
     change adding code after the try/catch, a bug in the catch/finally
     itself), not the primary failure path. Without it, an escaped
     rejection here is an unhandled promise rejection: this server's own
     crash-logging.ts survives an unhandledRejection (logs + continues),
     so this specific case wouldn't take the process down — but the job
     would otherwise vanish silently instead of reporting through the
     same polling API every other failure uses. */
  const jobPromise = runExportJob(
    job,
    located.bookDir,
    located.state,
    outPath,
    settings.exportSyncFolder,
    controller.signal,
  )
    .catch(async (e) => {
      console.error(`[export] runExportJob rejected unexpectedly for ${job.id}:`, e);
      job.status = 'failed';
      job.errorReason = requestFailureMessageFs(e, (e as Error)?.message || 'Export failed unexpectedly.');
      job.completedAt = new Date().toISOString();
      jobs.set(job.id, { ...job });
      jobControllers.delete(job.id);
      /* Finding 5 (independent review): runExportJob's own `finally` already
         wrote SOME manifest for this job before this backstop ever ran. If
         the escaped rejection originated from within runExportJob's own
         catch block (e.g. a non-Error thrown by a builder makes `(e as
         Error).message` at that catch's own error-message line throw a
         SECOND time — verified: this is exactly the shape that reaches
         here), that manifest reflects an earlier, incomplete snapshot —
         `errorReason`/`completedAt` never got set before the second throw
         cut the catch block short. This backstop fixes those fields up
         above, but only in memory unless we persist it too — without this,
         a restart rehydrates the stale manifest instead of the corrected
         one. Best-effort, same as runExportJob's own finally. */
      try {
        await writeJsonAtomicOrdered(manifestPath(located.bookDir, job.id), job);
      } catch {
        /* swallow — matches runExportJob's own finally */
      }
    })
    .finally(() => {
      jobPromises.delete(exportId);
    });
  jobPromises.set(exportId, jobPromise);

  /* srv-28 — ride the disk-low advisory back on the 201 body (warn mode). The
     export modal surfaces `warning` next to the queued job; the build still
     proceeds. Omitted entirely when the guard was ok / off. */
  const wireJob = exportJobForClient(req, job);
  res.status(201).json(diskWarning ? { ...wireJob, warning: diskWarning } : wireJob);
  markResponded();
  await jobPromise;
  } finally {
    markResponded();
  }
    });
  } catch (e) {
    console.error('[export] job registration failed', e);
    return res.status(500).json({ error: requestFailureMessage(e, 'Could not start the export.') });
  }
  if (registered === BOOK_GONE) return res.status(404).json({ error: 'book_not_found' });
  registered.done.catch((e) => {
    console.error('[export] export job failed to start', e);
    if (!res.headersSent) {
      res.status(500).json({ error: requestFailureMessage(e, 'Could not start the export.') });
    }
  });
  await responded;
}

exportRouter.post('/:bookId/exports', async (req: Request, res: Response) => {
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  pendingPostCreations.add(gate);
  try {
    return await createExportJob(req, res, (bookId, fn) => runBookJob(bookId, 'export', fn));
  } finally {
    /* Runs on every exit path (early-return error response, or the
       success path after `jobPromises.set(...)`) — by the time this
       fires, this POST has either created no job at all or has already
       registered its job into `jobPromises`. */
    releaseGate();
    pendingPostCreations.delete(gate);
  }
});

exportRouter.get('/:bookId/exports', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const list = [...jobs.values()]
    .filter((j) => j.bookId === located.state.bookId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return res.json(list.map((j) => exportJobForClient(req, j)));
});

exportRouter.delete('/:bookId/exports/:exportId', async (req: Request, res: Response) => {
  /* #3711 -- QUICK book-folder writer (the cancel's manifest write; it removes no artifact, #4228):
     holds book-op for its whole span, so a rename queued behind it lands in the new
     folder and this never recreates the old one. The cancelled job's token is released
     by its own `runBookJob`, so the cancel itself is not blocked by it. */
  let outcome;
  try {
    outcome = await withBookOp(req.params.bookId, async (located) => {
  await rehydrateBook(located.bookDir, located.state.bookId);
  const job = jobs.get(req.params.exportId);
  if (!job || job.bookId !== located.state.bookId)
    return res.status(404).json({ error: 'export_not_found' });

  /* Idempotent: a job already cancelling or terminal (done / failed /
     cancelled) replies 204 without touching state. Lets the frontend retry a
     cancel click without surfacing a spurious error if the job finished in
     between. */
  if (job.status !== 'queued' && job.status !== 'in_progress') {
    return res.status(204).end();
  }

  /* A running build is only asked to stop: the job reads `cancelling` until
     runExportJob has seen the abort and torn down, and it alone writes
     `cancelled`. With no controller nothing is building (a manifest left over
     from a process that died), so nothing would ever finish a `cancelling` job:
     it ends `cancelled` here. A COPY goes into the map: the entry may be
     runExportJob's own object, which DELETE never edits. */
  const controller = jobControllers.get(job.id);
  const next: BookExportJob = { ...job };
  if (controller) next.status = 'cancelling';
  else markCancelled(next, cancelReason(next.syncPath));
  jobs.set(next.id, next);
  controller?.abort();

  /* Best-effort manifest write so a server restart sees the cancel. If the
     disk write fails (the staging dir might already be gone), the in-memory
     state is still authoritative. */
  try {
    await writeJsonAtomicOrdered(manifestPath(located.bookDir, next.id), next);
  } catch {
    /* swallow */
  }

  /* Nothing is removed here (#4228). Every format builds into a job-private
     path (`.partial-<id>` file, or the mp3-folder staging folder) that
     runExportJob's own catch drops on the abort above, and the flat final
     name holds the PREVIOUS completed export until the job's own commit.
     Do NOT rm the exports/ parent: other completed exports of this book live
     there. */

  return res.status(204).end();
    });
  } catch (e) {
    console.error('[export] cancel failed', e);
    return res.status(500).json({ error: requestFailureMessage(e, 'Could not cancel the export.') });
  }
  if (outcome === BOOK_GONE) return res.status(404).json({ error: 'book_not_found' });
  return outcome;
});

exportRouter.get('/:bookId/exports/:exportId', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });
  await rehydrateBook(located.bookDir, located.state.bookId);
  const job = jobs.get(req.params.exportId);
  if (!job || job.bookId !== located.state.bookId)
    return res.status(404).json({ error: 'export_not_found' });
  return res.json(exportJobForClient(req, job));
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
        'Content-Type': mimeForFormat(job),
        'Content-Disposition': `attachment; filename="${encodeURIComponent(job.filename)}"`,
        'Cache-Control': 'no-cache',
      },
      /* `path` is fully server-computed from a validated bookId/exportId
         lookup, never client input — so `send`'s dotfile guard (any
         ancestor path segment starting with `.`, e.g. a workspace nested
         under a `.claude/worktrees/...` checkout) is a false positive
         here, not a real security boundary. Without this, the guard
         silently turns a perfectly valid request into a 404-shaped
         internal error that the catch-all below then flattens into an
         opaque, unlogged 500 (bug #1290's pattern). */
      dotfiles: 'allow',
    },
    (err) => {
      if (!err) return;
      const status = (err as { status?: number }).status ?? 500;
      /* Template literal, not `%s` placeholders: logger.ts's timestamp patch
         inserts the timestamp as the first argument, so this string is never
         treated as a format string and a `%s` here would print literally
         (logger.test.ts pins this). */
      console.error(
        `[export] sendFile failed for ${path}${res.headersSent ? ' (after headers sent)' : ''}: ${err.message}`,
        { status },
      );
      if (!res.headersSent) res.status(status).end();
    },
  );
});

function mimeForFormat(job: BookExportJob): string {
  if (job.format === 'm4b') return 'audio/mp4';
  if (job.format === 'captions' && job.captionScope === 'whole-book') {
    return job.captionFileFormat === 'vtt' ? 'text/vtt' : 'application/x-subrip';
  }
  /* Every other case (mp3-zip / aac-m4a-zip / opus-ogg-zip / per-chapter
     captions) is a zip archive. mp3-folder isn't downloadable (the route
     refuses it) so this branch never fires for that format. */
  return 'application/zip';
}

/* srv-28 — estimate an export's output footprint. An export packs the existing
   chapter audio into one archive/container, so the output is ~the sum of the
   chapter files; we add a 20 % overhead buffer for the temp staging copy +
   container metadata + zip framing. Best-effort: a chapter whose size can't be
   read falls back to AVG_CHAPTER_BYTES so the estimate never under-counts to
   zero. */
function estimateExportBytes(state: BookStateJson, bookDir: string, format: BookExportJob['format']): number {
  if (format === 'captions') {
    /* Captions are plain text derived from data already on disk — a few
       KB per chapter at most, nowhere near audio-file scale. A flat
       per-chapter estimate keeps the disk-guard meaningful without
       walking chapter audio sizes for a build that doesn't need them. */
    const chapterCount = state.chapters.filter((c) => !c.excluded).length;
    return chapterCount * 4096;
  }
  const root = join(bookDir, 'audio');
  let total = 0;
  for (const chapter of state.chapters) {
    if (chapter.excluded) continue;
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) continue;
    try {
      total += statSync(audio.path).size;
    } catch {
      total += AVG_CHAPTER_BYTES;
    }
  }
  return Math.round(total * 1.2);
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

/* #4446 — response copy of a job with the home dir collapsed in `syncPath` for
   LAN clients. The stored job keeps the absolute path (display-only on the wire). */
export function exportJobForClient(req: Request, job: BookExportJob): BookExportJob {
  return { ...job, syncPath: pathForClientOrNull(req, job.syncPath) };
}

/* Reason recorded on a cancelled job. A cancel that lands after the sync-folder
   copy leaves the copy and `syncPath` (never delete in the user's sync folder),
   so the record says so instead of reading like nothing was written (#4228). */
function cancelReason(syncPath: string | null): string {
  return syncPath
    ? 'Cancelled by user. The files were already copied to the sync folder.'
    : 'Cancelled by user.';
}

/* The one shape of a finished cancel. */
function markCancelled(job: BookExportJob, reason: string): void {
  job.status = 'cancelled';
  job.completedAt = new Date().toISOString();
  job.errorReason = reason;
}

/* Publish a freshly set `syncPath` to the jobs map without copying
   runExportJob's own object over the entry: DELETE may already have set the
   map entry to `cancelling`, and `{ ...job }` here would revert it to
   `in_progress`. Patches only the field. Synchronous. */
function publishSyncPath(job: BookExportJob): void {
  const cur = jobs.get(job.id);
  if (!cur) return;
  jobs.set(job.id, { ...cur, syncPath: job.syncPath });
}

/* Flip the in-flight marker on the job record around an un-cancellable
   sync-folder copy, patching the map entry the same way (DELETE may already
   have set it to `cancelling`). A cancelled job stays `cancelling` until the
   copy ends; the modal reads this marker after a cancel to know whether to
   keep waiting for the copy's outcome (#4228). Synchronous. */
function publishSyncCopyInFlight(job: BookExportJob, inFlight: boolean): void {
  job.syncCopyInFlight = inFlight;
  const cur = jobs.get(job.id);
  if (!cur) return;
  jobs.set(job.id, { ...cur, syncCopyInFlight: inFlight });
}

/* A builder that resolves does not mean the export is still wanted: a zip
   builder registers every chapter up front and can finish after DELETE has
   already asked the job to stop. Checked before each step that makes
   the artifact visible (sync-folder copy, rename into place, `done`) so a
   cancelled job ends cancelled. Drops `artifact` first, which must be a
   job-private path (the `.partial-<id>` build or the mp3-folder staging
   folder), never the flat final name that holds the previous export (#4228).
   An export cancelled after its sync-folder copy landed leaves that copy
   (never delete anything in the user's sync folder): only the private build is
   dropped and the local commit is skipped, so the previous LOCAL export stays
   intact (#4228). */
async function bailIfCancelled(
  signal: AbortSignal,
  artifact?: { path: string; folder?: boolean },
): Promise<void> {
  if (!signal.aborted) return;
  if (artifact) {
    await rm(artifact.path, { recursive: artifact.folder === true, force: true }).catch(() => {});
  }
  signal.throwIfAborted();
}

/* A directory cannot be renamed over a non-empty directory, so the previous
   flat folder is moved aside first, staging is renamed into place, and the
   old copy is removed best-effort. If the second rename fails the old folder
   is restored and the error rethrown. If that restore ALSO fails, the previous
   export is left in `oldPath` and logged loudly: nothing may delete it then,
   because it is the only copy of the user's earlier export (#4228). */
async function swapFolderIntoPlace(
  staging: string,
  finalPath: string,
  oldPath: string,
): Promise<void> {
  const hadPrevious = existsSync(finalPath);
  liveSwapAsides.add(oldPath);
  try {
    if (hadPrevious) await renameWithRetry(finalPath, oldPath);
    try {
      await renameWithRetry(staging, finalPath);
    } catch (e) {
      if (hadPrevious) {
        await renameWithRetry(oldPath, finalPath).catch((restoreErr) => {
          console.error(
            `[export] could not restore the previous export from ${oldPath} to ${finalPath}; it is left in place, restore it by hand:`,
            restoreErr,
          );
        });
      }
      throw e;
    }
    /* Committed: the new export supersedes the previous one and any `.old-*`
       an earlier failed cleanup left behind. Only now, and never a swap-aside
       another job is still using (#4228). */
    if (hadPrevious) await removeSupersededSwapAside(oldPath);
    await sweepSupersededSwapAsides(finalPath, oldPath);
  } finally {
    liveSwapAsides.delete(oldPath);
  }
}

/* Swap-asides of swaps running right now, so a sweep never takes the previous
   export of a concurrent same-name job out from under it. */
const liveSwapAsides = new Set<string>();

/* Best-effort removal of a superseded swap-aside: a transient lock (a scanner,
   Explorer) is retried, and a permanent failure is logged, not swallowed. The
   next successful export of the same name sweeps the leftover. */
async function removeSupersededSwapAside(path: string): Promise<void> {
  const ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= ATTEMPTS) {
        console.error(
          `[export] could not remove the superseded previous export at ${path}; the next successful export of it will retry:`,
          e,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function sweepSupersededSwapAsides(finalPath: string, ownOldPath: string): Promise<void> {
  const dir = dirname(finalPath);
  const prefix = `.${basename(finalPath)}.old-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const p = join(dir, n);
    if (p === ownOldPath || liveSwapAsides.has(p)) continue;
    await removeSupersededSwapAside(p);
  }
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
      /* After a cancel the map entry reads `cancelling`; a copy of this job's
         own object would turn it back into `in_progress`. */
      if (signal.aborted) return;
      jobs.set(job.id, { ...job });
    };
    if (job.format === 'mp3-folder') {
      /* Build into a job-private staging folder, never the flat `outPath`
         that holds the previous export (#4228). The builder rm's and
         recreates only `staging`; the sync-folder branch mirrors each file
         from it via writeFolderToSyncFolder. The swap onto `outPath` is the
         last step, after every cancel check. */
      const staging = join(
        bookExportsDir(bookDir),
        `.${sanitizeIdSegment(job.filename)}.partial-${job.id}`,
      );
      try {
        const folderResult = await buildMp3Folder({
          bookDir,
          state,
          outDir: staging,
          onProgress,
          signal,
        });
        job.sizeBytes = folderResult.totalBytes;
        job.progress = 1;
        await bailIfCancelled(signal, { path: staging, folder: true });

        if (syncFolder) {
          /* fs-54 — author-level nesting, applied to every sync-folder
             destination (this branch AND the single-file branch below), not
             just Audiobookshelf — keeps behavior consistent across every
             export tile and needs no wire-protocol change: `state.author`
             is already in scope here. */
          const authoredSyncDir = join(syncFolder, sanitiseForZip(state.author));
          const bookSubfolder = sanitiseForZip(state.title);
          /* The copy takes no signal, so a cancel cannot stop it: mark it in
             flight so a client that cancels meanwhile keeps following the job
             until `syncPath` (or its absence) is final (#4228). */
          publishSyncCopyInFlight(job, true);
          try {
            const synced = await writeFolderToSyncFolder(staging, authoredSyncDir, bookSubfolder);
            job.syncPath = synced.syncPath;
            publishSyncPath(job);
          } finally {
            publishSyncCopyInFlight(job, false);
          }
          /* A cancel after the sync copy drops only staging; the synced copy
             and syncPath stay (never delete in the user's sync folder). */
          await bailIfCancelled(signal, { path: staging, folder: true });
        }
        /* Commit step: swap staging onto the flat folder. The swap's renames
           retry for up to RENAME_RETRY_WORST_CASE_MS (~3.6 s each), a window a
           DELETE can land in; it still ends `cancelled` and the swapped folder
           stays as the newest valid export. The previous folder is moved to a
           dot-prefixed `.<slug>.old-<id>`: a crash mid-swap leaves it behind
           (dot-prefixed folders still show in Windows Explorer), and a
           cleanup rm that fails permanently does too; the next successful
           export of the same name removes it. */
        await swapFolderIntoPlace(
          staging,
          outPath,
          join(bookExportsDir(bookDir), `.${sanitizeIdSegment(job.filename)}.old-${job.id}`),
        );
        /* Synchronous, deletes nothing: re-evaluates a cancel that landed
           during the awaited swap and stays directly before the `done`
           publish below. */
        signal.throwIfAborted();
      } catch (e) {
        /* Drop the private staging folder on any failure or cancel. The
           `.old-<id>` folder is deliberately NOT removed here: after a failed
           swap it is either already restored (nothing to remove) or, when the
           restore failed too, the only copy of the previous export. */
        await rm(staging, { recursive: true, force: true }).catch(() => {});
        throw e;
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
         endpoint, the user's File Explorer). The sync-folder copy reads the
         private `.partial-` build, not the flat name (#4228). */
      const buildPath = join(
        bookExportsDir(bookDir),
        `.${sanitizeIdSegment(job.filename)}.partial-${job.id}`,
      );
      let staged: SyncStage | null = null;
      try {
        const result =
          job.format === 'mp3-zip'
            ? await buildMp3Zip({ bookDir, state, outPath: buildPath, onProgress, signal })
            : job.format === 'm4b'
              ? await buildM4b({ bookDir, state, outPath: buildPath, onProgress, signal })
              : job.format === 'captions'
                ? await buildCaptions({
                    bookDir,
                    state,
                    captionFileFormat: job.captionFileFormat!,
                    captionGranularity: job.captionGranularity!,
                    captionScope: job.captionScope!,
                    outPath: buildPath,
                    onProgress,
                    signal,
                  })
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
        /* Round-2-of-plan-review decision: only buildCaptions's result
           carries `warning` — the other three builders' result shapes
           don't have the field at all, so narrow by format rather than
           reading `result.warning` unconditionally. */
        if (job.format === 'captions') {
          job.warning = (result as { warning?: string }).warning ?? null;
        }
        await bailIfCancelled(signal, { path: buildPath });
        if (job.destination === 'sync-folder' && syncFolder) {
          const authoredSyncDir = join(syncFolder, sanitiseForZip(state.author));
          /* Stage a job-private `.tmp-<jobId>` copy next to the flat sync name
             (copied from the job-private build: the flat local name still holds
             the previous export). The previous sync copy at the flat name is
             untouched until the commit rename below (#4228). */
          const stage = await stageToSyncFolder(buildPath, authoredSyncDir, job.filename, job.id);
          staged = stage;
          if (signal.aborted) {
            /* Cancelled before the commit: drop only this job's own temp and
               the private build; the earlier sync copy stays byte-identical. */
            await discardSyncStage(stage);
            staged = null;
            await bailIfCancelled(signal, { path: buildPath });
          }
          /* The commit rename cannot be cancelled once started (see below): mark
             it in flight, as for the mp3-folder copy. */
          publishSyncCopyInFlight(job, true);
          try {
            const synced = await commitSyncStage(stage, authoredSyncDir);
            staged = null;
            job.syncPath = synced.syncPath;
            publishSyncPath(job);
          } finally {
            publishSyncCopyInFlight(job, false);
          }
          /* A cancel after the sync commit leaves the synced copy and syncPath
             (it already replaced the previous copy and cannot be restored).
             Only the private build is dropped, so the local rename below is
             skipped and the previous LOCAL export stays intact. */
          await bailIfCancelled(signal, { path: buildPath });
        }
        /* Commit step: the LAST thing that touches the flat name. Every cancel
           check above ran before it; once it has started it is never undone
           (we cannot restore the replaced file), so nothing below removes
           outPath. A DELETE landing while this rename is in flight (its retries
           run for up to RENAME_RETRY_WORST_CASE_MS, ~3.6 s) cannot stop it: the
           job still ends `cancelled` and the renamed file stays as the newest
           valid export. */
        await renameWithRetry(buildPath, outPath);
        /* Synchronous, no rm: re-evaluates a cancel that landed during the
           awaited rename and must stay directly before the `done` publish. */
        signal.throwIfAborted();
      } catch (e) {
        /* On any failure (including cancel) the partial file is dropped
           so a `<bookDir>/exports/` listing never shows half-baked
           artifacts. Best-effort — if the rename above already moved it
           there's nothing to unlink. */
        if (staged) await discardSyncStage(staged);
        await unlink(buildPath).catch(() => {});
        throw e;
      }

      job.downloadUrl = `/api/books/${encodeURIComponent(job.bookId)}/exports/${encodeURIComponent(job.id)}/download`;
    }
    job.status = 'done';
    job.completedAt = new Date().toISOString();
    /* Publish `done` to the jobs map in the same synchronous step as the last
       cancel check, before any await: DELETE reads the map's entry, so until
       this runs a DELETE landing during the revoke below would read
       `in_progress`, answer `cancelling`, and the `finally` would then write
       `done` + `downloadUrl` back over it. After this, a DELETE sees `done`
       and is a no-op. Rule:
       every cancel check happens BEFORE the commit rename, the commit rename
       is never undone, and nothing awaits between the final synchronous
       `signal.throwIfAborted()` and this publish. */
    jobs.set(job.id, { ...job });
    /* Plan 79 — clobber-newest-wins on disk PLUS revoke any older
       manifest for the same (book, format). Together they keep the
       queue de-duped: one row per format, always pointing at the
       latest build. Older artifacts on disk were already overwritten
       by this build's atomic-rename; older manifests would otherwise
       linger forever. */
    await revokeStaleSameFormat(bookDir, job.bookId, job, job.id);
  } catch (e) {
    /* Cancellation. The build has stopped and the inner catch has already
       dropped its job-private files, so only now is the job terminal: the
       `finally` publishes `cancelled` over DELETE's `cancelling`. Only DELETE
       aborts the controller, so an aborted signal means the user cancelled;
       its reason is read here, once any sync copy's outcome is known. */
    if (signal.aborted || (e as Error)?.name === 'AbortError') {
      markCancelled(
        job,
        signal.aborted ? cancelReason(job.syncPath) : (e as Error)?.message || 'Cancelled.',
      );
    } else {
      job.status = 'failed';
      const failureReason =
        e instanceof ExportIncompleteError
          ? `Export incomplete: ${e.missing.length} chapter(s) missing MP3 audio.`
          : requestFailureMessageFs(e, (e as Error).message);
      /* A local commit can fail after the sync copy already landed (the sync
         commit runs first); say so rather than reading like nothing was
         written (#4228). */
      job.errorReason = job.syncPath
        ? `${failureReason} The files were already copied to the sync folder.`
        : failureReason;
      job.completedAt = new Date().toISOString();
      /* The client-facing reason above is curated (no workspace path); the
         raw error — with ffmpeg/ffprobe stderr, which the scrubbed message
         drops — goes to the log. */
      console.error(
        `[export] job ${job.id} failed:`,
        e,
        (e as { ffmpegStderr?: string })?.ffmpegStderr ?? '',
      );
    }
  } finally {
    jobs.set(job.id, { ...job });
    jobControllers.delete(job.id);
    try {
      await writeJsonAtomicOrdered(manifestPath(bookDir, job.id), job);
    } catch {
      /* Manifest write is best-effort — failure to persist the manifest
         doesn't invalidate the artifact on disk. Next rehydrate will just
         miss this job; the artifact is still downloadable if the user
         still has the URL. */
    }
  }
}

/** Test-only: drop the in-memory job table. Does NOT wait for any job
    still in flight — a caller that's about to delete the workspace those
    jobs read/write must call _awaitInFlightExportJobs() first (this
    function only drops OUR bookkeeping, not the physical I/O a running
    job is still doing).

    Deliberately does NOT clear `jobPromises` (nit (b), independent
    review): the docstring above states the required order (drain, THEN
    reset), but nothing enforced it — a caller that reset first silently
    destroyed `_awaitInFlightExportJobs`'s only handle on any still-running
    job, so a SUBSEQUENT drain call would return immediately having waited
    for nothing at all, with no error to signal the mistake. Each
    `jobPromises` entry already self-removes via its own `.finally()` once
    its job settles (see the map's own comment), so leaving it alone here
    is a no-op for the correctly-ordered case and a safety net for the
    misordered one: a drain called after a misordered reset still finds
    the promise and still waits for it to genuinely finish. Clearing
    `jobControllers` here doesn't threaten that wait — `_awaitInFlightExportJobs`
    no longer aborts through it (see that function's own doc comment for
    why); it only waits on `jobPromises`. */
export function _resetExportJobs(): void {
  jobs.clear();
  jobControllers.clear();
}

/** Test-only: wait for every export job currently in flight to fully
    settle — including its own `finally` (the manifest write) — before
    returning. `_resetExportJobs()` alone only clears this module's
    in-memory bookkeeping; it does not stop a runExportJob call that's
    still mid-build from touching disk. A teardown that deletes the
    workspace right after resetting jobs (but without draining them first)
    can race a job that's still writing into it — on a loaded CI runner
    (macOS cross-os.yml, run 31588267496) that lost race surfaced as an
    ENOENT read racing rmSync, escaping as an uncaught exception.

    Waits for `pendingPostCreations` FIRST (nit (c), independent review) —
    a POST parked on its pre-flight work (mkdir / disk-guard probe) before
    any job exists hasn't registered into `jobPromises` yet; without this,
    it would register AFTER the `jobPromises` snapshot below and escape
    the drain entirely. This guarantees every POST in flight when this is
    called has, by the time the snapshot happens, either responded with no
    job created or registered one.

    WAITS ONLY — it does not abort in-flight jobs. An earlier version
    called `controller.abort()` on every job first; it was removed because
    the zip builders' abort path then settled while yazl was still reading.
    Today an aborted zip build settles only after its source reads have
    stopped (createZipWritePipeline in build-mp3-zip.ts).

    The actual guarantee this function makes: it waits for in-flight jobs
    to finish writing before teardown touches the workspace. The actual
    risk: a genuinely stuck build blocks this drain, bounded only by
    whatever timeout the calling test itself runs under — there is no
    independent ceiling anymore. This is unchanged for buildM4b, whose
    ffmpeg-SIGTERM cancel path is a separate mechanism from the zip
    pipeline above and was never shown to be broken — DELETE
    /exports/:id still calls `controller.abort()` in production and
    buildM4b still honours it; this function simply no longer relies on
    that to keep its own wait bounded. */
export async function _awaitInFlightExportJobs(): Promise<void> {
  await Promise.allSettled([...pendingPostCreations]);
  await Promise.allSettled([...jobPromises.values()]);
}
