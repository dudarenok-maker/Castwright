import { describe, it, expect } from 'vitest';
import { pcmDurationSec, pcmToWav } from './wav.js';

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

describe('pcmToWav', () => {
  it('produces a 44-byte RIFF/WAVE header before the PCM payload', () => {
    const pcm = Buffer.alloc(100, 0);
    const wav = pcmToWav(pcm, 24_000);

    expect(wav.length).toBe(44 + 100);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');

    expect(wav.readUInt16LE(20)).toBe(1);       // PCM format
    expect(wav.readUInt16LE(22)).toBe(1);       // mono
    expect(wav.readUInt32LE(24)).toBe(24_000);  // sample rate
    expect(wav.readUInt32LE(40)).toBe(100);     // data chunk size
  });
});
