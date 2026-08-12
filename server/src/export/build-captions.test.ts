import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePcmToAudio } from '../tts/mp3.js';
import { buildCaptions, ExportIncompleteError } from './build-captions.js';
import { probeDurationSec } from './build-m4b.js';
import { transcribeSegment } from '../tts/transcribe-client.js';
import type { BookStateJson } from '../workspace/scan.js';

/* Task-7-fix — probeDurationSec is mocked so the multi-chapter cumulative-
   offset test below isn't at the mercy of mp3-encoder padding drift when
   asserting exact cue timestamps (build-captions.ts is this module's only
   importer of probeDurationSec — see build-m4b.ts). transcribeSegment is
   mocked the same way caption-cues.test.ts mocks it (the ASR sidecar
   transport boundary); decodeAudioToPcm/readFile still run for real against
   this file's real ffmpeg-encoded fixture audio. */
vi.mock('./build-m4b.js', () => ({ probeDurationSec: vi.fn(async () => 0) }));
vi.mock('../tts/transcribe-client.js', () => ({ transcribeSegment: vi.fn() }));

/* Behavioral regression for the ZipFile-level `zip.on('error', reject)`
   listener in build-captions.ts's per-chapter branch (~line 206). Real
   yazl never routes an addBuffer-path failure through ZipFile's own
   'error' event (only addFile/addReadStream's read-stream-error and
   byte-count-mismatch paths do — see node_modules/yazl/index.js), so there
   is no code-path-only way to provoke a genuine internal yazl error here.
   Instead we intercept the `ZipFile` export itself and give it a
   test-controlled way to emit 'error' on the INSTANCE, at a moment chosen
   to mirror how yazl's own internal error emissions actually happen: from
   an async callback (an fs.stat callback, a stream 'end' handler), never
   synchronously during construction.

   That timing choice is load-bearing, not cosmetic: `new Promise((resolve,
   reject) => { const zip = new ZipFile(); ... })`'s executor runs
   synchronously, and the Promise constructor auto-catches any *synchronous*
   throw inside its executor and turns it into a rejection — with or
   without `zip.on('error', reject)` ever being wired. Emitting synchronously
   from the constructor would "pass" even with the fix line deleted, for the
   wrong reason (JS's own executor-throw-to-rejection, not build-captions.ts's
   deliberate forwarding). Scheduling the emit via `process.nextTick` moves
   it outside that synchronous frame — same as yazl's real internal error
   sites — so an absent `zip.on('error', reject)` reproduces the real bug:
   the emit has zero listeners, Node throws it as a process-level
   `uncaughtException`, and `buildCaptions`'s promise never settles.
   `process.nextTick` (rather than `setImmediate`) also wins the race
   against yazl's own real completion path deterministically: it's
   scheduled at ZipFile construction time, before the per-chapter loop's
   `addBuffer` calls even run, and Node drains the entire nextTick queue —
   FIFO, so ours fires first — before any zlib thread-pool callback
   (`addBuffer`'s own deflate step) can complete. */
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

  it('forwards a ZipFile-level internal error to the rejection instead of crashing the process (per-chapter scope)', async () => {
    /* Behavioral regression for zip.on('error', reject) in the per-chapter
       branch — see the vi.mock('yazl', ...) comment at the top of this file
       for why the injected error is emitted via process.nextTick rather
       than synchronously, and why that's what makes this test exercise
       build-captions.ts's own forwarding rather than the Promise
       constructor's unrelated executor-throw-to-rejection behavior. */
    const injected = new Error('mock yazl internal validation failure (ZipFile-level)');
    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    triggerZipFileError = injected;
    const outPath = join(bookDir, 'zipfile-level-error-test.zip');
    try {
      const raced = await Promise.race([
        buildCaptions({
          bookDir,
          state,
          captionFileFormat: 'srt',
          captionGranularity: 'sentence',
          captionScope: 'per-chapter',
          outPath,
        }).then(
          (r) => ({ kind: 'resolved' as const, value: r }),
          (e) => ({ kind: 'rejected' as const, value: e }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' }), 1000),
        ),
      ]);
      // With the listener wired, the injected error rejects buildCaptions's
      // own promise with the SAME error object. Without it, the promise
      // never settles at all (nothing ever calls reject) — that's the
      // 'timeout' branch, a deliberate, fast, diagnosable failure instead of
      // waiting on vitest's own test timeout.
      expect(raced.kind).toBe('rejected');
      expect((raced as { kind: 'rejected'; value: unknown }).value).toBe(injected);
    } finally {
      process.off('uncaughtException', onUncaught);
      triggerZipFileError = null;
    }
    // The other half of the regression: the injected error must have been
    // forwarded to the rejection, NOT escaped as a raw uncaught exception.
    // If this is non-null, an error on the ZipFile object crashed the
    // process instead of being caught by the error listener.
    expect(escaped).toBeNull();
  }, 10_000);

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

  it('offsets chapter 2 cues by chapter 1s probed duration in a multi-chapter whole-book export', async () => {
    const multiDir = mkdtempSync(join(tmpdir(), 'build-captions-multi-'));
    mkdirSync(join(multiDir, 'audio'), { recursive: true });
    mkdirSync(join(multiDir, '.audiobook'), { recursive: true });
    try {
      writeFileSync(join(multiDir, '.audiobook', 'cast.json'), JSON.stringify({
        characters: [{ id: 'narrator', name: 'Narrator' }],
      }));
      writeFileSync(join(multiDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one line.' },
          { id: 2, chapterId: 2, characterId: 'narrator', text: 'Chapter two line.' },
        ],
      }));
      writeFileSync(join(multiDir, 'audio', '01-chapter-one.segments.json'), JSON.stringify({
        bookId: 'bk_multi',
        chapterId: 1,
        chapterTitle: 'Chapter One',
        durationSec: 2,
        sampleRate: 24000,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [{ groupIndex: 0, characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 2 }],
      }));
      writeFileSync(join(multiDir, 'audio', '02-chapter-two.segments.json'), JSON.stringify({
        bookId: 'bk_multi',
        chapterId: 2,
        chapterTitle: 'Chapter Two',
        durationSec: 1,
        sampleRate: 24000,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [{ groupIndex: 0, characterId: 'narrator', sentenceIds: [2], startSec: 0.5, endSec: 1 }],
      }));
      // probeDurationSec is mocked at the top of this file — these audio
      // files only need to exist for findChapterAudio's existsSync probe;
      // their content is never read.
      writeFileSync(join(multiDir, 'audio', '01-chapter-one.mp3'), Buffer.from('dummy'));
      writeFileSync(join(multiDir, 'audio', '02-chapter-two.mp3'), Buffer.from('dummy'));

      // Chapter 1 (processed first, chapters sorted by id) probes to 10s;
      // chapter 2 probes to 4s but that value is never consumed (no chapter
      // 3 to offset).
      vi.mocked(probeDurationSec).mockResolvedValueOnce(10).mockResolvedValueOnce(4);

      const multiState = {
        ...state,
        chapters: [
          { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
          { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        ],
      } as BookStateJson;

      const outPath = join(multiDir, 'multi.srt');
      await buildCaptions({
        bookDir: multiDir,
        state: multiState,
        captionFileFormat: 'srt',
        captionGranularity: 'sentence',
        captionScope: 'whole-book',
        outPath,
      });

      const { readFileSync } = await import('node:fs');
      const text = readFileSync(outPath, 'utf8');
      // Chapter 1 is first — cursorSec is still 0, so its cue keeps its own
      // raw timing.
      expect(text).toContain('00:00:00,000 --> 00:00:02,000');
      // Chapter 2's cue is raw startSec/endSec 0.5/1.0 in its segments.json,
      // but the cumulative-offset loop must push it out by chapter 1's
      // probed 10s duration: 10.5 --> 11.0, not its own raw timestamps.
      expect(text).toContain('00:00:10,500 --> 00:00:11,000');
      expect(text).not.toContain('00:00:00,500 --> 00:00:01,000');
    } finally {
      rmSync(multiDir, { recursive: true, force: true });
    }
  });

  it('sets no warning in word mode even when segments would be flagged hasUnverifiableTextHash', async () => {
    // The shared bookDir fixture's 01-chapter-one.segments.json segments
    // carry no textHash (pre-#1105 shape) — in sentence/line mode this
    // trips the warning (see the first test above). Word mode must never
    // set it, proving the `captionGranularity !== 'word'` guard actually
    // suppresses the check rather than the check merely never firing.
    vi.mocked(transcribeSegment).mockResolvedValueOnce({
      text: '',
      language: 'en',
      avgLogprob: -0.1,
      noSpeechProb: 0.01,
      compressionRatio: 1.0,
      words: [
        { word: 'It', start: 0, end: 0.4 },
        { word: 'was.', start: 0.4, end: 1.0 },
      ],
    });

    const result = await buildCaptions({
      bookDir,
      state,
      captionFileFormat: 'srt',
      captionGranularity: 'word',
      captionScope: 'whole-book',
      outPath: join(bookDir, 'word-warning-check.srt'),
    });

    expect(result.warning).toBeUndefined();
  });

  it('rejects rather than swallowing the error when the ASR call fails in word mode', async () => {
    vi.mocked(transcribeSegment).mockRejectedValueOnce(new Error('sidecar unreachable'));

    await expect(
      buildCaptions({
        bookDir,
        state,
        captionFileFormat: 'srt',
        captionGranularity: 'word',
        captionScope: 'whole-book',
        outPath: join(bookDir, 'word-asr-failure.srt'),
      }),
    ).rejects.toThrow('sidecar unreachable');
  });
});
