import { describe, it, expect } from 'vitest';
import { scoreAttribution } from './scorer.js';

const truth = { chapterText: '', lines: [
  { text: '"Careful."', speakerId: 'mairin' },
  { text: 'She said.', speakerId: 'narrator' },
] };

describe('scoreAttribution', () => {
  it('perfect match → precision/recall 1.0', () => {
    const pred = [{ text: '"Careful."', characterId: 'mairin' }, { text: 'She said.', characterId: 'narrator' }];
    const s = scoreAttribution(truth, pred);
    expect(s.precision).toBe(1); expect(s.recall).toBe(1); expect(s.falsePositive).toBe(0);
  });
  it('one mis-attribution → FP and FN each 1', () => {
    const pred = [{ text: '"Careful."', characterId: 'narrator' }, { text: 'She said.', characterId: 'narrator' }];
    const s = scoreAttribution(truth, pred);
    expect(s.falsePositive).toBe(1); expect(s.falseNegative).toBe(1);
  });
  it('alias map rescues an id rename', () => {
    const pred = [{ text: '"Careful."', characterId: 'char_7' }, { text: 'She said.', characterId: 'narrator' }];
    const s = scoreAttribution(truth, pred, new Map([['char_7', 'mairin']]));
    expect(s.precision).toBe(1);
  });
  it('repeated identical text with different speakers is not collapsed', () => {
    const dup = { chapterText: '', lines: [
      { text: '「はい」', speakerId: 'a' }, { text: '「はい」', speakerId: 'b' },
    ] };
    const pred = [{ text: '「はい」', characterId: 'a' }, { text: '「はい」', characterId: 'b' }];
    const s = scoreAttribution(dup, pred);
    expect(s.truePositive).toBe(2); // order-aware: each occurrence matched to its own truth
    expect(s.falsePositive).toBe(0);
  });
});
