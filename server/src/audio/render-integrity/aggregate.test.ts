import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreBook } from './aggregate.js';
import { readVerdicts } from './verdicts-io.js';
import { readCentroids } from './centroids-io.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// helper: a 2-d unit vector at angle θ, padded to length 8 (test vectors are small)
const vec = (θ: number) => Float32Array.from([Math.cos(θ), Math.sin(θ), 0, 0, 0, 0, 0, 0]);

describe('scoreBook', () => {
  it('scores all segments acoustically — including fallback renders — and correctly classifies by cosine distance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-book-'));
    //
    // Fixture layout:
    //   sentenceIds [0..11]  — 12 clean Qwen segments clustered at θ≈0  (non-fallback anchor)
    //   sentenceIds [99]     — 1 non-fallback drifted segment at θ≈1.2  (far from centroid → voice-mismatch)
    //   sentenceIds [100]    — 1 fallback (renderedFallbackEngine='kokoro'), vec FAR (θ≈1.2) → voice-mismatch
    //   sentenceIds [101]    — 1 fallback (renderedFallbackEngine='kokoro'), vec CLOSE (θ≈0.01) → voice-match
    //
    // The discriminating test is sentenceIds[101]: the definitional (wrong) rule would have
    // flagged it as voice-mismatch simply because renderedEngine !== configuredEngine.
    // The acoustic rule correctly passes it because its cosine is high (near the centroid).
    // Per spec §0.1: acoustic ≠ config; a Kokoro fallback that sounds like the voice passes
    // the acoustic gate — the fallback itself is a config concern surfaced elsewhere.
    //
    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'hero', sentenceIds: [i], vec: vec(0.02 * i) });
    rows.push({ characterId: 'hero', sentenceIds: [99], vec: vec(1.2) });    // non-fallback, drifted
    rows.push({ characterId: 'hero', sentenceIds: [100], vec: vec(1.2) });   // fallback render, acoustically FAR
    rows.push({ characterId: 'hero', sentenceIds: [101], vec: vec(0.01) });  // fallback render, acoustically CLOSE

    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);

    // REAL shape: voiceEngine lives ONLY on characterSnapshots (per-character);
    // renderedFallbackEngine is per-segment on the segments[] entries.
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: rows.map((r) => ({
        characterId: 'hero', sentenceIds: r.sentenceIds,
        renderedFallbackEngine: (r.sentenceIds[0] === 100 || r.sentenceIds[0] === 101) ? 'kokoro' : null,
      })),
      characterSnapshots: { hero: { voiceEngine: 'qwen' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).not.toBeNull();
    const bySent = Object.fromEntries(verdicts!.map((v) => [v.sentenceIds[0], v]));

    // Non-fallback drifted segment flagged acoustically
    expect(bySent[99].verdict).toBe('voice-mismatch');

    // Fallback segment acoustically FAR → voice-mismatch; stored cosine is the REAL
    // measurement (not fabricated 0), but it will be low (far from centroid)
    expect(bySent[100].verdict).toBe('voice-mismatch');
    // The stored cosine must be the real acoustic measurement — it will be low
    // (far vector), but NOT necessarily exactly 0 unless perfectly orthogonal
    expect(bySent[100].cosine).toBeLessThan(0.5);

    // DISCRIMINATING TEST: fallback render that is acoustically CLOSE to the centroid
    // must pass as voice-match. The definitional (wrong) rule would have flagged this
    // because renderedEngine ('kokoro') !== configuredEngine ('qwen'). The acoustic
    // rule correctly passes it — per spec §0.1, acoustic scoring is independent of
    // config; the fallback is a config concern surfaced elsewhere.
    expect(bySent[101].verdict).toBe('voice-match');
    // Also confirm the stored cosine is the real high measurement
    expect(bySent[101].cosine).toBeGreaterThan(0.9);

    // Clean segments pass
    expect(bySent[0].verdict).toBe('voice-match');

    const centroids = await readCentroids(dir);
    expect(centroids!['hero'].referenceKind).toBe('in-book');
  });

  it('skips Kokoro-configured characters entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-kok-'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    const rows = [{ characterId: 'narrator', sentenceIds: [1], vec: vec(0) }];
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: rows.map((r) => ({ characterId: 'narrator', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
      characterSnapshots: { narrator: { voiceEngine: 'kokoro' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    // No verdicts written (Kokoro skipped)
    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    expect(verdicts).toBeNull();

    const centroids = await readCentroids(dir);
    expect(centroids).toBeNull();
  });
});

describe('centroids-io round-trip', () => {
  it('writes and reads back a centroid record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-ctrnd-'));
    const { writeCentroids, readCentroids: rc } = await import('./centroids-io.js');

    const rows = [
      {
        characterId: 'hero',
        centroid: [0.1, 0.2, 0.3],
        cleanMean: 0.85,
        pSevere: 0.5,
        pBand: 0.7,
        referenceKind: 'in-book' as const,
      },
    ];

    await writeCentroids(dir, rows);
    const back = await rc(dir);
    expect(back).not.toBeNull();
    expect(back!['hero'].referenceKind).toBe('in-book');
    expect(back!['hero'].cleanMean).toBeCloseTo(0.85);
    expect(back!['hero'].centroid).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns null on missing file', async () => {
    const { readCentroids: rc } = await import('./centroids-io.js');
    const dir = mkdtempSync(join(tmpdir(), 'spk-miss-'));
    expect(await rc(dir)).toBeNull();
  });
});
