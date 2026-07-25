import { describe, it, expect } from 'vitest';
import { encodePcmToWav } from './wav.js';

describe('encodePcmToWav', () => {
  it('prepends a 44-byte canonical PCM WAV header for s16le mono', () => {
    const pcm = Buffer.alloc(8, 0); // 4 samples
    const wav = encodePcmToWav(pcm, 24_000);
    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // ChunkSize
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(24_000 * 2); // byte rate = sr * blockAlign
    expect(wav.readUInt16LE(32)).toBe(2); // block align (mono * 16-bit)
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // Subchunk2Size
    expect(wav.subarray(44)).toEqual(pcm);
  });
});
