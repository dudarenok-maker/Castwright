/* EBU R128 two-pass loudness normalization helpers for the chapter encoder.
   Plan 71. Pairs with `encodePcmToAudio` in `./mp3.ts`.

   ffmpeg's `loudnorm` filter implements EBU R128. Single-pass mode normalises
   on-the-fly using a streaming algorithm; two-pass mode first measures the
   integrated loudness / LRA / true-peak of the source, then feeds those
   measurements back into a second invocation that hits the target more
   accurately (within ±0.5 LU vs ±1.5 LU for single-pass).

   We default to two-pass for chapter audio: the listener hears a whole
   chapter at once, so program-level accuracy matters more than the ~20 %
   encode-time hit. Single-pass is the opt-out (`twoPass: false`).

   First-pass output: `-af loudnorm=...:print_format=json -f null -` writes
   the per-stream stats to stderr as a JSON block following the per-frame
   ffmpeg log. We parse the LAST `{...}` block in stderr (ffmpeg may emit
   warnings before the JSON; the JSON is always the trailing brace-balanced
   structure).

   Second-pass filter string: feeds the first-pass measurements back as
   `measured_*` parameters plus `linear=true` (linear-mode normalisation,
   which preserves the signal envelope when the source is already close
   to the target). Caller composes the second-pass filter via
   `buildSecondPassFilterString` and passes it as `-af` to the encode step. */

import { spawn } from 'node:child_process';

export interface LoudnormOptions {
  /** Target integrated loudness in LUFS. EBU R128 broadcast = -23; audiobook
   *  default = -16 (matches Audible / ACX submission spec). */
  target: number;
  /** Target loudness range (LRA) in LU. 11 is the audiobook common pick. */
  lra: number;
  /** Target true-peak ceiling in dBTP. -1.5 leaves headroom for codec
   *  inter-sample peaks; ACX requires <= -3.0, the audiobook listener
   *  community generally accepts -1.5. */
  tp: number;
  /** When true, run the two-pass measure-then-apply flow. When false, run
   *  single-pass streaming normalisation in one ffmpeg invocation. */
  twoPass: boolean;
}

/** Shape of the JSON block ffmpeg's `loudnorm=print_format=json` writes to
 *  stderr after a first-pass analysis. ffmpeg returns the fields as strings;
 *  we coerce to numbers at parse time so the rest of the code can treat
 *  them as numbers throughout. The `target_offset` field is the delta
 *  ffmpeg recommends folding into the second-pass `offset` parameter. */
export interface LoudnormFirstPassStats {
  /** Measured integrated loudness (LUFS). */
  input_i: number;
  /** Measured loudness range (LU). */
  input_lra: number;
  /** Measured true peak (dBTP). */
  input_tp: number;
  /** Measured loudness threshold (LUFS) — silence gate ffmpeg used. */
  input_thresh: number;
  /** ffmpeg-recommended gain offset (LU) for the second pass. */
  target_offset: number;
}

/** Persistent record of a chapter's measured loudness, written next to the
 *  audio as `<chapterSlug>.lufs.json`. Plan 77 (Wave 2 — LUFS report card UI)
 *  reads this back; field names are stable contract. */
export interface LoudnormSidecarJson {
  /** Measured integrated loudness (LUFS) of the rendered chapter. */
  i: number;
  /** Measured loudness range (LU). */
  lra: number;
  /** Measured true peak (dBTP). */
  tp: number;
  /** Target integrated loudness (LUFS) used for normalisation. */
  target: number;
  /** Whether two-pass measure-then-apply was used. */
  twoPass: boolean;
  /** ISO-8601 timestamp the measurement was taken. */
  measuredAt: string;
}

/** Extract the trailing JSON object from ffmpeg stderr. ffmpeg prints
 *  loudnorm's `print_format=json` block at the end of stderr after any
 *  warnings / per-frame logging — we scan for the LAST balanced `{ ... }`. */
function extractTrailingJsonBlock(stderr: string): string | null {
  let depth = 0;
  let lastEnd = -1;
  let lastStart = -1;
  let currentStart = -1;
  for (let i = 0; i < stderr.length; i += 1) {
    const ch = stderr[i];
    if (ch === '{') {
      if (depth === 0) currentStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && currentStart >= 0) {
        lastStart = currentStart;
        lastEnd = i;
        currentStart = -1;
      }
    }
  }
  if (lastStart < 0 || lastEnd < 0) return null;
  return stderr.slice(lastStart, lastEnd + 1);
}

/** Parse a first-pass loudnorm JSON block (string form) into the stats
 *  shape. Exported so the unit test can drive the parser without spawning
 *  ffmpeg.
 *
 *  Field handling:
 *  - Numeric strings → number.
 *  - "-inf" / "+inf" → -Infinity / Infinity (ffmpeg emits these on dead-
 *    silent input). The caller must guard `Number.isFinite` before feeding
 *    the value into a second-pass filter — `isMeasurementUseable` does this. */
export function parseLoudnormFirstPassJson(jsonBlock: string): LoudnormFirstPassStats {
  const raw = JSON.parse(jsonBlock) as Record<string, unknown>;
  const field = (key: string): number => {
    const v = raw[key];
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '-inf' || trimmed === '-Infinity') return -Infinity;
      if (trimmed === '+inf' || trimmed === 'inf' || trimmed === 'Infinity') return Infinity;
      const n = Number(trimmed);
      if (Number.isFinite(n)) return n;
      throw new Error(`loudnorm: non-numeric "${key}" value "${v}" in first-pass JSON`);
    }
    throw new Error(`loudnorm: missing or non-numeric "${key}" in first-pass JSON`);
  };
  return {
    input_i: field('input_i'),
    input_lra: field('input_lra'),
    input_tp: field('input_tp'),
    input_thresh: field('input_thresh'),
    target_offset: field('target_offset'),
  };
}

/** True iff every field in `stats` is finite — i.e. ffmpeg's analysis pass
 *  returned a usable measurement. Silent / near-silent input produces
 *  `-inf` for `input_i` and `input_tp`; in that case the second-pass
 *  filter would receive bogus `measured_*` values and either fail or
 *  produce garbage. Callers should fall back to a plain encode when this
 *  returns false. */
export function isMeasurementUseable(stats: LoudnormFirstPassStats): boolean {
  return (
    Number.isFinite(stats.input_i) &&
    Number.isFinite(stats.input_lra) &&
    Number.isFinite(stats.input_tp) &&
    Number.isFinite(stats.input_thresh) &&
    Number.isFinite(stats.target_offset)
  );
}

/** Run ffmpeg's loudnorm filter in analysis-only mode and return the
 *  measured stats. `-f null -` discards the decoded output; stderr carries
 *  the JSON we want. */
export async function runLoudnormFirstPass(
  pcm: Buffer,
  sampleRate: number,
  opts: LoudnormOptions,
): Promise<LoudnormFirstPassStats> {
  const filter =
    `loudnorm=I=${opts.target}:LRA=${opts.lra}:TP=${opts.tp}:print_format=json`;
  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    '-f',
    's16le',
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    '-af',
    filter,
    '-f',
    'null',
    '-',
  ];

  return await new Promise<LoudnormFirstPassStats>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];

    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to spawn ffmpeg for loudnorm analysis: ${err.message}. ` +
            `Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).`,
        ),
      );
    });

    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        reject(
          new Error(`ffmpeg loudnorm first pass exited with code ${code}: ${stderr.trim()}`),
        );
        return;
      }
      const jsonBlock = extractTrailingJsonBlock(stderr);
      if (!jsonBlock) {
        reject(
          new Error(
            `loudnorm first pass: ffmpeg did not emit a JSON analysis block. ` +
              `stderr: ${stderr.trim()}`,
          ),
        );
        return;
      }
      try {
        resolve(parseLoudnormFirstPassJson(jsonBlock));
      } catch (e) {
        reject(e as Error);
      }
    });

    child.stdin.on('error', (err) => {
      /* EPIPE if ffmpeg dies before we finish writing — surfaced by the
         'close' handler with the real reason via stderr. */
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
    });

    child.stdin.end(pcm);
  });
}

/** Build the second-pass `-af` filter string that consumes the first-pass
 *  measurements. `linear=true` requests linear-mode normalisation (a single
 *  gain adjustment derived from the measurement) which preserves the source
 *  envelope. `print_format=summary` makes ffmpeg log a one-line summary on
 *  the second pass — useful when debugging but not parsed by the encoder. */
export function buildSecondPassFilterString(
  stats: LoudnormFirstPassStats,
  opts: LoudnormOptions,
): string {
  return (
    `loudnorm=I=${opts.target}:LRA=${opts.lra}:TP=${opts.tp}` +
    `:measured_I=${stats.input_i}` +
    `:measured_LRA=${stats.input_lra}` +
    `:measured_TP=${stats.input_tp}` +
    `:measured_thresh=${stats.input_thresh}` +
    `:offset=${stats.target_offset}` +
    `:linear=true:print_format=summary`
  );
}

/** Single-pass loudnorm filter string (no first-pass measurements). Cheaper
 *  to encode (one ffmpeg invocation total) but less accurate (±1.5 LU vs
 *  ±0.5 LU for two-pass). */
export function buildSinglePassFilterString(opts: LoudnormOptions): string {
  return `loudnorm=I=${opts.target}:LRA=${opts.lra}:TP=${opts.tp}:linear=true`;
}

/** Audiobook-friendly defaults: -16 LUFS / 11 LU range / -1.5 dBTP / two-pass.
 *  Matches the Audible / ACX submission target. Exported so the call site
 *  in generation.ts and the regression tests share one source. */
export const DEFAULT_LOUDNORM_OPTIONS: LoudnormOptions = {
  target: -16,
  lra: 11,
  tp: -1.5,
  twoPass: true,
};
