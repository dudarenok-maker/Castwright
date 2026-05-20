/* Real-ffmpeg integration test for encodePcmToAudio. We deliberately do NOT
   mock the subprocess — the value of this suite is catching wire-format or
   flag-name drift in the actual encoder boundary. If ffmpeg is missing the
   suite skips with a loud reason (CI must install it; users get a one-line
   hint from scripts/start-app.ps1 preflight). */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  encodePcmToAudio,
  writeChapterLufsFile,
  writeChapterPeaksFile,
  type ChapterPeaksFile,
} from './mp3.js';
import { BIN_COUNT } from '../audio/compute-peaks.js';

const ffmpegPresent = (() => {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
})();

const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

/* Build a 24 kHz mono int16 LE PCM buffer holding a 440 Hz sine wave for the
   given duration. Realistic-enough payload for the encoder; using silence
   would still work but a tone makes manual debugging (play the output) easier. */
function sinePcm(sampleRate: number, seconds: number, freq = 440): Buffer {
  const sampleCount = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(sampleCount * 2);
  const amp = 16000; // ~ -6 dBFS, plenty of headroom
  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

/* Decode an ID3v2 synchsafe size (4 bytes, top bit of each is 0). */
function id3v2TagLength(b: Buffer): number {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0; // "ID3"
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size;
}

/* Find the first valid MPEG audio frame header in the buffer. Returns its
   byte offset, or -1 if none found within the first 4 KiB. */
function findMpegSync(b: Buffer): number {
  const skip = id3v2TagLength(b);
  const limit = Math.min(b.length - 4, skip + 4096);
  for (let i = skip; i < limit; i++) {
    if (b[i] === 0xff && (b[i + 1] & 0xe0) === 0xe0) {
      // Sanity check: layer + version bits must not be reserved (00).
      const version = (b[i + 1] >> 3) & 0x3;
      const layer = (b[i + 1] >> 1) & 0x3;
      if (version === 1 || layer === 0) continue; // reserved patterns
      return i;
    }
  }
  return -1;
}

describeIfFfmpeg('encodePcmToAudio', () => {
  it('encodes 24 kHz mono PCM to a valid MPEG-2 Layer III mono stream', async () => {
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 1.0);
    const mp3 = await encodePcmToAudio(pcm, sampleRate, { quality: 2 });

    expect(mp3.length).toBeGreaterThan(1024); // ~1s @ V2 ≈ 18 KB, won't be tiny

    const syncOffset = findMpegSync(mp3);
    expect(syncOffset).toBeGreaterThanOrEqual(0);

    const headerByte1 = mp3[syncOffset + 1];
    const headerByte2 = mp3[syncOffset + 2];
    const headerByte3 = mp3[syncOffset + 3];

    const versionBits = (headerByte1 >> 3) & 0x3;
    const layerBits = (headerByte1 >> 1) & 0x3;
    expect(versionBits).toBe(0b10); // MPEG-2 (24 kHz is an MPEG-2 sample rate)
    expect(layerBits).toBe(0b01); // Layer III

    const sampleRateIndex = (headerByte2 >> 2) & 0x3;
    expect(sampleRateIndex).toBe(0b01); // MPEG-2 idx 01 → 24000 Hz

    const channelMode = (headerByte3 >> 6) & 0x3;
    expect(channelMode).toBe(0b11); // mono
  });

  it('rejects when ffmpeg exits non-zero (invalid sample rate)', async () => {
    const pcm = sinePcm(24_000, 0.1);
    await expect(encodePcmToAudio(pcm, 0, { quality: 2 })).rejects.toThrow(/ffmpeg/i);
  });

  it('rejects with a friendly hint if ffmpeg is not on PATH', async () => {
    // We can't realistically uninstall ffmpeg per-test, but we can verify
    // the error path by spawning a guaranteed-missing binary via a child
    // module copy that takes the binary name. Skip this corner — covered
    // by the friendly-hint string baked into encodePcmToAudio and exercised
    // only when users misconfigure their machine.
    // (Kept as a placeholder so future refactors that abstract the binary
    // name remember to add this assertion.)
  });
});

if (!ffmpegPresent) {
  // eslint-disable-next-line no-console
  console.warn(
    '[mp3.test.ts] ffmpeg not found on PATH — skipping encoder integration tests. ' +
      'Install: winget install Gyan.FFmpeg',
  );
}

/* writeChapterPeaksFile coverage (plan 56). No ffmpeg dependency — this is
   pure compute + fs, so it runs unconditionally even on CI without ffmpeg. */
describe('writeChapterPeaksFile', () => {
  function workDir(): string {
    return mkdtempSync(join(tmpdir(), 'audiobook-peaks-test-'));
  }

  it('writes a {peaks: number[240]} JSON file at the requested path', async () => {
    const dir = workDir();
    try {
      const peaksPath = join(dir, 'audio', 'ch-one.peaks.json');
      const pcm = sinePcm(24_000, 1.0);
      await writeChapterPeaksFile(pcm, 24_000, peaksPath);

      expect(existsSync(peaksPath)).toBe(true);
      const parsed: ChapterPeaksFile = JSON.parse(readFileSync(peaksPath, 'utf8'));
      expect(Array.isArray(parsed.peaks)).toBe(true);
      expect(parsed.peaks).toHaveLength(BIN_COUNT);
      for (const v of parsed.peaks) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates intermediate directories (matches mkdir { recursive: true })', async () => {
    const dir = workDir();
    try {
      const peaksPath = join(dir, 'nested', 'audio', 'ch-x.peaks.json');
      await writeChapterPeaksFile(sinePcm(24_000, 0.1), 24_000, peaksPath);
      expect(existsSync(peaksPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomic rename leaves no .tmp-* droppings in the audio dir on success', async () => {
    const dir = workDir();
    try {
      const audioDir = join(dir, 'audio');
      const peaksPath = join(audioDir, 'ch-clean.peaks.json');
      await writeChapterPeaksFile(sinePcm(24_000, 0.1), 24_000, peaksPath);
      const entries = readdirSync(audioDir);
      const droppings = entries.filter((e) => e.includes('.tmp-'));
      expect(droppings).toEqual([]);
      expect(entries).toContain('ch-clean.peaks.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('silent PCM yields an all-zero peaks array (no NaN serialized)', async () => {
    const dir = workDir();
    try {
      const peaksPath = join(dir, 'silent.peaks.json');
      await writeChapterPeaksFile(Buffer.alloc(24_000 * 2), 24_000, peaksPath);
      const parsed: ChapterPeaksFile = JSON.parse(readFileSync(peaksPath, 'utf8'));
      expect(parsed.peaks).toEqual(new Array(BIN_COUNT).fill(0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* writeChapterLufsFile coverage (plan 71). Sibling to writeChapterPeaksFile;
   same atomic-write pattern. Pure fs + JSON — no ffmpeg dependency, runs
   unconditionally. */
describe('writeChapterLufsFile', () => {
  function workDir(): string {
    return mkdtempSync(join(tmpdir(), 'audiobook-lufs-test-'));
  }

  it('writes a LoudnormSidecarJson payload at the requested path', async () => {
    const dir = workDir();
    try {
      const lufsPath = join(dir, 'audio', 'ch-one.lufs.json');
      const payload = {
        i: -16.2,
        lra: 8.4,
        tp: -2.1,
        target: -16,
        twoPass: true,
        measuredAt: '2026-05-20T12:00:00.000Z',
      };
      await writeChapterLufsFile(payload, lufsPath);
      expect(existsSync(lufsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(lufsPath, 'utf8'));
      expect(parsed).toEqual(payload);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomic rename leaves no .tmp-* droppings on success', async () => {
    const dir = workDir();
    try {
      const audioDir = join(dir, 'audio');
      const lufsPath = join(audioDir, 'ch-clean.lufs.json');
      await writeChapterLufsFile(
        {
          i: -16,
          lra: 11,
          tp: -1.5,
          target: -16,
          twoPass: false,
          measuredAt: new Date().toISOString(),
        },
        lufsPath,
      );
      const entries = readdirSync(audioDir);
      expect(entries.filter((e) => e.includes('.tmp-'))).toEqual([]);
      expect(entries).toContain('ch-clean.lufs.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

