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
  type LoudnormOptions,
  type LoudnormSidecarJson,
} from './loudnorm.js';
import { ffmpegBannerLine, parseFfmpegVersion } from '../diagnostics/ffmpeg.js';
import {
  rmsEnvelope,
  md5,
  toInt16,
  selectMode,
  compareEnvelope,
  rmsError,
  spectralTilt,
  TOL,
  type AssemblyBaseline,
} from './golden-baseline.js';
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
  /** The knobs actually resolved DURING this run — not re-derived after the
      fact. `runPipeline` forces `AUDIO_LOUDNORM_TARGET` for its own duration
      and restores it before returning, so a caller re-calling
      `resolveLoudnormOptions()` afterwards would see the WRONG run's target
      once a later `runPipeline` call has moved on. */
  loudnorm: LoudnormOptions;
  mp3: Buffer;
  mp3Md5: string;
  decoded: Int16Array;
  envelope: number[];
  spectralTilt: number;
  banner: string | null;
  audioRoot: string;
}

let art: Artifacts;
/** ops-36 Task 9c: the linear-loudnorm-arm run, at `LINEAR_TARGET`. */
let linearArt: Artifacts;
const workspaceRoots: string[] = [];

const BASELINE_PATH = join(FIXTURE_DIR, 'golden-chapter.baseline.json');
const DECODED_PATH = join(FIXTURE_DIR, 'golden-chapter.decoded.pcm');
/* The shipped `-16` target always takes the DYNAMIC loudnorm fallback on this
   fixture (crest factor never exceeds |target - tp|), so the LINEAR arm —
   the mode `buildSecondPassFilterString` actually requests — has zero
   coverage from the primary run. A second run at -20 LUFS reaches it
   (measured: normalization_type = linear). Attenuating the fixture cannot
   substitute for this: crest factor is gain-invariant. */
const LINEAR_TARGET = -20;
const LINEAR_BASELINE_PATH = join(FIXTURE_DIR, 'golden-chapter.linear.baseline.json');
const BLESS = process.env.GOLDEN_BLESS === '1';
const BLESS_CMD = 'npm run test:golden-audio -- --assembly-only --bless';

let baseline: AssemblyBaseline | null = null;
let linearBaseline: AssemblyBaseline | null = null;

/** Thin delegate — the branch logic lives in `golden-baseline.ts` so it can be
    unit-tested. On any one box only one arm ever runs, and the other arm would
    otherwise ship having never executed anywhere. */
function isTight(): boolean {
  return selectMode(art.banner, baseline?.ffmpegBanner ?? null) === 'TIGHT';
}

/** Suffix every failure message carries, so a cold reader knows which mode
    produced the verdict and how to re-record deliberately. */
function modeLine(): string {
  return (
    `\n  run: ffmpeg ${art.banner ?? '(absent)'}` +
    `\n  baseline: ffmpeg ${baseline?.ffmpegBanner ?? '(none)'}` +
    `\n  mode: ${isTight() ? 'TIGHT' : 'LOOSE'}` +
    `\n  If intended, re-bless: ${BLESS_CMD}`
  );
}

function loadBaseline(path: string): AssemblyBaseline {
  if (!existsSync(path)) {
    throw new Error(
      `golden assembly: baseline missing at ${path}.\n` +
        `  The baseline is committed, so absence means it was deleted.\n` +
        `  To record a new baseline: ${BLESS_CMD}`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as AssemblyBaseline;
}

/** `decodedPath === null` for the linear arm: there is no `.decoded.pcm`
    partner for it, so L4 on that arm is tight-only (see the L-linear `it`). */
function writeBaseline(a: Artifacts, baselinePath: string, decodedPath: string | null): void {
  /* Refuse to record a baseline whose mode is missing. If the second-pass JSON
     failed to parse at bless time, `normalizationType` is undefined,
     JSON.stringify drops the key, and L2 would then compare undefined to
     undefined and pass forever — defeating the exact absence-diagnosis L2
     exists for. A poisoned baseline is worse than no baseline. */
  if (!a.sidecar || a.sidecar.normalizationType === undefined) {
    throw new Error(
      `golden assembly BLESS: refusing to record a baseline without ` +
        `sidecar.normalizationType. The second-pass loudnorm JSON was not ` +
        `parsed (sidecar ${a.sidecar ? `i=${a.sidecar.i}` : 'absent'}). ` +
        `Fix that first — recording now would bake in a hole.`,
    );
  }
  const { target, lra, tp } = a.loudnorm;
  const floor = 10 ** (-50 / 20);
  const recorded: AssemblyBaseline = {
    recordedAt: new Date().toISOString().slice(0, 10),
    ffmpegBanner: a.banner ?? '',
    ffmpegVersion: parseFfmpegVersion(a.banner ?? ''),
    encode: { format: 'mp3', quality: 2, sampleRate: meta.sampleRate, writeXing: true },
    loudnorm: { target, lra, tp },
    firstPass: {
      input_i: a.firstPass.input_i,
      input_lra: a.firstPass.input_lra,
      input_tp: a.firstPass.input_tp,
      input_thresh: a.firstPass.input_thresh,
    },
    sidecar: {
      i: a.sidecar.i,
      lra: a.sidecar.lra,
      normalizationType: a.sidecar.normalizationType,
    },
    decoded: {
      bytes: a.decoded.length * 2,
      quietWindowsSkipped: a.envelope.filter((v) => v < floor).length,
    },
    spectralTilt: a.spectralTilt,
    envelope100ms: a.envelope,
    mp3Md5: a.mp3Md5,
  };
  writeFileSync(baselinePath, `${JSON.stringify(recorded, null, 2)}\n`);
  if (decodedPath) {
    writeFileSync(decodedPath, Buffer.from(a.decoded.buffer, 0, a.decoded.length * 2));
  }
  console.log(
    `\n[golden-assembly BLESS] wrote:\n` +
      `  ${baselinePath}\n` +
      (decodedPath ? `  ${decodedPath} (${a.decoded.length * 2} B)\n` : '') +
      `  ffmpeg: ${a.banner}\n` +
      `  NO assertions ran. Review the diff before committing.\n`,
  );
}

/** Runs the full synth -> loudnorm -> encode -> decode pipeline once, at
    `target` LUFS, and returns its artifacts. `target` is applied by forcing
    `AUDIO_LOUDNORM_TARGET` for the duration of this call only — the env is
    restored (not just cleared) before returning, so a second call cannot see
    a first call's override, and a caller's own pre-existing override (e.g. a
    box-level env var) is not clobbered permanently. */
async function runPipeline(target: number): Promise<Artifacts> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-golden-assembly-'));
  workspaceRoots.push(workspaceRoot);
  const prevTargetEnv = process.env.AUDIO_LOUDNORM_TARGET;
  process.env.AUDIO_LOUDNORM_TARGET = String(target);
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
    const loudnorm = resolveLoudnormOptions();
    const firstPass = await runLoudnormFirstPass(synth.pcm, synth.sampleRate, loudnorm);

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

    return {
      synth,
      finalized,
      firstPass,
      sidecar,
      loudnorm,
      mp3,
      mp3Md5: md5(mp3),
      decoded,
      envelope: rmsEnvelope(decoded, meta.sampleRate),
      spectralTilt: spectralTilt(decoded),
      banner: ffmpegBannerLine(),
      audioRoot,
    };
  } catch (e) {
    /* A hook failure kills every `it` at once, so it must not read as a layer
       verdict. Name it for what it is. */
    throw new Error(
      `golden assembly (target ${target}): the PIPELINE did not complete — ` +
        `this is NOT a layer verdict and says nothing about audio drift. ` +
        `Cause: ${(e as Error).message}`,
    );
  } finally {
    if (prevTargetEnv === undefined) delete process.env.AUDIO_LOUDNORM_TARGET;
    else process.env.AUDIO_LOUDNORM_TARGET = prevTargetEnv;
  }
}

beforeAll(async () => {
  /* Preserve whatever this box already resolves to (env override or the -16
     default) for the primary run — `runPipeline` re-asserts it via env so the
     LINEAR_TARGET run afterwards cannot leak into it. */
  const primaryTarget = resolveLoudnormOptions().target;
  art = await runPipeline(primaryTarget);
  linearArt = await runPipeline(LINEAR_TARGET);

  if (BLESS) {
    writeBaseline(art, BASELINE_PATH, DECODED_PATH);
    writeBaseline(linearArt, LINEAR_BASELINE_PATH, null);
  } else {
    baseline = loadBaseline(BASELINE_PATH);
    linearBaseline = loadBaseline(LINEAR_BASELINE_PATH);
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
  /* Eight ffmpeg spawns now (two runs x [raw first pass, finalize's internal
     first pass, encode, decode]) on ~5.7s of audio each. The config's
     hookTimeout is 30s; this explicit budget documents the headroom rather
     than relying on it. */
}, 60_000);

afterAll(() => {
  for (const root of workspaceRoots) rmSync(root, { recursive: true, force: true });
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
  });

  it('L1 — ffmpeg first-pass loudnorm measurement matches the baseline', () => {
    if (BLESS) return;
    const b = baseline!.firstPass;
    const a = art.firstPass;
    const fields: [string, number, number][] = [
      ['input_i', a.input_i, b.input_i],
      ['input_lra', a.input_lra, b.input_lra],
      ['input_tp', a.input_tp, b.input_tp],
      ['input_thresh', a.input_thresh, b.input_thresh],
    ];
    for (const [name, actual, expected] of fields) {
      const delta = actual - expected;
      expect(
        Math.abs(delta),
        `L1 first-pass drift: ${name} ${actual} (baseline ${expected}, ` +
          `delta ${delta.toFixed(2)} LU, tol ${TOL.firstPassLu})${modeLine()}`,
      ).toBeLessThanOrEqual(TOL.firstPassLu);
    }
  });

  it('L2 — the persisted loudness sidecar matches the baseline', () => {
    if (BLESS) return;
    expect(
      art.sidecar,
      `L2: no ${SLUG}.lufs.json was written at all. The encoder skips the ` +
        `sidecar when the FIRST pass is unusable (silent/near-silent input), ` +
        `so this points at the fixture or at loudnorm, not at a mode ` +
        `change.${modeLine()}`,
    ).not.toBeNull();

    const b = baseline!.sidecar;
    const s = art.sidecar!;

    /* Knob check first: a moved target produces the same symptom as ffmpeg
       drift, and the two are different bugs. */
    const knobs = resolveLoudnormOptions();
    expect(
      { target: knobs.target, lra: knobs.lra, tp: knobs.tp },
      `L2: the loudnorm knobs differ from the baseline's. This is a CONFIG ` +
        `change, not ffmpeg drift — re-bless deliberately.${modeLine()}`,
    ).toEqual(baseline!.loudnorm);

    for (const [name, actual, expected] of [
      ['i', s.i, b.i],
      ['lra', s.lra, b.lra],
    ] as [string, number, number][]) {
      const delta = actual - expected;
      expect(
        Math.abs(delta),
        `L2 sidecar drift: ${name} ${actual} (baseline ${expected}, ` +
          `delta ${delta.toFixed(2)} LU, tol ${TOL.sidecarLu})${modeLine()}`,
      ).toBeLessThanOrEqual(TOL.sidecarLu);
    }

    /* Asserted UNCONDITIONALLY — `twoPass === true` does NOT imply a mode is
       present (mp3.ts stamps twoPass before the encode and the fallback
       branches leave it untouched), so gating on twoPass would silently skip
       this. Absence is a DIFFERENT bug from a flip, and gets its own text. */
    expect(
      s.normalizationType,
      s.normalizationType === undefined
        ? `L2: normalizationType is absent (baseline "${b.normalizationType}").\n` +
          `  This is NOT a mode flip. The sidecar fell back to the input-side ` +
          `measurement, which means the second-pass loudnorm stderr JSON was ` +
          `not parsed — most likely an ffmpeg log-format change. Check \`i\`: ` +
          `it will read ~${baseline!.firstPass.input_i} (input side) rather ` +
          `than ~${b.i} (output side).${modeLine()}`
        : `L2: loudnorm mode changed — "${s.normalizationType}" vs baseline ` +
          `"${b.normalizationType}". A dynamic->linear flip alters how the ` +
          `chapter sounds while leaving integrated loudness near ` +
          `target.${modeLine()}`,
    ).toBe(b.normalizationType);
  });

  it('L3 — decoded length is exact and the RMS envelope matches', () => {
    if (BLESS) return;
    const bytes = art.decoded.length * 2;
    expect(
      bytes,
      `L3: decoded length ${bytes} B vs baseline ${baseline!.decoded.bytes} B. ` +
        `The encode/decode round-trip is length-preserving from a seekable ` +
        `input, so a change here is a duration/resampler change, not codec ` +
        `noise.${modeLine()}`,
    ).toBe(baseline!.decoded.bytes);

    const v = compareEnvelope(baseline!.envelope100ms, art.envelope);

    /* The skipped set must not silently grow: a regression that quietens a
       loud window would otherwise escape through the -50 dBFS floor. */
    expect(
      v.skipped,
      `L3: ${v.skipped} window(s) fell below ${TOL.quietFloorDbfs} dBFS on one ` +
        `side or the other; the baseline recorded ` +
        `${baseline!.decoded.quietWindowsSkipped}. A GROWN count means audio ` +
        `that used to be there went quiet, which is itself the ` +
        `regression.${modeLine()}`,
    ).toBe(baseline!.decoded.quietWindowsSkipped);

    /* The opposite direction. A window the baseline recorded as silent that
       this run made audible keeps `skipped` unchanged AND is skipped by the
       relative check, so nothing above would see it — and on the LOOSE path a
       -20 dBFS beep contributes only ~15 % rmse, under L4's 16 % gate. */
    expect(
      v.loudInQuietIndex,
      `L3: window ${v.loudInQuietIndex} (t=${(v.loudInQuietIndex * 0.1).toFixed(1)}s) ` +
        `is ${v.loudInQuietDbfs.toFixed(1)} dBFS but the baseline recorded it as ` +
        `silent. Something audible — a click, hum, or uninitialised buffer — ` +
        `landed in a pause. Ceiling is ${TOL.quietCeilingDbfs} dBFS.${modeLine()}`,
    ).toBe(-1);

    expect(
      v.ok,
      `L3 envelope drift: ${(v.worstRelDelta * 100).toFixed(1)} % at window ` +
        `${v.worstIndex} (t=${v.worstAtSec.toFixed(1)}s), tol ` +
        `${TOL.envelopeRel * 100} %. ${v.skipped} quiet window(s) ` +
        `skipped.${modeLine()}`,
    ).toBe(true);
  });

  it('L4 — the encoded MP3 matches the baseline', () => {
    if (BLESS) return;
    if (isTight()) {
      /* Same ffmpeg build: the encode is byte-identical across runs, so this
         is exact. Strongest assertion in the tier. */
      expect(
        art.mp3Md5,
        `L4 (TIGHT): MP3 md5 ${art.mp3Md5} vs baseline ${baseline!.mp3Md5}. ` +
          `The ffmpeg banner matches the baseline exactly, so the encode ` +
          `should be byte-identical — this is a real output change.${modeLine()}`,
      ).toBe(baseline!.mp3Md5);
      return;
    }

    /* Different build: LAME framing legitimately varies, so compare the
       decoded audio instead. This is the WEAKEST layer — its threshold is
       calibrated on encoder-quality steps as a proxy for a build change, and
       its noise floor (10.55 %) and target signal (24.79 %) are only 2.35x
       apart. L3's envelope is the sound LOOSE instrument. */
    const ref = toInt16(readFileSync(DECODED_PATH));
    /* L3 owns the length assertion, but L3 and L4 are deliberately independent
       `it`s — so if L3 failed, L4 would silently compare truncated arrays and
       report a reassuring number. Assert it here too. */
    expect(
      ref.length,
      `L4 (LOOSE): the reference PCM is ${ref.length} samples but this run ` +
        `decoded ${art.decoded.length}. RMS-error over a truncated overlap is ` +
        `meaningless — see L3 for the real verdict.${modeLine()}`,
    ).toBe(art.decoded.length);
    const err = rmsError(ref, art.decoded);
    expect(
      err,
      `L4 (LOOSE): decoded RMS-error ${(err * 100).toFixed(2)} % vs tol ` +
        `${TOL.rmseLoose * 100} %. Note this layer cannot see drift below ` +
        `~1.2 LU — L1 covers that range at +/-0.1 LU.${modeLine()}`,
    ).toBeLessThan(TOL.rmseLoose);
  });

  it('L5 — spectral tilt matches the baseline', () => {
    if (BLESS) return;
    const rel = (art.spectralTilt - baseline!.spectralTilt) / baseline!.spectralTilt;
    expect(
      Math.abs(rel),
      `L5 spectral-tilt drift: ${art.spectralTilt.toFixed(6)} vs baseline ` +
        `${baseline!.spectralTilt.toFixed(6)} (${(rel * 100).toFixed(2)} %, tol ` +
        `${TOL.spectralTiltRel * 100} %). Every other layer is an ENERGY instrument, ` +
        `so a resampler or lowpass change that dulls the top end shows up HERE ` +
        `and nowhere else. A gain change does not move this number.${modeLine()}`,
    ).toBeLessThanOrEqual(TOL.spectralTiltRel);
  });

  it('L-linear — the linear loudnorm arm produces the expected audio', () => {
    if (BLESS) return;
    const b = linearBaseline!;

    /* The whole point of this arm: the mode the code REQUESTS. If this reads
       "dynamic", the target no longer clears the true-peak ceiling and the
       fixture has stopped covering the linear path at all. */
    expect(
      linearArt.sidecar?.normalizationType,
      `L-linear: expected loudnorm to take the LINEAR arm at target ` +
        `${LINEAR_TARGET}, got "${linearArt.sidecar?.normalizationType}". Crest ` +
        `factor must exceed |target - tp| to trip dynamic; if that changed, this ` +
        `arm covers nothing.${modeLine()}`,
    ).toBe('linear');

    expect(Math.abs(linearArt.sidecar!.i - b.sidecar.i)).toBeLessThanOrEqual(TOL.sidecarLu);
    expect(linearArt.decoded.length * 2).toBe(b.decoded.bytes);

    const v = compareEnvelope(b.envelope100ms, linearArt.envelope);
    expect(v.ok, `L-linear envelope: ${(v.worstRelDelta * 100).toFixed(1)} % @ w${v.worstIndex}`).toBe(true);
    expect(v.loudInQuietIndex).toBe(-1);

    if (isTight()) expect(linearArt.mp3Md5).toBe(b.mp3Md5);
  });
});
