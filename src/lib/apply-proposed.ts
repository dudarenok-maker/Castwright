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

export interface ProposedNameGroup {
  /** First-seen display form of the name (for the form header). */
  name: string;
  /** The proposed fields to seed the create form with (first op's proposal). */
  proposed: { name: string; gender?: string; ageRange?: string };
  /** Every off-roster reattribute line sharing this normalized name. */
  ops: ReviewOpWithChapter[];
}

/** Split a batch of off-roster `reattribute` ops (each carrying `op.proposed`)
    into (a) one group per NEW normalized name — the names that need a single
    create-character confirm — and (b) the flat list of ops whose proposed name
    already matches a live cast member, which need no form (applied straight
    through the roster-seeded `applyProposedReattributions`). Pure. */
export function consolidateProposedByName(
  proposed: ReviewOpWithChapter[],
  rosterNames: ReadonlySet<string>,
): { newGroups: ProposedNameGroup[]; rosterMatchedOps: ReviewOpWithChapter[] } {
  const groups = new Map<string, ProposedNameGroup>();
  const rosterMatchedOps: ReviewOpWithChapter[] = [];
  for (const op of proposed) {
    if (!op.proposed) continue;
    const key = norm(op.proposed.name);
    if (rosterNames.has(key)) {
      rosterMatchedOps.push(op);
      continue;
    }
    const g = groups.get(key);
    if (g) g.ops.push(op);
    else groups.set(key, { name: op.proposed.name, proposed: op.proposed, ops: [op] });
  }
  return { newGroups: [...groups.values()], rosterMatchedOps };
}
