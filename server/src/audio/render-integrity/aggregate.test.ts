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
  it('flags a drifted segment + a fallback segment, passes the rest, and persists centroids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-book-'));
    // 12 clean Qwen segments clustered at θ≈0, one drifted at θ=1.2 rad, one fallback (kokoro) at θ≈0
    const rows: { characterId: string; sentenceIds: number[]; vec: Float32Array }[] = [];
    for (let i = 0; i < 12; i++) rows.push({ characterId: 'hero', sentenceIds: [i], vec: vec(0.02 * i) });
    rows.push({ characterId: 'hero', sentenceIds: [99], vec: vec(1.2) });      // drifted
    rows.push({ characterId: 'hero', sentenceIds: [100], vec: vec(0.01) });    // fallback render

    // Write embeddings sibling into dir (the aggregate looks for <dir>/audio/<slug>.embeddings.json)
    // The aggregate reads from audioDir(bookDir), which is <bookDir>/audio/
    // We need to create the audio sub-dir
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'audio'), { recursive: true });

    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);

    // REAL shape: voiceEngine lives ONLY on characterSnapshots (per-character);
    // renderedFallbackEngine is per-segment on the segments[] entries.
    writeFileSync(join(dir, 'audio', 'ch1.segments.json'), JSON.stringify({
      chapterId: 1,
      segments: rows.map((r) => ({
        characterId: 'hero', sentenceIds: r.sentenceIds,
        renderedFallbackEngine: r.sentenceIds[0] === 100 ? 'kokoro' : null,
      })),
      characterSnapshots: { hero: { voiceEngine: 'qwen', renderedFallbackEngine: 'kokoro' } },
    }));

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    const verdicts = await readVerdicts(join(dir, 'audio', 'ch1.render-integrity.json'));
    const bySent = Object.fromEntries(verdicts!.map((v) => [v.sentenceIds[0], v.verdict]));
    expect(bySent[99]).toBe('voice-mismatch');   // drifted
    expect(bySent[100]).toBe('voice-mismatch');  // fallback caught acoustically
    expect(bySent[0]).toBe('voice-match');

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
