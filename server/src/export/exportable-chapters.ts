/* #3507 — the chapters an export covers, shared by the route's pre-flight and
   every chapter-audio builder: non-excluded, sorted by id, minus a chapter with
   no narratable text and no live audio (generation skips it and counts it
   complete, so there is nothing to export for it).

   When that would leave nothing, nothing is dropped: each chapter then fails the
   caller's missing-audio check, so an empty archive is never written. A book
   with no manuscriptId, or an analysis cache that fails to load, drops nothing
   either. */

import { isNoTextChapter, loadAnalysisCache } from '../store/analysis-cache.js';
import { findChapterAudio } from '../workspace/chapter-take.js';
import { audioDir } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';

export async function exportableChapters(
  bookDir: string,
  state: BookStateJson,
): Promise<BookStateJson['chapters']> {
  const included = [...state.chapters].filter((c) => !c.excluded).sort((a, b) => a.id - b.id);
  if (!state.manuscriptId) return included;
  let cache: Awaited<ReturnType<typeof loadAnalysisCache>>;
  try {
    cache = await loadAnalysisCache(state.manuscriptId);
  } catch {
    return included;
  }
  const root = audioDir(bookDir);
  const covered = included.filter(
    (c) => !(isNoTextChapter(cache, c.id) && !findChapterAudio(root, c.slug)),
  );
  return covered.length > 0 ? covered : included;
}
