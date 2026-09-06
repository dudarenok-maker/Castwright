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
 *
 * CALIBRATION (srv-36 Task 16, 2026-06-22, operator listen on real Qwen
 * renders — Skulduggery/Scepter + Keeper/Unlocked). Per-character percentile
 * (NOT a global absolute cosine) is required: drift/clean boundaries differ
 * sharply per voice — e.g. china-sorrows reads clean at cosine 0.478 while
 * narrator is drift at 0.507, so no single absolute cutoff separates them.
 * 6/10 fit the operator's verdicts well (near-exact for stephanie/skulduggery;
 * a thin ~0.05-wide over-flag band for the tightest voices like narrator) — no
 * percentile value improves all characters at once, so 6/10 is the balance.
 * minDurationSec=3.0 because every operator "borderline" call was a <3s clip.
 * 27/27 extreme-tail flags (cosine 0.05–0.27) were confirmed real drift, 0 FP.
 */
export const CUTOFFS = {
  severeEdgePctl: 6,
  bandUpperPctl: 10,
  minDurationSec: MIN_DURATION_SEC,
} as const;

/**
 * A36 (2026-09-05 owner ruling) — distinct, wider calibration used ONLY when
 * a character's reference pool is small AND synthetic-only (Option-B Phase B:
 * anchors dropped for a bimodal split, or Phase A with zero real anchors to
 * begin with — see `AuditionCentroidResult.syntheticOnly` in
 * audition-centroid.ts). `CUTOFFS`'s percentile cutoffs assume a pool whose
 * scatter reflects real render-to-render variance; a same-engine,
 * same-conditions synthetic-only pool clusters far tighter than that (the
 * register's own observed case: N=6, cosines 0.9629±0.02), so a percentile
 * near the bottom of that tight cluster sits ABOVE a correctly-cast voice's
 * real re-render cosine (observed 0.928/0.934) — a false 'voice-mismatch'/
 * 'severe' flag on a correct render (srv-36 register row A36).
 *
 * Uses mean/std-dev sigma bands instead of percentile-of-pool: at N=6,
 * percentile-of-pool is really "near the sample minimum" (see `percentile`'s
 * behaviour at low pctl on a tiny array), which is exactly the tight-cluster
 * problem, not a fix for it. Sigma widths are picked so the register's own
 * false-positive case clears the severe edge:
 *   severeSigma=3  → well below the observed 0.928/0.934 correct-voice
 *                    cosines (no longer 'severe') for the register's own
 *                    pinned pool (mean 0.9629, population std≈0.0173).
 *   bandSigma=1.5  → both 0.928 and 0.934 land 'inconclusive' (never
 *                    'severe') against that same pool — the fix's actual
 *                    requirement; a clearly-matching render still resolves
 *                    'voice-match' well above this edge.
 * The normal (real-anchor) path is entirely unaffected — this band is never
 * consulted unless `syntheticOnly` is set.
 */
export const SYNTHETIC_ONLY_CUTOFFS = {
  severeSigma: 3,
  bandSigma: 1.5,
} as const;

/**
 * Mean/std-dev-based spread for a small synthetic-only audition pool — see
 * `SYNTHETIC_ONLY_CUTOFFS` for why this replaces percentile-of-pool rather
 * than just using different percentile numbers.
 *
 * **Dispersion guard:** The sigma-band calibration assumes a tight pool
 * (observed 0.9629±0.02); on a looser/degenerate pool (e.g., one bad render
 * in a six-render audition), the std dev can grow large enough to produce an
 * unbounded pSevere that makes the severe tier unreachable. This function
 * now detects pool dispersion (std dev relative to mean) and, when high
 * dispersion is detected, falls back to a tighter percentile-based band
 * (using lower percentiles than the real-anchor path) to ensure the severe
 * tier remains reachable even with degenerate outliers. At tight pools the
 * sigma-based computation is used (as originally calibrated); at loose
 * pools the percentile-based fallback with tighter percentiles activates.
 *
 * @param cosines Cosine-to-centroid values for the pool (any order; not
 *   required to be pre-sorted, unlike `percentile`).
 */
export function syntheticOnlySpread(cosines: number[]): { pSevere: number; pBand: number } {
  const mean = cosines.reduce((s, c) => s + c, 0) / cosines.length;
  const variance = cosines.reduce((s, c) => s + (c - mean) ** 2, 0) / cosines.length;
  const std = Math.sqrt(variance);
  const sorted = [...cosines].sort((a, b) => a - b);

  // Sigma-based band
  const sigmaPSevere = mean - SYNTHETIC_ONLY_CUTOFFS.severeSigma * std;
  const sigmaPBand = mean - SYNTHETIC_ONLY_CUTOFFS.bandSigma * std;

  // Dispersion detection: the calibration assumes a tight pool (std < ~0.05).
  // When std is much larger, the pool contains degenerate outliers and the
  // sigma-based band can collapse. Fall back to tighter percentiles (1st/5th
  // instead of 6th/10th) to ensure the severe tier stays reachable.
  const poolRange = sorted[sorted.length - 1] - sorted[0];
  const isDispersed = std > Math.max(0.05, poolRange * 0.1); // > 5% mean or > 10% of range

  if (isDispersed) {
    // Percentile-of-pool fallback with tighter percentiles for degenerate pools.
    // Using 1st/5th instead of 6th/10th ensures the severe tier can still flag
    // genuine mismatches even with outlier renders in the pool.
    return {
      pSevere: percentile(sorted, 1), // much tighter than CUTOFFS.severeEdgePctl (6)
      pBand: percentile(sorted, 5),   // tighter than CUTOFFS.bandUpperPctl (10)
    };
  }

  // Tight pool — use the sigma-based band as calibrated
  return {
    pSevere: sigmaPSevere,
    pBand: sigmaPBand,
  };
}

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
 * @param spread      The character's band boundaries (may be computed by different methods):
 *                    - `pSevere`: band boundary at the severe edge (E).
 *                    - `pBand`: band boundary at the inconclusive-band upper boundary (U).
 *                    Computed by the aggregate after either:
 *                    (a) calling `percentile()` on the character's clean cosine
 *                        distribution (real-anchor path), producing percentile values, or
 *                    (b) calling `syntheticOnlySpread()` for synthetic-only audition pools,
 *                        which may return sigma-based thresholds (tight pool) or percentile
 *                        values from the dispersion fallback (loose/degenerate pool).
 *                    Check the `bandMethod` field in CharacterCentroid to determine which
 *                    computation method was used (stored when persisting the centroid).
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
