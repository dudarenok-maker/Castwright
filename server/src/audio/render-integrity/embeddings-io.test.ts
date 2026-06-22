import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEmbeddings, readEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

describe('embeddings-io', () => {
  it('round-trips a vector and tolerates a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-'));
    const p = join(dir, 'ch1.embeddings.json');
    await writeEmbeddings(p, [{ characterId: 'c1', sentenceIds: [1, 2], vec: Float32Array.from([0.5, -0.25]) }], EMBEDDINGS_VERSION);
    const back = await readEmbeddings(p);
    expect(back?.version).toBe(EMBEDDINGS_VERSION);
    expect(Array.from(back!.rows[0].vec)).toEqual([0.5, -0.25]);
    expect(await readEmbeddings(join(dir, 'nope.json'))).toBeNull();
  });

  it('packs vectors as base64 of Float32 buffer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-'));
    const p = join(dir, 'ch1.embeddings.json');
    const vec = Float32Array.from([1.0, 2.0, 3.0]);
    await writeEmbeddings(p, [{ characterId: 'c2', sentenceIds: [5], vec }], EMBEDDINGS_VERSION);

    // Read raw JSON to verify base64 storage
    const { readFile } = await import('node:fs/promises');
    const raw = JSON.parse(await readFile(p, 'utf8'));
    const stored = raw.rows[0].vec;
    expect(typeof stored).toBe('string');

    // Decode and verify round-trip fidelity
    const buf = Buffer.from(stored, 'base64');
    const decoded = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    expect(Array.from(decoded)).toEqual([1.0, 2.0, 3.0]);
  });

  it('reports a version mismatch as stale (returns data with different version)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-'));
    const p = join(dir, 'ch1.embeddings.json');
    await writeEmbeddings(p, [{ characterId: 'c3', sentenceIds: [1], vec: Float32Array.from([0.1]) }], 'old-version-v0');
    const back = await readEmbeddings(p);
    // readEmbeddings returns the data regardless — caller checks version field
    expect(back).not.toBeNull();
    expect(back!.version).toBe('old-version-v0');
  });
});
