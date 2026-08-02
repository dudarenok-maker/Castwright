/* Unit coverage for the re-record replacement builder. The synth call is
   injected (no live sidecar), so we assert the load-bearing wiring: one
   single-segment replacement per target index, sorted, and PCM resampled onto
   the chapter grid when the synth returns a different rate. */

import { describe, it, expect } from 'vitest';
import { buildSynthReplacements, isRerecordableSegment, findDivergentSentences } from './build-synth-replacement.js';
import type { SynthOutput } from './build-synth-replacement.js';
import type { ChapterSegment } from '../tts/synthesise-chapter.js';

function seg(i: number, characterId: string, sentenceIds: number[]): ChapterSegment {
  return { groupIndex: i, characterId, sentenceIds, startSec: i, endSec: i + 1 };
}

describe('isRerecordableSegment', () => {
  it('rejects the title beat (kind:title / empty sentenceIds) so a narrator re-record cannot wipe it', () => {
    const title: ChapterSegment = { groupIndex: -1, characterId: 'narrator', sentenceIds: [], startSec: 0, endSec: 2, kind: 'title' };
    expect(isRerecordableSegment(title)).toBe(false);
  });
  it('rejects a sentence-less body segment', () => {
    expect(isRerecordableSegment(seg(0, 'amy', []))).toBe(false);
  });
  it('accepts a normal sentence-backed segment', () => {
    expect(isRerecordableSegment(seg(0, 'amy', [1, 2]))).toBe(true);
  });
});

const segments = [
  seg(0, 'amy', [1]),
  seg(1, 'castor', [2]),
  seg(2, 'amy', [3]),
  seg(3, 'castor', [4, 5]),
];

function pcmOfSamples(n: number): Buffer {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) b.writeInt16LE((i % 100) - 50, i * 2);
  return b;
}

describe('buildSynthReplacements', () => {
  it('emits one single-segment replacement per target index, in order', async () => {
    const calls: ChapterSegment[] = [];
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [3, 1], // unsorted input
      chapterSampleRate: 24_000,
      synth: async (s) => {
        calls.push(s);
        return { pcm: pcmOfSamples(240), sampleRate: 24_000, voiceSubstitutedFrom: undefined };
      },
    });
    expect(reps.map((r) => [r.startSegmentIndex, r.endSegmentIndex])).toEqual([
      [1, 1],
      [3, 3],
    ]);
    // synth was called per target segment, sorted ascending
    expect(calls.map((c) => c.groupIndex)).toEqual([1, 3]);
    // single-segment runs carry no inner split
    expect(reps[0].innerSegmentByteLengths).toBeUndefined();
  });

  it('passes the segment so the caller can synth from its sentenceIds', async () => {
    const seen: number[][] = [];
    await buildSynthReplacements({
      segments,
      targetIndices: [3],
      chapterSampleRate: 24_000,
      synth: async (s) => {
        seen.push(s.sentenceIds);
        return { pcm: pcmOfSamples(10), sampleRate: 24_000, voiceSubstitutedFrom: undefined };
      },
    });
    expect(seen).toEqual([[4, 5]]);
  });

  /* #1972 — voiceName always overwrites (unlike the QA fields, there's no
     "gate didn't run" state to protect: a re-record always synthesises, so
     a fresh voiceName is always meaningful when the caller reports one). */
  it('carries voiceName from the synth output onto the replacement', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        voiceName: 'kokoro-some-voice',
        voiceSubstitutedFrom: undefined,
      }),
    });
    // #1888 — voiceSubstitutedFrom is now unconditionally present (undefined
    // here, since this synth output didn't report one).
    expect(reps[0].freshVerdict).toStrictEqual({
      voiceName: 'kokoro-some-voice',
      voiceSubstitutedFrom: undefined,
    });
  });

  it('omits voiceName when the caller does not report one', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({ pcm: pcmOfSamples(100), sampleRate: 24_000, voiceSubstitutedFrom: undefined }),
    });
    expect('voiceName' in reps[0].freshVerdict!).toBe(false);
  });

  it('resamples replacement PCM onto the chapter grid when the synth rate differs', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({ pcm: pcmOfSamples(1000), sampleRate: 48_000, voiceSubstitutedFrom: undefined }),
    });
    // 1000 samples @48k downsampled to 24k → ~500 samples = ~1000 bytes.
    const bytes = reps[0].pcm.length;
    expect(bytes).toBeGreaterThan(800);
    expect(bytes).toBeLessThan(1100);
  });

  it('leaves PCM untouched when the synth rate already matches', async () => {
    const pcm = pcmOfSamples(333);
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({ pcm, sampleRate: 24_000, voiceSubstitutedFrom: undefined }),
    });
    expect(reps[0].pcm.length).toBe(pcm.length);
  });

  it('carries the fresh verdict from the synth output onto the replacement when the gate ran', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        qa: { status: 'ok', reasons: [], rms: 0.1, longestSilenceSec: 0, durationSec: 1, expectedSec: 1 },
        suspect: undefined,
        signalQaRan: true,
        voiceSubstitutedFrom: undefined,
      }),
    });
    // toStrictEqual (not toEqual) so a key present-but-undefined is
    // distinguished from an omitted key — the whole point of this fix.
    expect(reps[0].freshVerdict).toStrictEqual({
      qa: { status: 'ok', reasons: [], rms: 0.1, longestSilenceSec: 0, durationSec: 1, expectedSec: 1 },
      suspect: undefined,
      qaRetries: undefined,
      // #1888 — unconditionally present (undefined; this synth output
      // reported no substitution).
      voiceSubstitutedFrom: undefined,
    });
    // The asr/asrSuspect/asrRetries keys are OMITTED entirely (asrRan wasn't
    // set) — not merely `undefined`-valued.
    expect('asr' in reps[0].freshVerdict!).toBe(false);
    expect('asrSuspect' in reps[0].freshVerdict!).toBe(false);
    expect('asrRetries' in reps[0].freshVerdict!).toBe(false);
  });

  it('carries the fresh ASR verdict too when asrRan is true', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        signalQaRan: true,
        qa: { status: 'ok', reasons: [], rms: 0.1, longestSilenceSec: 0, durationSec: 1, expectedSec: 1 },
        asrRan: true,
        asr: { verdict: 'clean', reasons: [] } as unknown as ChapterSegment['asr'],
        asrSuspect: undefined,
        voiceSubstitutedFrom: undefined,
      }),
    });
    expect('asr' in reps[0].freshVerdict!).toBe(true);
    expect('asrSuspect' in reps[0].freshVerdict!).toBe(true);
    expect('asrRetries' in reps[0].freshVerdict!).toBe(true);
  });

  /* fs-51 review follow-up — the false-pass bug: a call whose caller never ran
     a gate (config off) must not let that gate's fields — even though they're
     all `undefined` on the SynthOutput — overwrite a segment's prior, genuine
     verdict. buildSynthReplacements must OMIT the whole key group, not
     include it with undefined values, so spliceChapterSegments's spread
     leaves the segment's prior fields alone. */
  it('omits the qa/suspect/qaRetries group entirely when signalQaRan is false — the gate never ran, not "ran clean"', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        // signalQaRan omitted (falsy) — the caller's gate never ran.
        voiceSubstitutedFrom: undefined,
      }),
    });
    // #1888 — voiceSubstitutedFrom is unconditionally present regardless of
    // the QA gates' on/off state.
    expect(reps[0].freshVerdict).toStrictEqual({ voiceSubstitutedFrom: undefined });
    expect('qa' in reps[0].freshVerdict!).toBe(false);
    expect('suspect' in reps[0].freshVerdict!).toBe(false);
    expect('qaRetries' in reps[0].freshVerdict!).toBe(false);
  });

  it('omits the asr/asrSuspect/asrRetries group entirely when asrRan is false', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        signalQaRan: true,
        qa: { status: 'ok', reasons: [], rms: 0.1, longestSilenceSec: 0, durationSec: 1, expectedSec: 1 },
        // asrRan omitted (falsy) — ASR never ran for this call.
        voiceSubstitutedFrom: undefined,
      }),
    });
    expect('asr' in reps[0].freshVerdict!).toBe(false);
    expect('asrSuspect' in reps[0].freshVerdict!).toBe(false);
    expect('asrRetries' in reps[0].freshVerdict!).toBe(false);
  });

  /* fs-51 review follow-up (Critical false-pass fix) — `suspect` is a UNION
     signal (synthesise-chapter.ts stamps it from `quarantined ||
     qa?.status === 'suspect'`, where `quarantined` is ASR-driven calibration-
     bleed detection, entirely independent of the signal-QA gate). It must
     therefore be included in freshVerdict whenever EITHER gate ran, not only
     when signalQaRan is true — bucketing it under signalQaRan alone let an
     ASR-only re-record's genuine `suspect: true` (from ASR quarantining dead
     silence) get silently dropped, leaving the segment's stale prior verdict
     (often clean) in place while the actual audio was quarantined silence. */
  it('includes suspect when ONLY asrRan is true (signal-QA gate off) — the ASR-driven quarantine must not be dropped', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        // signalQaRan omitted (false) — qa.seg.maxRerecords=0, gate off.
        asrRan: true,
        asr: { verdict: 'drift', reasons: [] } as unknown as ChapterSegment['asr'],
        suspect: true, // ASR's quarantined-calibration-bleed check fired.
        voiceSubstitutedFrom: undefined,
      }),
    });
    expect(reps[0].freshVerdict?.suspect).toBe(true);
    expect('suspect' in reps[0].freshVerdict!).toBe(true);
    // qa/qaRetries still correctly omitted — signal-QA itself never ran.
    expect('qa' in reps[0].freshVerdict!).toBe(false);
    expect('qaRetries' in reps[0].freshVerdict!).toBe(false);
  });

  it('includes suspect when ONLY signalQaRan is true (ASR off) — the signal-QA-driven suspect must still propagate', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        signalQaRan: true,
        qa: { status: 'suspect', reasons: ['clipping'], rms: 0.1, longestSilenceSec: 0, durationSec: 1, expectedSec: 1 },
        suspect: true,
        // asrRan omitted (false) — ASR never ran for this call.
        voiceSubstitutedFrom: undefined,
      }),
    });
    expect(reps[0].freshVerdict?.suspect).toBe(true);
    expect('asr' in reps[0].freshVerdict!).toBe(false);
    expect('asrSuspect' in reps[0].freshVerdict!).toBe(false);
  });

  it('omits suspect entirely when NEITHER gate ran, preserving the segment prior value even if out.suspect happens to be set', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        suspect: true, // stray/meaningless — neither gate ran, must be ignored.
        // signalQaRan and asrRan both omitted (false).
        voiceSubstitutedFrom: undefined,
      }),
    });
    // #1888 — voiceSubstitutedFrom is unconditionally present regardless.
    expect(reps[0].freshVerdict).toStrictEqual({ voiceSubstitutedFrom: undefined });
    expect('suspect' in reps[0].freshVerdict!).toBe(false);
  });

  /* M1 (#1972 follow-up) — baseVoiceName follows the SAME omit-don't-overwrite
     rule as voiceName. */
  it('carries baseVoiceName from the synth output onto the replacement', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        voiceName: 'qwen-wren__angry',
        baseVoiceName: 'qwen-wren',
        voiceSubstitutedFrom: undefined,
      }),
    });
    expect(reps[0].freshVerdict).toStrictEqual({
      voiceName: 'qwen-wren__angry',
      baseVoiceName: 'qwen-wren',
      voiceSubstitutedFrom: undefined,
    });
  });

  it('omits baseVoiceName when the caller does not report one', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({ pcm: pcmOfSamples(100), sampleRate: 24_000, voiceName: 'kokoro-x', voiceSubstitutedFrom: undefined }),
    });
    expect('baseVoiceName' in reps[0].freshVerdict!).toBe(false);
  });

  /* #1888 — unlike voiceName/baseVoiceName (omitted when the caller doesn't
     report one, so an unmigrated caller can't wipe a segment's prior value),
     voiceSubstitutedFrom must ALWAYS be present on freshVerdict, because a
     re-record always synthesises and therefore always has a definite answer
     for "did THIS take substitute" — undefined is a meaningful, current
     answer ("no"), not "the gate didn't run." Omitting the key here would let
     spliceChapterSegments's `{...segment, ...freshVerdict}` spread leave a
     stale prior substitution flag in place on a now-clean take. */
  it('carries voiceSubstitutedFrom from the synth output onto the replacement when the take substituted', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({
        pcm: pcmOfSamples(100),
        sampleRate: 24_000,
        voiceSubstitutedFrom: 'Requested Voice',
      }),
    });
    expect(reps[0].freshVerdict?.voiceSubstitutedFrom).toBe('Requested Voice');
  });

  it('includes voiceSubstitutedFrom as an explicit undefined key (not omitted) when the take reports no substitution — must not let the merge preserve a stale prior value (#1888)', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      // #2034 — voiceSubstitutedFrom is now a REQUIRED key on SynthOutput
      // (value still permits undefined), so this literal must supply it
      // explicitly; the assertions below still prove buildSynthReplacements
      // itself always sets the key on freshVerdict regardless.
      synth: async () => ({ pcm: pcmOfSamples(100), sampleRate: 24_000, voiceSubstitutedFrom: undefined }),
    });
    // toStrictEqual (not toEqual) so a key present-but-undefined is
    // distinguished from an omitted key — the whole point of this fix.
    expect('voiceSubstitutedFrom' in reps[0].freshVerdict!).toBe(true);
    expect(reps[0].freshVerdict?.voiceSubstitutedFrom).toBeUndefined();
  });
});

describe('SynthOutput#voiceSubstitutedFrom (#2034 — required, not optional)', () => {
  /* This is a COMPILE-TIME assertion, not a runtime one: vitest transpiles
     via esbuild and never evaluates `@ts-expect-error`, so this test always
     passes when run with `vitest run`. The real gate is `npm run typecheck`
     (tsc), which requires the line below to be an actual type error — if
     `voiceSubstitutedFrom` ever reverts to optional (`voiceSubstitutedFrom?:`
     on SynthOutput), tsc reports "Unused '@ts-expect-error' directive" and
     `npm run typecheck` goes red. Mutation-verified by reverting the `:71`
     production line and re-running `npm run typecheck` (see PR description /
     commit message for the pasted red output). */
  it('a SynthOutput literal that omits voiceSubstitutedFrom fails typecheck', () => {
    // @ts-expect-error — voiceSubstitutedFrom is a required key (value still
    // permits `undefined`); omitting the key entirely must not compile (#2034).
    const bad: SynthOutput = { pcm: Buffer.alloc(0), sampleRate: 24_000 };
    expect(bad).toBeTruthy();
  });
});

describe('findDivergentSentences (#1972 shared predicate)', () => {
  const segs = [
    seg(0, 'amy', [1]),
    seg(1, 'castor', [2]),
    seg(2, 'wren', [3, 4]),
  ];
  // #2040 — findDivergentSentences resolves both sides through the cast (+
  // an optional castIdHistory, defaulting to {} — see the alias-specific
  // coverage in build-synth-replacement.alias.test.ts). None of these ids
  // are aliased, so this cast only needs to make every id below an EXACT
  // hit — these tests pin the pre-existing raw-comparison behaviour, which
  // must be unaffected by the resolver conversion.
  const cast = [{ id: 'amy' }, { id: 'castor' }, { id: 'wren' }, { id: 'narrator' }];

  it('finds nothing when segFile and the current analysis agree', () => {
    const current = [
      { id: 1, characterId: 'amy', text: 'Hi.' },
      { id: 2, characterId: 'castor', text: 'Bye.' },
    ];
    expect(findDivergentSentences(segs, [0, 1], current, cast)).toEqual([]);
  });

  it('flags a sentence the current analysis moved to a DIFFERENT character, naming the new owner', () => {
    const current = [{ id: 2, characterId: 'narrator', text: 'Actually narration.' }];
    expect(findDivergentSentences(segs, [1], current, cast)).toEqual([
      { segmentIndex: 1, sentenceId: 2, newOwner: 'narrator' },
    ]);
  });

  it('flags a sentence id ABSENT from the current analysis (re-segmentation renumbered ids) — newOwner is null, not the stale characterId', () => {
    expect(findDivergentSentences(segs, [1], [], cast)).toEqual([
      { segmentIndex: 1, sentenceId: 2, newOwner: null },
    ]);
  });

  it('flags a sentence marked excludeFromSynthesis (fs-58) — buildSentenceGroups would drop it, splicing silence', () => {
    const current = [{ id: 2, characterId: 'castor', text: 'Bye.', excludeFromSynthesis: true }];
    expect(findDivergentSentences(segs, [1], current, cast)).toEqual([
      { segmentIndex: 1, sentenceId: 2, newOwner: null },
    ]);
  });

  it('flags a sentence that normalises to empty text — buildSentenceGroups drops it too', () => {
    const current = [{ id: 2, characterId: 'castor', text: '   ' }];
    expect(findDivergentSentences(segs, [1], current, cast)).toEqual([
      { segmentIndex: 1, sentenceId: 2, newOwner: null },
    ]);
  });

  it('emits one entry PER diverged sentence id for a multi-sentence segment', () => {
    const current = [
      { id: 3, characterId: 'wren', text: 'Mine.' }, // agrees
      { id: 4, characterId: 'narrator', text: 'Not mine.' }, // diverges
    ];
    expect(findDivergentSentences(segs, [2], current, cast)).toEqual([
      { segmentIndex: 2, sentenceId: 4, newOwner: 'narrator' },
    ]);
  });

  it('only checks the requested targetIndices, ignoring divergence elsewhere in segments', () => {
    const current = [
      { id: 1, characterId: 'amy', text: 'Agrees, and IS targeted.' },
      { id: 2, characterId: 'narrator', text: 'Diverged, but not targeted.' },
    ];
    expect(findDivergentSentences(segs, [0], current, cast)).toEqual([]);
  });
});
