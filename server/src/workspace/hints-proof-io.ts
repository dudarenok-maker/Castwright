/* The manuscript-edits.json read for the parse-fallback hints-pairing check
   (#3837, plan 290). Both seams call it: analysis start (which must not read the
   file itself — `analysis.edits-routing.guard.test.ts` pins every
   `manuscriptEditsJsonPath(` site in analysis.ts to the ordered write queue) and
   the restructure routes.

   It never throws. Every outcome is a kind, so the pre-leaf seam falls back to
   main's rule on anything but `ok`, and the leaf seam can rethrow exactly what
   `readJson` throws today (`corrupt` carries the SyntaxError, `unreadable` the
   read error). */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { manuscriptEditsJsonPath } from './paths.js';

export type EditsForCheck =
  | { kind: 'absent' } // ENOENT
  | { kind: 'corrupt'; error: SyntaxError } // JSON.parse failed (after the BOM strip)
  | { kind: 'unreadable'; error: unknown } // any other read error
  | { kind: 'ok'; value: unknown; sha256: string }; // parsed JSON + sha of the bytes read

export async function readEditsForHintsCheck(bookDir: string): Promise<EditsForCheck> {
  let bytes: Buffer;
  try {
    bytes = await readFile(manuscriptEditsJsonPath(bookDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', error };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  /* Strip a leading UTF-8 BOM exactly as `readJson` does (workspace/state-io.ts):
     Windows editors and PowerShell 5.1 write one, and readJson accepts the file. */
  const raw = bytes.toString('utf8');
  const stripped = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
  try {
    return { kind: 'ok', value: JSON.parse(stripped) as unknown, sha256 };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'corrupt', error };
    return { kind: 'unreadable', error };
  }
}

/** The `sentences` array of a parsed edits file; `[]` for anything without one.
    Entries that are not objects are dropped (a hand-edited file), so the check
    can read their fields without a guard. */
export function sentencesOf(value: unknown): Array<{ chapterId: number; text?: unknown; vocalization?: boolean }> {
  const sentences = (value as { sentences?: unknown } | null | undefined)?.sentences;
  if (!Array.isArray(sentences)) return [];
  return sentences.filter(
    (s): s is { chapterId: number; text?: unknown; vocalization?: boolean } => typeof s === 'object' && s !== null,
  );
}
