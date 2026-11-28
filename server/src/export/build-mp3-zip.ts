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
import type { Readable } from 'node:stream';
import { ZipFile } from 'yazl';
import { audioDir, coverImagePath } from '../workspace/paths.js';
import { findChapterAudio, type ChapterAudioExt } from '../workspace/chapter-take.js';

/* The export entry name's extension (the file is the live mp3 take's bytes). */
const MP3_EXT: ChapterAudioExt = 'mp3';
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
  /** Optional cancellation signal. When aborted, no further chapter is
      started, the in-flight source stream and the write stream are
      destroyed, and an AbortError is thrown once the source stream has
      closed. The route's cancel handler is the only producer today. */
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

/* Write pipeline wrapper around a yazl ZipFile — shared by buildMp3Zip,
   buildCodecZip, and buildCaptions's per-chapter branch.

   The actual subject of the crash fix this pipeline supports: yazl emits
   an `'error'` on `zip.outputStream` for a bad write, AND on the `zip`
   object itself for some of its own internal validation failures — either
   with zero listeners is an unhandled `'error'`, which Node throws as an
   uncaughtException (installCrashHandlers() answers that with exit(1)).
   `ws.on('error', ...)`, `zip.outputStream.on('error', ...)`, and
   `zip.on('error', ...)` below forward all three into one rejection path
   instead. Callers additionally attach `readStream.on('error',
   pipeline.rejectBuild)` on each chapter's own read stream at the
   `addReadStream` call site (yazl's `addFile` does this itself; its
   lower-level `addReadStream` does not, and `.pipe()` never forwards
   `'error'` source→destination).

   On any rejection, `rejectBuild` also unpipes `zip.outputStream` from the
   write stream and destroys the write stream — nit (f) from the original
   review: previously `ws` was never destroyed on ANY rejection, leaking
   the write fd for the process's lifetime (masked before this PR by the
   crash itself). The returned promise resolves only once the write
   stream's `close` event fires (fd genuinely released), not merely
   `finish` (bytes flushed to the OS, but the fd can still be open).

   Source side: a builder that streams files registers ONE at a time. It
   awaits `waitForSource` before handing yazl the next stream and names that
   stream with `setSource`, so the tracked stream is the one yazl's pump is
   reading. `rejectBuild` destroys it, and `donePromise` rejects only after
   its `close`: a rejected build has stopped reading its source files.

   An optional `signal` passed to createZipWritePipeline covers the spans a
   builder's own `throwIfAborted()` cannot (mid-chapter, and after the last
   registration). Its `abort` event calls `rejectBuild`, so the build fails
   as cancelled instead of resolving and being reported `done`. */
export interface ZipWritePipeline {
  /** Reject the pipeline (idempotent — a second call is a no-op), tear down
      the write stream and destroy the current source stream. */
  rejectBuild: (reason?: unknown) => void;
  /** Resolves with the total byte count once the write stream is fully
      closed. Rejects with whatever `rejectBuild` was called with, after the
      current source stream has closed. Marked handled immediately (see
      comment inline) so a rejection that lands before the caller awaits
      this isn't flagged as an unhandled rejection — the caller's own
      `await` still observes it. */
  donePromise: Promise<number>;
  /** Name the source stream about to be registered with yazl. Replaces the
      previous one, so call `waitForSource` first. */
  setSource: (source: Readable) => void;
  /** Resolves once the current source stream (if any) has closed, or the
      signal has aborted (a failure destroys the stream, which closes it).
      Rejects with the pipeline's failure reason if it has been rejected. */
  waitForSource: () => Promise<void>;
  /** Throws the failure reason if the pipeline has been rejected. */
  throwIfFailed: () => void;
}

export function createZipWritePipeline(
  outPath: string,
  zip: ZipFile,
  signal?: AbortSignal,
): ZipWritePipeline {
  const ws = createWriteStream(outPath);
  let settled = false;
  let bytes = 0;
  let resolveDone!: (n: number) => void;
  let rejectDone!: (reason?: unknown) => void;
  const donePromise = new Promise<number>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  donePromise.catch(() => {});
  let currentSource: Readable | null = null;
  let failure: { reason: unknown } | null = null;

  const onData = (chunk: Buffer): void => {
    bytes += chunk.length;
  };

  const onAbort = (): void => rejectBuild(signal?.reason ?? new Error('aborted'));

  const rejectBuild = (reason?: unknown): void => {
    if (settled) return;
    settled = true;
    const error = reason ?? new Error('zip write failed');
    failure = { reason: error };
    signal?.removeEventListener('abort', onAbort);
    /* Stop the WRITE side doing any further I/O now that we've decided to
       fail. Three things: detach the byte-counting 'data' listener (N3,
       independent review — previously left attached, so after rejectBuild
       the unpiped outputStream stayed in flowing mode with a live consumer,
       into a counter nobody would ever read — mirrors
       build-portable-book.ts's onData teardown); unpipe so no
       already-buffered zip bytes reach the write stream; and destroy the
       write stream to release its fd and cut off any write still in
       flight. */
    zip.outputStream.off('data', onData);
    zip.outputStream.unpipe(ws);
    ws.destroy();
    /* Then the READ side: reject only once the source stream has closed. */
    const source = currentSource;
    if (!source || source.closed) {
      rejectDone(error);
      return;
    }
    source.once('close', () => rejectDone(error));
    source.destroy();
  };

  const throwIfFailed = (): void => {
    if (failure) throw failure.reason;
  };

  const waitForSource = async (): Promise<void> => {
    const source = currentSource;
    if (source && !source.closed && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        /* Whichever fires first detaches both, so nothing accumulates on the
           caller's signal from one chapter to the next. */
        const done = (): void => {
          source.off('close', done);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        source.once('close', done);
        signal?.addEventListener('abort', done, { once: true });
      });
    }
    throwIfFailed();
  };

  ws.on('error', rejectBuild);
  zip.outputStream.on('data', onData);
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
    signal?.removeEventListener('abort', onAbort);
    resolveDone(bytes);
  });
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  return {
    rejectBuild,
    donePromise,
    setSource: (source) => {
      currentSource = source;
    },
    waitForSource,
    throwIfFailed,
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
       is genuinely closed, and forwards every yazl/write-stream error
       into one rejection that also tears down the write stream (nit (f))
       and the in-flight source stream. */
    const pipeline = createZipWritePipeline(outPath, zip, signal);

    try {
      for (let i = 0; i < resolved.length; i++) {
        signal?.throwIfAborted();
        const { chapter, mp3Path } = resolved[i];
        const entryName = `${pad2(i + 1)} - ${sanitiseForZip(chapter.title)}.${MP3_EXT}`;
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
        /* One source stream registered at a time. Waiting here, after the
           tagging above, lets this chapter's tagging overlap with yazl
           pumping the previous one. */
        await pipeline.waitForSource();
        const chapterReadStream = createReadStream(taggedPath);
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
        pipeline.setSource(chapterReadStream);
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
         `applyId3v24Tags`) — ensures the write stream is torn down on
         EVERY exit path, not only the ones yazl happens to route through
         an 'error' event. Idempotent: a no-op if `rejectBuild` already
         fired for some other reason. */
      pipeline.rejectBuild(e);
      /* Settle only once the in-flight source stream has closed. */
      await pipeline.donePromise.catch(() => {});
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
