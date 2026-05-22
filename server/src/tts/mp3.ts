/* PCM → audio encoder. Pipes raw 16-bit signed little-endian mono PCM through
   system `ffmpeg` and collects the encoder's stdout. Used by generation.ts
   after per-sentence PCM has been concatenated into the full chapter buffer
   — encoding once at chapter granularity sidesteps frame-alignment and
   gapless-playback issues that per-segment encoding would create.

   Format dispatch (plan 72): the `format` discriminator selects MP3
   (LAME, default), AAC/M4A (libfdk_aac or native AAC) or Opus (libopus).
   `buildMp3FfmpegArgs` keeps the v1 invocation byte-identical for the
   default path; the AAC/Opus builders are siblings that route through the
   same spawn/stdout-capture plumbing.

   ffmpeg is a hard runtime dep; scripts/start-app.ps1 preflights it. We do
   NOT mock the encoder boundary in tests — the integration suite spawns the
   real subprocess so we catch wire-format / flag-name drift.

   Sibling responsibility (plan 56): `writeChapterPeaksFile` reduces the same
   chapter PCM to a fixed-length (240-bin) RMS-peaks envelope and persists
   it under `<bookDir>/audio/<slug>.peaks.json` using the same temp-then-
   rename atomic-write convention `writeJsonAtomic` uses elsewhere. The
   chapter-audio meta endpoint reads it back; absence is graceful and yields
   `peaks: []` so chapters generated before this plan keep loading. */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { computePeaks } from '../audio/compute-peaks.js';
import {
  buildSecondPassFilterString,
  buildSinglePassFilterString,
  extractTrailingJsonBlock,
  isMeasurementUseable,
  isSecondPassMeasurementUseable,
  parseLoudnormSecondPassJson,
  runLoudnormFirstPass,
  type LoudnormFirstPassStats,
  type LoudnormOptions,
  type LoudnormSidecarJson,
} from './loudnorm.js';

/** Supported output container/codec.
 *  - `'mp3'` — MPEG-2 Layer III via libmp3lame (LAME VBR V2 default).
 *  - `'aac-m4a'` — AAC-LC in an M4A (mp4 audio, raw via ipod muxer) container.
 *    Uses libfdk_aac when ffmpeg was built with it; otherwise the native
 *    `aac` encoder. Target ≈ 128 kbps.
 *  - `'opus'` — Opus in an Ogg container at 96 kbps VBR (`-application audio`).
 */
export type EncodePcmAudioFormat = 'mp3' | 'aac-m4a' | 'opus';

export interface EncodePcmToAudioOptions {
  /** Output format. Defaults to `'mp3'`. The dispatch on this field is the
   *  seam encoder additions extend without changing this function's
   *  signature. See `EncodePcmAudioFormat` for per-format encoder + bitrate
   *  contracts. */
  format?: EncodePcmAudioFormat;
  /** LAME VBR quality (mp3 only): 0 (best, larger) .. 9 (worst, smaller).
   *  Default 2 ≈ V2, the LAME preset-standard. Ignored by AAC/Opus paths
   *  (they use fixed-bitrate targets — see per-format helpers). */
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

/* Cached result of probing `ffmpeg -codecs` for libfdk_aac. Cheaper to
   spawn-and-grep once per process than every encode call. Reset between
   tests via the exported `_resetFfmpegCodecCache` helper if a test needs
   a clean slate. */
let cachedHasLibFdkAac: boolean | null = null;

/** Probe ffmpeg's codec list for libfdk_aac. Cached per-process. Returns
 *  `true` when the encoder is available (free-software ffmpeg builds skip
 *  it for licensing reasons; the Windows static builds we recommend
 *  typically don't have it). Falsy result on probe failure — caller
 *  falls back to the native `aac` encoder. */
export function hasLibFdkAac(): boolean {
  if (cachedHasLibFdkAac !== null) return cachedHasLibFdkAac;
  try {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-codecs'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      cachedHasLibFdkAac = false;
      return cachedHasLibFdkAac;
    }
    /* The `-codecs` output lists each codec with its encoders inside
       parentheses; we look for the literal `libfdk_aac` token to avoid
       matching the plain `aac` encoder name. */
    const out = (result.stdout ?? '') + (result.stderr ?? '');
    cachedHasLibFdkAac = /\blibfdk_aac\b/.test(out);
    return cachedHasLibFdkAac;
  } catch {
    cachedHasLibFdkAac = false;
    return cachedHasLibFdkAac;
  }
}

/** Test-only: drop the cached libfdk_aac probe result. */
export function _resetFfmpegCodecCache(): void {
  cachedHasLibFdkAac = null;
}

interface FfmpegBuildOpts {
  sampleRate: number;
  quality: number;
  /** When set, injects `-af <loudnormFilter>` between input + codec args
   *  so EBU R128 normalisation runs across any codec branch. Plan 71. */
  loudnormFilter?: string | null;
}

/** Loudnorm's `print_format=json` summary is logged at info level — at the
 *  default `error` level the encoder's stderr stays empty and the sidecar
 *  parser has nothing to consume (2026-05-22 fix). When a loudnorm filter
 *  is present we bump to `info` and add `-nostats` to suppress the per-
 *  frame progress noise that would otherwise drown the JSON block. */
function ffmpegLogArgs(opts: FfmpegBuildOpts): string[] {
  if (opts.loudnormFilter) return ['-loglevel', 'info', '-nostats'];
  return ['-loglevel', 'error'];
}

/** Build the ffmpeg arg list for the MP3 (libmp3lame) path. The v1
 *  invocation — preserved byte-identical so existing chapters re-encode
 *  identically — was extracted out of `encodePcmToAudio` when format
 *  dispatch landed. */
function buildMp3FfmpegArgs(opts: FfmpegBuildOpts): string[] {
  return [
    ...ffmpegLogArgs(opts),
    '-f',
    's16le',
    '-ar',
    String(opts.sampleRate),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    ...(opts.loudnormFilter ? ['-af', opts.loudnormFilter] : []),
    /* Pin the output sample rate. The loudnorm filter resamples internally
       to 192 kHz; ffmpeg 8.x stopped resampling back to the input rate at
       the filter output, which left libmp3lame encoding at the wrong rate
       and produced 3.05x duration MP3s on 24 kHz Kokoro PCM. Explicit
       output `-ar` constrains the encoder regardless of filter behaviour. */
    '-ar',
    String(opts.sampleRate),
    '-c:a',
    'libmp3lame',
    '-q:a',
    String(opts.quality),
    '-f',
    'mp3',
    'pipe:1',
  ];
}

/** Build the ffmpeg arg list for the AAC/M4A path. Uses libfdk_aac (VBR
 *  mode 4 ≈ 128 kbps) when available, else falls back to the native AAC
 *  encoder at constant 128 kbps.
 *
 *  M4A output cannot stream to stdout directly — the mp4 / ipod muxers
 *  need a seekable output to write the moov atom in-place. We work around
 *  this by writing a fragmented MP4 stream (`-movflags
 *  +empty_moov+frag_keyframe`) which IS pipe-friendly, then `+faststart`
 *  (folded into the same `-movflags` arg) re-ranges the box order so the
 *  file is streaming-playable. Container is `.m4a` (mp4 audio) via the
 *  `ipod` muxer. */
function buildAacFfmpegArgs(opts: FfmpegBuildOpts): string[] {
  const useFdk = hasLibFdkAac();
  return [
    ...ffmpegLogArgs(opts),
    '-f',
    's16le',
    '-ar',
    String(opts.sampleRate),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    ...(opts.loudnormFilter ? ['-af', opts.loudnormFilter] : []),
    /* See buildMp3FfmpegArgs for the rationale — pin output `-ar` so the
       loudnorm filter's 192 kHz internal stream doesn't reach the encoder
       at the wrong rate under ffmpeg 8.x. */
    '-ar',
    String(opts.sampleRate),
    ...(useFdk ? ['-c:a', 'libfdk_aac', '-vbr', '4'] : ['-c:a', 'aac', '-b:a', '128k']),
    /* Fragmented mp4 so the muxer can stream to stdout: `empty_moov`
       skips the seek-back-and-write-moov dance; `frag_keyframe` starts a
       new fragment at every keyframe (audio-only streams have every
       frame as a keyframe, so this approximates per-frame fragments).
       `+faststart` is a no-op on fragmented MP4 but kept defensively in
       case ffmpeg falls back to a non-fragmented path. */
    '-movflags',
    '+empty_moov+frag_keyframe+faststart',
    '-f',
    'mp4',
    'pipe:1',
  ];
}

/** Build the ffmpeg arg list for the Opus path. Targets 96 kbps VBR with
 *  `-application audio` (libopus's general-music mode — voice-grade is
 *  noticeably tinnier on narration). Container is Ogg/Opus (`.ogg`
 *  extension); raw `.opus` files have spotty player support, Ogg wraps
 *  the same codec with broader compatibility. */
function buildOpusFfmpegArgs(opts: FfmpegBuildOpts): string[] {
  return [
    ...ffmpegLogArgs(opts),
    '-f',
    's16le',
    '-ar',
    String(opts.sampleRate),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    ...(opts.loudnormFilter ? ['-af', opts.loudnormFilter] : []),
    /* See buildMp3FfmpegArgs for the rationale — pin output `-ar`. libopus
       only accepts 8/12/16/24/48 kHz internally and will resample as
       needed; the explicit `-ar` keeps the filter chain from pushing
       192 kHz samples into the encoder unannounced. */
    '-ar',
    String(opts.sampleRate),
    '-c:a',
    'libopus',
    '-b:a',
    '96k',
    '-application',
    'audio',
    '-f',
    'ogg',
    'pipe:1',
  ];
}

export async function encodePcmToAudio(
  pcm: Buffer,
  sampleRate: number,
  opts: EncodePcmToAudioOptions = {},
): Promise<Buffer> {
  const format: EncodePcmAudioFormat = opts.format ?? 'mp3';
  const quality = opts.quality ?? 2;

  /* Optional EBU R128 loudness normalisation (plan 71). When `opts.loudnorm`
     is undefined, behaviour is identical to today (no filter applied). When
     `twoPass: true`, run an analysis pass first then feed the measurements
     into the encode filter; when `twoPass: false`, append a single-pass
     loudnorm filter inline. The composed filter string is threaded into
     all three codec builders via `FfmpegBuildOpts.loudnormFilter`.

     Two-pass post-encode flow (2026-05-22 fix): the second-pass filter
     uses `print_format=json` and emits the post-normalisation `output_i`
     in stderr after the encode. We parse that block below and persist
     the OUTPUT loudness (what the chapter actually sounds like) into the
     sidecar rather than the pre-filter input measurement. Falls back to
     the input measurement if the stderr JSON is missing or malformed —
     the MP3 is already on disk by then, so a sidecar parse failure must
     not fail the encode. */
  let loudnormFilter: string | null = null;
  /* Pre-encode sidecar payload. For two-pass: provisional, gets overridden
     by the parsed output_* stats after the encode succeeds. For single-pass:
     final (nominal target, no post-encode re-measure). */
  let pendingSidecar: LoudnormSidecarJson | null = null;
  let twoPassFirstStats: LoudnormFirstPassStats | null = null;
  if (opts.loudnorm) {
    if (opts.loudnorm.twoPass) {
      const stats = await runLoudnormFirstPass(pcm, sampleRate, opts.loudnorm);
      if (isMeasurementUseable(stats)) {
        loudnormFilter = buildSecondPassFilterString(stats, opts.loudnorm);
        twoPassFirstStats = stats;
        /* Provisional — overridden below with output_* values from the
           second-pass stderr JSON if parsing succeeds. */
        pendingSidecar = {
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
      pendingSidecar = {
        i: opts.loudnorm.target,
        lra: opts.loudnorm.lra,
        tp: opts.loudnorm.tp,
        target: opts.loudnorm.target,
        twoPass: false,
        measuredAt: new Date().toISOString(),
      };
    }
  }

  const builderOpts: FfmpegBuildOpts = { sampleRate, quality, loudnormFilter };

  let args: string[];
  switch (format) {
    case 'mp3':
      args = buildMp3FfmpegArgs(builderOpts);
      break;
    case 'aac-m4a':
      args = buildAacFfmpegArgs(builderOpts);
      break;
    case 'opus':
      args = buildOpusFfmpegArgs(builderOpts);
      break;
    default: {
      const _exhaustive: never = format;
      throw new Error(`encodePcmToAudio: unsupported format ${String(_exhaustive)}`);
    }
  }

  const encodeResult = await new Promise<{ encoded: Buffer; stderr: string }>(
    (resolve, reject) => {
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
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code === 0) {
          resolve({ encoded: Buffer.concat(stdoutChunks), stderr });
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim() || '(no stderr)'}`));
        }
      });

      child.stdin.on('error', (err) => {
        /* EPIPE if ffmpeg dies before we finish writing the PCM. The 'close'
           handler will report the real reason via stderr; swallow here so the
           promise doesn't reject twice. */
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
      });

      child.stdin.end(pcm);
    },
  );

  /* Two-pass post-encode upgrade: parse the second-pass loudnorm JSON from
     stderr and replace the provisional sidecar's input_i value with the
     actual post-normalisation output_i. On any parse failure we log a
     warning and keep the provisional input-based sidecar — the chapter
     plays fine; the UI pill is just less accurate until the next regen. */
  if (pendingSidecar && twoPassFirstStats && opts.loudnorm?.twoPass) {
    const jsonBlock = extractTrailingJsonBlock(encodeResult.stderr);
    if (jsonBlock) {
      try {
        const secondPass = parseLoudnormSecondPassJson(jsonBlock);
        if (isSecondPassMeasurementUseable(secondPass)) {
          pendingSidecar = {
            i: secondPass.output_i,
            lra: secondPass.output_lra,
            tp: secondPass.output_tp,
            target: opts.loudnorm.target,
            twoPass: true,
            measuredAt: pendingSidecar.measuredAt,
          };
        } else {
          // eslint-disable-next-line no-console
          console.warn(
            `[loudnorm] second-pass output stats are not finite (output_i=${secondPass.output_i}); ` +
              `persisting input-side measurement (${twoPassFirstStats.input_i.toFixed(2)} LUFS) ` +
              `as sidecar value.`,
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[loudnorm] failed to parse second-pass stderr JSON (${(e as Error).message}); ` +
            `persisting input-side measurement (${twoPassFirstStats.input_i.toFixed(2)} LUFS) ` +
            `as sidecar value.`,
        );
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[loudnorm] second-pass stderr did not include a JSON block; ` +
          `persisting input-side measurement (${twoPassFirstStats.input_i.toFixed(2)} LUFS) ` +
          `as sidecar value.`,
      );
    }
  }

  /* Loudness-stats callback fires AFTER the encode succeeds — that way a
     failed encode doesn't leave a `.lufs.json` sidecar describing audio
     that never landed on disk. Awaited so caller-supplied write errors
     surface as rejections from this function rather than unhandled. */
  if (pendingSidecar && opts.onLoudnessMeasured) {
    await opts.onLoudnessMeasured(pendingSidecar);
  }

  return encodeResult.encoded;
}

/** Map an `EncodePcmAudioFormat` to the on-disk file extension generation
 *  emits. Centralised so generation.ts + the audio-file locator agree on
 *  the same mapping. */
export function audioExtForFormat(format: EncodePcmAudioFormat): 'mp3' | 'm4a' | 'ogg' {
  switch (format) {
    case 'mp3':
      return 'mp3';
    case 'aac-m4a':
      return 'm4a';
    case 'opus':
      return 'ogg';
  }
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
