/**
 * srv-36 Hybrid centroid builder (pure, no IO).
 *
 * Math is ported from `server/tts-sidecar/spikes/srv36/metrics.py`
 * (`cosine`, `centroid`). All vector arithmetic is done in Float64 internally
 * to match the Python spike; results are returned as Float32Array.
 *
 * Determinism contract: given the same `eligible` array (same Float32Array
 * instances with identical values), every call returns bit-identical results.
 * This is enforced by:
 *   – stable sort (Array.prototype.sort is stable in V8 ≥ 7.0 / Node 11+)
 *   – fixed iteration cap (TRIM_MAX_ITERS)
 *   – no random number generation
 */

// ── Exported constants ──────────────────────────────────────────────────────

/** Minimum number of eligible vectors needed to build an 'in-book' centroid. */
export const CENTROID_MIN_N = 10;

/** Fraction of lowest-cosine-to-centroid vectors dropped per trim iteration. */
export const TRIM_ALPHA = 0.1;

/** Centroid-shift threshold (1 − cosine(prev,next)) below which we stop. */
export const TRIM_EPS = 1e-3;

/** Maximum number of trim iterations. */
export const TRIM_MAX_ITERS = 5;

/**
 * Bimodal-gap threshold.
 * When the largest consecutive gap in the sorted cosine-to-centroid
 * distribution exceeds this value AND both sides contain ≥ 20% of total
 * vectors, we flag bimodality.
 *
 * Choice: 0.15 — wide enough to distinguish a genuine two-cluster split
 * (typical inter-cluster gap ≈ 0.3–0.7) from within-cluster scatter
 * (typical gap < 0.05). Calibration-tunable without changing the algorithm.
 */
export const BIMODAL_GAP_THRESHOLD = 0.15;

/** Minimum fraction of the set each side of the gap must represent. */
export const BIMODAL_MIN_SIDE_FRACTION = 0.2;

// ── Internal vector helpers (Float64) ─────────────────────────────────────

/** L2 norm of a Float64Array. */
function norm64(v: Float64Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/**
 * Cosine similarity between two Float64 vectors.
 * Returns 0.0 if either has zero norm (matches the Python spike).
 */
function cosine64(a: Float64Array, b: Float64Array): number {
  const na = norm64(a);
  const nb = norm64(b);
  if (na === 0 || nb === 0) return 0.0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (na * nb);
}

/**
 * Compute the L2-renormalized mean (centroid) of a set of Float64 vectors.
 * Returns the raw mean if norm is zero (degenerate case).
 */
function renormalizedMean(vecs: Float64Array[]): Float64Array {
  const dim = vecs[0].length;
  const mean = new Float64Array(dim);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) mean[i] += v[i];
  }
  for (let i = 0; i < dim; i++) mean[i] /= vecs.length;
  const n = norm64(mean);
  if (n > 0) {
    for (let i = 0; i < dim; i++) mean[i] /= n;
  }
  return mean;
}

/** Convert a Float32Array to Float64Array (lossless widening). */
function toFloat64(v: Float32Array): Float64Array {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i];
  return out;
}

/** Convert a Float64Array to Float32Array (narrowing, for the return type). */
function toFloat32(v: Float64Array): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i];
  return out;
}

// ── Bimodal detection ──────────────────────────────────────────────────────

/**
 * Detect bimodality via largest-consecutive-gap on sorted cosines.
 *
 * Algorithm:
 *   1. Sort cosines ascending.
 *   2. Find the largest gap between consecutive values.
 *   3. Flag bimodal iff gap > BIMODAL_GAP_THRESHOLD AND the split puts
 *      ≥ BIMODAL_MIN_SIDE_FRACTION of the total on each side.
 *
 * This is deterministic (stable ascending sort; no random elements).
 */
function detectBimodal(cosines: Float64Array): boolean {
  const n = cosines.length;
  if (n < 2) return false;

  // Make a copy and sort ascending
  const sorted = new Float64Array(cosines).sort();

  let maxGap = 0;
  let maxGapIdx = 0; // index of the LEFT element before the largest gap
  for (let i = 0; i < n - 1; i++) {
    const gap = sorted[i + 1] - sorted[i];
    if (gap > maxGap) {
      maxGap = gap;
      maxGapIdx = i;
    }
  }

  if (maxGap <= BIMODAL_GAP_THRESHOLD) return false;

  // Both sides must be non-trivial
  const leftCount = maxGapIdx + 1;
  const rightCount = n - leftCount;
  const minCount = Math.ceil(n * BIMODAL_MIN_SIDE_FRACTION);
  return leftCount >= minCount && rightCount >= minCount;
}

// ── Public API ─────────────────────────────────────────────────────────────

export interface CentroidResult {
  centroid: Float32Array;
  kind: 'in-book' | 'too-thin';
  bimodal: boolean;
}

/**
 * Build the hybrid centroid from anchor-eligible embedding vectors.
 *
 * @param eligible Pre-filtered list of Float32Array embeddings (caller
 *   ensures gate-passing AND no renderedFallbackEngine).
 * @param opts Optional overrides for the algorithm constants (for calibration).
 * @returns CentroidResult — kind='too-thin' when there are fewer than
 *   CENTROID_MIN_N vectors; kind='in-book' otherwise.
 */
export function buildCentroid(
  eligible: Float32Array[],
  opts?: { minN?: number; alpha?: number; eps?: number; maxIters?: number },
): CentroidResult {
  const minN = opts?.minN ?? CENTROID_MIN_N;
  const alpha = opts?.alpha ?? TRIM_ALPHA;
  const eps = opts?.eps ?? TRIM_EPS;
  const maxIters = opts?.maxIters ?? TRIM_MAX_ITERS;

  // ── Too-thin fast path ──────────────────────────────────────────────────
  if (eligible.length < minN) {
    // Return the mean of whatever we have (or an empty vector if nothing).
    let centroid: Float32Array;
    if (eligible.length === 0) {
      centroid = new Float32Array(0);
    } else {
      const vecs64 = eligible.map(toFloat64);
      centroid = toFloat32(renormalizedMean(vecs64));
    }
    return { centroid, kind: 'too-thin', bimodal: false };
  }

  // ── Convert to Float64 for all internal arithmetic ─────────────────────
  let working: Float64Array[] = eligible.map(toFloat64);

  // ── Iterate-to-converge trimmed mean ───────────────────────────────────
  // Initial centroid from the full eligible set.
  let c = renormalizedMean(working);

  for (let iter = 0; iter < maxIters; iter++) {
    // Compute cosines to the current centroid.
    const cosines = working.map((v) => cosine64(v, c));

    // Drop the lowest alpha fraction.
    // We need a stable sort of the indices so that ties break consistently.
    const indices = Array.from({ length: working.length }, (_, i) => i);
    indices.sort((a, b) => {
      const diff = cosines[a] - cosines[b];
      // Stable tiebreaker: original index order (indices array is already
      // ordered 0..n-1, so equal-cosine pairs keep their original position).
      return diff !== 0 ? diff : a - b;
    });

    const dropCount = Math.floor(working.length * alpha);
    // Drop the `dropCount` lowest-cosine vectors (first in sorted order).
    const keepIndices = indices.slice(dropCount);
    // Re-sort keep indices in ascending original order for reproducibility.
    keepIndices.sort((a, b) => a - b);
    const kept = keepIndices.map((i) => working[i]);

    // Guard against empty kept set (degenerate: alpha≈1 or tiny working set).
    if (kept.length === 0) break;

    // Recompute centroid on the kept set.
    const cNext = renormalizedMean(kept);

    // Check convergence: shift = 1 − cosine(prev, next)
    const shift = 1 - cosine64(c, cNext);
    c = cNext;

    if (shift < eps) break;

    // Update working set for next iteration.
    working = kept;
  }

  // ── Bimodal detection on the ORIGINAL eligible set ─────────────────────
  // (per-spec: detect on "the eligible set's sorted cosine-to-provisional-
  //  centroid distribution" — we use the final centroid as the provisional one)
  const allCosines = new Float64Array(eligible.length);
  const allVecs64 = eligible.map(toFloat64);
  for (let i = 0; i < allVecs64.length; i++) {
    allCosines[i] = cosine64(allVecs64[i], c);
  }
  const bimodal = detectBimodal(allCosines);

  return { centroid: toFloat32(c), kind: 'in-book', bimodal };
}
