/* Integration tests for buildM4b — drives real ffmpeg + ffprobe.
   Mirrors build-mp3-zip.test.ts in shape (synthetic book, tiny silent
   MP3s, real encoder pass). Asserts the output is a well-formed MP4
   with one AAC stream at 44.1 kHz mono and one chapter atom per
   non-excluded source chapter, with cumulative timestamps. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { encodePcmToMp3 } from '../tts/mp3.js';
import { buildM4b, ExportIncompleteError } from './build-m4b.js';
import type { BookStateJson } from '../workspace/scan.js';

const toolsPresent = (() => {
  try {
    const a = spawnSync('ffmpeg',  ['-version'], { stdio: 'ignore' }).status === 0;
    const b = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
    return a && b;
  } catch { return false; }
})();
const describeIfTools = toolsPresent ? describe : describe.skip;

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
      { id: 2, title: 'Chapter 2',            slug: '02-chapter-2', duration: '0:00' },
      { id: 3, title: 'Front matter',         slug: '00-front-matter', excluded: true },
      { id: 4, title: 'Chapter 3',            slug: '04-chapter-3', duration: '0:00' },
    ],
    coverGradient: ['#abc', '#def'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    narratorCredit: 'Jane Narrator',
    genre: 'Audiobook',
    publicationDate: '2025',
  };
}

interface FfprobeReport {
  streams: Array<{
    codec_type: string;
    codec_name?: string;
    channels?: number;
    sample_rate?: string;
  }>;
  chapters: Array<{
    id: number;
    start: number;
    end: number;
    start_time: string;
    end_time: string;
    tags?: { title?: string };
  }>;
  format: { duration?: string; format_name?: string };
}

function ffprobeJson(path: string): FfprobeReport {
  const out = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_chapters', '-show_format', '-of', 'json', path],
    { encoding: 'utf8' },
  );
  if (out.status !== 0) throw new Error(`ffprobe failed: ${out.stderr}`);
  return JSON.parse(out.stdout) as FfprobeReport;
}

describeIfTools('buildM4b', () => {
  let tmpRoot: string;
  let bookDir: string;
  let outPath: string;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'build-m4b-'));
    bookDir = join(tmpRoot, 'book');
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    outPath = join(tmpRoot, 'out.m4b');

    /* 0.2 s of silence per chapter at 24 kHz mono → ~0.6 s total. Long
       enough that AAC priming + frame quantisation can't squish chapter
       boundaries to zero. */
    const slugs = ['01-chapter-1', '02-chapter-2', '04-chapter-3'];
    for (const slug of slugs) {
      const mp3 = await encodePcmToMp3(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
      writeFileSync(join(bookDir, 'audio', `${slug}.mp3`), mp3);
    }
  });

  afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  it('produces an MP4 audio file with AAC mono 44.1 kHz and one chapter per non-excluded source', async () => {
    const result = await buildM4b({ bookDir, state: makeState(), outPath });

    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.chapterCount).toBe(3);
    expect(result.totalDurationSec).toBeGreaterThan(0);

    /* Sniff the MP4 'ftyp' box at byte 4..8. */
    const head = readFileSync(outPath).subarray(0, 16);
    expect(head.subarray(4, 8).toString('ascii')).toBe('ftyp');

    const probe = ffprobeJson(outPath);
    const audio = probe.streams.find(s => s.codec_type === 'audio');
    expect(audio).toBeDefined();
    expect(audio?.codec_name).toBe('aac');
    expect(audio?.channels).toBe(1);
    expect(audio?.sample_rate).toBe('44100');

    expect(probe.chapters).toHaveLength(3);
    expect(probe.chapters[0].tags?.title).toBe('Chapter 1 — Opening');
    expect(probe.chapters[1].tags?.title).toBe('Chapter 2');
    expect(probe.chapters[2].tags?.title).toBe('Chapter 3');

    /* Monotonic, no gaps: each chapter's `end` equals the next's `start`. */
    for (let i = 1; i < probe.chapters.length; i++) {
      expect(probe.chapters[i].start).toBe(probe.chapters[i - 1].end);
    }
    expect(probe.chapters[0].start).toBe(0);

    const sumChapters = probe.chapters.reduce((acc, c) => acc + (c.end - c.start), 0);
    expect(sumChapters).toBeGreaterThan(0);
  }, 30_000);

  it('refuses with ExportIncompleteError when a non-excluded chapter has only a .wav', async () => {
    const legacyDir = join(tmpRoot, 'legacy', 'audio');
    mkdirSync(legacyDir, { recursive: true });
    const mp3 = await encodePcmToMp3(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
    writeFileSync(join(legacyDir, '01-chapter-1.mp3'), mp3);
    writeFileSync(join(legacyDir, '02-chapter-2.wav'), Buffer.from([0x52, 0x49, 0x46, 0x46]));

    await expect(
      buildM4b({
        bookDir: join(tmpRoot, 'legacy'),
        state: makeState(),
        outPath: join(tmpRoot, 'incomplete.m4b'),
      }),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  }, 15_000);

  it('reports monotonic progress reaching 1 on completion', async () => {
    const ratios: number[] = [];
    await buildM4b({
      bookDir,
      state: makeState(),
      outPath: join(tmpRoot, 'progress.m4b'),
      onProgress: r => ratios.push(r),
    });
    expect(ratios.length).toBeGreaterThan(0);
    expect(ratios[ratios.length - 1]).toBe(1);
    /* Monotonic non-decreasing — ffmpeg writes -progress ticks as
       encoding advances. */
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1] - 1e-9);
    }
    expect(statSync(join(tmpRoot, 'progress.m4b')).size).toBeGreaterThan(0);
  }, 30_000);
});

if (!toolsPresent) {
  // eslint-disable-next-line no-console
  console.warn('[build-m4b.test.ts] ffmpeg/ffprobe missing — skipping M4B integration tests.');
}
