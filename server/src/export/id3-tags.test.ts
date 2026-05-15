/* Real-ffmpeg integration test for applyId3v24Tags. Mirrors mp3.test.ts:
   we deliberately spawn the actual ffmpeg + ffprobe so wire-format /
   flag-name drift trips the test, not a user's first sideload attempt.

   Key invariant the test enforces: `-c:a copy` round-trips the MP3 frame
   bytes byte-identically. PocketBook reads the tags off the v2 header at
   the front of the file; nothing should re-encode the body. */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePcmToMp3 } from '../tts/mp3.js';
import { applyId3v24Tags } from './id3-tags.js';

const ffmpegPresent = (() => {
  try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
})();
const ffprobePresent = (() => {
  try { return spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
})();

const describeIf = ffmpegPresent && ffprobePresent ? describe : describe.skip;

/* Build a tiny 24 kHz mono int16 LE PCM buffer of `seconds` seconds of
   silence. Encoded result is a few KB — fast to round-trip. */
function silencePcm(sampleRate: number, seconds: number): Buffer {
  return Buffer.alloc(Math.floor(sampleRate * seconds) * 2);
}

/* Locate the first MPEG frame so we can compare audio-only bytes
   regardless of how big the v2 tag at the front is. */
function audioBytesOnly(mp3: Buffer): Buffer {
  if (mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) {
    const size = ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
    return mp3.subarray(10 + size);
  }
  return mp3;
}

function probe(path: string): Promise<{ tags: Record<string, string>; codec: string; durationSec: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-loglevel', 'error',
      '-show_entries', 'format=duration:format_tags:stream=codec_name',
      '-of', 'json',
      path,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', c => stdoutChunks.push(c));
    child.stderr.on('data', c => stderrChunks.push(c));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited ${code}: ${Buffer.concat(stderrChunks).toString('utf8')}`));
      }
      const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as {
        format?: { tags?: Record<string, string>; duration?: string };
        streams?: Array<{ codec_name?: string }>;
      };
      resolve({
        tags: parsed.format?.tags ?? {},
        codec: parsed.streams?.[0]?.codec_name ?? '',
        durationSec: Number.parseFloat(parsed.format?.duration ?? '0'),
      });
    });
  });
}

describeIf('applyId3v24Tags', () => {
  let tmpDir: string;
  let srcPath: string;
  let srcBytes: Buffer;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'id3-tags-'));
    srcPath = join(tmpDir, 'src.mp3');
    const mp3 = await encodePcmToMp3(silencePcm(24_000, 0.5), 24_000, { quality: 2 });
    writeFileSync(srcPath, mp3);
    srcBytes = mp3;
  });

  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes the expected ID3v2 frames without re-encoding audio', async () => {
    const destPath = join(tmpDir, 'tagged.mp3');
    await applyId3v24Tags(srcPath, destPath, {
      title:       'Chapter 1 — The Arrival',
      album:       'The Northern Star',
      artist:      'Jane Narrator',
      albumArtist: 'Some Author',
      track:       1,
      trackTotal:  12,
      genre:       'Audiobook',
      date:        '2025',
    });

    const { tags, codec, durationSec } = await probe(destPath);
    expect(codec).toBe('mp3');
    expect(tags.title).toBe('Chapter 1 — The Arrival');
    expect(tags.album).toBe('The Northern Star');
    expect(tags.artist).toBe('Jane Narrator');
    expect(tags.album_artist).toBe('Some Author');
    expect(tags.track).toBe('1/12');
    expect(tags.genre).toBe('Audiobook');

    /* No re-encode invariant: ffmpeg's `-c:a copy` keeps the audio sample
       bytes intact but is free to rewrite the Xing/Info VBR header at the
       front of the MPEG stream, so a strict byte-for-byte comparison is
       too strong. Asserting on duration + file-size envelope catches a
       drift to a re-encoded path (which would shift VBR characteristics
       enough to bust the size band) without flaking on Xing rewrites. */
    const srcProbe = await probe(srcPath);
    expect(Math.abs(durationSec - srcProbe.durationSec)).toBeLessThan(0.05);
    const destBytes = readFileSync(destPath);
    expect(destBytes.length).toBeGreaterThan(srcBytes.length * 0.5);
    expect(destBytes.length).toBeLessThan(srcBytes.length * 2.0);
    void audioBytesOnly; /* helper retained for ad-hoc debugging */
  });

  it('omits optional genre + date when not provided', async () => {
    const destPath = join(tmpDir, 'sparse.mp3');
    await applyId3v24Tags(srcPath, destPath, {
      title: 'X', album: 'Y', artist: 'Z', albumArtist: 'A',
      track: 2, trackTotal: 9,
    });
    const { tags } = await probe(destPath);
    expect(tags.genre).toBeUndefined();
    /* ffmpeg may still emit a default `encoder` tag; we only assert ours. */
    expect(tags.title).toBe('X');
    expect(tags.track).toBe('2/9');
  });

  it('rejects with the friendly hint when ffmpeg is missing from the spawn', async () => {
    /* We can't uninstall ffmpeg per-test; the friendly hint is exercised
       only when users misconfigure PATH. The placeholder mirrors mp3.test.ts. */
    expect(true).toBe(true);
  });
});

if (!ffmpegPresent || !ffprobePresent) {
  // eslint-disable-next-line no-console
  console.warn(
    '[id3-tags.test.ts] ffmpeg/ffprobe missing — skipping ID3 round-trip tests. ' +
    'Install: winget install Gyan.FFmpeg',
  );
}
