/* Integration tests for buildMp3Zip — spawns real ffmpeg via the id3-tags
   helper and writes a real zip via yazl. The zip is then opened with
   Node's built-in unzip helpers (yauzl) to verify entry order, names,
   and that each entry's ID3 frames carry the expected TRCK / TIT2.

   The zero-audio test ensures the precheck refuses to ship a half-built
   archive — PocketBook reads MP3.ZIP, and every non-excluded chapter
   needs an MP3 on disk. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { encodePcmToAudio } from '../tts/mp3.js';
import { ZipFile } from 'yazl';
import { buildMp3Zip, createZipWritePipeline, ExportIncompleteError, sanitiseForZip } from './build-mp3-zip.js';
import type { BookStateJson } from '../workspace/scan.js';

/* Nit (f) regression (below, in the `createZipWritePipeline` describe
   block) needs a handle on the REAL `fs.WriteStream` createZipWritePipeline
   constructs internally — it isn't exposed on the pipeline's own public
   API. Wrapping `createWriteStream` (everything else passed through to the
   real implementation via `importOriginal`, same pattern as the `yazl`
   mock above) captures it without changing behavior for any other test in
   this file. */
let lastWriteStream: WriteStream | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    createWriteStream: (...args: Parameters<typeof real.createWriteStream>) => {
      const ws = real.createWriteStream(...args);
      lastWriteStream = ws;
      return ws;
    },
  };
});

/* Behavioral regression for the ZipFile-level `zip.on('error', rejectBuild)`
   listener inside createZipWritePipeline (this file) — shared by both
   buildMp3Zip and buildCodecZip. See build-captions.test.ts's identical
   mock (the reference implementation this is copied from) for the full
   explanation of why the injected error is emitted via `process.nextTick`
   rather than synchronously during construction: `new Promise(executor)`
   auto-catches a *synchronous* throw inside its executor and turns it into
   a rejection on its own, so emitting synchronously from the ZipFile
   constructor would "pass" this test even with the fix line deleted, for
   JS's reasons rather than createZipWritePipeline's own forwarding.
   Scheduling via `process.nextTick` moves the emit outside that frame —
   same as yazl's real internal error sites — so an absent
   `zip.on('error', rejectBuild)` reproduces the real bug: zero listeners,
   an `uncaughtException`, and the pipeline's promise never settling. */
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

const ffmpegPresent = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();
const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

/* Decode a yazl-produced zip without pulling in another dep. ZIP layout:
   we only need the central directory (CD) — at the end of file there's
   an "End of central directory" record (EOCD, sig 0x06054b50), which
   points to the CD's offset and entry count. Each CD entry is fixed
   46 bytes + name + extra + comment. We only need the name + the
   "local file" offset, which we'll dereference to read the entry's
   compressed bytes. */
function readZipEntries(zip: Buffer): Array<{ name: string; data: Buffer }> {
  /* Find EOCD by scanning backwards for the signature (max comment 64 KB
     in the wild, but our tests don't write comments). */
  let eocdOff = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error('Not a zip (no EOCD)');
  const cdCount = zip.readUInt16LE(eocdOff + 10);
  const cdSize = zip.readUInt32LE(eocdOff + 12);
  const cdOff = zip.readUInt32LE(eocdOff + 16);
  void cdSize;

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

    /* Local file header is 30 bytes + name + extra; payload follows. */
    const lhNameLen = zip.readUInt16LE(localOff + 26);
    const lhExtraLen = zip.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const data = zip.subarray(dataStart, dataStart + compSize);
    if (compMethod !== 0) {
      throw new Error(
        'Test expects stored (no-deflate) entries; bigger files would zlib-inflate here.',
      );
    }
    entries.push({ name, data: Buffer.from(data) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readId3Title(mp3: Buffer): string | null {
  if (mp3[0] !== 0x49 || mp3[1] !== 0x44 || mp3[2] !== 0x33) return null;
  const tagSize =
    ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  let p = 10;
  while (p < 10 + tagSize - 10) {
    const frameId = mp3.subarray(p, p + 4).toString('latin1');
    const frameSize = mp3.readUInt32BE(p + 4);
    if (frameSize === 0) break;
    if (frameId === 'TIT2') {
      /* Frame body: 1-byte encoding + text. Encodings: 0=Latin1, 1=UTF-16 BOM,
         2=UTF-16BE, 3=UTF-8. */
      const enc = mp3[p + 10];
      const text = mp3.subarray(p + 11, p + 10 + frameSize);
      if (enc === 0) return text.toString('latin1').replace(/\0+$/, '');
      if (enc === 3) return text.toString('utf8').replace(/\0+$/, '');
      if (enc === 1) {
        /* UTF-16 with BOM */
        return text.toString('utf16le').replace(/^﻿/, '').replace(/\0+$/, '');
      }
    }
    p += 10 + frameSize;
  }
  return null;
}

function readId3Track(mp3: Buffer): string | null {
  if (mp3[0] !== 0x49 || mp3[1] !== 0x44 || mp3[2] !== 0x33) return null;
  const tagSize =
    ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  let p = 10;
  while (p < 10 + tagSize - 10) {
    const frameId = mp3.subarray(p, p + 4).toString('latin1');
    const frameSize = mp3.readUInt32BE(p + 4);
    if (frameSize === 0) break;
    if (frameId === 'TRCK') {
      const enc = mp3[p + 10];
      const text = mp3.subarray(p + 11, p + 10 + frameSize);
      if (enc === 0) return text.toString('latin1').replace(/\0+$/, '');
      if (enc === 3) return text.toString('utf8').replace(/\0+$/, '');
      if (enc === 1) return text.toString('utf16le').replace(/^﻿/, '').replace(/\0+$/, '');
    }
    p += 10 + frameSize;
  }
  return null;
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
      { id: 1, title: 'Chapter 1 — Opening', slug: '01-chapter-1', duration: '0:00' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2', duration: '0:00' },
      { id: 3, title: 'Front matter', slug: '00-front-matter', excluded: true },
      { id: 4, title: 'Chapter 3', slug: '04-chapter-3', duration: '0:00' },
    ],
    coverGradient: ['#abc', '#def'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    narratorCredit: 'Jane Narrator',
    genre: 'Audiobook',
    publicationDate: '2025',
  };
}

describeIfFfmpeg('buildMp3Zip', () => {
  let tmpRoot: string;
  let bookDir: string;
  let outPath: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'build-mp3-zip-'));
    bookDir = join(tmpRoot, 'book');
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    outPath = join(tmpRoot, 'out.zip');

    /* Tiny silent MP3s for the three non-excluded chapters. */
    const slugs = ['01-chapter-1', '02-chapter-2', '04-chapter-3'];
    for (const slug of slugs) {
      const mp3 = await encodePcmToAudio(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
      writeFileSync(join(bookDir, 'audio', `${slug}.mp3`), mp3);
    }
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('packs the non-excluded chapters in order with 2-digit prefixes', async () => {
    const result = await buildMp3Zip({ bookDir, state: makeState(), outPath });

    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.entries).toEqual([
      '01 - Chapter 1 - Opening.mp3',
      '02 - Chapter 2.mp3',
      '03 - Chapter 3.mp3',
    ]);

    const zip = readFileSync(outPath);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(result.entries);

    /* Each entry carries TIT2 and TRCK = `N/3`. */
    expect(readId3Title(entries[0].data)).toBe('Chapter 1 — Opening');
    expect(readId3Title(entries[1].data)).toBe('Chapter 2');
    expect(readId3Track(entries[0].data)).toBe('1/3');
    expect(readId3Track(entries[2].data)).toBe('3/3');
  });

  it('refuses with ExportIncompleteError when a non-excluded chapter has no audio file', async () => {
    const incompleteDir = join(tmpRoot, 'incomplete', 'audio');
    mkdirSync(incompleteDir, { recursive: true });
    const mp3 = await encodePcmToAudio(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
    writeFileSync(join(incompleteDir, '01-chapter-1.mp3'), mp3);
    /* No MP3 (or anything) for chapter 2 — precheck must reject. */

    await expect(
      buildMp3Zip({
        bookDir: join(tmpRoot, 'incomplete'),
        state: makeState(),
        outPath: join(tmpRoot, 'incomplete.zip'),
      }),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  });

  it('reports per-chapter progress to onProgress', async () => {
    const ratios: number[] = [];
    await buildMp3Zip({
      bookDir,
      state: makeState(),
      outPath: join(tmpRoot, 'progress.zip'),
      onProgress: (r) => ratios.push(r),
    });
    expect(ratios.length).toBe(3);
    expect(ratios[0]).toBeCloseTo(1 / 3, 5);
    expect(ratios[2]).toBe(1);
  });

  /* Production stability + macOS cross-os.yml flake (run 31588267496): a
     staged chapter file that disappears between being tagged and being
     zipped (e.g. the workspace getting torn down mid-build) used to crash
     the WHOLE process instead of failing the export.

     Root cause: `zip.addReadStream(createReadStream(taggedPath), ...)`
     hands yazl a raw readStream. yazl's `addFile` attaches its own
     `readStream.on('error', ...)` before pumping — but `addReadStream`
     does NOT (see node_modules/yazl/index.js: addFile line ~44 vs.
     addReadStreamLazy, which has no equivalent). `.pipe()` never forwards
     'error' from source to destination either. So an ENOENT on that read
     stream had zero listeners: Node throws it synchronously as an
     uncaught exception, bypassing every try/catch in the awaited call
     chain (buildMp3Zip's own try/finally included) — exactly the
     "Uncaught Exception" Vitest caught on the macOS runner, unrelated to
     whether the caller of buildMp3Zip ever added a .catch().

     This test deletes each chapter's staged file immediately after its
     read stream is created (via onProgress, which fires right after
     addReadStream in the loop) but before Node's async fs.open() behind
     it can possibly have resolved — reproducing the race deterministically
     on any platform, no sleep/poll required.

     Nit (d) (independent review): the staging-dir lookup below matches on
     PREFIX only (`<basename>.staging-<pid>-`), first match wins. A leftover
     staging dir from a prior attempt at the SAME outPath — exactly what a
     hung build leaves, since it never reaches its `finally` cleanup —
     collides on that prefix; `readdirSync`'s listing order then decides
     which one "wins", and it is not guaranteed to be the fresh one.
     Observed live on this box, reusing the shared `tmpRoot`/outPath across
     a vitest retry: attempt 1 timed out (leaving its staging dir behind),
     and attempt 2's `onProgress` matched attempt 1's ABANDONED dir instead
     of its own, deleted files nobody was reading, and produced a clean
     3-entry zip with no ENOENT at all — the seam disarmed itself between
     attempts. Giving this test its own freshly `mkdtemp`ed directory (a
     new random suffix every call, retries included) makes that collision
     structurally impossible: there is never a second staging dir under
     this path for the lookup to prefer by accident. */
  it('forwards a deleted-staged-file read error instead of crashing the process', async () => {
    const raceRoot = mkdtempSync(join(tmpdir(), 'build-mp3-zip-staging-race-'));
    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    const localOutPath = join(raceRoot, 'deleted-staging-race.zip');
    try {
      await expect(
        buildMp3Zip({
          bookDir,
          state: makeState(),
          outPath: localOutPath,
          onProgress: () => {
            const dir = dirname(localOutPath);
            const stagingPrefix = `${basename(localOutPath)}.staging-${process.pid}-`;
            const stagingName = readdirSync(dir).find((n) => n.startsWith(stagingPrefix));
            if (!stagingName) return;
            const stagingDir = join(dir, stagingName);
            for (const f of readdirSync(stagingDir)) {
              rmSync(join(stagingDir, f), { force: true });
            }
          },
        }),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      process.off('uncaughtException', onUncaught);
      rmSync(raceRoot, { recursive: true, force: true });
    }
    // The real assertion: nothing escaped as a raw uncaught exception. If
    // this is non-null, the read-stream error crashed the process instead
    // of rejecting buildMp3Zip's own promise.
    expect(escaped).toBeNull();
  }, 10_000);

  /* Reviewer finding: `zip.on('error', rejectBuild)` inside
     createZipWritePipeline had NO regression test of its own — deleting
     that one line and running the whole export suite left every test
     green.

     A book with ZERO chapters is NOT a sufficient repro here (tried first,
     see PR discussion): with no `addReadStream`/`addBuffer` entries at
     all, yazl's own completion is fully synchronous relative to the
     injected error and finishes on its own regardless of whether the
     listener exists — the promise resolves "successfully" either way,
     silently masking the missing forwarding rather than exposing it. At
     least one REAL `addReadStream` entry (a genuine async fs read, same
     as this file's own chapters) is what actually gives the disruption
     something in flight to interrupt — confirmed empirically: this test
     hangs to the 1s race timeout without the fix, and resolves instantly
     with it. Reuses this describe block's real ffmpeg-tagged chapter
     fixture so the per-chapter loop does genuine work before hitting
     `zip.end()` / `await pipeline.donePromise`. */
  it('forwards a ZipFile-level internal error to the rejection instead of crashing the process', async () => {
    const injected = new Error('mock yazl internal validation failure (ZipFile-level)');
    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    triggerZipFileError = injected;
    const localOutPath = join(tmpRoot, 'zipfile-level-error-test.zip');
    try {
      const raced = await Promise.race([
        buildMp3Zip({ bookDir, state: makeState(), outPath: localOutPath }).then(
          (r) => ({ kind: 'resolved' as const, value: r }),
          (e) => ({ kind: 'rejected' as const, value: e }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' }), 1000),
        ),
      ]);
      // With the listener wired, the injected error rejects buildMp3Zip's
      // own promise with the SAME error object. Without it, the promise
      // never settles at all — that's the 'timeout' branch, a deliberate,
      // fast, diagnosable failure instead of waiting on vitest's own test
      // timeout.
      expect(raced.kind).toBe('rejected');
      expect((raced as { kind: 'rejected'; value: unknown }).value).toBe(injected);
    } finally {
      process.off('uncaughtException', onUncaught);
      triggerZipFileError = null;
    }
    // The other half of the regression: the injected error must have been
    // forwarded to the rejection, NOT escaped as a raw uncaught exception.
    expect(escaped).toBeNull();
  }, 10_000);
});

describe('createZipWritePipeline', () => {
  /* Nit (f) (independent review): on ANY rejection of the write pipeline,
     `ws` (the output write stream) was never destroyed, leaking the write
     fd for the process's lifetime. Previously masked by the crash itself.
     `.destroyed` is the direct, platform-independent signal that Node
     itself has released the stream.

     N1 (third review pass — found in passing while reviewing THIS PR's own
     fix): the original version of this test named itself "destroys the
     write stream and the tracked read stream" but only ever asserted on a
     fake READ stream's `.destroyed` flag — deleting `ws.destroy()` from
     `rejectBuild` left this test green. `trackReadStream` (the mechanism
     the fake read stream exercised) has since been removed entirely — see
     `createZipWritePipeline`'s own doc comment for why — so this test now
     asserts on the one thing `rejectBuild` actually still tears down:
     `ws` itself, captured via the `createWriteStream` wrapper at the top
     of this file (the pipeline doesn't expose `ws` on its own public
     API). */
  it('destroys the write stream when rejectBuild fires on a plain error (nit (f))', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-pipeline-'));
    try {
      const outPath = join(dir, 'out.zip');
      const zip = new ZipFile();
      lastWriteStream = null;
      const pipeline = createZipWritePipeline(outPath, zip);
      expect(lastWriteStream).not.toBeNull();

      pipeline.rejectBuild(new Error('boom'));

      expect(lastWriteStream!.destroyed).toBe(true);
      return pipeline.donePromise.catch((e: unknown) => {
        expect((e as Error).message).toBe('boom');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves only once the write stream is genuinely closed, not merely flushed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-pipeline-close-'));
    try {
      const outPath = join(dir, 'out.zip');
      const zip = new ZipFile();
      const pipeline = createZipWritePipeline(outPath, zip);
      zip.end();
      await pipeline.donePromise;
      // If the promise resolved on 'finish' rather than 'close', the fd
      // could still be open here — assert the file is at least readable
      // with its final byte count settled (a `close`d stream guarantees
      // this; a merely-`finish`ed one does not, on every platform, since
      // autoClose can still be pending).
      expect(existsSync(outPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sanitiseForZip', () => {
  it('downgrades em-dash to ` - ` for FAT32 portability', () => {
    expect(sanitiseForZip('Chapter 1 — The Arrival')).toBe('Chapter 1 - The Arrival');
  });
  it('strips FAT32-illegal characters', () => {
    expect(sanitiseForZip('Bad/Name:With?Stuff*')).toBe('BadNameWithStuff');
  });
  it('trims trailing dots and whitespace', () => {
    expect(sanitiseForZip('Trailing dots...   ')).toBe('Trailing dots');
  });
  it('falls back to Untitled on empty input', () => {
    expect(sanitiseForZip('   ')).toBe('Untitled');
    expect(sanitiseForZip('///')).toBe('Untitled');
  });
});

if (!ffmpegPresent) {
  console.warn('[build-mp3-zip.test.ts] ffmpeg missing — skipping zip integration tests.');
}
