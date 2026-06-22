import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../../workspace/state-io.js';
export { EMBEDDINGS_VERSION } from './constants.js';

export interface EmbeddingRow {
  characterId: string;
  sentenceIds: number[];
  vec: Float32Array;
}

interface StoredRow {
  characterId: string;
  sentenceIds: number[];
  vec: string; // base64-encoded Float32 buffer
}

interface StoredFile {
  version: string;
  rows: StoredRow[];
}

/** Pack vectors as base64 of their Float32 buffer and write atomically. */
export async function writeEmbeddings(
  path: string,
  rows: EmbeddingRow[],
  version: string,
): Promise<void> {
  const stored: StoredFile = {
    version,
    rows: rows.map((r) => ({
      characterId: r.characterId,
      sentenceIds: r.sentenceIds,
      vec: Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength).toString('base64'),
    })),
  };
  await writeJsonAtomic(path, stored);
}

/** Read embeddings from disk. Returns null on ENOENT (torn-write tolerant).
 *  Caller must check `result.version` against `EMBEDDINGS_VERSION` to detect stale files. */
export async function readEmbeddings(
  path: string,
): Promise<{ version: string; rows: EmbeddingRow[] } | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const stored = JSON.parse(raw) as StoredFile;
  const rows: EmbeddingRow[] = stored.rows.map((r) => {
    const buf = Buffer.from(r.vec, 'base64');
    return {
      characterId: r.characterId,
      sentenceIds: r.sentenceIds,
      vec: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4),
    };
  });
  return { version: stored.version, rows };
}
