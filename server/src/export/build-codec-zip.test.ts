/* Tests for buildCodecZip (plan 72's AAC/M4A + Opus/Ogg zip packer). No
   ffmpeg required — like build-portable-book.test.ts, we use raw bytes for
   the audio fixtures since neither findChapterAudio nor buildCodecZip
   validate audio content, only extension + existence.

   Until this file existed, buildCodecZip had NO test coverage at all — a
   gap this round's crash-fix work surfaced (see the last test below) and
   closes alongside it, rather than leaving the module untested. */

import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { getEventListeners } from 'node:events';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

/* Seam for the stat-then-stream race: wraps `node:fs/promises` `stat` and
   `open` so a test can rename a different-size file over a chapter's path
   around the call — after the builder has learned the size (old code:
   stat(path)) or just before it opens its handle (new code: open(path)) —
   and before the bytes are streamed. Fires once. `openedHandles`
   records every handle the builder opens so a test can assert they close. */
let raceHook: { path: string; replacement: Buffer } | null = null;
const openedHandles: FileHandle[] = [];
/* Path whose handle's read stream errors right after creation. */
let readErrorPath: string | null = null;
/* Source-read meter for the cancel tests: every file the builder opens under
   `dir`, and the cumulative bytes those files' read streams emit. It counts by
   wrapping `emit`, so unlike a 'data' listener it never starts a stream
   flowing on its own. */
interface SourceMeter {
  dir: string;
  opened: string[];
  bytes: number;
  onBytes?: () => void;
}
let sourceMeter: SourceMeter | null = null;
function meterHandle(meter: SourceMeter, handle: FileHandle): void {
  const create = handle.createReadStream.bind(handle);
  handle.createReadStream = ((...a: Parameters<typeof create>) => {
    const rs = create(...a);
    const emit = rs.emit.bind(rs);
    rs.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === 'data') {
        meter.bytes += (args[0] as Buffer).length;
        meter.onBytes?.();
      }
      return emit(event, ...args);
    }) as typeof rs.emit;
    return rs;
  }) as typeof handle.createReadStream;
}
function fireRace(path: unknown): void {
  if (!raceHook || path !== raceHook.path) return;
  const { replacement } = raceHook;
  raceHook = null;
  const tmp = `${String(path)}.new`;
  writeFileSync(tmp, replacement);
  renameSync(tmp, String(path));
}
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    stat: (async (...args: Parameters<typeof real.stat>) => {
      const r = await real.stat(...args);
      fireRace(args[0]);
      return r;
    }) as typeof real.stat,
    open: (async (...args: Parameters<typeof real.open>) => {
      /* Fired BEFORE the real open: Windows refuses to rename over a file
         that is already open, so the only reachable window for the new
         code is "swapped just before it opens". Old code's window (after
         stat, before its lazy open) is hit via the stat hook above. */
      fireRace(args[0]);
      const h = await real.open(...args);
      openedHandles.push(h);
      if (sourceMeter && String(args[0]).startsWith(sourceMeter.dir)) {
        sourceMeter.opened.push(String(args[0]));
        meterHandle(sourceMeter, h);
      }
      if (readErrorPath === args[0]) {
        const create = h.createReadStream.bind(h);
        h.createReadStream = ((...a: Parameters<typeof create>) => {
          const rs = create(...a);
          setImmediate(() => rs.destroy(new Error('ENOENT: injected read failure')));
          return rs;
        }) as typeof h.createReadStream;
      }
      return h;
    }) as typeof real.open,
  };
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

     Since the size and bytes now come from one already-open handle, deleting
     the file mid-build no longer fails the read (the open inode survives), so
     the read error is injected on the handle's stream instead. */
  it('forwards a chapter read-stream error instead of crashing the process', async () => {
    const raceDir = join(tmpRoot, 'race');
    mkdirSync(join(raceDir, 'audio'), { recursive: true });
    const audioPaths = [
      join(raceDir, 'audio', '01-chapter-1.m4a'),
      join(raceDir, 'audio', '02-chapter-2.m4a'),
    ];
    for (const p of audioPaths) writeFileSync(p, Buffer.alloc(1024 * 1024, 7));
    readErrorPath = audioPaths[0];

    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    try {
      await expect(
        buildCodecZip({
          bookDir: raceDir,
          state: makeState(),
          outPath: join(tmpRoot, 'race.m4a.zip'),
          format: 'aac-m4a',
        }),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      readErrorPath = null;
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

     What stops the growth: the abort reaches `createZipWritePipeline`'s
     `rejectBuild`, which unpipes `zip.outputStream` from the write stream
     and destroys it — bytes stop reaching disk immediately, which is what
     this test measures. The source reads are measured separately, in the
     "cancel stops the source reads" tests below. Large-ish
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

  /* Race: the old shape did `await stat(path)` then `createReadStream(path)`,
     which opens the file lazily — a render commit renaming a different-size
     take over `path` in between made yazl's declared `size` disagree with the
     streamed bytes ("unexpected number of bytes"). The size is now read from
     the handle the bytes stream from, so both come from one inode. */
  it('declares each entry size from the handle it streams, surviving a rename over the path mid-build', async () => {
    const swapDir = join(tmpRoot, 'swap');
    mkdirSync(join(swapDir, 'audio'), { recursive: true });
    const first = join(swapDir, 'audio', '01-chapter-1.m4a');
    writeFileSync(first, Buffer.from('original-take'));
    writeFileSync(join(swapDir, 'audio', '02-chapter-2.m4a'), Buffer.from('chapter-2'));
    raceHook = { path: first, replacement: Buffer.from('a-much-longer-replacement-take-bytes') };

    const outPath = join(tmpRoot, 'swap.m4a.zip');
    try {
      await buildCodecZip({ bookDir: swapDir, state: makeState(), outPath, format: 'aac-m4a' });
    } finally {
      raceHook = null;
    }
    const entries = readZipEntries(readFileSync(outPath));
    expect(entries.map((e) => e.name)).toEqual(['01 - Chapter 1.m4a', '02 - Chapter 2.m4a']);
    // One consistent inode: the entry holds one whole take, never a mix.
    expect(['original-take', 'a-much-longer-replacement-take-bytes']).toContain(
      entries[0].data.toString('utf8'),
    );
    expect(entries[1].data.toString('utf8')).toBe('chapter-2');
  });

  it('closes every opened file handle when the build is aborted', async () => {
    const closeDir = join(tmpRoot, 'close-on-abort');
    mkdirSync(join(closeDir, 'audio'), { recursive: true });
    const state: BookStateJson = {
      ...makeState(),
      chapters: [1, 2, 3].map((n) => ({ id: n, title: `Chapter ${n}`, slug: `0${n}-chapter-${n}` })),
    };
    for (const c of state.chapters) {
      writeFileSync(join(closeDir, 'audio', `${c.slug}.m4a`), Buffer.alloc(2 * 1024 * 1024, c.id));
    }
    openedHandles.length = 0;
    const controller = new AbortController();
    await expect(
      buildCodecZip({
        bookDir: closeDir,
        state,
        outPath: join(tmpRoot, 'close-on-abort.zip'),
        format: 'aac-m4a',
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(openedHandles.length).toBeGreaterThan(0);
    // FileHandle.close() is async behind stream.destroy(); poll briefly.
    for (let i = 0; i < 50 && openedHandles.some((h) => h.fd !== -1); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(openedHandles.map((h) => h.fd)).toEqual(openedHandles.map(() => -1));
  });
});

/* Cancel stops at the chapter boundary (#2303). Measured on what is READ from
   the source files: a flat output file only shows that writes stopped, which is
   how an earlier abort path looked fixed while yazl kept pumping. Chapters are
   a few MB each so the pump is still inside a chapter when the abort lands. */
describe('buildCodecZip — cancel stops the source reads', () => {
  const chapterCount = 6;
  const chapterBytes = 4 * 1024 * 1024;
  let tmpRoot: string;
  let bookDir: string;
  const state: BookStateJson = {
    ...makeState(),
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      id: i + 1,
      title: `Chapter ${i + 1}`,
      slug: `0${i + 1}-chapter-${i + 1}`,
    })),
  };

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'build-codec-zip-cancel-'));
    bookDir = join(tmpRoot, 'book');
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    for (const c of state.chapters) {
      writeFileSync(join(bookDir, 'audio', `${c.slug}.m4a`), Buffer.alloc(chapterBytes, c.id));
    }
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function stagingDirsFor(outPath: string): string[] {
    return readdirSync(tmpRoot).filter((n) => n.startsWith(`${basename(outPath)}.staging-`));
  }

  /* Chapter 1: the abort lands while the loop is waiting to register chapter 2.
     Chapter 6: it lands after the last registration, when only the pipeline's
     own abort handling can stop the read. */
  it.each([1, chapterCount])(
    'cancel during chapter %i: opens no later chapter and reads nothing after the promise settles',
    async (inFlight) => {
      const outPath = join(tmpRoot, `cancel-${inFlight}.m4a.zip`);
      const readBeforeInFlight = (inFlight - 1) * chapterBytes;
      const controller = new AbortController();
      const meter: SourceMeter = { dir: bookDir, opened: [], bytes: 0 };
      let abortScheduled = false;
      /* Abort half way through the chapter in flight. */
      meter.onBytes = () => {
        if (abortScheduled || meter.bytes < readBeforeInFlight + chapterBytes / 2) return;
        abortScheduled = true;
        setImmediate(() => controller.abort());
      };
      const escaped: unknown[] = [];
      const onEscape = (err: unknown) => {
        escaped.push(err);
      };
      process.on('uncaughtException', onEscape);
      process.on('unhandledRejection', onEscape);
      openedHandles.length = 0;
      sourceMeter = meter;
      try {
        const rejection = await buildCodecZip({
          bookDir,
          state,
          outPath,
          format: 'aac-m4a',
          signal: controller.signal,
        }).then(
          () => null,
          (e: unknown) => e,
        );
        const bytesAtSettle = meter.bytes;
        const fdsAtSettle = openedHandles.map((h) => h.fd);
        const stagingAtSettle = stagingDirsFor(outPath);
        await new Promise((r) => setTimeout(r, 1500));

        expect((rejection as Error | null)?.name).toBe('AbortError');
        // (a) nothing past the chapter in flight at abort was ever opened.
        expect(meter.opened).toEqual(
          state.chapters.slice(0, inFlight).map((c) => join(bookDir, 'audio', `${c.slug}.m4a`)),
        );
        // (b) the pump was idle by the time the promise settled.
        expect(meter.bytes - bytesAtSettle).toBe(0);
        // The in-flight chapter was cut off, not drained to its end.
        expect(bytesAtSettle).toBeGreaterThanOrEqual(readBeforeInFlight + chapterBytes / 2);
        expect(bytesAtSettle).toBeLessThan(readBeforeInFlight + chapterBytes);
        // Every handle was already closed when the promise settled.
        expect(fdsAtSettle).toEqual(Array(inFlight).fill(-1));
        // (d) no staging directory left behind.
        expect(stagingAtSettle).toEqual([]);
        expect(escaped).toEqual([]);
      } finally {
        sourceMeter = null;
        process.off('uncaughtException', onEscape);
        process.off('unhandledRejection', onEscape);
      }
    },
  );

  it('control: an uncancelled build opens every chapter and reads all of it', async () => {
    const outPath = join(tmpRoot, 'control.m4a.zip');
    const controller = new AbortController();
    const meter: SourceMeter = { dir: bookDir, opened: [], bytes: 0 };
    sourceMeter = meter;
    try {
      await buildCodecZip({
        bookDir,
        state,
        outPath,
        format: 'aac-m4a',
        signal: controller.signal,
      });
    } finally {
      sourceMeter = null;
    }
    expect(meter.opened).toHaveLength(chapterCount);
    expect(meter.bytes).toBe(chapterCount * chapterBytes);
    const entries = readZipEntries(readFileSync(outPath));
    expect(entries.map((e) => e.data.length)).toEqual(Array(chapterCount).fill(chapterBytes));
    expect(entries.every((e, i) => e.data.equals(Buffer.alloc(chapterBytes, i + 1)))).toBe(true);
    // Waiting between chapters leaves nothing attached to the caller's signal.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(stagingDirsFor(outPath)).toEqual([]);
  });
});
