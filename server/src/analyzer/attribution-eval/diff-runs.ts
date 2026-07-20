import type { SentenceOutput } from '../../handoff/schemas.js';

const LOW = 0.75;

export function diffRuns(baseline: SentenceOutput[], tuned: SentenceOutput[]) {
  const lowCount = (arr: SentenceOutput[]) => arr.filter((s) => (s.confidence ?? 1) < LOW).length;
  const byId = new Map(baseline.map((s) => [s.id, s]));
  const changed = [];
  for (const t of tuned) {
    const b = byId.get(t.id);
    if (b && b.characterId !== t.characterId) {
      changed.push({ id: t.id, chapterId: t.chapterId, text: t.text, from: b.characterId, to: t.characterId });
    }
  }
  return { lowConfDelta: lowCount(tuned) - lowCount(baseline), changed };
}
