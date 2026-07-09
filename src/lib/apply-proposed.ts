import type { ReviewOpWithChapter } from '../store/script-review-slice';

export interface ApplyProposedDeps {
  rosterByName: Map<string, { id: string }>;
  createCharacter: (p: { name: string; gender?: string; ageRange?: string }) => Promise<{ id: string; name: string }>;
  addCharacter: (c: { id: string; name: string }) => void;
  setSentenceCharacter: (chapterId: number, sentenceId: number, characterId: string) => void;
  onBoundaryMove: (chapterId: number) => void;
  isSameBook: () => boolean;
  /** Fires immediately after EVERY successfully-applied op, including one
      that reused an existing/memoized id and never called createCharacter
      (design spec §6.5) — lets the caller resolve this op server-side
      one at a time, so a later op's failure never causes an earlier,
      genuinely-applied op to be left unresolved or a not-yet-applied one
      to be resolved by mistake. */
  onOpApplied: (op: ReviewOpWithChapter) => void;
}

const norm = (s: string) => s.trim().toLowerCase();

/* fs-58 Unit B — off-roster reattribute apply. INTERLEAVED create→reassign so a
   cancel/failure leaves a self-consistent partial (no created member without a
   line). Dedup by normalized name against roster ∪ createdThisBatch BEFORE the
   POST. Re-check isSameBook() after every await (concurrent-multi-book guard). */
export async function applyProposedReattributions(
  proposed: ReviewOpWithChapter[],
  deps: ApplyProposedDeps,
): Promise<{ created: number; createdCharacters: { id: string; name: string }[]; aborted: boolean }> {
  const memo = new Map<string, string>(); // normName -> id created this batch
  const createdCharacters: { id: string; name: string }[] = [];
  let created = 0;
  for (const op of proposed) {
    if (!op.proposed) continue;
    const key = norm(op.proposed.name);
    let id = deps.rosterByName.get(key)?.id ?? memo.get(key);
    if (!id) {
      const c = await deps.createCharacter(op.proposed);
      if (!deps.isSameBook()) return { created, createdCharacters, aborted: true };
      deps.addCharacter(c);
      id = c.id;
      memo.set(key, id);
      createdCharacters.push({ id: c.id, name: c.name });
      created += 1;
    }
    deps.setSentenceCharacter(op.chapterId, op.id, id);
    deps.onBoundaryMove(op.chapterId);
    deps.onOpApplied(op);
  }
  return { created, createdCharacters, aborted: false };
}
