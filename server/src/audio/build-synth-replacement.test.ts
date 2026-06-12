/* Unit coverage for the re-record replacement builder. The synth call is
   injected (no live sidecar), so we assert the load-bearing wiring: one
   single-segment replacement per target index, sorted, and PCM resampled onto
   the chapter grid when the synth returns a different rate. */

import { describe, it, expect } from 'vitest';
import { buildSynthReplacements, isRerecordableSegment } from './build-synth-replacement.js';
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
        return { pcm: pcmOfSamples(240), sampleRate: 24_000 };
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
        return { pcm: pcmOfSamples(10), sampleRate: 24_000 };
      },
    });
    expect(seen).toEqual([[4, 5]]);
  });

  it('resamples replacement PCM onto the chapter grid when the synth rate differs', async () => {
    const reps = await buildSynthReplacements({
      segments,
      targetIndices: [0],
      chapterSampleRate: 24_000,
      synth: async () => ({ pcm: pcmOfSamples(1000), sampleRate: 48_000 }),
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
      synth: async () => ({ pcm, sampleRate: 24_000 }),
    });
    expect(reps[0].pcm.length).toBe(pcm.length);
  });
});
