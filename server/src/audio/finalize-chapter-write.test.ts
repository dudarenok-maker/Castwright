/* srv-29 — unit coverage for the shared chapter-write tail. The generation
   route converged onto finalizeChapterAudioWrite and passes its no-progress
   watchdog `bumpProgress` as `onEncoded`; this pins the callback contract:
   it fires exactly once, AFTER the encode returns and BEFORE the audio file
   lands on disk (so the watchdog bump records the long encode step at the same
   point the inlined `bumpProgress()` used to).

   Real ffmpeg encode against a tempdir workspace — no mocks at the audio
   boundary, matching the rest of the audio suite. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTHOR = 'Finalize Author';
const SERIES = 'Standalones';
const TITLE = 'Finalize Story';
const SLUG = 'chapter-one';
const SR = 24_000;

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let bookId: string;
let finalizeChapterAudioWrite: typeof import('./finalize-chapter-write.js').finalizeChapterAudioWrite;

/** Constant-frequency int16 mono PCM so loudnorm has real signal to measure. */
function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

beforeEach(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-finalize-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ finalizeChapterAudioWrite: fn }, { makeBookId }] = await Promise.all([
    import('./finalize-chapter-write.js'),
    import('../workspace/paths.js'),
  ]);
  finalizeChapterAudioWrite = fn;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:00' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

const baseInput = () => {
  const pcm = tone(1.0, 12000);
  return {
    bookId,
    bookDir,
    chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
    pcm,
    sampleRate: SR,
    durationSec: 1.0,
    segments: [
      { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0 },
    ],
    cast: [{ id: 'amy', name: 'Amy', gender: 'female' as const, attributes: [] }],
    defaultEngine: 'kokoro' as const,
    modelKey: 'kokoro-v1' as const,
    audioFormat: 'mp3' as const,
  };
};

describe('finalizeChapterAudioWrite onEncoded', () => {
  it('fires the callback exactly once, after the encode and before the audio write', async () => {
    let calls = 0;
    let audioFileExistedWhenCalled: boolean | null = null;
    const audioPath = join(audioRoot, `${SLUG}.mp3`);

    await finalizeChapterAudioWrite({
      ...baseInput(),
      onEncoded: () => {
        calls += 1;
        // The atomic write (temp → rename) happens AFTER onEncoded, so the
        // live <slug>.mp3 must not exist yet at this point.
        audioFileExistedWhenCalled = existsSync(audioPath);
      },
    });

    expect(calls).toBe(1);
    expect(audioFileExistedWhenCalled).toBe(false);
    // The render still landed once finalize returned.
    expect(existsSync(audioPath)).toBe(true);
  });

  it('completes normally when no onEncoded callback is supplied', async () => {
    const result = await finalizeChapterAudioWrite(baseInput());
    expect(result.segmentCount).toBe(1);
    expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(true);
  });
});

describe('finalizeChapterAudioWrite engine stamp (false-drift fix)', () => {
  const readChapter = async () => {
    const { readJson } = await import('../workspace/state-io.js');
    const state = await readJson<{ chapters: Array<Record<string, unknown>> }>(
      join(bookDir, '.audiobook', 'state.json'),
    );
    return state!.chapters.find((c) => c.id === 1)!;
  };

  it('stamps the ACTUAL rendered engine, not the request default, for a uniform chapter', async () => {
    // Narrator-only chapter whose narrator renders on Qwen (per-character
    // engine), regenerated while the project default + request is Kokoro.
    const pcm = tone(1.0, 12000);
    const { audioModelKey } = await finalizeChapterAudioWrite({
      ...baseInput(),
      pcm,
      segments: [
        { groupIndex: 0, characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1.0 },
      ],
      cast: [{ id: 'narrator', name: 'Narrator', gender: 'neutral', attributes: [], ttsEngine: 'qwen' }],
      defaultEngine: 'kokoro',
      modelKey: 'kokoro-v1',
    });

    expect(audioModelKey).toBe('qwen3-tts-0.6b');
    const ch = await readChapter();
    expect(ch.audioModelKey).toBe('qwen3-tts-0.6b');
    expect(ch.audioEngines).toEqual({ qwen: 1 });
  });

  it('records the per-engine breakdown and keeps the request key for a mixed chapter', async () => {
    const pcm = tone(1.0, 12000);
    const { audioModelKey } = await finalizeChapterAudioWrite({
      ...baseInput(),
      pcm,
      segments: [
        { groupIndex: 0, characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 0.5 },
        { groupIndex: 1, characterId: 'wren', sentenceIds: [2], startSec: 0.5, endSec: 1.0 },
      ],
      cast: [
        { id: 'narrator', name: 'Narrator', gender: 'neutral', attributes: [] },
        { id: 'wren', name: 'Wren', gender: 'female', attributes: [], ttsEngine: 'qwen' },
      ],
      defaultEngine: 'kokoro',
      modelKey: 'kokoro-v1',
    });

    expect(audioModelKey).toBe('kokoro-v1');
    const ch = await readChapter();
    expect(ch.audioModelKey).toBe('kokoro-v1');
    expect(ch.audioEngines).toEqual({ kokoro: 1, qwen: 1 });
  });
});
