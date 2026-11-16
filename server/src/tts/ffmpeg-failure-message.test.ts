/* #4233 -- an ffmpeg failure must not carry the absolute temp/book path in
   `message` (ffmpeg echoes `Output #0, mp3, to '<abs path>'` and, with
   loudnorm on, the full banner). The detail stays on `ffmpegStderr` for the log.
   Drives the REAL encoder into failure by pointing TEMP/TMP at an unusable path. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePcmToAudio, decodeAudioToPcm, decodeAudioFileToPcm } from './mp3.js';
import { ffmpegFailure } from './ffmpeg-failure.js';
import { requestFailureMessageFs } from '../workspace/file-lock.js';
import { classifyFailure } from '../routes/failure-taxonomy.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ABS_PATH = /[A-Za-z]:[\\/]|\/(?:tmp|var|home|Users)\//;

const SR = 24000;
const pcm = Buffer.alloc(SR * 2);
for (let i = 0; i < SR; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SR)), i * 2);

const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
const scratch: string[] = [];
afterEach(() => {
  for (const k of ['TEMP', 'TMP', 'TMPDIR'] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** A "directory" that is really a file, so ffmpeg cannot open an output inside it. */
function breakTmpdir(): string {
  const dir = mkdtempSync(join(saved.TEMP ?? tmpdir(), 'ffmpeg-fail-'));
  scratch.push(dir);
  const file = join(dir, 'afile.txt');
  writeFileSync(file, 'x');
  const bad = join(file, 'sub');
  process.env.TEMP = bad;
  process.env.TMP = bad;
  process.env.TMPDIR = bad;
  return bad;
}

describe('ffmpegFailure', () => {
  it('keeps the exit code, scrubs paths, keeps the full stderr on a property', () => {
    const stderr = "ffmpeg version 8\n  built with gcc\nOutput #0, mp3, to 'C:\\Users\\bob\\AppData\\Local\\Temp\\x.mp3':\nav_interleaved_write_frame(): No space left on device\nConversion failed!";
    const err = ffmpegFailure('ffmpeg', 1, stderr);
    expect(err.message).toMatch(/^ffmpeg exited with code 1/);
    expect(err.message).toMatch(/no space left on device/i);
    expect(err.message).not.toMatch(ABS_PATH);
    expect(err.message).not.toContain('ffmpeg version');
    expect(err.ffmpegStderr).toBe(stderr);
  });

  it('handles an empty stderr and scrubs a posix path', () => {
    expect(ffmpegFailure('ffmpeg', 2, '').message).toBe('ffmpeg exited with code 2');
    const e = ffmpegFailure('ffmpeg', 1, 'Error opening output /var/tmp/a/b.mp3: No such file or directory');
    expect(e.message).not.toMatch(ABS_PATH);
    expect(e.message).toMatch(/No such file or directory/);
  });
});

describe.skipIf(!hasFfmpeg)('real ffmpeg failure is path-free in the message', () => {
  for (const [label, opts] of [
    ['loudnorm', { format: 'mp3' as const, loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: true } }],
    ['plain', { format: 'mp3' as const }],
  ] as const) {
    it(`encodePcmToAudio (${label})`, async () => {
      breakTmpdir();
      const err = (await encodePcmToAudio(pcm, SR, opts).then(
        () => null,
        (e: unknown) => e,
      )) as (Error & { ffmpegStderr?: string }) | null;
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/^ffmpeg exited with code/);
      expect(err!.message).not.toMatch(ABS_PATH);
      expect(err!.message.length).toBeLessThan(400);
      expect(typeof err!.ffmpegStderr).toBe('string');
      expect(err!.ffmpegStderr).toMatch(ABS_PATH);

      // The splice / QA-repair frame (fallback = the message) is path-free too.
      const frame = requestFailureMessageFs(err, `Splice failed: ${err!.message}`);
      expect(frame).not.toMatch(ABS_PATH);
      expect(frame).toMatch(/^Splice failed: ffmpeg exited with code/);
    });
  }

  it('decodeAudioToPcm / decodeAudioFileToPcm keep stderr off the message', async () => {
    const d = (await decodeAudioToPcm(Buffer.from('not audio at all'), SR).then(
      () => null,
      (e: unknown) => e,
    )) as (Error & { ffmpegStderr?: string }) | null;
    expect(d!.message).toMatch(/^ffmpeg \(decode\) exited with code/);
    expect(typeof d!.ffmpegStderr).toBe('string');

    const missing = join(tmpdir(), 'castwright-no-such-input-4233.mp3');
    const f = (await decodeAudioFileToPcm(missing, SR).then(
      () => null,
      (e: unknown) => e,
    )) as (Error & { ffmpegStderr?: string }) | null;
    expect(f!.message).toMatch(/^ffmpeg \(decode file\) exited with code/);
    expect(f!.message).not.toMatch(ABS_PATH);
    expect(f!.message).not.toContain(missing);
  });
});

describe('generation classifier on ffmpeg failures', () => {
  it('still classifies a full disk as disk-full from the path-free message', () => {
    const err = ffmpegFailure(
      'ffmpeg',
      1,
      "Output #0, mp3, to 'C:\\Users\\bob\\Temp\\x.mp3':\nav_interleaved_write_frame(): No space left on device",
    );
    const c = classifyFailure(err);
    expect(c.code).toBe('disk-full');
    expect(c.userMessage).not.toMatch(ABS_PATH);
  });
});
