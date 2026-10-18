/* #3711 — the two-span pattern's re-validation token. A quick route that parses
   the manuscript BEFORE taking `book-op` (reparse, chapters restructure) records
   this fingerprint with the parse, then compares it again once it holds the
   lock: a mismatch means the manuscript changed while it was being prepared.
   `mtimeMs` and `size` survive a folder rename, so a move alone never trips it. */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeSegment } from '../util/safe-path.js';

export interface ManuscriptFingerprint {
  manuscriptFile: string;
  size: number;
  mtimeMs: number;
}

/** The fingerprint of `<bookDir>/<manuscriptFile>`, or null if it cannot be stat'ed. */
export async function manuscriptFingerprint(
  bookDir: string,
  manuscriptFile: string,
): Promise<ManuscriptFingerprint | null> {
  try {
    const s = await stat(join(bookDir, safeSegment(manuscriptFile)));
    return { manuscriptFile, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

export function sameFingerprint(a: ManuscriptFingerprint | null, b: ManuscriptFingerprint | null): boolean {
  if (a === null || b === null) return a === b;
  return a.manuscriptFile === b.manuscriptFile && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
