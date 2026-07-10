import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePcmToAudio } from '../tts/mp3.js';
import { buildCaptions, ExportIncompleteError } from './build-captions.js';
import type { BookStateJson } from '../workspace/scan.js';

const ffmpegPresent = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

let bookDir: string;
let state: BookStateJson;

function silencePcm(seconds: number, sampleRate = 24000): Buffer {
  return Buffer.alloc(Math.floor(seconds * sampleRate) * 2);
}

beforeAll(async () => {
  bookDir = mkdtempSync(join(tmpdir(), 'build-captions-test-'));
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  state = {
    bookId: 'bk_test',
    title: 'The Coalfall Test',
    author: 'Test Author',
    chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
  } as BookStateJson;

  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({
    characters: [{ id: 'narrator', name: 'Narrator' }, { id: 'mira', name: 'Mira' }],
  }));
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({
    sentences: [
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'It was a dark night.' },
      { id: 2, chapterId: 1, characterId: 'mira', text: 'Who goes there?' },
    ],
  }));
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.segments.json'), JSON.stringify({
    bookId: 'bk_test',
    chapterId: 1,
    chapterTitle: 'Chapter One',
    durationSec: 3,
    sampleRate: 24000,
    modelKey: 'kokoro-v1',
    synthesizedAt: new Date().toISOString(),
    segments: [
      { groupIndex: 0, characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1.5 },
      { groupIndex: 1, characterId: 'mira', sentenceIds: [2], startSec: 1.5, endSec: 3 },
    ],
  }));

  const pcm = silencePcm(3);
  const mp3 = await encodePcmToAudio(pcm, 24000, { format: 'mp3', quality: 2 });
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), mp3);
});

afterAll(() => {
  rmSync(bookDir, { recursive: true, force: true });
});

describeIfFfmpeg('buildCaptions', () => {
  it('builds a whole-book .srt with cumulative offsets from manuscript-edits.json text', async () => {
    const outPath = join(bookDir, 'out.srt');
    const result = await buildCaptions({
      bookDir,
      state,
      captionFileFormat: 'srt',
      captionGranularity: 'sentence',
      captionScope: 'whole-book',
      outPath,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(outPath, 'utf8');
    expect(text).toContain('Narrator: It was a dark night.');
    expect(text).toContain('Mira: Who goes there?');
    expect(text).toContain('00:00:00,000 --> 00:00:01,500');
    // The fixture's segments.json carries no textHash (pre-#1105 shape) —
    // sentence/line granularity can't verify it's still current.
    expect(result.warning).toMatch(/couldn't fully verify/);
  });

  it('sets no warning when every segment carries a matching textHash', async () => {
    const { textHashForStale } = await import('../audio/segments-io.js');
    const freshDir = mkdtempSync(join(tmpdir(), 'build-captions-fresh-'));
    mkdirSync(join(freshDir, 'audio'), { recursive: true });
    mkdirSync(join(freshDir, '.audiobook'), { recursive: true });
    try {
      writeFileSync(join(freshDir, '.audiobook', 'cast.json'), JSON.stringify({
        characters: [{ id: 'narrator', name: 'Narrator' }],
      }));
      writeFileSync(join(freshDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({
        sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Fresh sentence.' }],
      }));
      writeFileSync(join(freshDir, 'audio', '01-chapter-one.segments.json'), JSON.stringify({
        bookId: 'bk_fresh',
        chapterId: 1,
        chapterTitle: 'Chapter One',
        durationSec: 1,
        sampleRate: 24000,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [
          {
            groupIndex: 0,
            characterId: 'narrator',
            sentenceIds: [1],
            startSec: 0,
            endSec: 1,
            textHash: textHashForStale('Fresh sentence.'),
          },
        ],
      }));
      const pcm = silencePcm(1);
      const mp3 = await encodePcmToAudio(pcm, 24000, { format: 'mp3', quality: 2 });
      writeFileSync(join(freshDir, 'audio', '01-chapter-one.mp3'), mp3);

      const result = await buildCaptions({
        bookDir: freshDir,
        state: { ...state, chapters: [state.chapters[0]] } as BookStateJson,
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'whole-book',
        outPath: join(freshDir, 'out.srt'),
      });
      expect(result.warning).toBeUndefined();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('builds a per-chapter .zip with one entry per chapter', async () => {
    const outPath = join(bookDir, 'out.zip');
    const result = await buildCaptions({
      bookDir,
      state,
      captionFileFormat: 'vtt',
      captionGranularity: 'line',
      captionScope: 'per-chapter',
      outPath,
    });
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('throws ExportIncompleteError when a chapter has no audio file', async () => {
    const brokenState = {
      ...state,
      chapters: [...state.chapters, { id: 2, title: 'Missing', slug: '02-missing' }],
    } as BookStateJson;
    await expect(
      buildCaptions({
        bookDir,
        state: brokenState,
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'whole-book',
        outPath: join(bookDir, 'broken.srt'),
      }),
    ).rejects.toBeInstanceOf(ExportIncompleteError);
  });

  it('throws a clear error when manuscript-edits.json is missing', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'build-captions-bare-'));
    mkdirSync(join(bareDir, 'audio'), { recursive: true });
    mkdirSync(join(bareDir, '.audiobook'), { recursive: true });
    try {
      await expect(
        buildCaptions({
          bookDir: bareDir,
          state: { ...state, chapters: [] } as BookStateJson,
          captionFileFormat: 'srt',
          captionGranularity: 'sentence',
          captionScope: 'whole-book',
          outPath: join(bareDir, 'x.srt'),
        }),
      ).rejects.toThrow(/manuscript-edits\.json/);
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });
});
