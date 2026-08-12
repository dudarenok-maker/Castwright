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
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildCodecZip } from './build-codec-zip.js';
import { ExportIncompleteError } from './build-mp3-zip.js';
import type { BookStateJson } from '../workspace/scan.js';

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
});
