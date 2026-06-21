import { describe, it, expect } from 'vitest';
import {
  buildCentroid,
  CENTROID_MIN_N,
  TRIM_ALPHA,
  TRIM_EPS,
  TRIM_MAX_ITERS,
  BIMODAL_GAP_THRESHOLD,
  BIMODAL_MIN_SIDE_FRACTION,
} from './centroid.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Produce a unit-length Float32Array in a given direction with optional noise. */
function makeVec(dir: number[], noiseScale = 0): Float32Array {
  const d = new Float64Array(dir.length);
  for (let i = 0; i < dir.length; i++) {
    d[i] = dir[i] + (noiseScale > 0 ? (Math.random() - 0.5) * noiseScale : 0);
  }
  // L2-normalize
  let norm = 0;
  for (let i = 0; i < d.length; i++) norm += d[i] * d[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = d[i] / norm;
  return out;
}

/** Cosine similarity between two Float32Arrays (computed in float64). */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// Seeded-ish cluster: 20 near-identical vectors along [1, 0, 0] with tiny noise
function tightCluster(n: number, dim = 8): Float32Array[] {
  const base = new Array(dim).fill(0);
  base[0] = 1;
  // Use deterministic perturbations (no Math.random) to keep tests stable
  return Array.from({ length: n }, (_, i) => {
    const dir = base.slice();
    dir[1] = (i % 5) * 0.005; // tiny deterministic noise
    dir[2] = Math.floor(i / 5) * 0.003;
    return makeVec(dir);
  });
}

// ── Constants export test ──────────────────────────────────────────────────

describe('centroid constants', () => {
  it('exports the specified constants', () => {
    expect(CENTROID_MIN_N).toBe(10);
    expect(TRIM_ALPHA).toBeCloseTo(0.1, 5);
    expect(TRIM_EPS).toBeCloseTo(1e-3, 8);
    expect(TRIM_MAX_ITERS).toBe(5);
    expect(BIMODAL_GAP_THRESHOLD).toBeCloseTo(0.15, 5);
    expect(BIMODAL_MIN_SIDE_FRACTION).toBeCloseTo(0.2, 5);
  });
});

// ── opts parameter override ────────────────────────────────────────────────

describe('buildCentroid — opts overrides', () => {
  it('opts.minN=5 causes 6-vector set to return kind=in-book instead of too-thin', () => {
    const sixVectors = tightCluster(6);
    // Default minN=10 → too-thin; override to 5 → in-book
    const result = buildCentroid(sixVectors, { minN: 5 });
    expect(result.kind).toBe('in-book');
  });
});

// ── (a) tight cluster → centroid ≈ mean, bimodal false ────────────────────

describe('buildCentroid — tight cluster', () => {
  it('returns kind=in-book and bimodal=false for a tight cluster of 20 vectors', () => {
    const vecs = tightCluster(20);
    const result = buildCentroid(vecs);

    expect(result.kind).toBe('in-book');
    expect(result.bimodal).toBe(false);
    // centroid should be very close to the cluster direction
    const sim = cosine(result.centroid, tightCluster(1)[0]);
    expect(sim).toBeGreaterThan(0.99);
  });

  it('centroid is L2-normalized (unit vector)', () => {
    const vecs = tightCluster(20);
    const { centroid } = buildCentroid(vecs);
    let norm = 0;
    for (let i = 0; i < centroid.length; i++) norm += centroid[i] * centroid[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  });
});

// ── (b) 18 clean + 2 far outliers → trim removes outliers ─────────────────

describe('buildCentroid — outlier trimming', () => {
  it('centroid stays close to the clean cluster despite 2 far outliers', () => {
    const dim = 8;
    const clean = tightCluster(18, dim);
    // Two outliers pointing in the opposite direction
    const outlier1 = makeVec([-1, 0, 0, 0, 0, 0, 0, 0]);
    const outlier2 = makeVec([-0.9, 0.4, 0, 0, 0, 0, 0, 0]);
    const vecs = [...clean, outlier1, outlier2];

    const result = buildCentroid(vecs);
    expect(result.kind).toBe('in-book');

    // Centroid should be well-aligned with the clean cluster direction
    const cleanRef = makeVec([1, 0, 0, 0, 0, 0, 0, 0]);
    const simToClean = cosine(result.centroid, cleanRef);
    // Without trimming, 2 outliers out of 20 would drag the centroid;
    // with trimming (alpha=0.1 → drops ~2 of 20), we expect high alignment.
    expect(simToClean).toBeGreaterThan(0.95);
  });
});

// ── (c) 12 clean + 8 second-mode → bimodal=true ───────────────────────────

describe('buildCentroid — bimodal detection', () => {
  it('detects bimodality when two clear clusters are present', () => {
    const dim = 8;
    // Cluster A: 12 vectors near [1, 0, ...]
    const clusterA = tightCluster(12, dim);
    // Cluster B: 8 vectors near [0, 1, 0, ...] — clearly separated
    const clusterB = Array.from({ length: 8 }, (_, i) => {
      const dir = new Array(dim).fill(0);
      dir[1] = 1;
      dir[2] = (i % 3) * 0.005;
      return makeVec(dir);
    });
    const vecs = [...clusterA, ...clusterB];

    const result = buildCentroid(vecs);
    expect(result.bimodal).toBe(true);
  });

  it('does NOT flag bimodal for a single cluster with mild spread', () => {
    // More spread-out single cluster (but not bimodal)
    const dim = 8;
    const vecs = Array.from({ length: 20 }, (_, i) => {
      const dir = new Array(dim).fill(0);
      dir[0] = 1;
      dir[1] = (i - 10) * 0.04; // mild spread, but all one cluster
      return makeVec(dir);
    });

    const result = buildCentroid(vecs);
    expect(result.bimodal).toBe(false);
  });
});

// ── (d) fewer than CENTROID_MIN_N → kind='too-thin' ───────────────────────

describe('buildCentroid — too-thin', () => {
  it('returns kind=too-thin when eligible.length < CENTROID_MIN_N', () => {
    const vecs = tightCluster(6);
    const result = buildCentroid(vecs);
    expect(result.kind).toBe('too-thin');
  });

  it('returns kind=too-thin for an empty array', () => {
    const result = buildCentroid([]);
    expect(result.kind).toBe('too-thin');
    expect(result.centroid).toBeInstanceOf(Float32Array);
  });

  it('returns kind=in-book when eligible.length equals CENTROID_MIN_N', () => {
    const vecs = tightCluster(CENTROID_MIN_N);
    const result = buildCentroid(vecs);
    expect(result.kind).toBe('in-book');
  });
});

// ── Determinism: same input → identical output ─────────────────────────────

describe('buildCentroid — determinism', () => {
  it('produces identical centroids on repeated calls with the same input', () => {
    const dim = 8;
    const vecs = tightCluster(20, dim);
    const r1 = buildCentroid(vecs);
    const r2 = buildCentroid(vecs);

    expect(r1.kind).toBe(r2.kind);
    expect(r1.bimodal).toBe(r2.bimodal);
    expect(r1.centroid.length).toBe(r2.centroid.length);
    for (let i = 0; i < r1.centroid.length; i++) {
      // Float32 bit-exact equality
      expect(r1.centroid[i]).toBe(r2.centroid[i]);
    }
  });

  it('determinism holds for a bimodal case too', () => {
    const dim = 8;
    const clusterA = tightCluster(12, dim);
    const clusterB = Array.from({ length: 8 }, (_, i) => {
      const dir = new Array(dim).fill(0);
      dir[1] = 1;
      dir[2] = (i % 3) * 0.005;
      return makeVec(dir);
    });
    const vecs = [...clusterA, ...clusterB];
    const r1 = buildCentroid(vecs);
    const r2 = buildCentroid(vecs);
    for (let i = 0; i < r1.centroid.length; i++) {
      expect(r1.centroid[i]).toBe(r2.centroid[i]);
    }
  });
});
