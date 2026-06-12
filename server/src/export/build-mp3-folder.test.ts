/* Integration tests for buildMp3Folder (plan 34 B1). Mirrors the
   build-mp3-zip test rig but inspects the on-disk per-chapter MP3s
   directly instead of unzipping. */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { encodePcmToAudio } from '../tts/mp3.js';
import { buildMp3Folder } from './build-mp3-folder.js';
import { ExportIncompleteError } from './build-mp3-zip.js';
import type { BookStateJson } from '../workspace/scan.js';

const ffmpegPresent = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();
const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

function readId3Frame(mp3: Buffer, wantedId: 'TIT2' | 'TRCK' | 'TALB'): string | null {
  if (mp3[0] !== 0x49 || mp3[1] !== 0x44 || mp3[2] !== 0x33) return null;
  const tagSize =
    ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  let p = 10;
  while (p < 10 + tagSize - 10) {
    const frameId = mp3.subarray(p, p + 4).toString('latin1');
    const frameSize = mp3.readUInt32BE(p + 4);
    if (frameSize === 0) break;
    if (frameId === wantedId) {
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

function makeState(over: Partial<BookStateJson> = {}): BookStateJson {
  return {
    bookId: 'demo__sa__test',
    manuscriptId: 'mns_test',
    title: 'the Coalfall Commission',
    author: 'Shannon Messenger',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: true,
    chapters: [
      { id: 1, title: 'Chapter 1 — Opening', slug: '01-chapter-1', duration: '0:00' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2', duration: '0:00' },
      { id: 3, title: 'Front matter', slug: '00-front-matter', excluded: true },
    ],
    coverGradient: ['#abc', '#def'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    narratorCredit: 'Anders Vale',
    genre: 'Fantasy',
    publicationDate: '2026',
    ...over,
  };
}

describeIfFfmpeg('buildMp3Folder', () => {
  let tmpRoot: string;
  let bookDir: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'build-mp3-folder-'));
    bookDir = join(tmpRoot, 'book');
    mkdirSync(join(bookDir, 'audio'), { recursive: true });

    const slugs = ['01-chapter-1', '02-chapter-2'];
    for (const slug of slugs) {
      const mp3 = await encodePcmToAudio(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
      writeFileSync(join(bookDir, 'audio', `${slug}.mp3`), mp3);
    }
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes one tagged MP3 per non-excluded chapter, ordered by id, with NN- filenames', async () => {
    const outDir = join(tmpRoot, 'export-1', 'the Coalfall Commission');
    const result = await buildMp3Folder({ bookDir, state: makeState(), outDir });

    expect(result.entries).toHaveLength(2);
    expect(result.totalBytes).toBeGreaterThan(0);

    const names = readdirSync(outDir).sort();
    expect(names).toEqual(['01 - Chapter 1 - Opening.mp3', '02 - Chapter 2.mp3']);

    const ch1 = readFileSync(join(outDir, names[0]));
    expect(readId3Frame(ch1, 'TIT2')).toBe('Chapter 1 — Opening');
    expect(readId3Frame(ch1, 'TALB')).toBe('the Coalfall Commission');
    expect(readId3Frame(ch1, 'TRCK')).toBe('1/2');

    const ch2 = readFileSync(join(outDir, names[1]));
    expect(readId3Frame(ch2, 'TIT2')).toBe('Chapter 2');
    expect(readId3Frame(ch2, 'TRCK')).toBe('2/2');
  }, 30_000);

  it('refuses with ExportIncompleteError when a non-excluded chapter has no audio file', async () => {
    const incompleteAudio = join(tmpRoot, 'incomplete-book', 'audio');
    mkdirSync(incompleteAudio, { recursive: true });
    const mp3 = await encodePcmToAudio(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
    writeFileSync(join(incompleteAudio, '01-chapter-1.mp3'), mp3);
    /* No audio at all for chapter 2 — precheck must reject. */

    await expect(
      buildMp3Folder({
        bookDir: join(tmpRoot, 'incomplete-book'),
        state: makeState(),
        outDir: join(tmpRoot, 'export-incomplete', 'the Coalfall Commission'),
      }),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  }, 15_000);

  it('overwrites the destination directory on rerun so stale chapter files do not survive', async () => {
    const outDir = join(tmpRoot, 'export-rerun', 'the Coalfall Commission');
    /* Plant a stale file inside the destination first — represents a
       previous run that produced more chapters than this one. The
       builder must rm-and-recreate, not just write-through. */
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, '99 - Stale Chapter.mp3'), Buffer.from('stale'));

    await buildMp3Folder({ bookDir, state: makeState(), outDir });

    const names = readdirSync(outDir).sort();
    expect(names).toEqual(['01 - Chapter 1 - Opening.mp3', '02 - Chapter 2.mp3']);
    expect(existsSync(join(outDir, '99 - Stale Chapter.mp3'))).toBe(false);
  }, 30_000);

  it('reports monotonic progress reaching 1 on completion', async () => {
    const outDir = join(tmpRoot, 'export-progress', 'the Coalfall Commission');
    const ratios: number[] = [];
    await buildMp3Folder({
      bookDir,
      state: makeState(),
      outDir,
      onProgress: (r) => ratios.push(r),
    });
    expect(ratios.length).toBeGreaterThan(0);
    expect(ratios[ratios.length - 1]).toBe(1);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1] - 1e-9);
    }
  }, 30_000);
});
