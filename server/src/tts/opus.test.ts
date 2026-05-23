/* Real-ffmpeg integration test for the Opus/Ogg path through
   encodePcmToAudio. Mirrors aac.test.ts: synthesise a 1 s tone, feed
   it to encodePcmToAudio with `format: 'opus'`, assert:

   - The output is OggS-magic-prefixed (the Ogg container signature).
   - ffmpeg can re-decode the buffer back to PCM (round-trip smoke).

   Skips when ffmpeg isn't on PATH. libopus is bundled with the static
   ffmpeg builds we recommend; if a CI image strips it the round-trip
   test will fail loudly rather than silently passing. */

import { spawn, spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { encodePcmToAudio } from './mp3.js';

const ffmpegPresent = (() => {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
})();

const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

function sinePcm(sampleRate: number, seconds: number, freq = 440): Buffer {
  const sampleCount = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(sampleCount * 2);
  const amp = 16000;
  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

function decodeOpusToPcmLength(buf: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-f',
        'ogg',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        '24000',
        '-ac',
        '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      resolve(out.length);
    });
    child.on('error', () => resolve(0));
    child.stdin.on('error', () => {});
    child.stdin.end(buf);
  });
}

describeIfFfmpeg('encodePcmToAudio (format: opus)', () => {
  it('encodes 24 kHz mono PCM to an Ogg/Opus stream (OggS magic)', async () => {
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 1.0);
    const ogg = await encodePcmToAudio(pcm, sampleRate, { format: 'opus' });

    /* 1 s @ 96 kbps Opus ≈ 12 KB; even quiet inputs clear ~2 KB after
       container overhead. */
    expect(ogg.length).toBeGreaterThan(2048);

    /* Every Ogg page starts with the 4-byte magic 'OggS'. The first
       page sits at offset 0. */
    const oggsMarker = ogg.subarray(0, 4).toString('ascii');
    expect(oggsMarker).toBe('OggS');
  });

  it('produces a buffer ffmpeg can decode back to PCM (round-trip smoke)', async () => {
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 0.5);
    const ogg = await encodePcmToAudio(pcm, sampleRate, { format: 'opus' });

    const decodedLength = await decodeOpusToPcmLength(ogg);
    expect(decodedLength).toBeGreaterThan(0);
  });
});

if (!ffmpegPresent) {
  console.warn(
    '[opus.test.ts] ffmpeg not found on PATH — skipping encoder integration tests. ' +
      'Install: winget install Gyan.FFmpeg',
  );
}
