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
import {
  buildSecondPassFilterString,
  buildSinglePassFilterString,
  isMeasurementUseable,
  runLoudnormFirstPass,
  type LoudnormOptions,
  type LoudnormSidecarJson,
} from './loudnorm.js';

/** Supported output container/codec. Single-value union today; future PRs
 *  will widen to e.g. `'mp3' | 'm4a' | 'opus'` and dispatch on this field. */
export type EncodePcmAudioFormat = 'mp3';

export interface EncodePcmToAudioOptions {
  /** Output format. Defaults to `'mp3'`. Single-value union for now —
   *  the dispatch on this field is the seam future encoder additions
   *  (AAC/M4A, Opus) extend without changing this function's signature. */
  format?: EncodePcmAudioFormat;
  /** LAME VBR quality: 0 (best, larger) .. 9 (worst, smaller). Default 2
      ≈ V2, the LAME preset-standard. */
  quality?: number;
  /** When set, run EBU R128 loudness normalisation via ffmpeg's `loudnorm`
   *  filter as part of the encode. Undefined = no filter applied (legacy
   *  behaviour, preserved for callers like voice samples that don't need
   *  program-level normalisation). See `./loudnorm.ts` for the two-pass
   *  flow and `LoudnormOptions` defaults. Plan 71. */
  loudnorm?: LoudnormOptions;
  /** Invoked after a `loudnorm` pass with the measured loudness stats so
   *  the caller can persist them next to the audio (e.g. as
   *  `<slug>.lufs.json`). Only called when `loudnorm` is set; the callback
   *  fires with `twoPass: true` measurements when two-pass is on, and with
   *  the target as the measurement when single-pass is on (we don't re-
   *  measure single-pass output to save the extra ffmpeg invocation). */
  onLoudnessMeasured?: (stats: LoudnormSidecarJson) => Promise<void> | void;
}

export async function encodePcmToAudio(
  pcm: Buffer,
  sampleRate: number,
  opts: EncodePcmToAudioOptions = {},
): Promise<Buffer> {
  /* Read but don't yet branch on `format` — we accept the discriminator and
     default it to 'mp3' so callers can already pass it explicitly, but the
     ffmpeg invocation below is the existing MP3 path verbatim. Future PRs
     (AAC/M4A, Opus) dispatch from here. */
  const format: EncodePcmAudioFormat = opts.format ?? 'mp3';
  void format;
  const quality = opts.quality ?? 2;

  /* Optional EBU R128 loudness normalisation (plan 71). When `opts.loudnorm`
     is undefined, behaviour is identical to today (no filter applied). When
     `twoPass: true`, run an analysis pass first then feed the measurements
     into the encode filter; when `twoPass: false`, append a single-pass
     loudnorm filter inline. */
  let loudnormFilter: string | null = null;
  let measuredStats: LoudnormSidecarJson | null = null;
  if (opts.loudnorm) {
    if (opts.loudnorm.twoPass) {
      const stats = await runLoudnormFirstPass(pcm, sampleRate, opts.loudnorm);
      if (isMeasurementUseable(stats)) {
        loudnormFilter = buildSecondPassFilterString(stats, opts.loudnorm);
        measuredStats = {
          i: stats.input_i,
          lra: stats.input_lra,
          tp: stats.input_tp,
          target: opts.loudnorm.target,
          twoPass: true,
          measuredAt: new Date().toISOString(),
        };
      }
      /* Else: silent / unusable measurement (ffmpeg emits "-inf" for dead-
         silent input). Fall through to a plain encode without the loudnorm
         filter and skip the sidecar callback — there's nothing meaningful
         to normalise. Keeps test PCM (Buffer.alloc(N)) + real silent-gap
         chapters from hard-failing the encode. */
    } else {
      loudnormFilter = buildSinglePassFilterString(opts.loudnorm);
      /* Single-pass: ffmpeg normalises on the fly without an analysis step.
         Report the target as the (assumed-achieved) measurement so the
         sidecar JSON shape is consistent across modes; record `twoPass:
         false` so consumers know the i/lra/tp are nominal not measured. */
      measuredStats = {
        i: opts.loudnorm.target,
        lra: opts.loudnorm.lra,
        tp: opts.loudnorm.tp,
        target: opts.loudnorm.target,
        twoPass: false,
        measuredAt: new Date().toISOString(),
      };
    }
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
    ...(loudnormFilter ? ['-af', loudnormFilter] : []),
    '-c:a',
    'libmp3lame',
    '-q:a',
    String(quality),
    '-f',
    'mp3',
    'pipe:1',
  ];

  const encoded = await new Promise<Buffer>((resolve, reject) => {
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

  /* Loudness-stats callback fires AFTER the encode succeeds — that way a
     failed encode doesn't leave a `.lufs.json` sidecar describing audio
     that never landed on disk. Awaited so caller-supplied write errors
     surface as rejections from this function rather than unhandled. */
  if (measuredStats && opts.onLoudnessMeasured) {
    await opts.onLoudnessMeasured(measuredStats);
  }

  return encoded;
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

/** Persist a `LoudnormSidecarJson` payload at `lufsPath` using the same
 *  atomic temp-then-rename pattern `writeChapterPeaksFile` uses. The path
 *  is a sibling of the chapter MP3 — typically `<bookDir>/audio/<slug>.lufs.json`.
 *  Failure to write here is non-fatal to playback (Wave 2 plan 77's report-card
 *  UI degrades gracefully on missing sidecar) but the caller should still
 *  log + surface so the operator notices. Plan 71. */
export async function writeChapterLufsFile(
  payload: LoudnormSidecarJson,
  lufsPath: string,
): Promise<void> {
  await mkdir(dirname(lufsPath), { recursive: true });
  const tmp = `${lufsPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  try {
    await rename(tmp, lufsPath);
  } catch (err) {
    /* Match writeChapterPeaksFile / writeJsonAtomic: clean up the temp
       on terminal failure so we don't leak `.tmp-*` droppings. */
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Reduce `pcm` to a 240-bin RMS envelope and persist it as JSON at
 *  `peaksPath` using the same atomic temp-then-rename pattern
 *  `writeJsonAtomic` uses (write `path.tmp-<pid>-<ts>`, fsync via
 *  `writeFile`, rename over target; cleanup the temp file on terminal
 *  failure so we don't leak `.tmp-*` droppings into the workspace).
 *
 *  Called by `generation.ts` alongside `encodePcmToAudio` so the peaks land
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
