/* Per-book diminutive merge suggestions sibling file.

   The dedup pass (roster-dedup.ts Tier-2b) produces SUGGESTIONS rather than
   hard merges for diminutive pairs — e.g. "Оля + Ольга — same person?". These
   persist to a sibling file (NOT inside cast.json) so the UI can surface them
   across browser reloads and re-analyses without the cast.json envelope
   stripping them.

   Lifecycle:
     - `writeSuggestions` — called at dedup finalisation (Task 10); overwrites
       the whole file with the latest dedup pass result.
     - `loadSuggestions` — called by the suggestions route (Task 11); returns
       `{ suggestions: [] }` when the file is absent or malformed.
     - `clearSuggestions` — called on `fresh: true` re-analysis alongside
       `clearCastMerges` (Task 10); no-op when absent.
     - `dismissSuggestion` — called when the user rejects a suggestion; removes
       the matching pair and rewrites the file.

   Same atomic-write + empty-on-missing contract as store/cast-merges.ts. */

import { rm } from 'node:fs/promises';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { castMergeSuggestionsJsonPath } from '../workspace/paths.js';
import type { MergeSuggestion } from '../analyzer/roster-dedup.js';

export type { MergeSuggestion };

export interface CastMergeSuggestionsFile {
  suggestions: MergeSuggestion[];
}

/** Load the suggestions file; returns `{ suggestions: [] }` when absent or malformed. */
export async function loadSuggestions(bookDir: string): Promise<CastMergeSuggestionsFile> {
  const existing = await readJson<CastMergeSuggestionsFile>(
    castMergeSuggestionsJsonPath(bookDir),
  );
  if (existing && Array.isArray(existing.suggestions)) return existing;
  return { suggestions: [] };
}

/** Atomically overwrite the suggestions file with the latest dedup pass result. */
export async function writeSuggestions(
  bookDir: string,
  suggestions: MergeSuggestion[],
): Promise<void> {
  await writeJsonAtomic(castMergeSuggestionsJsonPath(bookDir), { suggestions });
}

/** Delete the suggestions file. No-op when absent. */
export async function clearSuggestions(bookDir: string): Promise<void> {
  await rm(castMergeSuggestionsJsonPath(bookDir), { force: true });
}

/** Remove the suggestion matching `sourceId`+`targetId` and write back.
    No-op when the pair is not found or the file is absent. */
export async function dismissSuggestion(
  bookDir: string,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const file = await loadSuggestions(bookDir);
  const filtered = file.suggestions.filter(
    (s) => !(s.sourceId === sourceId && s.targetId === targetId),
  );
  await writeSuggestions(bookDir, filtered);
}
