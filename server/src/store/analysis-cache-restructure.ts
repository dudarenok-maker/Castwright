import type { AnalysisCache } from './analysis-cache.js';

/** #3506 — move every chapter-keyed record of an analysis cache through a
    chapter restructure. `chapterCast`, `castDurations`, `stage2Durations`,
    `failedChapterIds`, `failedChapterErrors` and the pending set P
    (`pendingAttributionChapterIds`) are handled in two steps:
    1. carry: an entry whose OLD id is in `idMap` moves to the mapped NEW id,
       value untouched; an entry whose old id is not in `idMap` is dropped (the
       chapter no longer exists).
    2. reset: each NEW id in `resetNewIds` loses its entries in the first five
       and joins P, so the chapter is re-analysed. It need not have had any.
    Two old ids mapping to one new id throws: a merge has no single record to
    carry, so the caller must resolve it first. A member absent from the input
    stays absent (a reset may add P). `chapters` is not touched — a restructure
    rebuilds the takes from `manuscript-edits.json`. Pure: no I/O, the input is
    not mutated. */
export function remapCacheChapterKeys(
  cache: AnalysisCache,
  idMap: ReadonlyMap<number, number>,
  resetNewIds: ReadonlySet<number>,
): AnalysisCache {
  const oldIdByNew = new Map<number, number>();
  for (const [oldId, newId] of idMap) {
    const other = oldIdByNew.get(newId);
    if (other !== undefined) {
      throw new Error(
        `remapCacheChapterKeys: old chapters ${other} and ${oldId} both map to new chapter ${newId}`,
      );
    }
    oldIdByNew.set(newId, oldId);
  }

  const carryRecord = <T>(record: Record<string | number, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(record)) {
      const newId = idMap.get(Number(key));
      if (newId !== undefined && !resetNewIds.has(newId)) out[String(newId)] = value;
    }
    return out;
  };
  const sortedUnique = (ids: Iterable<number>): number[] => [...new Set(ids)].sort((a, b) => a - b);
  const carryIds = (ids: readonly number[]): number[] =>
    sortedUnique(ids.flatMap((id) => idMap.get(id) ?? []));

  const out: AnalysisCache = { ...cache };
  if (cache.chapterCast) out.chapterCast = carryRecord(cache.chapterCast);
  if (cache.castDurations) out.castDurations = carryRecord(cache.castDurations);
  if (cache.stage2Durations) out.stage2Durations = carryRecord(cache.stage2Durations);
  if (cache.failedChapterErrors) {
    out.failedChapterErrors = carryRecord(cache.failedChapterErrors);
  }
  if (cache.failedChapterIds) {
    out.failedChapterIds = carryIds(cache.failedChapterIds).filter((id) => !resetNewIds.has(id));
  }
  if (cache.pendingAttributionChapterIds || resetNewIds.size > 0) {
    out.pendingAttributionChapterIds = sortedUnique([
      ...carryIds(cache.pendingAttributionChapterIds ?? []),
      ...resetNewIds,
    ]);
  }
  return out;
}
