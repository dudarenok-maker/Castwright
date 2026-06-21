import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../../workspace/state-io.js';

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
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw) as VerdictRow[];
}
