/* Integration tests for buildM4b — drives real ffmpeg + ffprobe.
   Mirrors build-mp3-zip.test.ts in shape (synthetic book, tiny silent
   MP3s, real encoder pass). Asserts the output is a well-formed MP4
   with one AAC stream at 44.1 kHz mono and one chapter atom per
   non-excluded source chapter, with cumulative timestamps. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
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
    disposition?: Record<string, number>;
  }>;
  chapters: Array<{
    id: number;
    start: number;
    end: number;
    start_time: string;
    end_time: string;
    tags?: { title?: string };
  }>;
  format: { duration?: string; format_name?: string; tags?: Record<string, string> };
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

/* Read the iTunes media-kind atom (`stik`) from an MP4 file.

   Primary path: `ffprobe -show_entries format_tags=media_type` — newer
   Gyan.FFmpeg builds surface this as the `media_type` format tag. Older
   builds drop it on the floor, so we walk the atom tree ourselves as a
   fallback. Both paths guard the same invariant: the audiobook
   media-kind atom survives the mp4 muxer.

   Voice-Android itself doesn't read `stik` (it treats every file in its
   library as an audiobook regardless), but Apple Books / Plex / BookPlayer
   do. If a future ffmpeg release silently stops writing this atom, the
   regression would only surface on those cross-app library moves — exactly
   the kind of slow-burn break this guard catches. */
function probeStik(m4bPath: string): number | null {
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format_tags=media_type', '-of', 'json', m4bPath],
    { encoding: 'utf8' },
  );
  if (probe.status === 0) {
    try {
      const parsed = JSON.parse(probe.stdout) as { format?: { tags?: { media_type?: string } } };
      const raw = parsed.format?.tags?.media_type;
      if (raw !== undefined) {
        const n = Number(raw);
        if (Number.isFinite(n)) return n;
      }
    } catch {/* fall through to raw atom scan */}
  }
  return readStikFromBuffer(readFileSync(m4bPath));
}

/* Recursive descent through MP4 atom tree to find a value at
   `moov/udta/meta/ilst/stik/data`.

   MP4 atoms are `[size:uint32 BE][type:4 ascii] <payload>`. size === 1
   means a 64-bit largesize follows; size === 0 means the atom runs to EOF.
   The `meta` atom is the odd one out — it has a 4-byte version/flags
   header before its children, so we skip those 4 bytes when descending
   into it. The `data` atom under iTunes ilst entries has an 8-byte
   prefix (4-byte type code, 4-byte locale) before the value bytes; for
   `stik` the value is a 1-byte unsigned int. */
function readStikFromBuffer(buf: Buffer): number | null {
  const stikContainer = findAtom(buf, 0, buf.length, ['moov', 'udta', 'meta', 'ilst', 'stik']);
  if (!stikContainer) return null;
  const data = findAtom(buf, stikContainer.start, stikContainer.end, ['data']);
  if (!data) return null;
  const valueStart = data.start + 8;
  if (valueStart >= data.end) return null;
  return buf.readUInt8(valueStart);
}

function findAtom(
  buf: Buffer,
  start: number,
  end: number,
  path: string[],
): { start: number; end: number } | null {
  if (path.length === 0) return { start, end };
  const [head, ...rest] = path;
  let off = start;
  while (off + 8 <= end) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    let atomLen: number;
    let headerLen = 8;
    if (size === 1) {
      if (off + 16 > end) return null;
      const hi = buf.readUInt32BE(off + 8);
      const lo = buf.readUInt32BE(off + 12);
      atomLen = hi * 0x100000000 + lo;
      headerLen = 16;
    } else if (size === 0) {
      atomLen = end - off;
    } else {
      atomLen = size;
    }
    if (atomLen < headerLen || off + atomLen > end) return null;
    if (type === head) {
      const childStart = off + headerLen + (head === 'meta' ? 4 : 0);
      return findAtom(buf, childStart, off + atomLen, rest);
    }
    off += atomLen;
  }
  return null;
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

  it('refuses with ExportIncompleteError when a non-excluded chapter has no audio file', async () => {
    const incompleteDir = join(tmpRoot, 'incomplete', 'audio');
    mkdirSync(incompleteDir, { recursive: true });
    const mp3 = await encodePcmToMp3(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
    writeFileSync(join(incompleteDir, '01-chapter-1.mp3'), mp3);
    /* No audio at all for chapter 2 — precheck must reject. */

    await expect(
      buildM4b({
        bookDir: join(tmpRoot, 'incomplete'),
        state: makeState(),
        outPath: join(tmpRoot, 'incomplete.m4b'),
      }),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  }, 15_000);

  it('embeds the OpenLibrary cover (.audiobook/cover.jpg) as an attached_pic when present', async () => {
    /* Plan 36 A2: when the cover-art pipeline has cached a cover for
       this book, buildM4b passes it as a third ffmpeg input and writes
       the iTunes `covr` atom with attached_pic disposition. ffprobe
       should report a video stream with codec_name=mjpeg (or png) and
       disposition.attached_pic=1; the audio stream stays unchanged. */
    const coverDir = join(bookDir, '.audiobook');
    if (!existsSync(coverDir)) mkdirSync(coverDir, { recursive: true });
    /* Tiny 1x1 baseline JPEG. The bytes only need to round-trip
       through ffmpeg's image demuxer; pixel content is irrelevant. */
    const jpegBytes = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
      'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9sAQwEBAQEBAQEBAQEBAQEB' +
      'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
      '/8AAEQgAAQABAwERAAIRAQMRAf/EABQAAQAAAAAAAAAAAAAAAAAAAAj/xAAUAQEAAAAAAAAA' +
      'AAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aov8A/9k=',
      'base64',
    );
    const coverPath = join(coverDir, 'cover.jpg');
    writeFileSync(coverPath, jpegBytes);

    const outPathCover = join(tmpRoot, 'with-cover.m4b');
    await buildM4b({ bookDir, state: makeState(), outPath: outPathCover });

    const probe = ffprobeJson(outPathCover);
    const video = probe.streams.find(s => s.codec_type === 'video');
    expect(video).toBeDefined();
    expect(video?.codec_name).toMatch(/mjpeg|png/);
    expect(video?.disposition?.attached_pic).toBe(1);
    /* Audio stream still intact. */
    const audio = probe.streams.find(s => s.codec_type === 'audio');
    expect(audio?.codec_name).toBe('aac');

    /* Clean up so the absence-test below sees no cover file. */
    rmSync(coverPath, { force: true });
  }, 30_000);

  it('still produces a valid M4B with no video stream when no cover is cached on disk', async () => {
    /* Negative path — the export pipeline must remain resilient to the
       common case (user hasn't picked a cover yet). No video stream
       should land in the output. */
    const coverPath = join(bookDir, '.audiobook', 'cover.jpg');
    if (existsSync(coverPath)) rmSync(coverPath, { force: true });

    const outPathNoCover = join(tmpRoot, 'no-cover.m4b');
    await buildM4b({ bookDir, state: makeState(), outPath: outPathNoCover });

    const probe = ffprobeJson(outPathNoCover);
    expect(probe.streams.find(s => s.codec_type === 'video')).toBeUndefined();
    expect(probe.streams.find(s => s.codec_type === 'audio')?.codec_name).toBe('aac');
  }, 30_000);

  it('writes the iTunes audiobook media-kind atom (stik = 2) so cross-app players treat it as an audiobook', async () => {
    /* Regression guard for plan 33 (Voice export). FFMETADATA's
       `media_type=2` round-trips through the mp4 muxer as the `stik`
       atom under `moov/udta/meta/ilst`. A future ffmpeg upgrade that
       silently drops this mapping would still play fine on Voice-Android
       (it groups every file under "audiobooks" regardless), but Apple
       Books / Plex / BookPlayer would downgrade the file to "music" —
       and we'd ship that regression without noticing. */
    const stikPath = join(tmpRoot, 'stik.m4b');
    await buildM4b({ bookDir, state: makeState(), outPath: stikPath });
    const stik = probeStik(stikPath);
    expect(stik).toBe(2);
  }, 30_000);

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
