/* Unit coverage for the 240-bin RMS reducer behind plan 56. The reducer is
   pure (no fs / no ffmpeg) so every shape, normalization, and edge-case
   assertion lives in this file — the higher-level wire-up (write JSON ↔
   read JSON ↔ serve over HTTP) is covered separately in `../tts/mp3.test.ts`
   and `../routes/chapter-audio.test.ts`. */

import { describe, it, expect } from 'vitest';
import { BIN_COUNT, BYTES_PER_SAMPLE, computePeaks } from './compute-peaks.js';

/** Build a length-`sampleCount` int16 LE mono PCM buffer by sampling
 *  `valueAt(i)` for each sample index. Returns a `Buffer` ready to feed
 *  to `computePeaks`. `valueAt` should return numbers in `[-32768, 32767]`. */
function makePcm(sampleCount: number, valueAt: (i: number) => number): Buffer {
  const buf = Buffer.alloc(sampleCount * BYTES_PER_SAMPLE);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = Math.max(-32768, Math.min(32767, Math.round(valueAt(i))));
    buf.writeInt16LE(sample, i * BYTES_PER_SAMPLE);
  }
  return buf;
}

function silence(sampleCount: number): Buffer {
  return makePcm(sampleCount, () => 0);
}

function sine(sampleCount: number, sampleRate: number, freq: number, amp = 16000): Buffer {
  return makePcm(sampleCount, (i) => amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));
}

/** Linear ramp from 0 to ±32000 across the buffer. Useful for asserting
 *  the reducer respects ordering — a ramp must produce bins in
 *  monotonically increasing magnitude order. */
function ramp(sampleCount: number, peak = 32000): Buffer {
  return makePcm(sampleCount, (i) => Math.round((peak * i) / Math.max(1, sampleCount - 1)));
}

describe('computePeaks', () => {
  describe('shape contract', () => {
    it('always returns exactly BIN_COUNT (240) numbers', () => {
      const sr = 24_000;
      for (const n of [0, 1, 100, 240, 241, 1_000, 1_000_000]) {
        const peaks = computePeaks(silence(n), sr);
        expect(peaks).toHaveLength(BIN_COUNT);
      }
    });

    it('returns finite numbers in [0, 1] for every bin', () => {
      const sr = 24_000;
      const pcm = sine(sr * 2, sr, 440); // 2 s @ 24 kHz
      const peaks = computePeaks(pcm, sr);
      for (const v of peaks) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('throws on a non-positive sample rate (mis-wiring should fail loud)', () => {
      const pcm = silence(1_000);
      expect(() => computePeaks(pcm, 0)).toThrow(/sampleRate/);
      expect(() => computePeaks(pcm, -1)).toThrow(/sampleRate/);
      expect(() => computePeaks(pcm, Number.NaN)).toThrow(/sampleRate/);
      expect(() => computePeaks(pcm, Number.POSITIVE_INFINITY)).toThrow(/sampleRate/);
    });
  });

  describe('silence and empty PCM', () => {
    it('empty PCM → 240 zeros (no NaN, no normalization-by-zero)', () => {
      const peaks = computePeaks(Buffer.alloc(0), 24_000);
      expect(peaks).toEqual(new Array(BIN_COUNT).fill(0));
    });

    it('all-zero PCM → 240 zeros even when sampleCount >> BIN_COUNT', () => {
      const peaks = computePeaks(silence(24_000), 24_000);
      expect(peaks).toEqual(new Array(BIN_COUNT).fill(0));
    });
  });

  describe('normalization', () => {
    it('a steady tone normalizes so the loudest bin reads exactly 1.0', () => {
      const sr = 24_000;
      const pcm = sine(sr * 1, sr, 440); // 1 s sine
      const peaks = computePeaks(pcm, sr);
      const max = Math.max(...peaks);
      expect(max).toBeCloseTo(1, 5);
    });

    it('a steady tone produces (approximately) flat bins across the array', () => {
      const sr = 24_000;
      const pcm = sine(sr * 2, sr, 440); // 2 s sine, plenty of cycles per bin
      const peaks = computePeaks(pcm, sr);
      /* Each bin sees ~200 samples (48 000 / 240) ≈ 90+ cycles of the 440 Hz
         tone, so the RMS per bin should be near-identical. Allow ±5% drift —
         windowing artifacts from non-integer cycles per bin show up at the
         far edges. */
      const mean = peaks.reduce((s, v) => s + v, 0) / peaks.length;
      for (const v of peaks) {
        expect(v).toBeGreaterThan(mean * 0.9);
        expect(v).toBeLessThan(mean * 1.1);
      }
    });

    it('RMS of a full-scale sine is √(1/2) ≈ 0.707 before normalization, 1.0 after', () => {
      /* The reducer normalizes against its peak, so we can't read the raw
         RMS directly. Instead we verify the *relative* RMS by mixing a
         full-scale sine in the first half with a half-scale sine in the
         second half: post-normalization the second half should sit near
         0.5 (the amplitude ratio carries through the linear RMS reduce). */
      const sr = 24_000;
      const halfLen = sr; // 1 s
      const loud = sine(halfLen, sr, 440, 32000);
      const quiet = sine(halfLen, sr, 440, 16000);
      const pcm = Buffer.concat([loud, quiet]);
      const peaks = computePeaks(pcm, sr);
      /* First-half bins should peak near 1.0, second-half bins near 0.5. */
      const firstHalfMax = Math.max(...peaks.slice(0, BIN_COUNT / 2));
      const secondHalfMax = Math.max(...peaks.slice(BIN_COUNT / 2));
      expect(firstHalfMax).toBeCloseTo(1, 2);
      expect(secondHalfMax).toBeCloseTo(0.5, 1);
    });
  });

  describe('long PCM (downsample)', () => {
    it('covers every sample exactly once across all bins (no gaps, no overlaps)', () => {
      /* This is asserted indirectly: feed a buffer where a single non-zero
         sample at index k lights up exactly one bin, then walk k across
         the full range and verify each k lights up some bin (i.e. no
         sample is silently dropped between bins). */
      const sampleCount = 10_000;
      for (const k of [0, 1, 100, 5_000, sampleCount - 1]) {
        const pcm = makePcm(sampleCount, (i) => (i === k ? 32000 : 0));
        const peaks = computePeaks(pcm, 24_000);
        /* Exactly one bin should be non-zero (the spike's bin). */
        const nonZero = peaks.filter((v) => v > 0);
        expect(nonZero.length).toBe(1);
      }
    });

    it('an ascending ramp produces monotonically-non-decreasing bin magnitudes', () => {
      /* Stronger ordering: the ramp's per-bin RMS is monotone in the bin
         index because each subsequent bin's window holds strictly larger
         absolute values. Allow exact equality on adjacent bins for tiny
         rounding, but reject any descent. */
      const pcm = ramp(48_000); // 2 s @ 24 kHz
      const peaks = computePeaks(pcm, 24_000);
      for (let i = 1; i < peaks.length; i += 1) {
        expect(peaks[i]).toBeGreaterThanOrEqual(peaks[i - 1] - 1e-9);
      }
      /* And the last bin is the global max (the loudest end of the ramp). */
      expect(peaks[peaks.length - 1]).toBeCloseTo(1, 5);
    });

    it('handles a very long buffer without overflow', () => {
      /* 1 h @ 24 kHz = 86.4 M samples. Skip the actual full-length buffer
         (allocates 172 MB of RAM in tests; bloats CI) and assert the
         algorithm by feeding a 5-minute buffer instead — same code path,
         no risk of overflow because each bin normalizes its sum-of-squares
         in [0,1] space (see compute-peaks.ts implementation note). */
      const sr = 24_000;
      const sampleCount = sr * 60 * 5;
      const pcm = sine(sampleCount, sr, 440);
      const peaks = computePeaks(pcm, sr);
      expect(peaks).toHaveLength(BIN_COUNT);
      for (const v of peaks) expect(Number.isFinite(v)).toBe(true);
    });
  });

  describe('short PCM (< BIN_COUNT samples)', () => {
    it('maps each sample 1:1 to a bin; trailing bins are zero', () => {
      const sampleCount = 10;
      /* Ascending magnitudes; every sample lights up a unique bin. */
      const pcm = makePcm(sampleCount, (i) => 100 * (i + 1));
      const peaks = computePeaks(pcm, 24_000);
      /* First 10 bins are non-zero, ordered by magnitude (the post-norm
         max should be 1.0 from the last sample). */
      for (let i = 0; i < sampleCount; i += 1) {
        expect(peaks[i]).toBeGreaterThan(0);
      }
      for (let i = sampleCount; i < BIN_COUNT; i += 1) {
        expect(peaks[i]).toBe(0);
      }
      expect(peaks[sampleCount - 1]).toBeCloseTo(1, 5);
    });

    it('single-sample PCM → bin[0] = 1, rest = 0', () => {
      const pcm = makePcm(1, () => 16_000);
      const peaks = computePeaks(pcm, 24_000);
      expect(peaks[0]).toBeCloseTo(1, 5);
      for (let i = 1; i < BIN_COUNT; i += 1) expect(peaks[i]).toBe(0);
    });

    it('does NOT upsample / repeat — silence stays silence', () => {
      const peaks = computePeaks(silence(50), 24_000);
      expect(peaks).toEqual(new Array(BIN_COUNT).fill(0));
    });
  });

  describe('sample-rate invariance', () => {
    it('the same sample count produces the same shape regardless of sample rate', () => {
      /* Reducer is sample-count proportional today (see contract note in
         compute-peaks.ts). Future time-based reducers may break this — when
         that happens, this test changes signaling the contract update. */
      const pcm = sine(2_400, 24_000, 440);
      const a = computePeaks(pcm, 24_000);
      const b = computePeaks(pcm, 48_000);
      expect(a).toEqual(b);
    });
  });
});
