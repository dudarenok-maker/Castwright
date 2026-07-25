import { describe, it, expect } from 'vitest';
import { assessCloneSample } from './clone-quality.js';

const SR = 24_000;
// tone(seconds, amplitude) → s16le mono buffer of a constant-amplitude square-ish signal
function tone(seconds: number, amp: number): Buffer {
  const n = Math.floor(seconds * SR);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 === 0 ? amp : -amp, i * 2);
  return b;
}

describe('assessCloneSample', () => {
  it('reports duration in seconds', () => {
    expect(assessCloneSample(tone(5, 8000), SR).durationSeconds).toBeCloseTo(5, 1);
  });
  it('fatals a clip under 4s', () => {
    expect(assessCloneSample(tone(3, 8000), SR).fatal).toMatch(/short/i);
  });
  it('fatals near-silence', () => {
    expect(assessCloneSample(tone(6, 20), SR).fatal).toMatch(/silen/i);
  });
  it('warns (not fatal) on a 4–8s clip', () => {
    const q = assessCloneSample(tone(5, 8000), SR);
    expect(q.fatal).toBeUndefined();
    expect(q.warnings.join(' ')).toMatch(/short/i);
  });
  it('warns on clipping', () => {
    const q = assessCloneSample(tone(10, 32767), SR);
    expect(q.fatal).toBeUndefined();
    expect(q.warnings.join(' ')).toMatch(/clip/i);
  });
  it('clean 10s clip: no fatal, no warnings', () => {
    const q = assessCloneSample(tone(10, 8000), SR);
    expect(q.fatal).toBeUndefined();
    expect(q.warnings).toEqual([]);
  });
});
