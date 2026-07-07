/* srv-36 audition-centroid redesign: the whole point of blending real
   anchor embeddings into the Option-B pool is that they drive the
   resulting cleanMean/pSevere/pBand — but aggregate-audition-pool.test.ts
   mocks auditionCentroid entirely, so it can never prove that. This file
   exercises the REAL (unmocked) auditionCentroid via a fixture engineered
   to need ZERO synthetic renders: a too-thin character (< CENTROID_MIN_N=10
   anchor-eligible embeddings, so centroid.ts routes it to the audition
   fallback) whose anchor count is already at/above auditionCentroid's
   DEFAULT AUDITION_POOL_TARGET_N (6) — scoreBook calls auditionCentroid
   with no targetN/margin override, so the default (6) applies. With
   existingAnchors.length >= 6, auditionCentroid's phase-A deficit is 0, so
   its render loop never calls synth() at all — safe to run without a
   sidecar, no mock needed. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { scoreBook } from './aggregate.js';
import { readCentroids } from './centroids-io.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// A unit vector in a given axis direction, dim=8, tiny deterministic jitter —
// a single tight cluster (not bimodal), mirroring the codebase's existing
// vec() helpers in aggregate.test.ts / aggregate-audition-tier.test.ts.
function axisVec(axis: number, i: number, dim = 8): number[] {
  const dir = new Array(dim).fill(0);
  dir[axis] = 1;
  dir[(axis + 1) % dim] = (i % 3) * 0.005;
  let norm = 0;
  for (const v of dir) norm += v * v;
  norm = Math.sqrt(norm);
  return dir.map((v) => v / norm);
}
const vec = (i: number) => Float32Array.from(axisVec(0, i));

describe('scoreBook — real (unmocked) auditionCentroid drives the spread from blended anchors', () => {
  it('a too-thin character whose anchors already meet the default target gets referenceKind "audition" with a real, anchor-derived cleanMean', async () => {
    // Belt-and-suspenders against #1242/#1243 (a dev box's own live sidecar
    // on :9000 turning a "fails fast" assumption into a 15s hang): point
    // LOCAL_TTS_URL at a guaranteed-empty ephemeral port. After Task 2's fix
    // this test never actually reaches the network (existingAnchors alone
    // meet target, so auditionCentroid's synth() loop never runs) — but the
    // guard keeps this test safe to run standalone at ANY point in the TDD
    // cycle, including the pre-fix "confirm it fails" step, which (before
    // existingAnchors is threaded through) DOES attempt a real network call.
    const probe = createServer();
    const ephemeralPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const addr = probe.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const prevLocalTtsUrl = process.env.LOCAL_TTS_URL;
    process.env.LOCAL_TTS_URL = `http://127.0.0.1:${ephemeralPort}`;

    const dir = mkdtempSync(join(tmpdir(), 'spk-pool-real-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });

    // 8 anchor-eligible vectors: below CENTROID_MIN_N=10 (too-thin per
    // centroid.ts) but above AUDITION_POOL_TARGET_N=6 (so auditionCentroid
    // needs zero new renders — existingAnchors alone already meet target).
    const rows = Array.from({ length: 8 }, (_, i) => ({
      characterId: 'thurid',
      sentenceIds: [i],
      vec: vec(i),
    }));
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b',
        segments: rows.map((r) => ({
          characterId: 'thurid',
          sentenceIds: r.sentenceIds,
          renderedFallbackEngine: null,
        })),
        characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
      }),
    );
    // No cast.json — hint stays undefined, irrelevant here since no text
    // ever gets rendered (deficit=0, zero synth() calls).

    try {
      await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    } finally {
      if (prevLocalTtsUrl === undefined) delete process.env.LOCAL_TTS_URL;
      else process.env.LOCAL_TTS_URL = prevLocalTtsUrl;
    }

    const centroids = await readCentroids(dir);
    expect(centroids).not.toBeNull();
    const ref = centroids!['thurid'];
    // Real auditionCentroid returned kind='audition' (built purely from the
    // 8 blended anchors, zero synthetic renders) — NOT 'too-short'.
    expect(ref.referenceKind).toBe('audition');
    // The 8 anchors are a tight single cluster, so their cosines to their
    // own centroid are all very close to 1 — cleanMean must reflect that
    // real spread, not a placeholder/zero value.
    expect(ref.cleanMean).toBeGreaterThan(0.9);
  });
});
