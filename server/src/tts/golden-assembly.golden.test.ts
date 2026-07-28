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
 * boundary, matching the rest of the audio suite.
 *
 * ops-36 restructured this file to run the pipeline ONCE in `beforeAll`,
 * producing a module-scoped `art` object that later `it` blocks (and later
 * ops-36 tasks) read from rather than each re-running its own encode. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import { evaluateSegmentPcm } from './segment-qa.js';
import { pcmDurationSec } from './pcm.js';
import { decodeAudioFileToPcm } from './mp3.js';
import {
  runLoudnormFirstPass,
  resolveLoudnormOptions,
  type LoudnormFirstPassStats,
  type LoudnormSidecarJson,
} from './loudnorm.js';
import { ffmpegBannerLine } from '../diagnostics/ffmpeg.js';
import { rmsEnvelope, md5, toInt16 } from './golden-baseline.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import type { SentenceOutput } from '../handoff/schemas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '__fixtures__');

const AUTHOR = 'Golden Author';
const SERIES = 'Standalones';
const TITLE = 'Golden Story';
const SLUG = 'golden-chapter';

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

interface Artifacts {
  synth: Awaited<ReturnType<typeof synthesiseChapter>>;
  /** The finalize call's own return value. Kept because it is this repo's only
      coverage of `segmentCount` / `durationSec` on that result. */
  finalized: { segmentCount: number; durationSec: number };
  firstPass: LoudnormFirstPassStats;
  sidecar: LoudnormSidecarJson | null;
  mp3: Buffer;
  mp3Md5: string;
  decoded: Int16Array;
  envelope: number[];
  banner: string | null;
  audioRoot: string;
}

let art: Artifacts;
let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-golden-assembly-'));
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

    const synth = await synthesiseChapter({
      sentences,
      cast,
      provider: makeRecordedProvider(),
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
      groupHeartbeatMs: 0,
    });

    /* L1's source: the raw fixture measured directly. This is a SEPARATE
       ffmpeg spawn from the one finalizeChapterAudioWrite runs internally —
       `encodePcmToAudio` does not expose its own first-pass stats. */
    const firstPass = await runLoudnormFirstPass(
      synth.pcm,
      synth.sampleRate,
      resolveLoudnormOptions(),
    );

    const finalized = await finalizeChapterAudioWrite({
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

    const mp3Path = join(audioRoot, `${SLUG}.mp3`);
    const mp3 = readFileSync(mp3Path);
    /* Decode from the FILE, not via decodeAudioToPcm: a pipe input skips the
       LAME gapless trim and appends ~495 samples of padding. */
    const decoded = toInt16(await decodeAudioFileToPcm(mp3Path, meta.sampleRate));

    const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
    const sidecar = existsSync(lufsPath)
      ? (JSON.parse(readFileSync(lufsPath, 'utf8')) as LoudnormSidecarJson)
      : null;

    art = {
      synth,
      finalized,
      firstPass,
      sidecar,
      mp3,
      mp3Md5: md5(mp3),
      decoded,
      envelope: rmsEnvelope(decoded, meta.sampleRate),
      banner: ffmpegBannerLine(),
      audioRoot,
    };
  } catch (e) {
    /* A hook failure kills every `it` at once, so it must not read as a layer
       verdict. Name it for what it is. */
    throw new Error(
      `golden assembly: the PIPELINE did not complete — this is NOT a layer ` +
        `verdict and says nothing about audio drift. Cause: ${(e as Error).message}`,
    );
  }
  /* Four ffmpeg spawns (raw first pass, finalize's internal first pass, encode,
     decode) on ~5.7s of audio. The config's hookTimeout is 30s; this explicit
     budget documents the headroom rather than relying on it. */
}, 60_000);

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('golden assembly (GPU-free)', () => {
  it('synthesiseChapter concatenates recorded PCM into deterministic segments', () => {
    expect(art.synth.segments).toHaveLength(meta.segments.length);
    expect(art.synth.sampleRate).toBe(meta.sampleRate);

    let cumBytes = 0;
    art.synth.segments.forEach((seg, i) => {
      const startSec = pcmDurationSec(cumBytes, meta.sampleRate);
      cumBytes += meta.segments[i].byteLength;
      const endSec = pcmDurationSec(cumBytes, meta.sampleRate);
      expect(seg.startSec).toBeCloseTo(startSec, 6);
      expect(seg.endSec).toBeCloseTo(endSec, 6);
      expect(seg.voiceSubstitutedFrom).toBeUndefined();
    });

    const totalBytes = meta.segments.reduce((a, s) => a + s.byteLength, 0);
    expect(art.synth.durationSec).toBeCloseTo(pcmDurationSec(totalBytes, meta.sampleRate), 6);
    expect(art.synth.pcm.length).toBe(totalBytes);

    art.synth.segments.forEach((seg, i) => {
      const segPcm = art.synth.pcm.subarray(
        Math.round(seg.startSec * meta.sampleRate) * 2,
        Math.round(seg.endSec * meta.sampleRate) * 2,
      );
      const verdict = evaluateSegmentPcm(segPcm, meta.sampleRate, meta.segments[i].text);
      expect(verdict.status, verdict.reasons.join('; ')).toBe('ok');
    });
  });

  it('finalizeChapterAudioWrite writes the audio and its sidecars', () => {
    /* Carried over from the pre-ops-36 test: this is the repo's only coverage
       of the finalize result's segmentCount / durationSec. */
    expect(art.finalized.segmentCount).toBe(meta.segments.length);
    expect(art.finalized.durationSec).toBeCloseTo(art.synth.durationSec, 1);

    expect(existsSync(join(art.audioRoot, `${SLUG}.mp3`))).toBe(true);
    expect(existsSync(join(art.audioRoot, `${SLUG}.segments.json`))).toBe(true);
    expect(existsSync(join(art.audioRoot, `${SLUG}.lufs.json`))).toBe(true);

    const segFile = JSON.parse(
      readFileSync(join(art.audioRoot, `${SLUG}.segments.json`), 'utf8'),
    ) as { segments: unknown[] };
    expect(segFile.segments).toHaveLength(meta.segments.length);

    /* Superseded by L2 in a later task — kept here only so this refactor
       changes no assertions. */
    expect(art.sidecar).not.toBeNull();
    expect(art.sidecar!.i).toBeGreaterThan(-30);
    expect(art.sidecar!.i).toBeLessThan(-10);
  });
});
