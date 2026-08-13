/* Integration tests for buildMp3Zip — spawns real ffmpeg via the id3-tags
   helper and writes a real zip via yazl. The zip is then opened with
   Node's built-in unzip helpers (yauzl) to verify entry order, names,
   and that each entry's ID3 frames carry the expected TRCK / TIT2.

   The zero-audio test ensures the precheck refuses to ship a half-built
   archive — PocketBook reads MP3.ZIP, and every non-excluded chapter
   needs an MP3 on disk. */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { encodePcmToAudio } from '../tts/mp3.js';
import { ZipFile } from 'yazl';
import {
  buildMp3Zip,
  createZipWritePipeline,
  ExportIncompleteError,
  sanitiseForZip,
} from './build-mp3-zip.js';
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
   an `uncaughtException`, and the pipeline's promise never settling.

   `lastZipFile` captures the constructed instance so a test can also
   inspect its `outputStream`'s listener count after rejection (N3). The
   sibling `zip.outputStream.on('error', rejectBuild)` forwarding line is
   NOT exercised via this same constructor-time nextTick mechanism — see the
   `createZipWritePipeline` describe block below for that test and why it's
   injected differently (a full-`buildMp3Zip()` version through this
   mechanism was flaky under load; see that test's own comment for why). */
let triggerZipFileError: Error | null = null;
let lastZipFile: InstanceType<typeof import('yazl').ZipFile> | null = null;
vi.mock('yazl', async (importOriginal) => {
  const real = await importOriginal<typeof import('yazl')>();
  class TestZipFile extends real.ZipFile {
    constructor() {
      super();
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- test-only capture of the constructed instance, see comment above.
      lastZipFile = this;
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
      // De-raced (see the `createZipWritePipeline` describe block's
      // "outputStream-level" test comment below for the full history): no
      // more `Promise.race` against a hand-rolled timer. That raced the
      // per-chapter loop's real ffmpeg-tagging I/O, which is unrelated
      // work this test doesn't control — under contention it can outrun
      // any fixed timer even when the forwarding line is correct. With the
      // listener wired, the injected error rejects buildMp3Zip's own
      // promise with the SAME error object; without it, the promise never
      // settles, and this assertion fails by vitest's own (generous,
      // centrally configured via testTimeout in vitest.config.ts) test
      // timeout instead — the correct red for "never settles".
      await expect(
        buildMp3Zip({ bookDir, state: makeState(), outPath: localOutPath }),
      ).rejects.toBe(injected);
    } finally {
      process.off('uncaughtException', onUncaught);
      triggerZipFileError = null;
    }
    // The other half of the regression: the injected error must have been
    // forwarded to the rejection, NOT escaped as a raw uncaught exception.
    expect(escaped).toBeNull();
  });

  /* N3 (fourth review pass, found in passing while chasing the mutation
     gaps above): the byte-counting 'data' listener on `zip.outputStream`
     was never detached on reject — build-portable-book.ts's equivalent
     (`onData`, its own N6 fix) explicitly `.off('data', onData)`s for
     exactly this reason. Left attached, an unpiped-but-still-flowing
     outputStream after rejectBuild keeps a live 'data' consumer, so yazl's
     internal pump keeps running at full speed with no backpressure through
     every already-registered chapter, into a counter nobody will ever read.

     Reuses the ZipFile-level error injection (`triggerZipFileError`) so the
     pipeline rejects deterministically, then inspects the captured ZipFile
     instance's `outputStream` — a listener count of 0 for 'data' is the
     direct, black-box-observable signal that the counter stopped
     consuming; deleting the `.off('data', onData)` call in
     build-mp3-zip.ts leaves this at 1 (never removed) and reddens this
     test without needing to observe `bytes` itself, which isn't exposed
     outside the module. */
  it('stops consuming outputStream data once the pipeline has already rejected (N3)', async () => {
    const injected = new Error('mock yazl internal validation failure (ZipFile-level, N3)');
    triggerZipFileError = injected;
    const localOutPath = join(tmpRoot, 'n3-data-leak-test.zip');
    try {
      await expect(
        buildMp3Zip({ bookDir, state: makeState(), outPath: localOutPath }),
      ).rejects.toBe(injected);
    } finally {
      triggerZipFileError = null;
    }

    expect(lastZipFile).not.toBeNull();
    expect(lastZipFile!.outputStream.listenerCount('data')).toBe(0);
  }, 10_000);

  /* Mutation-testing finding (fourth review pass): `pipeline.rejectBuild(e)`
     in buildMp3Zip's own catch block (the one wrapping the per-chapter
     loop) had no test — build-codec-zip.ts's equivalent IS covered (its
     "an abort actually stops the write" test), mp3-zip's was not.

     This is a DIFFERENT call site than every other test above: those cover
     the readStream/ws/zip/outputStream 'error' forwarders, all of which
     also route through `rejectBuild`, but none of which exercises THIS
     particular catch — the one that fires when `signal?.throwIfAborted()`
     itself throws a plain AbortError with no 'error' event involved at
     all. A naive "does the build reject with AbortError" assertion would
     NOT catch this mutant: `throw e;` on the very next line re-throws
     regardless of whether `pipeline.rejectBuild(e)` ran, so the OUTER
     promise's rejection value is identical either way. The actual,
     mutation-sensitive side effect is what `rejectBuild` does to the write
     pipeline — unpipe `zip.outputStream` from `ws` and `ws.destroy()` —
     which is directly observable via `lastWriteStream` (the same
     `createWriteStream` wrapper the nit (f) test above uses) without
     needing a large fixture or a real-time growth window: with the catch's
     `pipeline.rejectBuild(e)` deleted, nothing ever destroys `ws` on this
     path (the loop never reaches `zip.end()`, so there's no natural
     'finish'/'close' either), so `lastWriteStream.destroyed` stays `false`
     even though `buildMp3Zip` has already rejected. */
  it('destroys the write stream when the build aborts mid-loop (pipeline.rejectBuild in the catch)', async () => {
    const controller = new AbortController();
    lastWriteStream = null;
    const localOutPath = join(tmpRoot, 'abort-catch-rejectbuild-test.zip');
    let rejection: unknown = null;
    try {
      await buildMp3Zip({
        bookDir,
        state: makeState(),
        outPath: localOutPath,
        signal: controller.signal,
        // Abort partway through the first chapter, mirroring build-codec-
        // zip.test.ts's "abort from the first onProgress" repro — the NEXT
        // iteration's `signal?.throwIfAborted()` is what actually throws.
        onProgress: () => {
          controller.abort();
        },
      });
    } catch (e) {
      rejection = e;
    }
    expect((rejection as Error)?.name).toBe('AbortError');
    expect(lastWriteStream).not.toBeNull();
    expect(lastWriteStream!.destroyed).toBe(true);
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

  /* Placebo fix (fourth review pass): this test's name claims it resolves
     only once the write stream is "genuinely closed, not merely flushed",
     but the body only ever asserted `existsSync(outPath)` — which `finish`
     satisfies exactly as well as `close` does (the file exists, and its
     bytes are on disk, well before the fd is actually released). Changing
     `ws.on('close', ...)` to `ws.on('finish', ...)` in createZipWritePipeline
     left this test green, silently defeating the whole point of the nit
     (f)/N1 fix history above.

     `ws.closed` is the direct, platform-independent signal this test was
     supposed to check: confirmed empirically (see this PR's dev notes) that
     a plain `fs.WriteStream` reports `.closed === false` at the moment
     `'finish'` fires and only flips to `true` once `'close'` actually
     fires — `finish` means bytes are flushed to the OS, `close` means the
     fd itself has been released via the async autoClose `fs.close()`
     round-trip, which is a genuinely later tick. Reading `lastWriteStream`
     via the `createWriteStream` wrapper at the top of this file (same
     mechanism nit (f)'s test above uses) makes that flag observable from
     outside the pipeline's own API. */
  it('resolves only once the write stream is genuinely closed, not merely flushed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-pipeline-close-'));
    try {
      const outPath = join(dir, 'out.zip');
      const zip = new ZipFile();
      lastWriteStream = null;
      const pipeline = createZipWritePipeline(outPath, zip);
      expect(lastWriteStream).not.toBeNull();
      zip.end();
      await pipeline.donePromise;
      // The direct signal that the fd itself was released — `finish` alone
      // (bytes flushed, fd possibly still open) would NOT satisfy this;
      // only the `'close'` event flips it.
      expect(lastWriteStream!.closed).toBe(true);
      expect(existsSync(outPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /* Mutation-testing finding (fourth review pass): `zip.outputStream.on(
     'error', rejectBuild)` inside createZipWritePipeline — the OTHER of the
     three error forwarders the class docstring above lists, distinct from
     the ZipFile-level one covered by the `buildMp3Zip` describe block above
     — had no test of its own. Deleting that one line left all existing
     tests (this file included) green, and this pipeline is shared by
     buildMp3Zip, buildCodecZip, and buildCaptions via createZipWritePipeline,
     so a regression here silently affects all three builders at once.

     FIRST VERSION of this test lived in the `buildMp3Zip` describe block
     above and injected the error via a `process.nextTick`-scheduled emit on
     the mocked ZipFile's constructor, racing it against a full
     `buildMp3Zip()` call over that block's real 3-chapter ffmpeg-tagged
     fixture (same shape as the ZipFile-level test still there). That was
     flaky under load: the forwarding line settles `pipeline.donePromise`
     correctly and near-instantly, but `buildMp3Zip`'s OUTER promise doesn't
     observe that settlement until control flow reaches `await
     pipeline.donePromise` — which is only reached once the per-chapter loop
     finishes tagging all 3 real chapters via `applyId3v24Tags` (real ffmpeg
     spawns + disk I/O). Under contention that unrelated real work can itself
     outrun an arbitrary race timeout, failing the test even when the
     forwarding line is correct — a race against the fixture's own I/O, not
     against the bug this test exists to catch. (The ZipFile-level test above
     doesn't share this exposure the same way: its injected error sets
     yazl's own `self.errored`, which halts `pumpEntries` — but the per-
     chapter loop's real ffmpeg work still has to finish before `await
     pipeline.donePromise` is reached either way, so it wasn't actually
     exempt; it wasn't observed flaking, but the mechanism was identical.
     Since fixed the same way as this test — dropped its own `Promise.race`
     against a hard-coded timer, so a mutant now fails by vitest's own test
     timeout instead — rather than left carrying the same latent exposure.)

     Rewritten below to exercise `createZipWritePipeline` directly, same as
     nit (f)/N1 above: no chapters, no ffmpeg, nothing real to wait on.
     `zip.outputStream.emit('error', ...)` is called SYNCHRONOUSLY — not via
     nextTick. There's no Promise-executor auto-catch trap to dodge here the
     way there was for the mocked-constructor version: by this point
     `createZipWritePipeline` has already returned and its executor has
     already run to completion, so settling `donePromise` from a later emit
     is no different than nit (f)'s direct `pipeline.rejectBuild(...)` call.
     With the fix line present, the emit's own listener dispatch settles
     `donePromise` before `.emit()` returns — no race, no timeout. Without it
     (mutant), `.emit()` itself throws: `zip.outputStream` genuinely has zero
     'error' listeners at that point (confirmed empirically — `.pipe()` does
     NOT install one on its source stream in this Node version, unlike a
     common misconception), and that throw happens synchronously inside this
     test's own call, failing it immediately and unmistakably. The outcome
     no longer depends on which of two async paths wins.

     PRODUCTION CONSEQUENCE (why the line matters — not what this unit test
     itself exercises, since it deliberately no longer drives the async
     mutant shape): an earlier version of this comment claimed the mutant
     made `buildMp3Zip` "resolve as if nothing failed", calling that
     "arguably worse than a hang". Verified FALSE. A standalone Node repro of
     the real async shape — a piped PassThrough, the error emitted via
     `process.nextTick` (matching yazl's own real internal error timing,
     mid-pump) with zero listeners on the source — shows the throw ALSO
     escapes as an `uncaughtException`, on top of the pipeline eventually
     resolving on its own once the rest of the (now-orphaned) pump finishes:
       uncaughtException(s): ["INJECTED"]
       donePromise RESOLVED: true
     In production, `installCrashHandlers()` (server/src/crash-logging.ts)
     answers `uncaughtException` with `exit(1)` — so the mutant's real shape
     is the SAME server-killing crash class this PR exists to fix, plus a
     bogus success for anyone watching only the API response and not the
     process log. Not "worse than a hang" — the ordinary crash, with a
     false-positive success as an added twist.

     No uncaughtException probe below (unlike the ZipFile-level test above):
     with the injection now synchronous rather than nextTick-scheduled, the
     mutant surfaces as a direct throw inside THIS test's own call stack —
     there's no escape to `process` left for a probe to observe. A
     standalone nextTick-based probe, built to match this file's exact mock
     harness, DID fire reliably when tried in isolation — so the earlier
     discrepancy (a test-installed handler reportedly not observing this
     specific throw, despite a positive control confirming such handlers
     fire under this vitest setup) was not reproduced here. Left unresolved
     rather than asserted on faith, and moot for this version of the test
     regardless. */
  it('forwards an outputStream-level write error to the rejection instead of crashing the process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-pipeline-outputstream-'));
    try {
      const outPath = join(dir, 'out.zip');
      const zip = new ZipFile();
      lastWriteStream = null;
      const pipeline = createZipWritePipeline(outPath, zip);
      expect(lastWriteStream).not.toBeNull();

      const injected = new Error('mock yazl write failure (outputStream-level)');
      zip.outputStream.emit('error', injected);

      await expect(pipeline.donePromise).rejects.toBe(injected);
      expect(lastWriteStream!.destroyed).toBe(true);
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
