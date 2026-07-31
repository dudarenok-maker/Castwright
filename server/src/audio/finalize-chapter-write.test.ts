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
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureLoudnessFile } from './measure-loudness.js';
import { resolveLoudnormOptions } from '../tts/loudnorm.js';

const AUTHOR = 'Finalize Author';
const SERIES = 'Standalones';
const TITLE = 'Finalize Story';
const SLUG = 'chapter-one';
const SR = 24_000;

/* plan 274 T8 — the committed golden-fixture PCM (real synthesised speech,
   captured by the golden-audio harness), NOT a synthetic tone. §1.8's
   five-ceiling measurement was run against this exact fixture, and it is
   the only signal in this repo known to reproduce the requested/measured
   true-peak gap: a pure sine tone's low crest factor lands loudnorm's
   output nowhere near the ceiling regardless of amplitude (verified before
   writing this test), while this fixture's speech-like dynamics measure
   requested -1.5 / real -1.2, matching §1.8's row exactly. */
const HERE = dirname(fileURLToPath(import.meta.url));
const goldenChapterPcm = readFileSync(join(HERE, '..', 'tts', '__fixtures__', 'golden-chapter.pcm'));
const goldenChapterDurationSec = goldenChapterPcm.length / 2 / SR;

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

describe('finalizeChapterAudioWrite measurementSource provenance (plan 274 T4)', () => {
  afterEach(() => {
    vi.doUnmock('./measure-loudness.js');
    vi.resetModules();
  });

  it('stamps "ebur128" when the real re-measurement succeeds', async () => {
    await finalizeChapterAudioWrite(baseInput());

    const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
    const sidecar = JSON.parse(readFileSync(lufsPath, 'utf8'));
    expect(sidecar.measurementSource).toBe('ebur128');
  });

  it('stamps "loudnorm" when the real re-measurement fails (fallback to loudnorm self-reports)', async () => {
    vi.resetModules();
    vi.doMock('./measure-loudness.js', () => ({
      measureLoudnessFile: async () => null,
    }));

    const { finalizeChapterAudioWrite: finalizeMocked } = await import('./finalize-chapter-write.js');
    await finalizeMocked(baseInput());

    const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
    const sidecar = JSON.parse(readFileSync(lufsPath, 'utf8'));
    expect(sidecar.measurementSource).toBe('loudnorm');
    // Sanity: this is the real re-measurement failing, not a forced Shape B —
    // loudnorm's own second-pass parse still succeeded normally.
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

describe('finalizeChapterAudioWrite QA clip check — the centrepiece (plan 274 T8)', () => {
  afterEach(() => {
    delete process.env.QA_CLIP_TP_DB;
  });

  it('stays quiet at defaults, then fires once the threshold moves into the requested/measured gap', async () => {
    /* Clean arm: default ceiling (resolveLoudnormOptions().tp), default
       QA_CLIP_TP_DB (-0.1). Both arms run at DEFAULT loudnorm config — more
       faithful to production audio than moving the ceiling (plan §1.8: there
       is no ceiling where `requested < -0.1 <= measured`, so the fix has to
       move the THRESHOLD into the gap, not the ceiling). */
    const goldenInput = {
      ...baseInput(),
      pcm: goldenChapterPcm,
      durationSec: goldenChapterDurationSec,
    };
    const { audioQa: cleanQa } = await finalizeChapterAudioWrite(goldenInput);
    const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
    const sidecar = JSON.parse(readFileSync(lufsPath, 'utf8'));
    const measured: number = sidecar.tp;
    const { tp: requested } = resolveLoudnormOptions();

    expect(cleanQa.status).toBe('ok');
    expect(cleanQa.reasons.some((r) => /clip/i.test(r))).toBe(false);
    // Non-vacuousness: the clean arm reads the REAL measured peak, not the
    // requested ceiling loudnorm was asked for (plan 274 T2).
    expect(cleanQa.truePeakDb).toBeCloseTo(measured, 5);
    expect(cleanQa.truePeakDb).not.toBe(requested);

    /* Self-calibrating guard (plan §1.8 / risk register: "medium" — ffmpeg-
       version drift could silently close this window). If the measured
       peak has drifted down to within 0.1 dB of the requested ceiling on
       THIS ffmpeg build, there is no threshold left that can discriminate
       clipping from clean without also tripping the clean arm above — fail
       LOUDLY, don't silently skip and let a green run masquerade as proof. */
    if (measured <= requested + 0.1) {
      throw new Error(
        `plan 274 T8: the true-peak overshoot window has collapsed on this ` +
          `ffmpeg build (requested=${requested}, measured=${measured}). This ` +
          `test can no longer discriminate the clip check — investigate ` +
          `before trusting a green result here.`,
      );
    }

    /* Clipping arm: the SAME audio, the SAME ceiling — only QA_CLIP_TP_DB
       moves, into the gap between the requested ceiling and the real
       measured peak. This is the only variable that changes between arms. */
    process.env.QA_CLIP_TP_DB = String(measured - 0.05);
    const { audioQa: clipQa } = await finalizeChapterAudioWrite(goldenInput);
    expect(clipQa.status).toBe('suspect');
    expect(clipQa.reasons.some((r) => /clip/i.test(r))).toBe(true);
  });

  /* Covers T1's probe risk: `tmpAudio` has no real extension
     (`<slug>.<ext>.tmp-<pid>-<ts>`), so ffmpeg must probe by content for
     every format the encoder supports, not just the ones easy to sniff. */
  it.each(['mp3', 'aac-m4a', 'opus'] as const)(
    'measures a real true peak for %s at the extensionless temp path',
    async (format) => {
      const { audioQa } = await finalizeChapterAudioWrite({
        ...baseInput(),
        pcm: goldenChapterPcm,
        durationSec: goldenChapterDurationSec,
        audioFormat: format,
      });
      expect(audioQa.truePeakDb).not.toBeNull();
    },
  );
});

describe('finalizeChapterAudioWrite resolvedVoiceName carry-forward (C1, #1972 follow-up)', () => {
  it('carries resolvedVoiceName forward from the PRIOR segments file when this run synthesised nothing for a speaking character (e.g. a gain-only remix)', async () => {
    // A LEGACY (pre-#1972) prior render: characterSnapshots carries
    // resolvedVoiceName but the segment itself carries no voiceName field at
    // all — the shape every chapter rendered before this PR has on disk.
    writeFileSync(
      join(audioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId,
        chapterId: 1,
        chapterTitle: 'Chapter 1',
        durationSec: 1.0,
        sampleRate: SR,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [{ groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0 }],
        characterSnapshots: { amy: { voiceEngine: 'kokoro', resolvedVoiceName: 'kokoro-amy-legacy' } },
      }),
    );

    // This "run" mirrors a remix: amy still speaks (has a segment in the
    // input) but nothing was actually synthesised, so baseInput()'s segment
    // carries no voiceName/baseVoiceName.
    await finalizeChapterAudioWrite(baseInput());

    const segFile = JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8'));
    expect(segFile.characterSnapshots.amy.resolvedVoiceName).toBe('kokoro-amy-legacy');
  });

  it('does NOT carry forward a stale voice for a character this run DID synthesise for — the fresh voiceName wins', async () => {
    writeFileSync(
      join(audioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId,
        chapterId: 1,
        chapterTitle: 'Chapter 1',
        durationSec: 1.0,
        sampleRate: SR,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [
          { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0, voiceName: 'kokoro-amy-STALE' },
        ],
        characterSnapshots: { amy: { voiceEngine: 'kokoro', resolvedVoiceName: 'kokoro-amy-STALE' } },
      }),
    );

    await finalizeChapterAudioWrite({
      ...baseInput(),
      segments: [
        { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0, voiceName: 'kokoro-amy-FRESH' },
      ],
    });

    const segFile = JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8'));
    expect(segFile.characterSnapshots.amy.resolvedVoiceName).toBe('kokoro-amy-FRESH');
  });

  it('carries forward a voice for a character NOT targeted by a partial rerecord, while the targeted character gets its fresh voice', async () => {
    // Prior render: amy + wren both have a resolvedVoiceName on disk.
    writeFileSync(
      join(audioRoot, `${SLUG}.segments.json`),
      JSON.stringify({
        bookId,
        chapterId: 1,
        chapterTitle: 'Chapter 1',
        durationSec: 1.0,
        sampleRate: SR,
        modelKey: 'kokoro-v1',
        synthesizedAt: new Date().toISOString(),
        segments: [
          { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 0.5 },
          { groupIndex: 1, characterId: 'wren', sentenceIds: [2], startSec: 0.5, endSec: 1.0 },
        ],
        characterSnapshots: {
          amy: { voiceEngine: 'kokoro', resolvedVoiceName: 'kokoro-amy-legacy' },
          wren: { voiceEngine: 'kokoro', resolvedVoiceName: 'kokoro-wren-legacy' },
        },
      }),
    );

    // This run only re-recorded wren; amy's segment carries no voiceName.
    await finalizeChapterAudioWrite({
      ...baseInput(),
      segments: [
        { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 0.5 },
        { groupIndex: 1, characterId: 'wren', sentenceIds: [2], startSec: 0.5, endSec: 1.0, voiceName: 'kokoro-wren-FRESH' },
      ],
      cast: [
        { id: 'amy', name: 'Amy', gender: 'female' as const, attributes: [] },
        { id: 'wren', name: 'Wren', gender: 'female' as const, attributes: [] },
      ],
    });

    const segFile = JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8'));
    expect(segFile.characterSnapshots.amy.resolvedVoiceName).toBe('kokoro-amy-legacy');
    expect(segFile.characterSnapshots.wren.resolvedVoiceName).toBe('kokoro-wren-FRESH');
  });
});

describe('finalizeChapterAudioWrite resolvedVoiceName strips the emotion-variant suffix (M1, #1972 follow-up)', () => {
  it('stamps the BASE voice, not an emotion-suffixed variant, even when the LAST segment for a character is emotion-tagged', async () => {
    await finalizeChapterAudioWrite({
      ...baseInput(),
      segments: [
        { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 0.5, voiceName: 'qwen-amy', baseVoiceName: 'qwen-amy' },
        { groupIndex: 1, characterId: 'amy', sentenceIds: [2], startSec: 0.5, endSec: 1.0, voiceName: 'qwen-amy__angry', baseVoiceName: 'qwen-amy' },
      ],
    });

    const segFile = JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8'));
    expect(segFile.characterSnapshots.amy.resolvedVoiceName).toBe('qwen-amy');
  });

  it('falls back to the exact voiceName when baseVoiceName is absent (an un-migrated caller)', async () => {
    await finalizeChapterAudioWrite({
      ...baseInput(),
      segments: [{ groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0, voiceName: 'qwen-amy' }],
    });

    const segFile = JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8'));
    expect(segFile.characterSnapshots.amy.resolvedVoiceName).toBe('qwen-amy');
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
