/* srv-50 — shared post-fold sentence loader. Extracted byte-for-byte from the
   duplicate copies that fs-58 deliberately kept in annotate-emotion.ts and
   script-review.ts (to avoid cross-route coupling at build time). Hoisting it
   here means the two routes can't silently drift if one ever gets a
   reconciliation bugfix. Behaviour is identical to the originals. */

import { manuscriptEditsJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { loadAnalysisCache } from './analysis-cache.js';
import type { SentenceOutput } from '../handoff/schemas.js';

/* Load the book's POST-FOLD attributed sentences grouped by chapter — the
   same source synth + the manuscript view use. Prefers manuscript-edits.json
   (the folded, user-edited list) when present, falling back to the analysis
   cache. Mirrors the reconciliation in book-state.ts: keep an edit sentence
   when its id still exists in the cache (or exceeds the max cache id, i.e. a
   user-created split offspring). */
export async function loadPostFoldSentencesByChapter(
  manuscriptId: string,
  bookDir: string,
): Promise<Map<number, SentenceOutput[]>> {
  const cache = await loadAnalysisCache(manuscriptId);
  const cachedSentences = Object.values(cache.chapters ?? {}).flat();
  const edits = await readJson<{ sentences?: SentenceOutput[] }>(manuscriptEditsJsonPath(bookDir));

  let sentences: SentenceOutput[];
  if (edits && Array.isArray(edits.sentences) && edits.sentences.length > 0) {
    if (cachedSentences.length > 0) {
      const cacheIds = new Set<number>();
      let maxCacheId = 0;
      for (const s of cachedSentences) {
        cacheIds.add(s.id);
        if (s.id > maxCacheId) maxCacheId = s.id;
      }
      sentences = edits.sentences.filter(
        (s) => typeof s?.id !== 'number' || cacheIds.has(s.id) || s.id > maxCacheId,
      );
    } else {
      sentences = edits.sentences;
    }
  } else {
    sentences = cachedSentences;
  }

  const byChapter = new Map<number, SentenceOutput[]>();
  for (const s of sentences) {
    if (typeof s?.chapterId !== 'number') continue;
    const bucket = byChapter.get(s.chapterId);
    if (bucket) bucket.push(s);
    else byChapter.set(s.chapterId, [s]);
  }
  return byChapter;
}
