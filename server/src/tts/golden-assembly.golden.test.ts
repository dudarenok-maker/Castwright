/* Suite B of the golden-audio harness (ops-11) — GPU-FREE assembly golden.
 *
 * A committed recorded-Kokoro-PCM fixture (server/src/tts/__fixtures__/, captured
 * by server/tts-sidecar/tests/golden/capture_assembly_fixture.py) is fed through
 * the REAL assembly + encode path with a stub provider — NO model, NO GPU — so
 * the assembly / loudnorm / encode / segments contract is locked on realistic
 * speech, not a synthetic tone.
 *
 * This file is named `*.golden.test.ts` and is EXCLUDED from the default
 * `test:server` tier (server/vitest.config.ts) — it runs only via the opt-in
 * `npm run test:golden-audio` / `:assembly` (server/vitest.config.golden.ts).
 *
 * Real ffmpeg encode against a tempdir workspace — no mocks at the audio
 * boundary, matching the rest of the audio suite. */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  synthesiseChapter,
  type CastCharacter,
} from './synthesise-chapter.js';
import { evaluateSegmentPcm } from './segment-qa.js';
import { pcmDurationSec } from './pcm.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import type { SentenceOutput } from '../handoff/schemas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '__fixtures__');

interface FixtureSegment {
  characterId: string;
  text: string;
  voiceName: string;
  byteLength: number;
}
interface FixtureMeta {
  sampleRate: number;
  segments: FixtureSegment[];
}

const meta: FixtureMeta = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'golden-chapter.json'), 'utf8'),
);
const fixturePcm = readFileSync(join(FIXTURE_DIR, 'golden-chapter.pcm'));

/** Slice the concatenated fixture PCM into its per-segment buffers, keyed by the
    EXACT text each segment was synthesized from (the lines are caps/dash-free so
    `normaliseForTts` is identity — the stub keys on the post-normalisation text
    the provider receives). */
function sliceByText(): Map<string, Buffer> {
  const byText = new Map<string, Buffer>();
  let off = 0;
  for (const seg of meta.segments) {
    byText.set(seg.text, fixturePcm.subarray(off, off + seg.byteLength));
    off += seg.byteLength;
  }
  return byText;
}

/** Stub provider that returns the recorded PCM for the requested text. */
function makeRecordedProvider(): TtsProvider & { calls: SynthesizeInput[] } {
  const byText = sliceByText();
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      const pcm = byText.get(input.text);
      if (!pcm) throw new Error(`no recorded PCM for text: ${input.text}`);
      return { pcm: Buffer.from(pcm), sampleRate: meta.sampleRate, mimeType: 'audio/pcm' };
    },
  };
}

const cast: CastCharacter[] = meta.segments.map((s, i) => ({
  id: s.characterId,
  name: s.characterId,
  gender: (i === 1 ? 'female' : 'male') as 'female' | 'male',
  attributes: [],
}));

const sentences: SentenceOutput[] = meta.segments.map((s, i) => ({
  id: i + 1,
  chapterId: 1,
  characterId: s.characterId,
  text: s.text,
}));

describe('golden assembly (GPU-free)', () => {
  it('synthesiseChapter concatenates recorded PCM into deterministic segments', async () => {
    const provider = makeRecordedProvider();
    const result = await synthesiseChapter({
      sentences,
      cast,
      provider,
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
      groupHeartbeatMs: 0,
    });

    // One segment per group, in narrative order — no title beat (none passed).
    expect(result.segments).toHaveLength(meta.segments.length);
    expect(result.sampleRate).toBe(meta.sampleRate);

    // Per-segment boundaries are exact cumulative offsets of the byte lengths.
    let cumBytes = 0;
    result.segments.forEach((seg, i) => {
      const startSec = pcmDurationSec(cumBytes, meta.sampleRate);
      cumBytes += meta.segments[i].byteLength;
      const endSec = pcmDurationSec(cumBytes, meta.sampleRate);
      expect(seg.startSec).toBeCloseTo(startSec, 6);
      expect(seg.endSec).toBeCloseTo(endSec, 6);
      // No silent voice fallback on a clean recorded render.
      expect(seg.voiceSubstitutedFrom).toBeUndefined();
    });

    // Total duration == sum of segment durations.
    const totalBytes = meta.segments.reduce((a, s) => a + s.byteLength, 0);
    expect(result.durationSec).toBeCloseTo(pcmDurationSec(totalBytes, meta.sampleRate), 6);
    expect(result.pcm.length).toBe(totalBytes);

    // Each recorded segment passes the per-sentence QA gate (real speech: not
    // silent, plausible length) — the same gate generation runs pre-assembly.
    result.segments.forEach((seg, i) => {
      const segPcm = result.pcm.subarray(
        Math.round(seg.startSec * meta.sampleRate) * 2,
        Math.round(seg.endSec * meta.sampleRate) * 2,
      );
      const verdict = evaluateSegmentPcm(segPcm, meta.sampleRate, meta.segments[i].text);
      expect(verdict.status, verdict.reasons.join('; ')).toBe('ok');
    });
  });

  it('finalizeChapterAudioWrite encodes through real ffmpeg loudnorm with stable duration + LUFS', async () => {
    const AUTHOR = 'Golden Author';
    const SERIES = 'Standalones';
    const TITLE = 'Golden Story';
    const SLUG = 'golden-chapter';

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-golden-assembly-'));
    process.env.WORKSPACE_DIR = workspaceRoot;
    try {
      const [{ finalizeChapterAudioWrite }, { makeBookId }] = await Promise.all([
        import('../audio/finalize-chapter-write.js'),
        import('../workspace/paths.js'),
      ]);
      const bookId = makeBookId(AUTHOR, SERIES, TITLE);
      const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
      const audioRoot = join(bookDir, 'audio');
      mkdirSync(audioRoot, { recursive: true });
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId,
          manuscriptId: 'm_golden',
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

      // Re-derive segments from the (no-GPU) synthesis step so we exercise the
      // exact assembly output, then encode it.
      const synth = await synthesiseChapter({
        sentences,
        cast,
        provider: makeRecordedProvider(),
        modelKey: 'kokoro-v1',
        engine: 'kokoro',
        groupHeartbeatMs: 0,
      });

      const result = await finalizeChapterAudioWrite({
        bookId,
        bookDir,
        chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
        pcm: synth.pcm,
        sampleRate: synth.sampleRate,
        durationSec: synth.durationSec,
        segments: synth.segments,
        cast,
        defaultEngine: 'kokoro',
        modelKey: 'kokoro-v1',
        audioFormat: 'mp3',
      });

      // Contract: 3 segments, duration preserved, audio + sidecars written.
      expect(result.segmentCount).toBe(meta.segments.length);
      expect(result.durationSec).toBeCloseTo(synth.durationSec, 1);
      expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(true);
      expect(existsSync(join(audioRoot, `${SLUG}.segments.json`))).toBe(true);

      // LUFS sidecar written by the real 2-pass loudnorm, normalized toward the
      // EBU R128 target — a wide band guards against an encode/loudnorm break
      // without flaking on ffmpeg-version drift.
      const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
      expect(existsSync(lufsPath)).toBe(true);
      const lufs = JSON.parse(readFileSync(lufsPath, 'utf8')) as { i: number };
      expect(lufs.i).toBeGreaterThan(-30);
      expect(lufs.i).toBeLessThan(-10);

      // The persisted segments.json carries the same segment count.
      const segFile = JSON.parse(
        readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8'),
      ) as { segments: unknown[] };
      expect(segFile.segments).toHaveLength(meta.segments.length);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
