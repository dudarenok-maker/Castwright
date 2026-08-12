/* MP3.ZIP packer — Phase A of the audiobook export pipeline.

   Walks `state.chapters` (sorted by id, excluding any with `excluded === true`),
   resolves each chapter's `.mp3` on disk via the shared findChapterAudio
   probe, re-tags each one with chapter/book ID3v2.4 metadata via
   applyId3v24Tags (no re-encode — `-c:a copy` only), then streams the
   tagged files into a single zip via yazl.

   PocketBook Reader Android reads the resulting `*.zip` as a multi-chapter
   audiobook ordered by filename, displaying the TIT2 / TALB / TPE1 / TPE2 /
   TRCK frames as Title / Album / Author. Other apps (Voice, Plex, etc.)
   accept the same shape.

   Refuses with `ExportIncompleteError` listing missing chapter slugs when
   any non-excluded chapter has no `.mp3` on disk. Callers turn that into a
   409 with a clickable "Regenerate missing chapters" hint in the export
   modal. */

import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { audioDir, coverImagePath } from '../workspace/paths.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { sanitizeIdSegment } from '../util/safe-path.js';
import { applyId3v24Tags, type Id3Tags } from './id3-tags.js';
import { artistForExport } from './narrator-credit.js';
import type { BookStateJson } from '../workspace/scan.js';

export interface BuildMp3ZipOptions {
  bookDir: string;
  state: BookStateJson;
  outPath: string;
  /** Optional progress callback — fires once per chapter packed, with a
      0..1 ratio. The route uses this to update the job's `progress`. */
  onProgress?: (ratio: number) => void;
  /** Optional cancellation signal. Checked between chapters; when aborted
      mid-build the zip stream is destroyed and an AbortError is thrown.
      The route's cancel handler is the only producer today. */
  signal?: AbortSignal;
}

export interface BuildMp3ZipResult {
  sizeBytes: number;
  /** Filenames inside the zip, in the order they were written. Useful for
      the regression test + the change-log entry the route writes. */
  entries: string[];
}

export class ExportIncompleteError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`Export incomplete: ${missing.length} chapter(s) lack an MP3 audio file.`);
    this.name = 'ExportIncompleteError';
    this.missing = missing;
  }
}

/* Abort-safe wrapper around a yazl ZipFile's write pipeline — shared by
   buildMp3Zip, buildCodecZip, and buildCaptions's per-chapter branch.

   Independent-review findings 1+2 on the original crash fix: the zip
   builders only checked `signal.throwIfAborted()` at the top of the
   per-chapter loop, which (1) can't stop a slow/stuck write mid-flight —
   the loop merely REGISTERS read streams, the dominant cost is the
   awaited write-out that follows the loop and had no abort awareness at
   all — and (2) even when the check DOES land between chapters, nothing
   stopped yazl's internal pump: the builder's promise settled while bytes
   kept landing on disk well after (measured: settle at 65 KB, +40 MB more
   200 ms later). That re-opened the exact ENOENT-racing-rmSync race the
   crash fix's own drain (`_awaitInFlightExportJobs`) exists to close.

   This wraps the write stream + `zip.outputStream` pipe so that:
     - an `abort` event on `signal` immediately unpipes AND destroys the
       write stream, plus whichever chapter read stream is currently open,
       so nothing can write another byte once `rejectBuild` has fired —
       closing both findings, and nit (f)'s fd leak on the plain-error
       path (previously `ws` was never destroyed on ANY rejection, leaking
       the write fd + open read handle for the process's lifetime — masked
       before this PR by the crash itself);
     - the returned promise resolves only once the write stream's `close`
       event fires (fd genuinely released), not merely `finish` (bytes
       flushed to the OS, but the fd can still be open) — so a caller that
       awaits this promise can trust nothing is still writing once it
       settles, whether it settles by success OR by abort. */
export interface ZipWritePipeline {
  /** Call once per chapter/entry read stream added to the zip, so an
      abort knows which one to destroy. Entries are added sequentially
      (never concurrently) — a later call simply replaces the tracked
      stream, which is correct: the previous one is already done. */
  trackReadStream: (rs: { destroy: (error?: Error) => void }) => void;
  /** Reject the pipeline (idempotent — a second call is a no-op) and tear
      down the write stream + tracked read stream so nothing keeps
      writing once this returns. */
  rejectBuild: (reason?: unknown) => void;
  /** Resolves with the total byte count once the write stream is fully
      closed. Rejects with whatever `rejectBuild` was called with. Marked
      handled immediately (see comment inline) so a rejection that lands
      before the caller awaits this isn't flagged as an unhandled
      rejection — the caller's own `await` still observes it. */
  donePromise: Promise<number>;
}

export function createZipWritePipeline(
  outPath: string,
  zip: ZipFile,
  signal?: AbortSignal,
): ZipWritePipeline {
  const ws = createWriteStream(outPath);
  let settled = false;
  let currentReadStream: { destroy: (error?: Error) => void } | null = null;
  let bytes = 0;
  let resolveDone!: (n: number) => void;
  let rejectDone!: (reason?: unknown) => void;
  const donePromise = new Promise<number>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  donePromise.catch(() => {});

  const rejectBuild = (reason?: unknown): void => {
    if (settled) return;
    settled = true;
    rejectDone(reason ?? new Error('zip write failed'));
    /* Stop the pipeline doing any further I/O now that we've decided to
       fail: unpipe so no already-buffered zip bytes reach the write
       stream, destroy the write stream to release its fd and cut off any
       write still in flight, and destroy whichever chapter read stream is
       currently open so ITS fd is released too. */
    zip.outputStream.unpipe(ws);
    ws.destroy();
    currentReadStream?.destroy();
  };

  ws.on('error', rejectBuild);
  zip.outputStream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  zip.outputStream.on('error', rejectBuild);
  /* yazl's ZipFile emits several of its OWN internal validation failures
     (e.g. "file data stream has unexpected number of bytes") via
     `self.emit('error', ...)` on the ZipFile object itself — not on
     `outputStream`. Without a listener here those are ALSO an unhandled
     'error' with zero listeners → an uncaught exception, same failure
     class as the readStream gap this whole pipeline exists to close. */
  zip.on('error', rejectBuild);
  zip.outputStream.pipe(ws);
  ws.on('close', () => {
    if (settled) return;
    settled = true;
    resolveDone(bytes);
  });

  if (signal) {
    const onAbort = (): void => {
      rejectBuild(
        signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'),
      );
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      /* `.finally()` returns a NEW derived promise (a separate branch off
         `donePromise`, independent of the `donePromise.catch(() => {})`
         above) that adopts `donePromise`'s rejection — nobody else holds a
         reference to it, so without its own `.catch()` a rejection here
         is an unhandled rejection in its own right (confirmed: this
         crashed a throwaway repro via `unhandledRejection` with no other
         change). Chain the catch onto the SAME derived promise. */
      donePromise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
    }
  }

  return {
    trackReadStream: (rs) => {
      currentReadStream = rs;
    },
    rejectBuild,
    donePromise,
  };
}

export async function buildMp3Zip(opts: BuildMp3ZipOptions): Promise<BuildMp3ZipResult> {
  const { bookDir, state, outPath, onProgress, signal } = opts;

  const chapters = [...state.chapters].filter((c) => !c.excluded).sort((a, b) => a.id - b.id);

  /* Pre-flight: every non-excluded chapter must have an MP3 on disk.
     Surface ALL missing slugs in one go so the user gets a full punch
     list, not one-at-a-time errors. */
  const root = audioDir(bookDir);
  const missing: string[] = [];
  const resolved: Array<{ idx: number; chapter: (typeof chapters)[number]; mp3Path: string }> = [];
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const audio = findChapterAudio(root, chapter.slug);
    /* Plan 72: `findChapterAudio` widened from mp3-only to mp3/m4a/ogg.
       The MP3.ZIP builder strictly requires `.mp3` on disk — re-encoding
       m4a/ogg back to mp3 would force a quality-losing transcode the
       user didn't ask for, and ID3v2 tags don't apply to those formats.
       Treat non-mp3 chapters as missing so the 409 missing-chapter
       banner surfaces in the modal; the user can either regenerate them
       as mp3 (by toggling the book's audioFormat) or pick the matching
       AAC.ZIP / Opus.ZIP export. */
    if (!audio || audio.ext !== 'mp3') {
      missing.push(chapter.slug);
      continue;
    }
    resolved.push({ idx: i, chapter, mp3Path: audio.path });
  }
  if (missing.length > 0) throw new ExportIncompleteError(missing);

  const total = resolved.length;
  const albumArtist = state.author;
  const artist = artistForExport(state);
  const album = state.title;

  /* Plan 36 A3: embed the cached OpenLibrary cover into each chapter's
     ID3v2 header as an APIC frame when one exists. Absent → no APIC
     frame, ID3 round-trip is otherwise unchanged. Probed once per export
     (the file doesn't change mid-export). */
  const coverDiskPath = coverImagePath(bookDir);
  const coverJpegPath: string | null = existsSync(coverDiskPath) ? coverDiskPath : null;

  /* Stage each tagged MP3 in a temp dir alongside the output, then zip
     them. We can't pipe ffmpeg-stdout straight into yazl because yazl
     wants Readable streams with a known content-length, and ffmpeg's
     ID3v2 + Xing-header rewrite means we don't know that until the
     file is done. A small per-chapter temp file is simpler and the I/O
     is dwarfed by the zip write itself. */
  const stagingDir = `${outPath}.staging-${process.pid}-${Date.now()}`;
  await mkdir(stagingDir, { recursive: true });

  const entries: string[] = [];
  try {
    const zip = new ZipFile();
    /* createZipWritePipeline (above) resolves only once the write stream
       is genuinely closed, and — the fix for findings 1+2 — destroys the
       write stream + whichever chapter read stream is open the instant
       `signal` aborts, so a slow/stuck write can't hang a caller draining
       on this promise, and bytes stop landing on disk the moment abort
       lands rather than continuing to grow after this promise settles. */
    const pipeline = createZipWritePipeline(outPath, zip, signal);

    try {
      for (let i = 0; i < resolved.length; i++) {
        signal?.throwIfAborted();
        const { chapter, mp3Path } = resolved[i];
        const entryName = `${pad2(i + 1)} - ${sanitiseForZip(chapter.title)}.mp3`;
        /* `entryName` is the pretty label written INTO the zip; the on-disk
           staging filename is the same string routed through sanitizeIdSegment
           so a `..`/separator that survived sanitiseForZip can't escape
           stagingDir (js/path-injection). No-op for real titles. */
        const taggedPath = join(stagingDir, sanitizeIdSegment(entryName));

        const tags: Id3Tags = {
          title: chapter.title,
          album,
          artist,
          albumArtist,
          track: i + 1,
          trackTotal: total,
          genre: state.genre ?? null,
          date: state.publicationDate ?? null,
          comment: 'Rendered with Castwright · castwright.ai',
        };
        await applyId3v24Tags(mp3Path, taggedPath, tags, { coverJpegPath });
        const taggedStat = await stat(taggedPath);

        /* `compress: false` keeps entries "stored" — MP3 is already
           compressed, so deflate would burn CPU for ~0-1% gain. Stored
           entries also stay byte-readable from the zip without inflate,
           which keeps the test harness simple. */
        const chapterReadStream = createReadStream(taggedPath);
        pipeline.trackReadStream(chapterReadStream);
        /* Production stability (macOS cross-os.yml crash, run 31588267496):
           yazl's `addFile` attaches its own `readStream.on('error', ...)`
           before pumping a file, but `addReadStream` — what we use here —
           does NOT (see node_modules/yazl/index.js). `.pipe()` never
           forwards 'error' from source to destination either. So a read
           failure on this exact stream (e.g. `taggedPath` vanishing between
           being staged and being read, which is exactly what happens when a
           test/teardown deletes the workspace mid-build) had ZERO
           listeners: Node throws it synchronously as an uncaught exception,
           bypassing every try/catch in the awaited call chain — including
           this function's own `finally` below — instead of failing the
           export. Forward it into the same rejection as every other build
           failure. */
        chapterReadStream.on('error', pipeline.rejectBuild);
        zip.addReadStream(chapterReadStream, entryName, {
          size: taggedStat.size,
          mtime: new Date(),
          compress: false,
        });
        entries.push(entryName);
        onProgress?.((i + 1) / total);
      }
      zip.end();
      const sizeBytes = await pipeline.donePromise;
      return { sizeBytes, entries };
    } catch (e) {
      /* Covers any throw the pipeline's own listeners didn't already
         catch (e.g. `signal.throwIfAborted()` itself, or a bug in
         `applyId3v24Tags`) — ensures the write stream + any open read
         stream are torn down on EVERY exit path, not only the ones yazl
         happens to route through an 'error' event. Idempotent: a no-op if
         `rejectBuild` already fired (e.g. the abort listener beat us
         here). */
      pipeline.rejectBuild(e);
      throw e;
    }
  } finally {
    /* Best-effort staging cleanup. If this throws, the caller's higher-up
       failure handler will already be reporting the build error — don't
       overwrite that with a cleanup-only complaint. */
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/* FAT32-safe filename. PocketBook Reader on Android reads from internal
   storage *or* removable SD; SD cards are typically FAT32, which forbids
   `\ / : * ? " < > |` and trims trailing dots/spaces. Em-dash is fine
   on FAT32 (UTF-16 LFN), but downgrade to ` - ` so titles also survive
   if the user copies the zip onto an old MTP-only e-reader path that
   can't handle the higher codepoint. */
export function sanitiseForZip(name: string): string {
  const cleaned = name
    .replace(/—/g, ' - ')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
  return cleaned || 'Untitled';
}
