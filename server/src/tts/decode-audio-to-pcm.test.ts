/* Real-ffmpeg integration coverage for decodeAudioToPcm (fs-26). The splice
   engine needs the encoded chapter MP3 back as raw PCM on the SAME sample grid
   the segments file was timed against, so the key assertions are: the decode
   round-trips an encode to ~the same duration, and it forces the output rate
   via `-ar` regardless of the source rate. Real subprocess — no mock. */

import { describe, it, expect } from 'vitest';
import { encodePcmToAudio } from './mp3.js';
import { decodeAudioToPcm } from './mp3.js';
import { pcmDurationSec } from './pcm.js';

const SR = 24_000;

function sine(durationSec: number, sampleRate: number, freq = 220, amp = 12000): Buffer {
  const n = Math.round(durationSec * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)), i * 2);
  }
  return buf;
}

describe('decodeAudioToPcm', () => {
  it('round-trips an mp3 encode back to ~the same duration of PCM', async () => {
    const original = sine(1.0, SR);
    const mp3 = await encodePcmToAudio(original, SR, { format: 'mp3', quality: 2 });
    const pcm = await decodeAudioToPcm(mp3, SR);
    // MP3 is lossy + carries a little encoder delay/padding; the LAME/Xing
    // header lets ffmpeg strip most of it, so allow a small tolerance.
    expect(pcmDurationSec(pcm.length, SR)).toBeGreaterThan(0.95);
    expect(pcmDurationSec(pcm.length, SR)).toBeLessThan(1.05);
  });

  it('forces the output onto the requested sample grid', async () => {
    // Encode at 24k, decode demanding 16k → byte count reflects 16k.
    const original = sine(1.0, SR);
    const mp3 = await encodePcmToAudio(original, SR, { format: 'mp3', quality: 2 });
    const pcm16k = await decodeAudioToPcm(mp3, 16_000);
    expect(pcmDurationSec(pcm16k.length, 16_000)).toBeGreaterThan(0.95);
    expect(pcmDurationSec(pcm16k.length, 16_000)).toBeLessThan(1.05);
    // 16k PCM of ~1s is ~32000 bytes, materially fewer than 24k's ~48000.
    expect(pcm16k.length).toBeLessThan(40_000);
  });

  it('produces 16-bit mono PCM (even byte length)', async () => {
    const mp3 = await encodePcmToAudio(sine(0.5, SR), SR, { format: 'mp3' });
    const pcm = await decodeAudioToPcm(mp3, SR);
    expect(pcm.length % 2).toBe(0);
    expect(pcm.length).toBeGreaterThan(0);
  });
});
