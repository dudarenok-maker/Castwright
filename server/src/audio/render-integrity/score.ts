/**
 * srv-36 3-tier per-character scoring (pure, no IO).
 *
 * Scoring logic mirrors the spike's `metrics.py` (`cosine`, `spread_stats`).
 * All arithmetic is done in plain JS numbers (float64).
 *
 * Three-tier verdict bands per character (E < U):
 *   cosine < E  → voice-mismatch / severe
 *   E ≤ cos < U → inconclusive
 *   cos ≥ U     → voice-match
 *
 * Sub-floor override: segments shorter than CUTOFFS.minDurationSec are always
 * 'inconclusive' regardless of cosine (embedding unreliable on short audio).
 *
 * ACCEPT_MARGIN RULE (for Task 13 auto-fix):
 *   A re-render is accepted only if its cosine ≥ the character's `cleanMean`
 *   (the mean cosine across the character's own anchor segments). This is NOT
 *   a standalone constant — it is checked against the per-character centroid
 *   stat, so the threshold adapts per voice. The auto-fix must retrieve
 *   `cleanMean` from the character's `CentroidStats` and compare the
 *   re-render's `cosineToCentroid` result against it.
 */

import { MIN_DURATION_SEC } from './constants.js';
export type { Verdict } from './verdicts-io.js';
import type { Verdict } from './verdicts-io.js';

// ── Named, calibration-tuned cutoff constants ─────────────────────────────

/**
 * Global floor constants, pinned by the test.
 * - `severeEdgePctl`: percentile of a character's cosine distribution below
 *   which a segment is flagged 'voice-mismatch' (severe).
 * - `bandUpperPctl`: percentile below which a segment is flagged 'inconclusive'
 *   (and at or above which it is 'voice-match').
 * - `minDurationSec`: segments shorter than this are always 'inconclusive'.
 */
export const CUTOFFS = {
  severeEdgePctl: 6,
  bandUpperPctl: 10,
  minDurationSec: MIN_DURATION_SEC,
} as const;

// ── percentile ─────────────────────────────────────────────────────────────

/**
 * Linear-interpolated percentile of an ascending-sorted array.
 *
 * @param sorted Ascending-sorted array of numbers.
 * @param pctl   Percentile in [0, 100].
 * @returns      The interpolated value at the requested percentile.
 */
export function percentile(sorted: number[], pctl: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (pctl / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ── cosineToCentroid ───────────────────────────────────────────────────────

/**
 * Cosine similarity between `vec` and `centroid`.
 *
 * Ported from the spike's `metrics.py::cosine`:
 *   `dot(a, b) / (‖a‖ · ‖b‖)`, returning 0 if either norm is 0.
 *
 * Accepts plain `number[]` (callers pass `Array.from(float32)` or plain arrays).
 *
 * @param vec      Query embedding vector.
 * @param centroid Reference centroid vector.
 * @returns        Cosine similarity in [-1, 1], or 0 for zero-norm inputs.
 */
export function cosineToCentroid(vec: number[], centroid: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < vec.length; i++) {
    dot += vec[i] * centroid[i];
    na += vec[i] * vec[i];
    nb += centroid[i] * centroid[i];
  }
  const normA = Math.sqrt(na);
  const normB = Math.sqrt(nb);
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

// ── scoreSegment ───────────────────────────────────────────────────────────

/**
 * Compute the 3-tier verdict for a single rendered segment.
 *
 * @param cosine      Cosine similarity of this segment's embedding to the
 *                    character's centroid (from `cosineToCentroid`).
 * @param spread      The character's own percentile cutoffs:
 *                    - `pSevere`: percentile value at `CUTOFFS.severeEdgePctl`
 *                      (E — the severe-edge boundary).
 *                    - `pBand`: percentile value at `CUTOFFS.bandUpperPctl`
 *                      (U — the inconclusive-band upper boundary).
 *                    Passed in by the aggregate (Task 9) after calling
 *                    `percentile()` on the character's clean cosine distribution.
 * @param durationSec Rendered segment duration in seconds.
 * @returns           `{ verdict: Verdict; severity: 'severe'|'inconclusive'|null }`.
 *
 * ACCEPT_MARGIN RULE (Task 13 reference):
 *   Auto-fix accepts a re-render only if its cosine ≥ the character's
 *   `cleanMean`. Task 13 must retrieve `cleanMean` from `CentroidStats` and
 *   call `cosineToCentroid` on the re-render's embedding, then compare.
 */
export function scoreSegment(
  cosine: number,
  spread: { pSevere: number; pBand: number },
  durationSec: number,
): { verdict: Verdict; severity: 'severe' | 'inconclusive' | null } {
  // Sub-floor override: unreliable short segments → always inconclusive.
  if (durationSec < CUTOFFS.minDurationSec) {
    return { verdict: 'inconclusive', severity: 'inconclusive' };
  }

  // Tier E: severe mismatch
  if (cosine < spread.pSevere) {
    return { verdict: 'voice-mismatch', severity: 'severe' };
  }

  // Tier U: inconclusive band
  if (cosine < spread.pBand) {
    return { verdict: 'inconclusive', severity: 'inconclusive' };
  }

  // Above U: voice-match
  return { verdict: 'voice-match', severity: null };
}
