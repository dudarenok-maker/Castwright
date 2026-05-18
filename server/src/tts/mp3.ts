/* PCM → MP3 encoder. Pipes raw 16-bit signed little-endian mono PCM through
   system `ffmpeg` and collects libmp3lame's stdout. Used by generation.ts
   after per-sentence PCM has been concatenated into the full chapter buffer
   — encoding once at chapter granularity sidesteps MP3 frame-alignment and
   gapless-playback issues that per-segment encoding would create.

   ffmpeg is a hard runtime dep; scripts/start-app.ps1 preflights it. We do
   NOT mock the encoder boundary in tests — the integration suite spawns the
   real subprocess so we catch wire-format / flag-name drift.

   Sibling responsibility (plan 56): `writeChapterPeaksFile` reduces the same
   chapter PCM to a fixed-length (240-bin) RMS-peaks envelope and persists
   it under `<bookDir>/audio/<slug>.peaks.json` using the same temp-then-
   rename atomic-write convention `writeJsonAtomic` uses elsewhere. The
   chapter-audio meta endpoint reads it back; absence is graceful and yields
   `peaks: []` so chapters generated before this plan keep loading. */

import { spawn } from 'node:child_process';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { computePeaks } from '../audio/compute-peaks.js';

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

/** Disk shape of `<bookDir>/audio/<slug>.peaks.json`. Single field today —
 *  the wrapper object exists so future per-chapter audio metadata (loudness
 *  / true-peak / channel layout) can land alongside without a second sibling
 *  file or a schema-version negotiation. */
export interface ChapterPeaksFile {
  /** Length-240 RMS envelope, every value in `[0, 1]`. See
   *  `server/src/audio/compute-peaks.ts` for the reduction contract. */
  peaks: number[];
}

/** Reduce `pcm` to a 240-bin RMS envelope and persist it as JSON at
 *  `peaksPath` using the same atomic temp-then-rename pattern
 *  `writeJsonAtomic` uses (write `path.tmp-<pid>-<ts>`, fsync via
 *  `writeFile`, rename over target; cleanup the temp file on terminal
 *  failure so we don't leak `.tmp-*` droppings into the workspace).
 *
 *  Called by `generation.ts` alongside `encodePcmToMp3` so the peaks land
 *  next to the MP3 in one render pass. Failure here is non-fatal — peaks
 *  are a visualization aid, not load-bearing for playback — but we still
 *  reject so the caller can decide whether to log / surface; today
 *  generation.ts awaits the write to keep the on-disk state consistent
 *  with the segments.json + MP3 it just emitted. */
export async function writeChapterPeaksFile(
  pcm: Buffer,
  sampleRate: number,
  peaksPath: string,
): Promise<void> {
  const peaks = computePeaks(pcm, sampleRate);
  const payload: ChapterPeaksFile = { peaks };
  await mkdir(dirname(peaksPath), { recursive: true });
  const tmp = `${peaksPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  try {
    await rename(tmp, peaksPath);
  } catch (err) {
    /* Clean up the temp file on terminal failure (matches writeJsonAtomic
       in workspace/state-io.ts). Swallow unlink errors — the rename
       failure is the real one to surface. */
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
