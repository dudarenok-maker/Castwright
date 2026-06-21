import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as VerdictRow[];
}
