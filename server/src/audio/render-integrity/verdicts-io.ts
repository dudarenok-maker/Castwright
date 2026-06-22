import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../../workspace/state-io.js';
import { audioDir } from '../../workspace/paths.js';

export type Verdict = 'voice-match' | 'voice-mismatch' | 'inconclusive';

export interface VerdictRow {
  characterId: string;
  sentenceIds: number[];
  verdict: Verdict;
  cosine: number;
  severity: 'severe' | 'inconclusive' | null;
  fixable: boolean;
  expectedEngine: string;
  renderedEngine: string;
  referenceKind: 'in-book' | 'audition' | 'too-short';
  windowed: boolean;
}

/** Write verdict rows atomically. */
export async function writeVerdicts(path: string, rows: VerdictRow[]): Promise<void> {
  await writeJsonAtomic(path, rows);
}

/** Read verdict rows from disk. Returns null on ENOENT (torn-write tolerant). */
export async function readVerdicts(path: string): Promise<VerdictRow[] | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw) as VerdictRow[];
}

/**
 * Cheap book-level outline derive — reads ONLY the per-chapter
 * `<slug>.render-integrity.json` verdict files, never the embeddings.
 *
 * Mirrors the `loadSegmentsFiles` rollup pattern (`segments-io.ts`).
 *
 * @param bookDir  The book's root directory on disk.
 * @param chapters Array of `{ id, slug }` identifying the book's chapters.
 */
export async function deriveBookOutline(
  bookDir: string,
  chapters: { id: number; slug: string }[],
): Promise<{
  issues: VerdictRow[];
  counts: { suspect: number; fixable: number; uncheckedCharacters: string[] };
}> {
  const root = audioDir(bookDir);
  const issues: VerdictRow[] = [];
  const uncheckedSet = new Set<string>();

  for (const ch of chapters) {
    const path = join(root, `${ch.slug}.render-integrity.json`);
    const rows = await readVerdicts(path);
    if (!rows) continue;

    for (const row of rows) {
      if (row.verdict === 'voice-mismatch') {
        issues.push(row);
      }
      if (row.referenceKind === 'too-short') {
        uncheckedSet.add(row.characterId);
      }
    }
  }

  const uncheckedCharacters = Array.from(uncheckedSet).sort();

  return {
    issues,
    counts: {
      suspect: issues.length,
      fixable: issues.filter((r) => r.fixable).length,
      uncheckedCharacters,
    },
  };
}
