/* PCM → audio encoder. Pipes raw 16-bit signed little-endian mono PCM through
   system `ffmpeg`. Used by generation.ts after per-sentence PCM has been
   concatenated into the full chapter buffer — encoding once at chapter
   granularity sidesteps frame-alignment and gapless-playback issues that
   per-segment encoding would create.

   Format dispatch (plan 72): the `format` discriminator selects MP3
   (LAME, default), AAC/M4A (libfdk_aac or native AAC) or Opus (libopus).
   The AAC/Opus builders stream to stdout (`pipe:1`); the MP3 builder writes
   to a seekable temp file instead so libmp3lame can seek back and stamp the
   Xing/Info VBR header (plan 109 — a non-seekable pipe drops it and players
   then estimate, and badly inflate, the duration). `encodePcmToAudio` reads
   the temp file back so all three formats return a Buffer to the caller.

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
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computePeaks } from '../audio/compute-peaks.js';
import { ffmpegFailure } from './ffmpeg-failure.js';
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
      windowsHide: true,
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
  /** When set, the MP3 builder writes the encode to this seekable file path
   *  instead of `pipe:1`. Required for libmp3lame to seek back and write the
   *  Xing/Info VBR header — a non-seekable pipe drops it, leaving players to
   *  estimate (and wildly inflate) the duration. Plan 109. AAC/Opus paths
   *  ignore this and keep streaming to stdout (they carry reliable duration
   *  metadata without a seek-back). */
  outputPath?: string;
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

/** Build the ffmpeg arg list for the MP3 (libmp3lame) path. Writes to
 *  `opts.outputPath` (a seekable temp file) rather than `pipe:1` so the Xing
 *  VBR header lands; falls back to `pipe:1` when no path is supplied (e.g.
 *  arg-shape tests). The output `-ar` pin (loudnorm fix, plan 71) and the
 *  `-q:a` VBR quality are unchanged. */
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
    /* Write the Xing/Info VBR header. libmp3lame can only do this when the
       output is seekable (it seeks back to the file start after encoding to
       fill in the final frame count); on a non-seekable `pipe:1` the header
       is silently dropped and players estimate duration from a sampled
       bitrate — ~7x too long on a quiet chapter lead-in. `outputPath` routes
       us to a seekable temp file so the header lands. Plan 109. */
    '-write_xing',
    '1',
    '-f',
    'mp3',
    opts.outputPath ?? 'pipe:1',
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

  /* MP3 must encode to a seekable file so libmp3lame can write the Xing VBR
     header (see buildMp3FfmpegArgs). A unique temp path per call — pid+ts
     alone can collide when concurrent multi-book generation encodes
     simultaneously, so a random suffix guarantees uniqueness. AAC/Opus stay
     on `pipe:1`. Plan 109. */
  const mp3OutPath =
    format === 'mp3'
      ? join(
          tmpdir(),
          `audiobook-encode-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}.${format}`,
        )
      : null;

  const builderOpts: FfmpegBuildOpts = {
    sampleRate,
    quality,
    loudnormFilter,
    ...(mp3OutPath ? { outputPath: mp3OutPath } : {}),
  };

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

  let encodeResult: { encoded: Buffer; stderr: string };
  try {
    encodeResult = await new Promise<{ encoded: Buffer; stderr: string }>((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

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
          reject(ffmpegFailure('ffmpeg', code, stderr));
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
  } catch (err) {
    /* On encode failure (spawn error / non-zero exit) clean up any partial
       temp file ffmpeg may have left behind before rethrowing. Plan 109. */
    if (mp3OutPath) await unlink(mp3OutPath).catch(() => {});
    throw err;
  }

  /* MP3 was written to a seekable temp file (so the Xing header landed);
     read it back into the Buffer this function contracts to return, then
     remove the temp. AAC/Opus stream to stdout as before. Plan 109. */
  let encoded: Buffer;
  if (mp3OutPath) {
    try {
      encoded = await readFile(mp3OutPath);
      fixLameEncoderDelayInPlace(encoded);
    } finally {
      await unlink(mp3OutPath).catch(() => {});
    }
  } else {
    encoded = encodeResult.encoded;
  }

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
            normalizationType:
              secondPass.normalization_type === 'linear'
                ? 'linear'
                : secondPass.normalization_type === 'dynamic'
                  ? 'dynamic'
                  : undefined,
            measuredAt: pendingSidecar.measuredAt,
          };
        } else {
          console.warn(
            `[loudnorm] second-pass output stats are not finite (output_i=${secondPass.output_i}); ` +
              `persisting input-side measurement (${twoPassFirstStats.input_i.toFixed(2)} LUFS) ` +
              `as sidecar value.`,
          );
        }
      } catch (e) {
        console.warn(
          `[loudnorm] failed to parse second-pass stderr JSON (${(e as Error).message}); ` +
            `persisting input-side measurement (${twoPassFirstStats.input_i.toFixed(2)} LUFS) ` +
            `as sidecar value.`,
        );
      }
    } else {
      console.warn(
        `[loudnorm] second-pass stderr did not include a JSON block; ` +
          `persisting input-side measurement (${twoPassFirstStats.input_i.toFixed(2)} LUFS) ` +
          `as sidecar value.`,
      );
    }
  }

  /* Loudness-stats callback fires AFTER the encode succeeds — that way a
     failed encode doesn't leave a `.lufs.json` sidecar describing audio
     that never landed on disk. Awaited to keep ordering deterministic: the
     only caller (finalize-chapter-write.ts) just captures `stats` into a
     local for the real ebur128 re-measurement + single sidecar write that
     happen after this function returns (plan 274 T1) — no write happens
     inside the callback itself — but awaiting still means any future
     callback error would surface as a rejection from this function rather
     than going unhandled. */
  if (pendingSidecar && opts.onLoudnessMeasured) {
    await opts.onLoudnessMeasured(pendingSidecar);
  }

  return encoded;
}

/* LAME always has a 576-sample encoder delay, and a decoder drops that plus its
   own 529-sample delay (1105 in all) when the Xing/Info tag is honest. ffmpeg
   9.1's libmp3lame encoder stamps the tag with 47 (576 - 529) instead, but only
   on MPEG-2 / MPEG-2.5 streams (<= 24 kHz; 44.1 / 48 kHz keep the right 576),
   so every decoder, 8.x included, trims 529 samples too few and the whole
   chapter reads ~22 ms late (#4573). Segment windows then catch the
   neighbouring take's audio and a dead segment no longer scans as silent.

   Two defences, both keyed on the tag's content and never on the ffmpeg
   version, so a build that fixes the tag falls through to a no-op:
   - `fixLameEncoderDelay` rewrites the delay (and the tag CRC) after every
     encode and remux we do, so each file we write is right for every player;
   - `mp3StartPadShortfall` reads a file that already carries the wrong delay
     (rendered before the fix) so the decode helpers can drop the missing
     lead-in. */
const LAME_ENCODER_DELAY = 576;

/* Sample rates by MPEG version bits (3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5). */
const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/* Layer III bitrates in kbit/s by frame-header index: MPEG-1, then MPEG-2 / 2.5. */
const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/* Bytes past an ID3v2 block that always hold the Xing/Info frame (<= ~200). */
const MP3_TAG_FRAME_SLACK = 512;

/* Offset just past a leading ID3v2 block (syncsafe size + header + footer), or 0. */
function id3v2End(b: Buffer): number {
  if (b.length < 10 || b.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  return 10 + size + (b[5] & 0x10 ? 10 : 0);
}

/* How many leading bytes hold the whole Xing/LAME tag frame, given the first 10. */
function mp3HeadLength(first: Buffer): number {
  return id3v2End(first) + MP3_TAG_FRAME_SLACK;
}

interface LameTag {
  /* Offset of the tag frame's header. */
  frameStart: number;
  /* Length in bytes of the tag frame. */
  frameLen: number;
  /* Offset of the LAME/Lavc/Lavf encoder string. */
  enc: number;
  /* Encoder delay as stamped, in samples at `streamRate`. */
  delay: number;
  /* The MP3 stream's own sample rate (not the decode's output rate). */
  streamRate: number;
}

/* The tag of a file whose encoder delay is short of LAME's 576; null for a
   correct tag, a tag-less file or a non-MP3 input. */
function parseWrongLameTag(head: Buffer): LameTag | null {
  const frameStart = id3v2End(head);
  if (frameStart + 4 > head.length) return null;
  const b1 = head[frameStart + 1];
  // frame sync, layer III
  if (head[frameStart] !== 0xff || (b1 & 0xe0) !== 0xe0 || ((b1 >> 1) & 3) !== 1) return null;
  const version = (b1 >> 3) & 3;
  const rates = MPEG_SAMPLE_RATES[version];
  const rateIdx = (head[frameStart + 2] >> 2) & 3;
  if (!rates || rateIdx === 3) return null;
  const bitrateIdx = head[frameStart + 2] >> 4;
  if (bitrateIdx === 0 || bitrateIdx === 15) return null;
  const mono = ((head[frameStart + 3] >> 6) & 3) === 3;
  const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const crcBytes = b1 & 1 ? 0 : 2;
  const tag = frameStart + 4 + crcBytes + sideInfo;
  if (tag + 8 > head.length) return null;
  const kind = head.toString('latin1', tag, tag + 4);
  if (kind !== 'Xing' && kind !== 'Info') return null;
  const flags = head.readUInt32BE(tag + 4);
  // frames, bytes, TOC (100), quality - each present only when its flag is set.
  let enc = tag + 8;
  if (flags & 1) enc += 4;
  if (flags & 2) enc += 4;
  if (flags & 4) enc += 100;
  if (flags & 8) enc += 4;
  if (enc + 0x18 > head.length) return null;
  const id = head.toString('latin1', enc, enc + 4);
  if (id !== 'LAME' && id !== 'Lavc' && id !== 'Lavf') return null;
  const delay = (head[enc + 0x15] << 4) | (head[enc + 0x16] >> 4);
  // delay 0 is a non-LAME ffmpeg encoder (libshine, mp3_mf); 576 is honest.
  if (!(delay > 0 && delay < LAME_ENCODER_DELAY)) return null;
  const streamRate = rates[rateIdx];
  const kbps = (version === 3 ? MPEG1_L3_BITRATES : MPEG2_L3_BITRATES)[bitrateIdx];
  const frameLen =
    Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / streamRate) + ((head[frameStart + 2] >> 1) & 1);
  return { frameStart, frameLen, enc, delay, streamRate };
}

/** How many leading samples, at the MP3's own rate, a decode leaves over because
    the tag's delay is short; 0 when the tag is right or absent. */
export function mp3StartPadShortfall(head: Buffer): number {
  const tag = parseWrongLameTag(head);
  return tag ? LAME_ENCODER_DELAY - tag.delay : 0;
}

/* The tag's CRC: CRC-16 (poly 0x8005 reflected, init 0) over the first 190
   bytes of the tag frame, with the CRC field itself (34 bytes after the
   encoder string) and anything past the end of a shorter frame read as zero.
   Matches what both LAME and ffmpeg's muxer write. */
const LAME_TAG_CRC_SPAN = 190;
function lameTagCrc(b: Buffer, tag: LameTag): number {
  const crcAt = tag.enc + 34;
  const end = tag.frameStart + Math.min(LAME_TAG_CRC_SPAN, tag.frameLen);
  let crc = 0;
  for (let i = tag.frameStart; i < tag.frameStart + LAME_TAG_CRC_SPAN; i++) {
    crc ^= i >= end || i === crcAt || i === crcAt + 1 ? 0 : b[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

/** Return a copy of `head` (an MP3's ID3v2 block plus its Xing frame) with the
    wrong LAME encoder delay set to 576 and the tag CRC recomputed, or null when
    the tag needs no fix (#4573). */
export function fixLameEncoderDelay(head: Buffer): Buffer | null {
  const tag = parseWrongLameTag(head);
  if (!tag) return null;
  const crcAt = tag.enc + 34;
  if (tag.frameStart + LAME_TAG_CRC_SPAN > head.length) return null;
  const fixed = Buffer.from(head);
  fixed[tag.enc + 0x15] = LAME_ENCODER_DELAY >> 4;
  fixed[tag.enc + 0x16] = ((LAME_ENCODER_DELAY & 0xf) << 4) | (head[tag.enc + 0x16] & 0xf);
  fixed.writeUInt16BE(lameTagCrc(fixed, tag), crcAt);
  return fixed;
}

/* Fix a whole encoded MP3 in place (see `fixLameEncoderDelay`). */
function fixLameEncoderDelayInPlace(mp3: Buffer): void {
  const fixed = fixLameEncoderDelay(mp3.subarray(0, mp3HeadLength(mp3)));
  if (fixed) fixed.copy(mp3, 0);
}

/* Read the ID3v2 block and the Xing frame behind it from the front of a file. */
async function readMp3Head(path: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const first = Buffer.alloc(10);
    const { bytesRead } = await fh.read(first, 0, 10, 0);
    const buf = Buffer.alloc(mp3HeadLength(first.subarray(0, bytesRead)));
    const read = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, read.bytesRead);
  } finally {
    await fh.close();
  }
}

/** Fix an MP3 file on disk in place (see `fixLameEncoderDelay`). Only the head
    is read and rewritten, and a file that needs no fix is not touched. For
    files another tool wrote, e.g. the `-c:a copy` remux in `id3-tags.ts`. */
export async function fixLameEncoderDelayInFile(path: string): Promise<void> {
  const fixed = fixLameEncoderDelay(await readMp3Head(path));
  if (!fixed) return;
  const fh = await open(path, 'r+');
  try {
    await fh.write(fixed, 0, fixed.length, 0);
  } finally {
    await fh.close();
  }
}

/* Drop the leftover lead-in `mp3StartPadShortfall` reports from mono s16le PCM
   that ffmpeg already resampled to `outRate`; the shortfall is in the MP3's own
   samples, so it is scaled to the output rate first. */
function trimStartPad(pcm: Buffer, head: Buffer, outRate: number): Buffer {
  const tag = parseWrongLameTag(head);
  if (!tag) return pcm;
  const samples = Math.round(((LAME_ENCODER_DELAY - tag.delay) * outRate) / tag.streamRate);
  return pcm.subarray(Math.min(pcm.length, samples * 2));
}

/** Decode an encoded audio buffer (mp3 / m4a / ogg) back to raw 16-bit signed
    LE mono PCM at `sampleRate`. The inverse of `encodePcmToAudio`, used by the
    fs-26 splice engine to recover a rendered chapter's samples for byte-range
    surgery.

    `-ar <sampleRate>` FORCES the output onto the requested grid: the splice
    engine maps `segments.json` timestamps to byte offsets assuming PCM at the
    segments file's `sampleRate`, so decoding to that exact rate keeps sec↔byte
    round-trips drift-free. MP3 is lossy and carries a little encoder
    delay/padding — the `-write_xing` header we emit on encode lets ffmpeg's
    decoder strip most of it, so the decode lands ~sample-aligned to the
    original synthesis PCM.

    Mirrors `encodePcmToAudio`'s subprocess handling (friendly spawn-failure
    hint, EPIPE-safe stdin, reject on non-zero exit). We feed the whole encoded
    file on stdin; mp3/ogg and fragmented-mp4 (our AAC output) all probe fine
    from a pipe for decode. */
export async function decodeAudioToPcm(input: Buffer, sampleRate: number): Promise<Buffer> {
  const args = [
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
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
      if (code === 0) {
        const head = input.subarray(0, mp3HeadLength(input));
        resolve(trimStartPad(Buffer.concat(stdoutChunks), head, sampleRate));
      } else reject(ffmpegFailure('ffmpeg (decode)', code, stderr));
    });
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
    });
    child.stdin.end(input);
  });
}

/** Decode an encoded audio FILE to raw s16le mono PCM at `sampleRate`.

    Deliberately separate from `decodeAudioToPcm`, which feeds `pipe:0`. On a
    NON-SEEKABLE input ffmpeg does not apply the LAME tag's end-padding trim,
    so a pipe decode returns ~495 samples more than the source PCM. A seekable
    file input round-trips to the exact input length. The golden-assembly tier
    (ops-36) pins the decoded byte count, so it needs the file form.

    Same subprocess handling as its pipe sibling: friendly spawn-failure hint,
    reject on non-zero exit. */
export async function decodeAudioFileToPcm(
  inputPath: string,
  sampleRate: number,
): Promise<Buffer> {
  const args = [
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    'pipe:1',
  ];
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to spawn ffmpeg (decode file): ${err.message}. ` +
            `Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).`,
        ),
      );
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) return reject(ffmpegFailure('ffmpeg (decode file)', code, `${inputPath}\n${stderr}`));
      readMp3Head(inputPath).then(
        (head) => resolve(trimStartPad(Buffer.concat(stdoutChunks), head, sampleRate)),
        reject,
      );
    });
  });
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
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
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
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, peaksPath);
  } catch (err) {
    /* Clean up the temp file on terminal failure (matches writeJsonAtomic
       in workspace/state-io.ts). Swallow unlink errors — the write or
       rename failure is the real one to surface. */
    await unlink(tmp).catch(() => {});
    throw err;
  }
}
