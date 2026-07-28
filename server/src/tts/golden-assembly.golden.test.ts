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
import { ffmpegBannerLine, parseFfmpegVersion } from '../diagnostics/ffmpeg.js';
import { rmsEnvelope, md5, toInt16, selectMode, type AssemblyBaseline } from './golden-baseline.js';
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

const BASELINE_PATH = join(FIXTURE_DIR, 'golden-chapter.baseline.json');
const DECODED_PATH = join(FIXTURE_DIR, 'golden-chapter.decoded.pcm');
const BLESS = process.env.GOLDEN_BLESS === '1';
const BLESS_CMD = 'npm run test:golden-audio -- --assembly-only --bless';

let baseline: AssemblyBaseline | null = null;

/** Thin delegate — the branch logic lives in `golden-baseline.ts` so it can be
    unit-tested. On any one box only one arm ever runs, and the other arm would
    otherwise ship having never executed anywhere. */
function isTight(): boolean {
  return selectMode(art.banner, baseline?.ffmpegBanner ?? null) === 'TIGHT';
}

/** Suffix every failure message carries, so a cold reader knows which mode
    produced the verdict and how to re-record deliberately.
    (Exported-from-module-scope-only via `export` so `noUnusedLocals` does not
    flag it between this task, which defines it, and the next, which is the
    first to call it from a layer's failure message.) */
export function modeLine(): string {
  return (
    `\n  run: ffmpeg ${art.banner ?? '(absent)'}` +
    `\n  baseline: ffmpeg ${baseline?.ffmpegBanner ?? '(none)'}` +
    `\n  mode: ${isTight() ? 'TIGHT' : 'LOOSE'}` +
    `\n  If intended, re-bless: ${BLESS_CMD}`
  );
}

function loadBaseline(): AssemblyBaseline {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `golden assembly: baseline missing at ${BASELINE_PATH}.\n` +
        `  Both baseline artifacts are committed, so absence means one was deleted.\n` +
        `  To record a new baseline: ${BLESS_CMD}`,
    );
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as AssemblyBaseline;
}

function writeBaseline(): void {
  /* Refuse to record a baseline whose mode is missing. If the second-pass JSON
     failed to parse at bless time, `normalizationType` is undefined,
     JSON.stringify drops the key, and L2 would then compare undefined to
     undefined and pass forever — defeating the exact absence-diagnosis L2
     exists for. A poisoned baseline is worse than no baseline. */
  if (!art.sidecar || art.sidecar.normalizationType === undefined) {
    throw new Error(
      `golden assembly BLESS: refusing to record a baseline without ` +
        `sidecar.normalizationType. The second-pass loudnorm JSON was not ` +
        `parsed (sidecar ${art.sidecar ? `i=${art.sidecar.i}` : 'absent'}). ` +
        `Fix that first — recording now would bake in a hole.`,
    );
  }
  const { target, lra, tp } = resolveLoudnormOptions();
  const floor = 10 ** (-50 / 20);
  const recorded: AssemblyBaseline = {
    recordedAt: new Date().toISOString().slice(0, 10),
    ffmpegBanner: art.banner ?? '',
    ffmpegVersion: parseFfmpegVersion(art.banner ?? ''),
    encode: { format: 'mp3', quality: 2, sampleRate: meta.sampleRate, writeXing: true },
    loudnorm: { target, lra, tp },
    firstPass: {
      input_i: art.firstPass.input_i,
      input_lra: art.firstPass.input_lra,
      input_tp: art.firstPass.input_tp,
      input_thresh: art.firstPass.input_thresh,
    },
    sidecar: {
      i: art.sidecar.i,
      lra: art.sidecar.lra,
      normalizationType: art.sidecar.normalizationType,
    },
    decoded: {
      bytes: art.decoded.length * 2,
      quietWindowsSkipped: art.envelope.filter((v) => v < floor).length,
    },
    envelope100ms: art.envelope,
    mp3Md5: art.mp3Md5,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
  writeFileSync(DECODED_PATH, Buffer.from(art.decoded.buffer, 0, art.decoded.length * 2));
  console.log(
    `\n[golden-assembly BLESS] wrote:\n` +
      `  ${BASELINE_PATH}\n` +
      `  ${DECODED_PATH} (${art.decoded.length * 2} B)\n` +
      `  ffmpeg: ${art.banner}\n` +
      `  NO assertions ran. Review the diff before committing.\n`,
  );
}

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
  if (BLESS) {
    writeBaseline();
  } else {
    baseline = loadBaseline();
    /* Announce LOOSE on a PASSING run too. Every other mention of the mode
       lives inside a failure message, so without this an operator running the
       tier on a second ffmpeg build — the owed on-box acceptance — would get
       a green run and no way to tell whether the LOOSE path was even taken. */
    if (!isTight()) {
      console.warn(
        `\n[golden-assembly] LOOSE mode — the ffmpeg banner differs from the ` +
          `baseline's.\n` +
          `  run:      ${art.banner ?? '(absent)'}\n` +
          `  baseline: ${baseline.ffmpegBanner}\n` +
          `  L4 compares decoded RMS-error instead of the MP3 md5. A mismatch ` +
          `here means the comparison is CONFOUNDED, not that anything ` +
          `regressed.\n`,
      );
    }
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
    if (BLESS) return;
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
    if (BLESS) return;
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
