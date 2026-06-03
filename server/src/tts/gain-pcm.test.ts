/* Real-ffmpeg integration coverage for the per-character gain primitive
   (fs-26 re-mix path). Like the encoder boundary, we do NOT mock ffmpeg —
   the subprocess runs for real so we catch flag/wire-format drift. The
   load-bearing contract for the splice engine is sample-count preservation
   (a gain must not change duration), so that gets the strictest assertion. */

import { describe, it, expect } from 'vitest';
import { applyGainToPcm } from './gain-pcm.js';

const SR = 24_000;

/** Constant-amplitude int16 mono PCM — easy to reason about gain on. */
function constPcm(sampleCount: number, value: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) buf.writeInt16LE(value, i * 2);
  return buf;
}

function avgAbs(pcm: Buffer): number {
  let sum = 0;
  const n = pcm.length / 2;
  for (let i = 0; i < n; i += 1) sum += Math.abs(pcm.readInt16LE(i * 2));
  return sum / n;
}

describe('applyGainToPcm', () => {
  it('preserves sample count (zero duration drift) — the splice-engine contract', async () => {
    const input = constPcm(2400, 5000);
    const out = await applyGainToPcm(input, SR, 6);
    expect(out.length).toBe(input.length);
  });

  it('+6.0206 dB roughly doubles amplitude', async () => {
    const input = constPcm(2400, 5000);
    const out = await applyGainToPcm(input, SR, 6.0206);
    expect(avgAbs(out)).toBeGreaterThan(9500);
    expect(avgAbs(out)).toBeLessThan(10500);
  });

  it('-6.0206 dB roughly halves amplitude', async () => {
    const input = constPcm(2400, 10000);
    const out = await applyGainToPcm(input, SR, -6.0206);
    expect(avgAbs(out)).toBeGreaterThan(4500);
    expect(avgAbs(out)).toBeLessThan(5500);
  });

  it('0 dB is (near) identity', async () => {
    const input = constPcm(2400, 8000);
    const out = await applyGainToPcm(input, SR, 0);
    expect(avgAbs(out)).toBeGreaterThan(7900);
    expect(avgAbs(out)).toBeLessThan(8100);
  });

  it('clamps to int16 on an extreme boost (no wraparound)', async () => {
    const input = constPcm(2400, 20000);
    const out = await applyGainToPcm(input, SR, 24); // ×~15.8 → way past 32767
    for (let i = 0; i < out.length / 2; i += 1) {
      const s = out.readInt16LE(i * 2);
      expect(s).toBeLessThanOrEqual(32767);
      expect(s).toBeGreaterThanOrEqual(0); // positive input stays positive
    }
    expect(avgAbs(out)).toBeGreaterThan(32000); // saturated near the ceiling
  });
});
