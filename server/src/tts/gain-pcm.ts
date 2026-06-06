/* Per-character gain primitive (fs-26 re-mix path). Pipes raw 16-bit mono PCM
   through ffmpeg's `volume` filter to apply a dB gain, returning PCM of the
   IDENTICAL sample count (volume is a per-sample multiply). That zero-drift
   property is what lets the splice engine substitute a gained segment without
   re-timing anything downstream.

   Mirrors `encodePcmToAudio`'s subprocess handling (friendly spawn-failure
   hint, EPIPE-safe stdin, reject on non-zero exit). ffmpeg is a hard runtime
   dep; we spawn the real binary in tests rather than mock this boundary. */

import { spawn } from 'node:child_process';

/** Apply `gainDb` (signed dB) to 16-bit signed LE mono PCM at `sampleRate`.
    Output sample count equals the input's. ffmpeg's encoder/filter clamps to
    the int16 range, so an extreme boost saturates rather than wrapping. */
export async function applyGainToPcm(
  pcm: Buffer,
  sampleRate: number,
  gainDb: number,
): Promise<Buffer> {
  if (!Number.isFinite(gainDb)) {
    throw new Error(`applyGainToPcm: gainDb must be finite, got ${gainDb}`);
  }
  const args = [
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    '-af',
    `volume=${gainDb}dB`,
    '-f',
    's16le',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    'pipe:1',
  ];

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to spawn ffmpeg: ${err.message}. ` +
            `Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).`,
        ),
      );
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) resolve(Buffer.concat(stdoutChunks));
      else reject(new Error(`ffmpeg (volume) exited with code ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
    });
    child.stdin.end(pcm);
  });
}
