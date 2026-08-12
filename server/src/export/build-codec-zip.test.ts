/* Tests for buildCodecZip (plan 72's AAC/M4A + Opus/Ogg zip packer). No
   ffmpeg required — like build-portable-book.test.ts, we use raw bytes for
   the audio fixtures since neither findChapterAudio nor buildCodecZip
   validate audio content, only extension + existence.

   Until this file existed, buildCodecZip had NO test coverage at all — a
   gap this round's crash-fix work surfaced (see the last test below) and
   closes alongside it, rather than leaving the module untested. */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { buildCodecZip } from './build-codec-zip.js';
import { ExportIncompleteError } from './build-mp3-zip.js';
import type { BookStateJson } from '../workspace/scan.js';

/* Behavioral regression for the ZipFile-level `zip.on('error', rejectBuild)`
   listener inside createZipWritePipeline (build-mp3-zip.ts) — shared by
   buildCodecZip via `createZipWritePipeline`, and by buildMp3Zip. See
   build-captions.test.ts's identical mock (the reference implementation
   this is copied from) for the full explanation of why the injected error
   is emitted via `process.nextTick` rather than synchronously during
   construction: `new Promise(executor)` auto-catches a *synchronous* throw
   inside its executor and turns it into a rejection on its own, so emitting
   synchronously from the ZipFile constructor would "pass" this test even
   with the fix line deleted, for JS's reasons rather than
   createZipWritePipeline's own forwarding. Scheduling via `process.nextTick`
   moves the emit outside that frame — same as yazl's real internal error
   sites — so an absent `zip.on('error', rejectBuild)` reproduces the real
   bug: zero listeners, an `uncaughtException`, and the pipeline's promise
   never settling. */
let triggerZipFileError: Error | null = null;
vi.mock('yazl', async (importOriginal) => {
  const real = await importOriginal<typeof import('yazl')>();
  class TestZipFile extends real.ZipFile {
    constructor() {
      super();
      if (triggerZipFileError) {
        const err = triggerZipFileError;
        process.nextTick(() => {
          this.emit('error', err);
        });
      }
    }
  }
  return { ...real, ZipFile: TestZipFile };
});

/* Same minimal yazl-produced-zip reader as build-mp3-zip.test.ts — only the
   central directory + stored (uncompressed) entry bytes, no external dep. */
function readZipEntries(zip: Buffer): Array<{ name: string; data: Buffer }> {
  let eocdOff = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error('Not a zip (no EOCD)');
  const cdCount = zip.readUInt16LE(eocdOff + 10);
  const cdOff = zip.readUInt32LE(eocdOff + 16);

  const entries: Array<{ name: string; data: Buffer }> = [];
  let p = cdOff;
  for (let i = 0; i < cdCount; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad CD signature');
    const compMethod = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOff = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    const lhNameLen = zip.readUInt16LE(localOff + 26);
    const lhExtraLen = zip.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const data = zip.subarray(dataStart, dataStart + compSize);
    if (compMethod !== 0) {
      throw new Error('Test expects stored (no-deflate) entries.');
    }
    entries.push({ name, data: Buffer.from(data) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function makeState(): BookStateJson {
  return {
    bookId: 'demo__standalones__test-book',
    manuscriptId: 'mns_test',
    title: 'Test Book',
    author: 'Demo Author',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: true,
    chapters: [
      { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
    ],
    coverGradient: ['#abc', '#def'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
}

describe('buildCodecZip', () => {
  let tmpRoot: string;
  let bookDir: string;
  let opusBookDir: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'build-codec-zip-'));
    bookDir = join(tmpRoot, 'book');
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    writeFileSync(join(bookDir, 'audio', '01-chapter-1.m4a'), Buffer.from('m4a-bytes-chapter-1'));
    writeFileSync(join(bookDir, 'audio', '02-chapter-2.m4a'), Buffer.from('m4a-bytes-chapter-2'));

    /* Separate book dir for the opus/.ogg fixtures — findChapterAudio's
       probe order is mp3 → m4a → ogg and stops at the first match, so an
       .m4a and a .ogg for the same slug in the same directory would mask
       the .ogg (a real, if narrow, invariant: only one on-disk format is
       expected per chapter at a time). */
    opusBookDir = join(tmpRoot, 'opus-book');
    mkdirSync(join(opusBookDir, 'audio'), { recursive: true });
    writeFileSync(join(opusBookDir, 'audio', '01-chapter-1.ogg'), Buffer.from('ogg-bytes-chapter-1'));
    writeFileSync(join(opusBookDir, 'audio', '02-chapter-2.ogg'), Buffer.from('ogg-bytes-chapter-2'));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('packs aac-m4a chapters in order with 2-digit prefixes, byte-for-byte', async () => {
    const outPath = join(tmpRoot, 'out.m4a.zip');
    const result = await buildCodecZip({ bookDir, state: makeState(), outPath, format: 'aac-m4a' });
    expect(result.entries).toEqual(['01 - Chapter 1.m4a', '02 - Chapter 2.m4a']);

    const entries = readZipEntries(readFileSync(outPath));
    expect(entries.map((e) => e.name)).toEqual(result.entries);
    expect(entries[0].data.toString('utf8')).toBe('m4a-bytes-chapter-1');
    expect(entries[1].data.toString('utf8')).toBe('m4a-bytes-chapter-2');
  });

  it('packs opus chapters as .ogg entries', async () => {
    const outPath = join(tmpRoot, 'out.opus.zip');
    const result = await buildCodecZip({
      bookDir: opusBookDir,
      state: makeState(),
      outPath,
      format: 'opus',
    });
    expect(result.entries).toEqual(['01 - Chapter 1.ogg', '02 - Chapter 2.ogg']);

    const entries = readZipEntries(readFileSync(outPath));
    expect(entries[0].data.toString('utf8')).toBe('ogg-bytes-chapter-1');
  });

  it('refuses with ExportIncompleteError when a non-excluded chapter has no matching-format file', async () => {
    const incompleteDir = join(tmpRoot, 'incomplete');
    mkdirSync(join(incompleteDir, 'audio'), { recursive: true });
    writeFileSync(join(incompleteDir, 'audio', '01-chapter-1.m4a'), Buffer.from('only-one'));
    /* No chapter-2 file at all — precheck must reject. */

    await expect(
      buildCodecZip({
        bookDir: incompleteDir,
        state: makeState(),
        outPath: join(tmpRoot, 'incomplete.zip'),
        format: 'aac-m4a',
      }),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  });

  it('reports per-chapter progress to onProgress', async () => {
    const ratios: number[] = [];
    await buildCodecZip({
      bookDir,
      state: makeState(),
      outPath: join(tmpRoot, 'progress.zip'),
      format: 'aac-m4a',
      onProgress: (r) => ratios.push(r),
    });
    expect(ratios).toEqual([0.5, 1]);
  });

  /* Same defect class as build-mp3-zip.ts's own regression test (see that
     file's comment for the full root cause): `zip.addReadStream(
     createReadStream(path), ...)` hands yazl a raw readStream. yazl's
     `addFile` attaches its own `readStream.on('error', ...)` — `addReadStream`
     does not, and `.pipe()` never forwards 'error' from source to
     destination. A read failure on that stream (e.g. the source audio file
     vanishing mid-build) had zero listeners: Node throws it as an uncaught
     exception, killing the whole server (crash-logging.ts's
     uncaughtException handler exits 1) instead of just failing this export.

     Unlike build-mp3-zip.ts (which streams from a per-chapter STAGED copy,
     re-created fresh each iteration), buildCodecZip streams straight from
     each chapter's original on-disk file, and re-stats each chapter's own
     path on every loop iteration. So this test deletes ONLY the file that
     was just read (via onProgress, which fires right after addReadStream)
     — never a LATER chapter's still-needed file — to isolate the
     readStream-error path from an ordinary (and already-correctly-handled)
     `stat()` failure on a subsequent chapter. Chapter 1's file vanishing
     right after being streamed, while chapter 2's `await stat()` is still
     in flight, reproduces the exact race deterministically: no sleep or
     poll needed, because deletion always lands before Node's async
     fs.open() behind the read stream can possibly have resolved. */
  it('forwards a deleted-source-file read error instead of crashing the process', async () => {
    const raceDir = join(tmpRoot, 'race');
    mkdirSync(join(raceDir, 'audio'), { recursive: true });
    const audioPaths = [
      join(raceDir, 'audio', '01-chapter-1.m4a'),
      join(raceDir, 'audio', '02-chapter-2.m4a'),
    ];
    for (const p of audioPaths) writeFileSync(p, Buffer.from('doomed-bytes'));

    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    let call = 0;
    try {
      await expect(
        buildCodecZip({
          bookDir: raceDir,
          state: makeState(),
          outPath: join(tmpRoot, 'race.m4a.zip'),
          format: 'aac-m4a',
          onProgress: () => {
            const justRead = audioPaths[call];
            call++;
            rmSync(justRead, { force: true });
          },
        }),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    // The real assertion: nothing escaped as a raw uncaught exception. If
    // this is non-null, the read-stream error crashed the process instead
    // of rejecting buildCodecZip's own promise.
    expect(escaped).toBeNull();
  }, 10_000);

  /* Independent review, findings 1+2 on the crash fix: the old shape only
     checked `signal.throwIfAborted()` at the top of the per-chapter loop,
     which (1) can't stop a slow/stuck write mid-flight — the loop merely
     REGISTERS read streams, the dominant cost (`await writePromise`) had
     no abort awareness at all — and (2) even when the check DID land
     between chapters, nothing stopped yazl's internal pump: the builder's
     promise settled while bytes kept landing on disk well after. Reviewer
     measurement on this exact builder (3x40MB chapters, abort from the
     first onProgress): settled at 65584 bytes, grew to 41943104 bytes 200ms
     later — a fully-completed build despite the "abort".

     What actually stops the growth today: `signal?.throwIfAborted()`
     throwing on the NEXT loop iteration reaches `createZipWritePipeline`'s
     `rejectBuild`, which unpipes `zip.outputStream` from the write stream
     and destroys it — bytes stop reaching disk immediately, which is what
     this test measures. (A third review pass found and removed a SEPARATE
     mechanism that used to also destroy whichever chapter read stream was
     most recently tracked, on abort — it didn't hold up: the loop
     registers entries far faster than yazl's pump consumes them, so the
     tracked stream was typically the wrong one and destroying it was a
     no-op for the pump. That removal doesn't affect this test — the write
     side, not the read side, is what keeps the file's size flat.) Large-ish
     (2 MB) fixtures + a real 150ms settle window make growth observable if
     the write-side teardown regresses — a fixture too small could pass
     vacuously (already fully flushed before either sample). */
  it('an abort actually stops the write — output size does not grow after the promise settles', async () => {
    const abortDir = join(tmpRoot, 'abort-codec');
    mkdirSync(join(abortDir, 'audio'), { recursive: true });
    const chapterCount = 4;
    const chapterBytes = 2 * 1024 * 1024; // 2 MB/chapter — large enough for growth to be observable
    const state: BookStateJson = {
      ...makeState(),
      chapters: Array.from({ length: chapterCount }, (_, i) => ({
        id: i + 1,
        title: `Chapter ${i + 1}`,
        slug: `${String(i + 1).padStart(2, '0')}-chapter-${i + 1}`,
      })),
    };
    for (const chapter of state.chapters) {
      writeFileSync(
        join(abortDir, 'audio', `${chapter.slug}.m4a`),
        Buffer.alloc(chapterBytes, chapter.id),
      );
    }
    const outPath = join(tmpRoot, 'abort-codec.zip');

    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);

    const controller = new AbortController();
    let rejection: unknown = null;
    try {
      const build = buildCodecZip({
        bookDir: abortDir,
        state,
        outPath,
        format: 'aac-m4a',
        signal: controller.signal,
        onProgress: () => {
          // Abort partway through the first chapter's write, mirroring the
          // reviewer's "abort from the first onProgress" repro.
          controller.abort();
        },
      });
      await build;
    } catch (e) {
      rejection = e;
    }
    // Give the fs layer a real window to keep writing IF the pump were
    // still running — this is the actual proof, not the rejection itself.
    const sizeAtSettle = readFileSync(outPath).length;
    await new Promise((r) => setTimeout(r, 150));
    const sizeAfterDelay = readFileSync(outPath).length;

    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);

    expect((rejection as Error)?.name).toBe('AbortError');
    expect(escaped).toBeNull();
    expect(sizeAfterDelay).toBe(sizeAtSettle);
    // Sanity: the abort genuinely landed before the full archive was
    // written (chapterCount * chapterBytes), so this isn't just proving
    // "a completed build doesn't grow further".
    expect(sizeAtSettle).toBeLessThan(chapterCount * chapterBytes);
  });

  /* Reviewer finding: `zip.on('error', rejectBuild)` inside
     createZipWritePipeline (build-mp3-zip.ts) had NO regression test of
     its own — deleting that one line and running the whole export suite
     left every test green, including this file's.

     A book with ZERO chapters is NOT a sufficient repro (tried first, see
     PR discussion): with no `addReadStream` entries at all, yazl's own
     completion is fully synchronous relative to the injected error and
     finishes on its own regardless of whether the listener exists — the
     promise resolves "successfully" either way, silently masking the
     missing forwarding rather than exposing it. At least one REAL
     `addReadStream` entry (a genuine async fs read) is what actually gives
     the disruption something in flight to interrupt — confirmed
     empirically: this test hangs to the 1s race timeout without the fix,
     and resolves instantly with it. Reuses this describe block's real
     `bookDir` fixture (`01-chapter-1.m4a` / `02-chapter-2.m4a`) so the
     per-chapter loop does genuine addReadStream work before hitting
     `zip.end()` / `await pipeline.donePromise`. */
  it('forwards a ZipFile-level internal error to the rejection instead of crashing the process', async () => {
    const injected = new Error('mock yazl internal validation failure (ZipFile-level)');
    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    triggerZipFileError = injected;
    const outPath = join(tmpRoot, 'zipfile-level-error-test.m4a.zip');
    try {
      // De-raced (see build-mp3-zip.test.ts's identical sibling test for the
      // full history): no more `Promise.race` against a hand-rolled timer.
      // That raced the per-chapter loop's real addReadStream I/O, which is
      // unrelated work this test doesn't control — under contention it can
      // outrun any fixed timer even when the forwarding line is correct.
      // With the listener wired, the injected error rejects buildCodecZip's
      // own promise with the SAME error object; without it, the promise
      // never settles, and this assertion fails by vitest's own (generous,
      // centrally configured via testTimeout in vitest.config.ts) test
      // timeout instead — the correct red for "never settles".
      await expect(
        buildCodecZip({ bookDir, state: makeState(), outPath, format: 'aac-m4a' }),
      ).rejects.toBe(injected);
    } finally {
      process.off('uncaughtException', onUncaught);
      triggerZipFileError = null;
    }
    // The other half of the regression: the injected error must have been
    // forwarded to the rejection, NOT escaped as a raw uncaught exception.
    expect(escaped).toBeNull();
  });
});
