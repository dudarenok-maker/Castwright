/* #3400 — carry the merged-away tombstones (`"chapterId:sentenceId"`) through
   a chapter restructure. A key survives, re-keyed to its chapter's new id with
   the same sentence id, only when the op left that chapter's sentence ids
   unchanged: every remap entry from the old chapter lands in ONE new chapter
   at the same sentence id, and no other old chapter lands there too (a merge).
   Anything else (a merge/split member, a chapter renumbered by a gap, a chapter
   with no live sentence to prove it by) has no correct new key and is dropped.
   Mirrors `carryMergedAwayKeys` in server/src/workspace/restructure.ts — the
   server writes the same result to manuscript-edits.json, and the client's
   save after the remap must agree with it. */

export interface SentenceRemapEntry {
  oldChapterId: number;
  oldSentenceId: number;
  newChapterId: number;
  newSentenceId: number;
}

export function carryMergedAwayKeys(
  keys: readonly string[],
  remap: readonly SentenceRemapEntry[],
): string[] {
  const newIdByOld = new Map<number, number | null>();
  const oldIdsByNew = new Map<number, Set<number>>();
  for (const r of remap) {
    const prior = newIdByOld.get(r.oldChapterId);
    const keeps = r.newSentenceId === r.oldSentenceId;
    newIdByOld.set(
      r.oldChapterId,
      keeps && (prior === undefined || prior === r.newChapterId) ? r.newChapterId : null,
    );
    let olds = oldIdsByNew.get(r.newChapterId);
    if (!olds) oldIdsByNew.set(r.newChapterId, (olds = new Set()));
    olds.add(r.oldChapterId);
  }
  const out: string[] = [];
  for (const key of keys) {
    const [chapter, sentence] = key.split(':');
    const newId = newIdByOld.get(Number(chapter));
    if (newId == null || oldIdsByNew.get(newId)!.size !== 1) continue;
    out.push(`${newId}:${sentence}`);
  }
  return out;
}
