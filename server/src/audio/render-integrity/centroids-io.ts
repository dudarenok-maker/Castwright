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
  /** Band boundary at the severe edge (E — severe-edge boundary).
   *  Only 'audition' referenceKind rows carry `bandMethod`. The field's presence/value
   *  distinguishes post-fix rows (trusted) from pre-fix rows (missing field = rebuild).
   *  - When `bandMethod` is 'percentile': a percentile-of-pool value (used on both
   *    real-anchor audition pools AND synthetic-only audition pools that were too dispersed
   *    for sigma calibration and fell back to percentile computation).
   *  - When `bandMethod` is 'synthetic-sigma': a sigma-based threshold computed from
   *    mean ± severeSigma × std (used only on tight synthetic-only audition pools). */
  pSevere: number;
  /** Band boundary at the inconclusive-band upper boundary (U — inconclusive-band upper boundary).
   *  Only 'audition' referenceKind rows carry `bandMethod`. The field's presence/value
   *  distinguishes post-fix rows (trusted) from pre-fix rows (missing field = rebuild).
   *  - When `bandMethod` is 'percentile': a percentile-of-pool value (used on both
   *    real-anchor audition pools AND synthetic-only audition pools that were too dispersed
   *    for sigma calibration and fell back to percentile computation).
   *  - When `bandMethod` is 'synthetic-sigma': a sigma-based threshold computed from
   *    mean ± bandSigma × std (used only on tight synthetic-only audition pools). */
  pBand: number;
  /** How this centroid was built:
   *  - 'in-book': from the character's own clean anchor segments (in-book mode)
   *  - 'audition': from the character's audition sample (Task 10 Option-B)
   *  - 'too-short': not enough clean segments; segments scored inconclusive */
  referenceKind: 'in-book' | 'audition' | 'too-short';
  /** #1969 / #3676 — the voice this centroid was computed under, recorded on 'audition' rows and
   *  on 'too-short' rows that had voice info, so resolveCharacterReference can tell when a voice
   *  reassignment has made the persisted reference stale. Absent on 'in-book' rows, on a legacy
   *  row written before this field existed, and on a 'too-short' row computed with no voice
   *  info. An 'audition' row with no recorded voice is treated as unknown and rebuilt; a
   *  'too-short' row with none is reused only while there is still no voice info. */
  auditionVoice?: AuditionVoiceRef;
  /** #3524 — the cast.json voice an 'in-book' row's anchors were pooled from (only lines
   *  rendered in the character's then-current voice count). Recorded only when the character
   *  had a current voice; absent on 'audition'/'too-short' rows and on legacy rows. Lets the
   *  qa-repair route tell when the in-book reference has gone stale after a voice change. */
  inBookVoiceName?: string;
  /** #3524 — marker on a 'too-short' row written for a character that has a current cast voice
   *  but NO rendered line in it yet (reassigned before any re-render, or rendered only on a
   *  fallback engine). It is a conclusive "nothing to check yet", not a reference: it takes the
   *  character off the qa-report's `charactersPending`, is never reused as a reference, and the
   *  next pass that finds a current-voice line rebuilds a real one over it. */
  noCurrentVoiceReference?: true;
  /** A36 fix — detection of pre-fix persisted audition rows. Records which band-computation
   *  method was used on post-fix audition centroid rows:
   *  - 'percentile': percentile-of-pool method (used on real-anchor paths, or on synthetic-only
   *    pools that triggered the dispersion fallback due to high std dev > 0.05).
   *  - 'synthetic-sigma': sigma-based method (mean ± sigma × std; used only on tight synthetic-only
   *    pools with low std dev ≤ 0.05).
   *  Pre-fix rows lack this field entirely — they are detected and rebuilt to apply the current
   *  band-computation logic. Only present on 'audition' referenceKind rows. */
  bandMethod?: 'percentile' | 'synthetic-sigma';
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
 *  character's CURRENT resolved voice name + model key. The caller
 *  (chapter-qa-repair.ts) derives the voice name from the CURRENT cast via
 *  pickVoiceForEngine, but the model key from the snapshot/segFile (NOT the current
 *  cast). Voice name staleness after a reassignment with no re-render is caught here
 *  (#3449). An in-book row is usable when it recorded NO `inBookVoiceName` (a legacy
 *  row, or one built when no current voice was known — kept as before, rebuilt with
 *  the field once a line is rendered in the current voice and `scoreBook` runs) or when that name equals the character's
 *  current voice; a recorded name that differs (or a missing current voice) means the
 *  anchors came from a voice the character no longer has and the row is dropped
 *  (#3524, settles #3517's in-book half). An 'audition' row is
 *  usable ONLY when it recorded a voice identity AND that identity matches the
 *  character's current resolved voice/model — otherwise it is a stale reference
 *  (possibly for a voice the character no longer is) and must not be scored against.
 *  A null/absent current (no resolved voice to compare) is never trusted.
 *  NOTE: this is the repair seam's intentionally CONSERVATIVE subset — it compares
 *  only the voice name + model key. Voice-name changes are caught reliably; same-engine
 *  voice reassignments are caught by voice-name mismatch; Qwen tier changes are NOT
 *  caught here (known gap per #3518). The authoritative scoring gate (`matchesCurrentVoice`
 *  in aggregate.ts) additionally enforces strict language/cloned equality on the next
 *  `scoreBook` pass, which supersedes any residual language-only staleness between a
 *  repair and that pass. */
export function auditionCentroidUsableForCurrent(
  row: CharacterCentroid,
  currentVoiceName: string | undefined,
  currentModelKey: string,
): boolean {
  if (row.referenceKind === 'in-book') {
    return row.inBookVoiceName == null || row.inBookVoiceName === currentVoiceName;
  }
  if (row.referenceKind !== 'audition') return false; // incl. 'too-short'
  if (row.auditionVoice == null || currentVoiceName == null) return false;
  return row.auditionVoice.voiceName === currentVoiceName && row.auditionVoice.modelKey === currentModelKey;
}
