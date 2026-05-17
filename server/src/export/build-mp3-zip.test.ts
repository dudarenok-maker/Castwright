/* Integration tests for buildMp3Zip — spawns real ffmpeg via the id3-tags
   helper and writes a real zip via yazl. The zip is then opened with
   Node's built-in unzip helpers (yauzl) to verify entry order, names,
   and that each entry's ID3 frames carry the expected TRCK / TIT2.

   The zero-audio test ensures the precheck refuses to ship a half-built
   archive — PocketBook reads MP3.ZIP, and every non-excluded chapter
   needs an MP3 on disk. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { encodePcmToMp3 } from '../tts/mp3.js';
import { buildMp3Zip, ExportIncompleteError, sanitiseForZip } from './build-mp3-zip.js';
import type { BookStateJson } from '../workspace/scan.js';

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
      const mp3 = await encodePcmToMp3(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
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
    const mp3 = await encodePcmToMp3(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
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
  // eslint-disable-next-line no-console
  console.warn('[build-mp3-zip.test.ts] ffmpeg missing — skipping zip integration tests.');
}
