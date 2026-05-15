import { describe, it, expect } from 'vitest';
import { resamplePcm16 } from './resample-pcm16.js';

/** Helper: build a PCM16 LE buffer from a sample array. */
function pcm(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

/** Helper: read PCM16 LE buffer back into a sample array. */
function readSamples(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length / 2; i++) out.push(buf.readInt16LE(i * 2));
  return out;
}

describe('resamplePcm16', () => {
  it('returns the input untouched when fromHz === toHz (identity)', () => {
    const input = pcm([0, 100, 200, 300, 400]);
    const out = resamplePcm16(input, 24000, 24000);
    expect(out).toBe(input);
  });

  it('downsamples a known buffer with the expected length ratio', () => {
    /* 100 samples at 24kHz -> 91 or 92 samples at 22050Hz (100 * 22050/24000 = 91.875).
       Allow a 1-sample tolerance — Math.round picks the nearest. */
    const input = pcm(new Array(100).fill(0).map((_, i) => i * 100));
    const out = resamplePcm16(input, 24000, 22050);
    expect(out.length / 2).toBeGreaterThanOrEqual(91);
    expect(out.length / 2).toBeLessThanOrEqual(92);
  });

  it('upsamples a known buffer with the expected length ratio', () => {
    /* 100 samples at 22050Hz -> 108 or 109 at 24kHz (100 * 24000/22050 = 108.84). */
    const input = pcm(new Array(100).fill(0).map((_, i) => i * 100));
    const out = resamplePcm16(input, 22050, 24000);
    expect(out.length / 2).toBeGreaterThanOrEqual(108);
    expect(out.length / 2).toBeLessThanOrEqual(110);
  });

  it('preserves a constant (DC) signal exactly', () => {
    /* A buffer of all 1234 should resample to all 1234 — linear interp between
       two identical samples is the same sample, regardless of ratio. */
    const input = pcm(new Array(50).fill(1234));
    const out = resamplePcm16(input, 24000, 22050);
    const samples = readSamples(out);
    for (const s of samples) expect(s).toBe(1234);
  });

  it('handles an odd-length buffer (trailing half-byte) without throwing', () => {
    /* PCM16 frames are 2 bytes; a single trailing byte is malformed. Drop it
       silently rather than crash. */
    const base = pcm([100, 200, 300, 400]);
    const oddTail = Buffer.concat([base, Buffer.from([0x7f])]);
    expect(oddTail.length).toBe(9);
    const out = resamplePcm16(oddTail, 24000, 22050);
    /* Should resample the 4 valid samples and ignore the half-byte. */
    expect(out.length % 2).toBe(0);
    expect(out.length / 2).toBeGreaterThanOrEqual(3);
    expect(out.length / 2).toBeLessThanOrEqual(4);
  });

  it('clamps gracefully at sample boundaries (no out-of-bounds reads)', () => {
    /* Tiny 2-sample input upsampled by 10x — the last several output samples
       fall at or past the final input index, which used to be where an
       off-by-one reads past the end. Should produce 20 samples, no throw. */
    const input = pcm([5000, 10000]);
    const out = resamplePcm16(input, 1000, 10000);
    expect(out.length / 2).toBe(20);
    const samples = readSamples(out);
    /* First sample equals first input sample exactly. */
    expect(samples[0]).toBe(5000);
    /* No sample exceeds the input range — no extrapolation. */
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(5000);
      expect(s).toBeLessThanOrEqual(10000);
    }
  });

  it('rejects non-positive sample rates', () => {
    const input = pcm([0, 100]);
    expect(() => resamplePcm16(input, 0, 22050)).toThrow();
    expect(() => resamplePcm16(input, 24000, -1)).toThrow();
  });

  it('returns an empty buffer when given an empty input', () => {
    const out = resamplePcm16(Buffer.alloc(0), 24000, 22050);
    expect(out.length).toBe(0);
  });

  it('interpolates linearly between two samples (midpoint check)', () => {
    /* Upsample by 2x: every other output sample is the midpoint of the two
       adjacent input samples. With input [0, 1000], output should be
       [0, ~500, 1000, ~1000] (the trailing sample reuses the last). */
    const input = pcm([0, 1000]);
    const out = resamplePcm16(input, 1000, 2000);
    const samples = readSamples(out);
    expect(samples[0]).toBe(0);
    /* samples[1] interpolates at srcPos=0.5 between 0 and 1000 → 500 */
    expect(samples[1]).toBe(500);
  });
});
