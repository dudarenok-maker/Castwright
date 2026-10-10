/* Plan 70c — analysis-cache rebuild from manuscript-edits.json.

   The merge / split / reorder routes used to delete the cache outright on
   every successful restructure, on the theory that the cache's outer
   chapter-id keying was now stale. But generation reads from the cache
   directly (server/src/routes/generation.ts) and halts when it's empty —
   so any post-merge Generate fired "No analysed sentences cached for this
   book. Re-run analysis first." even though manuscript-edits.json still
   held every surviving sentence with its characterId + text.

   This helper re-derives the cache's `chapters` map from manuscript-edits
   .json. Sentence shape matches: SentenceOutput requires { id, chapterId,
   characterId, text } and accepts optional `confidence`, all of which
   manuscript-edits.json carries through the remap. chapterCast /
   stage1 / castDurations / failedChapterIds are carried forward
   unchanged from any prior cache — generation doesn't read them, but
   keeping them avoids dropping observed-rate samples that the analyzer
   uses on resume.

   Plan 287 spec 2.2 — two modes. `'overlay'` (the default) lays the edits
   over the prior chapters map instead of replacing it: the edits carry no
   `[]` take (a chapter with no sentences contributes no rows) and no excluded
   chapter, so replacing the map deleted those keys, and a chapter's own key is
   what makes it "analysed" (`hasCurrentTake`). Overlay never changes the
   pending set, the failure records, `takesPersisted` or `confirmReached`.
   `'replace'` is today's behaviour, for restructure, which renumbers ids. */

import type { SentenceOutput } from '../handoff/schemas.js';
import { readJson } from '../workspace/state-io.js';
import {
  clearAnalysisCache,
  loadAnalysisCache,
  saveAnalysisCache,
} from './analysis-cache.js';

interface EditsFile {
  sentences?: SentenceOutput[];
}

export interface RebuildCacheOptions {
  /** Default `'overlay'`. */
  mode?: 'overlay' | 'replace';
  /** Overlay only: the chapters excluded in state.json, whose prior take is
      kept although the edits do not carry it. */
  excludedChapterIds?: readonly number[];
}

export async function rebuildCacheFromEdits(
  manuscriptId: string,
  editsPath: string,
  opts: RebuildCacheOptions = {},
): Promise<void> {
  const mode = opts.mode ?? 'overlay';
  const edits = await readJson<EditsFile>(editsPath);
  const sentences = edits?.sentences ?? [];
  if (sentences.length === 0 && mode === 'replace') {
    // Genuinely no analysis-derived sentences on disk — there is nothing
    // to rebuild. Drop any prior cache so the next access starts clean
    // rather than serving stale data.
    await clearAnalysisCache(manuscriptId);
    return;
  }
  const prior = await loadAnalysisCache(manuscriptId);
  const chapters: Record<number, SentenceOutput[]> = {};
  for (const s of sentences) {
    (chapters[s.chapterId] ??= []).push(s);
  }
  for (const list of Object.values(chapters)) {
    list.sort((a, b) => a.id - b.id);
  }
  if (mode === 'overlay') {
    /* A chapter the edits carry has replaced its prior entry wholesale above, so
       a sentence the user deleted (tombstoned) cannot come back. A prior chapter
       the edits do not carry is kept only if it is `[]` or excluded; any other
       is an intended removal (the user emptied it) and its key goes. */
    const excluded = new Set(opts.excludedChapterIds ?? []);
    for (const [key, prevSentences] of Object.entries(prior.chapters ?? {})) {
      const id = Number(key);
      if (Object.hasOwn(chapters, id)) continue;
      if (prevSentences.length === 0 || excluded.has(id)) chapters[id] = prevSentences;
    }
  }
  await saveAnalysisCache(manuscriptId, { ...prior, chapters });
}
