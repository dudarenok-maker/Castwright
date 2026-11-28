/* #3507 — seeds the on-disk analysis cache an export test book's manuscriptId
   points at. The cache dir is shared by every test file, so each caller uses a
   manuscriptId no other file uses and removes it again. */

import { rm, writeFile } from 'node:fs/promises';
import { cachePath, saveAnalysisCache } from '../store/analysis-cache.js';

/** `words` — a take with one attributed line; `empty` — a `[]` take. */
export type SeededTake = 'words' | 'empty';

export async function seedTakes(
  manuscriptId: string,
  takes: Record<number, SeededTake>,
  failedChapterIds: number[] = [],
): Promise<void> {
  await saveAnalysisCache(manuscriptId, {
    chapters: Object.fromEntries(
      Object.entries(takes).map(([id, take]) => [
        id,
        take === 'empty'
          ? []
          : [{ id: 1, chapterId: Number(id), characterId: 'narrator', text: 'Words.' }],
      ]),
    ),
    failedChapterIds,
  });
}

/** A cache file that exists but cannot be loaded. */
export async function seedCorruptCache(manuscriptId: string): Promise<void> {
  await writeFile(cachePath(manuscriptId), '{ "chapters": { "1": "not-a-list" } }', 'utf8');
}

export async function removeTakes(manuscriptId: string): Promise<void> {
  await rm(cachePath(manuscriptId), { force: true });
}
