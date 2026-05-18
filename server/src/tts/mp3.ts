/* PCM → MP3 encoder. Pipes raw 16-bit signed little-endian mono PCM through
   system `ffmpeg` and collects libmp3lame's stdout. Used by generation.ts
   after per-sentence PCM has been concatenated into the full chapter buffer
   — encoding once at chapter granularity sidesteps MP3 frame-alignment and
   gapless-playback issues that per-segment encoding would create.

   ffmpeg is a hard runtime dep; scripts/start-app.ps1 preflights it. We do
   NOT mock the encoder boundary in tests — the integration suite spawns the
   real subprocess so we catch wire-format / flag-name drift. */

import { spawn } from 'node:child_process';

export interface EncodePcmToMp3Options {
  /** LAME VBR quality: 0 (best, larger) .. 9 (worst, smaller). Default 2
      ≈ V2, the LAME preset-standard. */
  quality?: number;
}

export async function encodePcmToMp3(
  pcm: Buffer,
  sampleRate: number,
  opts: EncodePcmToMp3Options = {},
): Promise<Buffer> {
  const quality = opts.quality ?? 2;

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
    '-c:a',
    'libmp3lame',
    '-q:a',
    String(quality),
    '-f',
    'mp3',
    'pipe:1',
  ];

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      /* spawn failure: ffmpeg not on PATH. Surface a friendly hint — the
         preflight in start-app.ps1 should normally prevent this. */
      reject(
        new Error(
          `Failed to spawn ffmpeg: ${err.message}. ` +
            `Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).`,
        ),
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr || '(no stderr)'}`));
      }
    });

    child.stdin.on('error', (err) => {
      /* EPIPE if ffmpeg dies before we finish writing the PCM. The 'close'
         handler will report the real reason via stderr; swallow here so the
         promise doesn't reject twice. */
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
    });

    child.stdin.end(pcm);
  });
}
