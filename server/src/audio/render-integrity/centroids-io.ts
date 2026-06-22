/**
 * srv-36 Centroid persistence — read/write of per-character centroid stats.
 *
 * Written by the aggregate orchestrator (aggregate.ts) after building each
 * character's centroid; read by the repair route (Task 13) to retrieve the
 * character's `cleanMean` for the accept-check.
 *
 * File: `<bookDir>/audio/render-integrity.centroids.json`
 * (sibling to the audio/ folder's chapter files, found via audioDir helper)
 *
 * Null on ENOENT — safe to call when no chapters have been scored yet.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../workspace/state-io.js';
import { audioDir } from '../../workspace/paths.js';

/** Per-character centroid stats persisted across the book's render-integrity pass. */
export interface CharacterCentroid {
  characterId: string;
  /** L2-normalized centroid vector (number[] for JSON round-trip). */
  centroid: number[];
  /** Mean cosine of the anchor-eligible set against this centroid.
   *  Used as the accept-check threshold in the auto-fix route (Task 13). */
  cleanMean: number;
  /** Percentile value at CUTOFFS.severeEdgePctl (E — severe-edge boundary). */
  pSevere: number;
  /** Percentile value at CUTOFFS.bandUpperPctl (U — inconclusive-band upper boundary). */
  pBand: number;
  /** How this centroid was built:
   *  - 'in-book': from the character's own clean anchor segments (in-book mode)
   *  - 'audition': from the character's audition sample (Task 10 Option-B)
   *  - 'too-short': not enough clean segments; segments scored inconclusive */
  referenceKind: 'in-book' | 'audition' | 'too-short';
}

const CENTROIDS_FILENAME = 'render-integrity.centroids.json';

function centroidsPath(bookDir: string): string {
  return join(audioDir(bookDir), CENTROIDS_FILENAME);
}

/** Write all character centroids atomically.
 *  `rows` is the full set for the book — overwrites any prior file. */
export async function writeCentroids(
  bookDir: string,
  rows: CharacterCentroid[],
): Promise<void> {
  const record: Record<string, CharacterCentroid> = {};
  for (const row of rows) {
    record[row.characterId] = row;
  }
  await writeJsonAtomic(centroidsPath(bookDir), record);
}

/** Read all character centroids.
 *  Returns null on ENOENT (no centroid file written yet). */
export async function readCentroids(
  bookDir: string,
): Promise<Record<string, CharacterCentroid> | null> {
  let raw: string;
  try {
    raw = await readFile(centroidsPath(bookDir), 'utf8');
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw) as Record<string, CharacterCentroid>;
}
