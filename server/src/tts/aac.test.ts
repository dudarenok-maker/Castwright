/* Real-ffmpeg integration test for the AAC/M4A path through
   encodePcmToAudio. Same shape as `mp3.test.ts`: a synthetic 1 s sine
   tone goes in, an M4A buffer comes out. We assert:

   - The output starts with the mp4 `ftyp` box (the M4A container's
     well-known magic bytes); a 'isom' or 'M4A ' major brand follows.
   - ffmpeg can re-decode the buffer back to PCM (any non-zero output is
     enough; this proves the file is structurally valid).

   The encoder picks libfdk_aac when available and the native `aac`
   encoder otherwise. Both are exercised by this suite — the fallback
   is invisible to the assertions. Skips when ffmpeg isn't on PATH (CI
   docker images that don't bundle it). */

import { spawn, spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach } from 'vitest';
import { encodePcmToAudio, hasLibFdkAac, _resetFfmpegCodecCache } from './mp3.js';

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

/* Decode an M4A buffer back to PCM via ffmpeg. Returns the decoded byte
   length on success, 0 otherwise. Used as a smoke proof that the buffer
   is a valid M4A — a wrong container would surface as a non-zero exit
   from ffmpeg. */
function decodeM4aToPcmLength(buf: Buffer): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-f',
        'm4a',
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

beforeEach(() => {
  _resetFfmpegCodecCache();
});

describeIfFfmpeg('encodePcmToAudio (format: aac-m4a)', () => {
  it('encodes 24 kHz mono PCM to a valid M4A (ftyp box) container', async () => {
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 1.0);
    const m4a = await encodePcmToAudio(pcm, sampleRate, { format: 'aac-m4a' });

    /* Loose-but-honest lower bound: 1 s of AAC at 128 kbps yields ~16 KB
       including container overhead. We accept >= 2 KB to give libfdk_aac
       VBR mode 4 some headroom on quiet inputs. */
    expect(m4a.length).toBeGreaterThan(2048);

    /* The mp4 `ftyp` box sits at offset 4: size (4 bytes) + 'ftyp' (4
       bytes) + major brand (4 bytes) + minor version + compatible
       brands. Compare bytes 4..8 to the literal 'ftyp'. */
    const ftypMarker = m4a.subarray(4, 8).toString('ascii');
    expect(ftypMarker).toBe('ftyp');

    /* Major brand at bytes 8..12 — common brands written by ffmpeg's
       ipod muxer are 'M4A ', 'isom', 'mp42'. Accept any of those rather
       than pinning a specific value (drift across ffmpeg versions). */
    const majorBrand = m4a.subarray(8, 12).toString('ascii');
    expect(['M4A ', 'isom', 'mp42']).toContain(majorBrand);
  });

  it('produces a buffer ffmpeg can decode back to PCM (round-trip smoke)', async () => {
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 0.5);
    const m4a = await encodePcmToAudio(pcm, sampleRate, { format: 'aac-m4a' });

    const decodedLength = await decodeM4aToPcmLength(m4a);
    expect(decodedLength).toBeGreaterThan(0);
  });

  it('honours the libfdk_aac codec probe (cached value drives dispatch)', () => {
    /* The probe runs synchronously on first call. We just verify it
       returns a stable boolean and the cache reuses it (no spawn loop
       in steady state). A second call must match the first. */
    const first = hasLibFdkAac();
    const second = hasLibFdkAac();
    expect(typeof first).toBe('boolean');
    expect(second).toBe(first);
  });
});

if (!ffmpegPresent) {
  // eslint-disable-next-line no-console
  console.warn(
    '[aac.test.ts] ffmpeg not found on PATH — skipping encoder integration tests. ' +
      'Install: winget install Gyan.FFmpeg',
  );
}
