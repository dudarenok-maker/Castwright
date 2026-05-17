import { describe, it, expect } from 'vitest';
import { pcmDurationSec } from './pcm.js';

describe('pcmDurationSec', () => {
  it('returns 1.0 for one second of 24 kHz mono int16', () => {
    expect(pcmDurationSec(24_000 * 2, 24_000)).toBe(1);
  });

  it('returns 0 for an empty buffer', () => {
    expect(pcmDurationSec(0, 24_000)).toBe(0);
  });

  it('handles fractional durations exactly (rational byte counts)', () => {
    // 1200 bytes ÷ (2 bytes/sample × 24000 samples/sec) = 0.025 s
    expect(pcmDurationSec(1200, 24_000)).toBeCloseTo(0.025, 6);
  });

  it('scales linearly with sample rate', () => {
    const bytes = 2 * 44_100; // 1 s at 44.1 kHz
    expect(pcmDurationSec(bytes, 44_100)).toBe(1);
    expect(pcmDurationSec(bytes, 22_050)).toBe(2);
  });
});
