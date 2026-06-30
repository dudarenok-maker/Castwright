/* Per-sentence pre-assembly QA. The chapter-level gate (`audio-qa.ts`, srv-27)
   only sees whole-chapter loudness + total duration, so a single dropped /
   silent / runaway SENTENCE inside a long chapter sails through. This module
   evaluates one sentence's raw int16 mono PCM — the same buffer that sits in
   `synthesise-chapter.ts`'s `results[]` array BEFORE the concat — against three
   cheap signal-based checks so the gate can re-record just the bad sentences
   before assembly:

     - dead / near-silent: mean RMS far below an audible floor (the engine
       returned (near-)silence),
     - internal silence run: the longest contiguous run of near-zero samples
       exceeds a cap (a mid-sentence dropout / gap),
     - duration drift: the rendered length is far shorter (truncated) or far
       longer (runaway / garbled) than the sentence text predicts.

   Detection is intentionally signal-only (no ASR) — see the per-sentence ASR
   content-verification backlog item for catching "fluent but wrong words"
   defects that pass these checks.

   Purity: NO file I/O, NO ffmpeg, NO timers, NO randomness. Mirrors the
   env-override pattern of `audio-qa.ts`. */

import { pcmDurationSec } from './pcm.js';
import { configValue } from '../config/resolver.js';

const BYTES_PER_SAMPLE = 2;
const INT16_FULL_SCALE = 32768;

/* Same heuristic the chapter-level duration check uses (generation.ts):
   ~150 wpm at ~5.5 chars/word incl. spaces. Coarse on purpose — it only has to
   separate a runaway / truncated render from a plausible one. */
const QA_CHARS_PER_SEC = 14;

export type SegmentQaStatus = 'ok' | 'suspect';

export interface SegmentQaVerdict {
  status: SegmentQaStatus;
  reasons: string[];
  /** Mean normalised RMS over the whole segment, in [0, 1]. */
  rms: number;
  /** Longest contiguous near-silent run, in seconds. */
  longestSilenceSec: number;
  durationSec: number;
  /** Expected duration from the sentence text, or null when there is no text. */
  expectedSec: number | null;
}

export interface SegmentQaThresholds {
  /** Mean RMS at/below this is "dead / near-silent". */
  silenceRms: number;
  /** A sample whose |value| (normalised) is below this counts as silent for the
      internal-silence-run scan. */
  noiseFloor: number;
  /** Longest internal near-silent run above this (seconds) is "suspect". */
  maxInternalSilenceSec: number;
  /** durationSec / expectedSec below this is "truncated". */
  minDurationRatio: number;
  /** durationSec / expectedSec above this is "runaway". */
  maxDurationRatio: number;
  /** A "runaway" is only flagged when the rendered audio is also at least this
      many seconds long, in ABSOLUTE terms. A ratio over a sub-second expectedSec
      (a one-word line) is meaningless; every real runaway is ≫ this floor. */
  minRunawaySec: number;
}

export const DEFAULT_SEGMENT_QA_THRESHOLDS: SegmentQaThresholds = {
  silenceRms: 0.003,
  noiseFloor: 0.01,
  maxInternalSilenceSec: 1.5,
  minDurationRatio: 0.4,
  maxDurationRatio: 2.5,
  minRunawaySec: 3.0,
};

/* Resolve thresholds: explicit arg wins, else registry (env var / app override /
   default) on top of the shipped defaults. Read lazily per call so a live
   override takes effect on the next synthesised sentence. */
function resolveThresholds(override?: SegmentQaThresholds): SegmentQaThresholds {
  if (override) return override;
  return {
    silenceRms: configValue<number>('qa.seg.silenceRms'),
    noiseFloor: configValue<number>('qa.seg.noiseFloor'),
    maxInternalSilenceSec: configValue<number>('qa.seg.maxInternalSilenceSec'),
    minDurationRatio: configValue<number>('qa.seg.minRatio'),
    maxDurationRatio: configValue<number>('qa.seg.maxRatio'),
    minRunawaySec: configValue<number>('qa.seg.minRunawaySec'),
  };
}

/* Single pass over the buffer: accumulate the sum of squares (for mean RMS) and
   track the longest contiguous run of near-silent samples. Normalising each
   sample to [-1, 1] before squaring keeps the running sum bounded on long
   sentences (same reasoning as compute-peaks.ts). */
function scanPcm(
  pcm: Buffer,
  sampleRate: number,
  noiseFloor: number,
): { rms: number; longestSilenceSec: number } {
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (sampleCount === 0) return { rms: 0, longestSilenceSec: 0 };

  let sumOfSquares = 0;
  let curSilent = 0;
  let longestSilent = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const normalized = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / INT16_FULL_SCALE;
    sumOfSquares += normalized * normalized;
    if (Math.abs(normalized) < noiseFloor) {
      curSilent += 1;
      if (curSilent > longestSilent) longestSilent = curSilent;
    } else {
      curSilent = 0;
    }
  }
  return {
    rms: Math.sqrt(sumOfSquares / sampleCount),
    longestSilenceSec: longestSilent / sampleRate,
  };
}

/** Evaluate one sentence's PCM against the signal-based QA checks and return an
    advisory verdict. `text` is the sentence text (drives the expected-duration
    estimate); pass empty/whitespace to skip the duration check. */
export function evaluateSegmentPcm(
  pcm: Buffer,
  sampleRate: number,
  text: string,
  thresholds?: SegmentQaThresholds,
): SegmentQaVerdict {
  const t = resolveThresholds(thresholds);
  const reasons: string[] = [];

  const durationSec = pcmDurationSec(pcm.length, sampleRate);
  const { rms, longestSilenceSec } = scanPcm(pcm, sampleRate, t.noiseFloor);

  if (rms <= t.silenceRms) {
    reasons.push(`Near-silent — mean RMS ${rms.toFixed(4)} is at/below the ${t.silenceRms} floor.`);
  }

  if (longestSilenceSec > t.maxInternalSilenceSec) {
    reasons.push(
      `Silence gap — ${longestSilenceSec.toFixed(2)}s of continuous near-silence exceeds the ${
        t.maxInternalSilenceSec
      }s cap (possible mid-sentence dropout).`,
    );
  }

  const trimmedChars = text.trim().length;
  const expectedSec = trimmedChars > 0 ? trimmedChars / QA_CHARS_PER_SEC : null;
  if (expectedSec != null && expectedSec > 0) {
    const ratio = durationSec / expectedSec;
    if (ratio < t.minDurationRatio) {
      reasons.push(
        `Suspiciously short — ${durationSec.toFixed(1)}s rendered vs ~${expectedSec.toFixed(
          1,
        )}s expected (possible truncation).`,
      );
    } else if (ratio > t.maxDurationRatio && durationSec >= t.minRunawaySec) {
      reasons.push(
        `Suspiciously long — ${durationSec.toFixed(1)}s rendered vs ~${expectedSec.toFixed(
          1,
        )}s expected (possible runaway synthesis).`,
      );
    }
  }

  return {
    status: reasons.length > 0 ? 'suspect' : 'ok',
    reasons,
    rms,
    longestSilenceSec,
    durationSec,
    expectedSec,
  };
}
