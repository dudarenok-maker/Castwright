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

/** Identity of the voice an audition centroid was built from (#1969). */
export interface AuditionVoiceRef {
  /** Resolved voice name actually sent to the provider (snapshot resolvedVoiceName, #1972). */
  voiceName: string;
  /** The TTS model key the audition rendered under. */
  modelKey: string;
  /** Book language the audition rendered in (#1951). Optional — pre-#1951 auditions carry none. */
  language?: string;
  /** Whether the voice is a clone on this engine. Always present on built rows. */
  cloned?: boolean;
}

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
  /** #1969 — the voice this centroid was built from, recorded only on 'audition' rows so
   *  resolveCharacterReference can tell when a voice reassignment has made the persisted
   *  reference stale. Absent on a legacy row written before this field existed (and on any
   *  non-audition row) — an 'audition' row with no recorded voice is treated as unknown and
   *  rebuilt rather than trusted. */
  auditionVoice?: AuditionVoiceRef;
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

/** #1969 sibling — is a persisted centroid usable to score a character given the
 *  character's CURRENT resolved voice name + model key from the render's snapshots.
 *  in-book rows are rebuilt fresh every pass, so they self-heal and stay usable.
 *  An 'audition' row is usable ONLY when it recorded a voice identity AND that
 *  identity matches the character's current resolved voice/model — otherwise it is
 *  a stale reference (possibly for a voice the character no longer is) and must not
 *  be scored against. A null/absent current (no resolved voice to compare) is never
 *  trusted. */
export function auditionCentroidUsableForCurrent(
  row: CharacterCentroid,
  currentVoiceName: string | undefined,
  currentModelKey: string,
): boolean {
  if (row.referenceKind === 'in-book') return true;
  if (row.referenceKind !== 'audition') return false; // incl. 'too-short'
  if (row.auditionVoice == null || currentVoiceName == null) return false;
  return row.auditionVoice.voiceName === currentVoiceName && row.auditionVoice.modelKey === currentModelKey;
}
