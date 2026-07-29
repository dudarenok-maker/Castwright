/* srv-29 — unit coverage for the shared chapter-write tail. The generation
   route converged onto finalizeChapterAudioWrite and passes its no-progress
   watchdog `bumpProgress` as `onEncoded`; this pins the callback contract:
   it fires exactly once, AFTER the encode returns and BEFORE the audio file
   lands on disk (so the watchdog bump records the long encode step at the same
   point the inlined `bumpProgress()` used to).

   Real ffmpeg encode against a tempdir workspace — no mocks at the audio
   boundary, matching the rest of the audio suite. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureLoudnessFile } from './measure-loudness.js';
import { resolveLoudnormOptions } from '../tts/loudnorm.js';

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

describe('finalizeChapterAudioWrite loudness sidecar (ops-36 finding 10)', () => {
  it('persists a REAL ebur128 measurement, not loudnorm self-reports', async () => {
    await finalizeChapterAudioWrite(baseInput());

    const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
    const audioPath = join(audioRoot, `${SLUG}.mp3`);
    const sidecar = JSON.parse(readFileSync(lufsPath, 'utf8'));
    const real = await measureLoudnessFile(audioPath);

    expect(real).not.toBeNull();
    expect(sidecar.i).toBeCloseTo(real!.i, 1);
    expect(sidecar.lra).toBeCloseTo(real!.lra, 1);
    expect(sidecar.tp).toBeCloseTo(real!.tp, 1);
    /* The regression this locks: loudnorm reports tp as the REQUESTED ceiling,
       which is not a measurement and can sit below the sample peak. Derived
       from resolveLoudnormOptions() rather than hardcoded, so a moved
       AUDIO_LOUDNORM_TP doesn't quietly turn this inert. This assertion is
       INDEPENDENT of `measureLoudnessFile` (unlike the toBeCloseTo checks
       above, which compare the sidecar to the same function under test): a
       self-report would read EXACTLY the requested ceiling, so a
       consistently-wrong parser that just echoed the ceiling back would fail
       here even though it would pass the toBeCloseTo checks. */
    const { tp: requestedCeiling } = resolveLoudnormOptions();
    expect(sidecar.tp).not.toBe(requestedCeiling);
    // loudnorm's own state still comes from loudnorm.
    expect(sidecar.normalizationType).toBeDefined();
  });
});

describe('finalizeChapterAudioWrite QA vs sidecar (plan 274 T3 — the two surfaces can never disagree)', () => {
  it('QA truePeakDb matches the sidecar tp exactly, and neither is the requested ceiling', async () => {
    const { audioQa } = await finalizeChapterAudioWrite(baseInput());

    const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
    const sidecar = JSON.parse(readFileSync(lufsPath, 'utf8'));

    // One number, two surfaces.
    expect(audioQa.truePeakDb).toBe(sidecar.tp);
    // ...and it is a real measurement, not the ceiling loudnorm was asked for.
    expect(audioQa.truePeakDb).not.toBe(resolveLoudnormOptions().tp);
  });
});

describe('finalizeChapterAudioWrite QA — three-shape fail-soft (plan 274 T2)', () => {
  afterEach(() => {
    vi.doUnmock('./measure-loudness.js');
    vi.doUnmock('../tts/loudnorm.js');
    vi.resetModules();
  });

  it('does not judge QA on Shape B\'s pre-filter loudness (spurious near-silent guard)', async () => {
    // Force the real ebur128 re-measurement to fail (`realLoudness === null`)
    // AND force loudnormStats into Shape B: the second-pass JSON parse
    // throws, so `mp3.ts` falls back to the provisional pre-filter stats
    // (input_i/input_lra/input_tp) while still stamping `twoPass: true` and
    // leaving `normalizationType` undefined — the discriminator for Shape B
    // (plan §1.9).
    vi.resetModules();
    vi.doMock('./measure-loudness.js', () => ({
      measureLoudnessFile: async () => null,
    }));
    vi.doMock('../tts/loudnorm.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../tts/loudnorm.js')>();
      return {
        ...actual,
        parseLoudnormSecondPassJson: () => {
          throw new Error('forced Shape B: second-pass JSON unparseable');
        },
      };
    });

    const { finalizeChapterAudioWrite: finalizeMocked } = await import('./finalize-chapter-write.js');

    // Quiet-but-not-silent continuous tone: PRE-filter input loudness sits
    // well below the -40 LUFS near-silent floor, but loudnorm still
    // normalises the actual encoded output to ~-16 LUFS. Shape B's fallback
    // keeps the PRE-filter figure (input_i) in loudnormStats — if QA judged
    // on that unconditionally, it would spuriously trip `nearSilentLufs`
    // even though the real rendered output is fine (plan §1.9/§1.10).
    const pcm = tone(1.0, 100);
    const { audioQa } = await finalizeMocked({ ...baseInput(), pcm });

    expect(audioQa.measuredLufs).toBeNull();
    expect(audioQa.reasons.some((r) => /near-silent/i.test(r))).toBe(false);

    const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
    const sidecar = JSON.parse(readFileSync(lufsPath, 'utf8'));
    // Confirms the fixture actually landed in Shape B — otherwise this test
    // would be vacuous.
    expect(sidecar.twoPass).toBe(true);
    expect(sidecar.normalizationType).toBeUndefined();
  });
});
