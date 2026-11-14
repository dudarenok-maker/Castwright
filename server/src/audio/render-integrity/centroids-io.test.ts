import { describe, expect, it } from 'vitest';
import { auditionCentroidUsableForCurrent, type CharacterCentroid } from './centroids-io.js';

const base = { characterId: 'c', centroid: [1], cleanMean: 0.9, pSevere: 0.5, pBand: 0.6 };

const audition = (voiceName: string, modelKey: string): CharacterCentroid => ({
  ...base,
  referenceKind: 'audition',
  auditionVoice: { voiceName, modelKey },
});

const inBook = (inBookVoiceName?: string): CharacterCentroid => ({
  ...base,
  referenceKind: 'in-book',
  ...(inBookVoiceName != null ? { inBookVoiceName } : {}),
});

const T06 = 'qwen3-tts-0.6b';
const T17 = 'qwen3-tts-1.7b';

describe('auditionCentroidUsableForCurrent (#3518 tier rule)', () => {
  it('A1: audition row matching voice and model key is usable', () => {
    expect(auditionCentroidUsableForCurrent(audition('v', T06), 'v', T06)).toBe(true);
  });

  it('A2: audition row recorded at another tier is unusable', () => {
    expect(auditionCentroidUsableForCurrent(audition('v', T06), 'v', T17)).toBe(false);
  });

  it('A3: audition row with no current model key is unusable', () => {
    expect(auditionCentroidUsableForCurrent(audition('v', T06), 'v', undefined)).toBe(false);
  });

  it('B1: in-book row rendered at the current tier is usable', () => {
    expect(auditionCentroidUsableForCurrent(inBook('v'), 'v', T17, T17)).toBe(true);
  });

  it('B2: in-book row last rendered at another tier is unusable', () => {
    expect(auditionCentroidUsableForCurrent(inBook('v'), 'v', T17, T06)).toBe(false);
  });

  it('B3: legacy in-book row (no voice name) is still dropped on a tier mismatch', () => {
    expect(auditionCentroidUsableForCurrent(inBook(), 'v', T17, T06)).toBe(false);
  });

  it('B4: in-book row with an unknown tier is judged on voice alone', () => {
    expect(auditionCentroidUsableForCurrent(inBook('v'), 'v', T17)).toBe(true);
    expect(auditionCentroidUsableForCurrent(inBook('v'), 'v', undefined, T06)).toBe(true);
  });

  it('B5: in-book voice rule is kept', () => {
    expect(auditionCentroidUsableForCurrent(inBook('old'), 'v', T17, T17)).toBe(false);
  });

  it('C1: too-short row is never usable', () => {
    const row: CharacterCentroid = { ...base, referenceKind: 'too-short' };
    expect(auditionCentroidUsableForCurrent(row, 'v', T06, T06)).toBe(false);
  });
});
