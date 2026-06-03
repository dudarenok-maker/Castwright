/* srv-27 — post-synthesis audio QA gate (ADVISORY). After a chapter renders we
   sanity-check the result against three cheap signals and stamp a verdict:

     - near-silent: integrated loudness far below the audiobook target (a dead /
       barely-audible render — the TTS engine produced near-silence),
     - clipped: true peak at/above the clip ceiling (the render is hard-clipping,
       which sounds harsh),
     - duration drift: the rendered length is far shorter (truncated) or far
       longer (runaway / stuck) than the text predicts.

   The verdict is ADVISORY: the chapter STILL flips to `done`. A "suspect" badge
   surfaces the reason in the Generate + Listen views so the user can decide
   whether to regenerate. No done-gating, no auto-regen.

   The loudness signals come from the loudnorm pass already measured during
   encode (mp3.ts `onLoudnessMeasured` → LoudnormSidecarJson). In two-pass mode
   those are POST-normalisation values, so a genuinely near-silent SOURCE is
   usually caught by loudnorm's own measurement-unusable fallback (it leaves the
   sidecar's i/tp degenerate) rather than by a post-norm reading; the duration
   check is the most robust signal and is independent of loudnorm. */

export type QaStatus = 'ok' | 'suspect';

export interface ChapterQaVerdict {
  status: QaStatus;
  reasons: string[];
  /** Integrated loudness (LUFS) the verdict checked, or null when loudnorm was
      disabled / not measured. */
  measuredLufs: number | null;
  /** True peak (dBTP) the verdict checked, or null when not measured. */
  truePeakDb: number | null;
  durationSec: number;
  /** Expected duration derived from the chapter text, or null when the caller
      had no text estimate. */
  expectedSec: number | null;
  checkedAt: string;
}

export interface QaThresholds {
  /** Integrated loudness at/below this (LUFS) is "near-silent". */
  nearSilentLufs: number;
  /** True peak at/above this (dBTP) is "clipping". */
  clipTpDb: number;
  /** durationSec / expectedSec below this is "truncated". */
  minDurationRatio: number;
  /** durationSec / expectedSec above this is "runaway". */
  maxDurationRatio: number;
}

export const DEFAULT_QA_THRESHOLDS: QaThresholds = {
  nearSilentLufs: -40,
  clipTpDb: -0.1,
  minDurationRatio: 0.5,
  maxDurationRatio: 2.5,
};

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/* Resolve thresholds: explicit arg wins, else env overrides on top of the
   defaults. Read lazily (per call) so an env change between runs is honoured
   without a process restart. */
function resolveThresholds(override?: QaThresholds): QaThresholds {
  if (override) return override;
  return {
    nearSilentLufs: envNum('QA_NEAR_SILENT_LUFS', DEFAULT_QA_THRESHOLDS.nearSilentLufs),
    clipTpDb: envNum('QA_CLIP_TP_DB', DEFAULT_QA_THRESHOLDS.clipTpDb),
    minDurationRatio: envNum('QA_MIN_DUR_RATIO', DEFAULT_QA_THRESHOLDS.minDurationRatio),
    maxDurationRatio: envNum('QA_MAX_DUR_RATIO', DEFAULT_QA_THRESHOLDS.maxDurationRatio),
  };
}

/** Evaluate a rendered chapter against the QA signals and return an advisory
    verdict. `lufs` / `truePeakDb` are null when loudnorm was disabled or could
    not measure; `expectedSec` is null when the caller had no text estimate
    (those checks are then skipped). */
export function evaluateChapterQa(
  input: {
    durationSec: number;
    expectedSec: number | null;
    lufs: number | null;
    truePeakDb: number | null;
  },
  thresholds?: QaThresholds,
): ChapterQaVerdict {
  const t = resolveThresholds(thresholds);
  const reasons: string[] = [];

  if (input.lufs != null && input.lufs <= t.nearSilentLufs) {
    reasons.push(
      `Near-silent — integrated loudness ${
        Number.isFinite(input.lufs) ? `${input.lufs.toFixed(1)} LUFS` : 'silent'
      } is far below the ${t.nearSilentLufs} LUFS floor.`,
    );
  }

  if (input.truePeakDb != null && input.truePeakDb >= t.clipTpDb) {
    reasons.push(
      `Clipping — true peak ${input.truePeakDb.toFixed(2)} dBTP reaches the ${t.clipTpDb} dBTP ceiling.`,
    );
  }

  if (input.expectedSec != null && input.expectedSec > 0) {
    const ratio = input.durationSec / input.expectedSec;
    if (ratio < t.minDurationRatio) {
      reasons.push(
        `Suspiciously short — ${input.durationSec.toFixed(0)}s rendered vs ~${input.expectedSec.toFixed(
          0,
        )}s expected (possible truncation).`,
      );
    } else if (ratio > t.maxDurationRatio) {
      reasons.push(
        `Suspiciously long — ${input.durationSec.toFixed(0)}s rendered vs ~${input.expectedSec.toFixed(
          0,
        )}s expected (possible runaway synthesis).`,
      );
    }
  }

  return {
    status: reasons.length > 0 ? 'suspect' : 'ok',
    reasons,
    measuredLufs: input.lufs,
    truePeakDb: input.truePeakDb,
    durationSec: input.durationSec,
    expectedSec: input.expectedSec,
    checkedAt: new Date().toISOString(),
  };
}
