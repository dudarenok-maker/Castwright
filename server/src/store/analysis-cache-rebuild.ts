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
   uses on resume. */

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

export async function rebuildCacheFromEdits(
  manuscriptId: string,
  editsPath: string,
): Promise<void> {
  const edits = await readJson<EditsFile>(editsPath);
  const sentences = edits?.sentences ?? [];
  if (sentences.length === 0) {
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
  await saveAnalysisCache(manuscriptId, { ...prior, chapters });
}
