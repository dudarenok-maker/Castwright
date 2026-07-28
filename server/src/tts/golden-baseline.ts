/* Comparison math for the golden-assembly output baseline (ops-36).

   Pure: no ffmpeg, no I/O, no clock. That is deliberate — this module is
   unit-tested in the ordinary `test:server` tier (`golden-baseline.test.ts`,
   NOT `*.golden.test.ts`), so the opt-in golden tier's statistics are proven
   on every push rather than only when someone remembers to run the tier.

   Tolerances are DERIVED from a measured perturbation curve, not picked —
   see the spec's finding 6. Do not adjust them without re-deriving. */

import { createHash } from 'node:crypto';

/** Shape of `server/src/tts/__fixtures__/golden-chapter.baseline.json`. */
export interface AssemblyBaseline {
  recordedAt: string;
  /** Full first line of `ffmpeg -version`. Exact equality selects TIGHT mode. */
  ffmpegBanner: string;
  /** Parsed MAJOR.MINOR, for the failure message only. */
  ffmpegVersion: string | null;
  /** Encode parameters the baseline was taken under. PROVENANCE ONLY — no
   *  layer asserts it, because `finalizeChapterAudioWrite` hardcodes `-q:a`
   *  internally and the test cannot observe it. What actually guards a changed
   *  encode parameter is L4-tight's md5, which a `-q:a` change moves. This
   *  block exists so a human reading a failure knows what the baseline was
   *  recorded under; do not mistake it for an assertion. */
  encode: { format: string; quality: number; sampleRate: number; writeXing: boolean };
  /** Loudnorm knobs, so a failure separates "ffmpeg changed" from "someone
   *  moved audio.loudnorm.targetLufs". */
  loudnorm: { target: number; lra: number; tp: number };
  firstPass: { input_i: number; input_lra: number; input_tp: number; input_thresh: number };
  sidecar: { i: number; lra: number; normalizationType: 'linear' | 'dynamic' };
  decoded: { bytes: number; quietWindowsSkipped: number };
  envelope100ms: number[];
  mp3Md5: string;
}

/** Derived tolerances. See the spec's finding 6 for the curve each came from. */
export const TOL = {
  /** L1 — first-pass loudnorm stats, LU/dB. Measurement is bit-stable on one
   *  build; this band covers formatting, not drift. */
  firstPassLu: 0.1,
  /** L2 — persisted sidecar loudness, LU. */
  sidecarLu: 0.3,
  /** L3 — per-window relative RMS delta. Noise floor under the skip rule is
   *  1.6–2.0 %; fires at ~0.6 LU of drift. Separation ~5-6x. */
  envelopeRel: 0.1,
  /** L3 — windows quieter than this on EITHER side are skipped. At -67 dBFS a
   *  10 % relative band is a fraction of one int16 quantisation step. */
  quietFloorDbfs: -50,
  /** L3 — absolute ceiling for a window the BASELINE recorded as quiet.
   *
   *  The skip rule is asymmetric on its own: loud->silenced grows the skipped
   *  count and is caught, but quiet->LOUD is skipped (baseline side is below
   *  the floor), leaves the count unchanged, and passes. A hum, a click, or a
   *  -20 dBFS beep injected into the trailing silence would sail through all
   *  four layers on the LOOSE path. This ceiling closes that direction: 15 dB
   *  above codec silence-reconstruction noise (so cross-build noise cannot
   *  false-red it), 25 dB below speech (so anything audible trips it). */
  quietCeilingDbfs: -45,
  /** L4-loose — relative RMS-error. Geometric mean of a 2.35x-wide separation
   *  (noise floor 10.55 %, target signal 24.79 %): sqrt(.1055 * .2479) = .1617.
   *  This is the WEAKEST layer — see the spec's §1. */
  rmseLoose: 0.16,
  /** L3 — envelope window width. */
  windowMs: 100,
} as const;

export interface EnvelopeVerdict {
  /** The RELATIVE check only. `loudInQuietIndex` is asserted separately. */
  ok: boolean;
  /** Index of the worst non-skipped window, or -1 when every window skipped. */
  worstIndex: number;
  /** Relative delta at that window (0.15 == 15 %). */
  worstRelDelta: number;
  /** Start time of that window, for a human-readable failure message. */
  worstAtSec: number;
  /** How many windows the -50 dBFS floor excluded. Asserted by the caller. */
  skipped: number;
  /** Index of a window the baseline recorded as quiet but this run made
   *  audible (>= `TOL.quietCeilingDbfs`), or -1. Catches an artifact injected
   *  into silence, which the relative check skips by construction. */
  loudInQuietIndex: number;
  /** dBFS of that window in this run. -Infinity when there is none. */
  loudInQuietDbfs: number;
}

/** dBFS of a normalised RMS value. -Infinity for digital silence. */
export function dbfs(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** Copy `buf` into a fresh ArrayBuffer and view it as little-endian int16.
 *
 *  The copy is NOT wasteful defensiveness: `readFileSync` returns pooled
 *  Buffers whose `byteOffset` is frequently odd, and `new Int16Array(ab,
 *  oddOffset, n)` throws "start offset of Int16Array should be a multiple
 *  of 2". Node is little-endian on every platform we ship to, so the raw
 *  reinterpret is correct. */
export function toInt16(buf: Buffer): Int16Array {
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Int16Array(copy.buffer, 0, Math.floor(buf.length / 2));
}

/** Normalised RMS (0..1) of an int16 sample array. */
export function pcmRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** Per-window normalised RMS. Full windows only — a trailing partial window is
 *  dropped, identically on both sides of a comparison. */
export function rmsEnvelope(
  samples: Int16Array,
  sampleRate: number,
  windowMs: number = TOL.windowMs,
): number[] {
  const w = Math.round((sampleRate * windowMs) / 1000);
  const out: number[] = [];
  for (let i = 0; i + w <= samples.length; i += w) {
    out.push(pcmRms(samples.subarray(i, i + w)));
  }
  return out;
}

/** Relative RMS-error between two sample arrays: the RMS of their difference
 *  over the RMS of `a`. Returns a ratio (0.0808 == 8.08 %).
 *
 *  Truncates to the shorter input so unequal lengths cannot produce NaN. The
 *  caller asserts the length delta separately — truncation is about keeping
 *  the math defined, NOT about tolerating a length change. */
export function rmsError(a: Int16Array, b: Int16Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let err = 0;
  let sig = 0;
  for (let i = 0; i < n; i += 1) {
    const d = a[i] - b[i];
    err += d * d;
    sig += a[i] * a[i];
  }
  if (sig === 0) return err === 0 ? 0 : Infinity;
  return Math.sqrt(err / n) / Math.sqrt(sig / n);
}

/** Compare two RMS envelopes window-by-window.
 *
 *  A window is skipped for the RELATIVE check when either side falls below
 *  `TOL.quietFloorDbfs` — a 10 % band at -67 dBFS is a fraction of one
 *  quantisation step, so a relative comparison there is noise.
 *
 *  That skip is asymmetric, and the asymmetry is the point of the second
 *  check. loud -> silenced grows `skipped` and the caller catches it. But
 *  quiet -> LOUD keeps the count unchanged and is skipped by the relative
 *  check, so an artifact injected into silence would pass. Windows the
 *  BASELINE recorded as quiet therefore also get an absolute ceiling. */
export function compareEnvelope(
  baseline: number[],
  actual: number[],
  windowMs: number = TOL.windowMs,
): EnvelopeVerdict {
  const floor = 10 ** (TOL.quietFloorDbfs / 20);
  const ceiling = 10 ** (TOL.quietCeilingDbfs / 20);
  const n = Math.min(baseline.length, actual.length);
  let worstIndex = -1;
  let worstRelDelta = 0;
  let skipped = 0;
  let loudInQuietIndex = -1;
  let loudInQuietRms = 0;
  for (let i = 0; i < n; i += 1) {
    if (baseline[i] < floor || actual[i] < floor) {
      skipped += 1;
      if (baseline[i] < floor && actual[i] >= ceiling && actual[i] > loudInQuietRms) {
        loudInQuietRms = actual[i];
        loudInQuietIndex = i;
      }
      continue;
    }
    const rel = Math.abs(actual[i] - baseline[i]) / baseline[i];
    if (rel > worstRelDelta) {
      worstRelDelta = rel;
      worstIndex = i;
    }
  }
  return {
    ok: worstRelDelta <= TOL.envelopeRel,
    worstIndex,
    worstRelDelta,
    worstAtSec: worstIndex < 0 ? 0 : (worstIndex * windowMs) / 1000,
    skipped,
    loudInQuietIndex,
    loudInQuietDbfs: loudInQuietIndex < 0 ? -Infinity : dbfs(loudInQuietRms),
  };
}

/** Hex md5 of a buffer. Used for the TIGHT-path MP3 comparison, which is exact
 *  because the encode is byte-identical across runs on one ffmpeg build. */
export function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

/** TIGHT only when the running ffmpeg banner is byte-identical to the one the
 *  baseline was recorded under.
 *
 *  Deliberately exact-string, not MAJOR.MINOR: two 8.1 builds can ship
 *  different LAME, so a version match does not promise identical output. Lives
 *  here rather than in the golden test file so the branch is unit-testable —
 *  on any single box one of the two arms never executes, and an untested arm
 *  that only runs on someone else's machine is the worst kind. */
export function selectMode(
  runBanner: string | null,
  baselineBanner: string | null,
): 'TIGHT' | 'LOOSE' {
  if (!runBanner || !baselineBanner) return 'LOOSE';
  return runBanner === baselineBanner ? 'TIGHT' : 'LOOSE';
}
