import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';
import type { SentenceOutput } from '../../handoff/schemas.js';
import { priorChapterBoundaryExchange } from '../../routes/script-review.js';

export function buildLabelledChapter(
  chapterText: string,
  sentences: SentenceOutput[],
  chapterId: number,
): LabelledChapter {
  const lines = sentences
    .filter((s) => s.chapterId === chapterId)
    .sort((a, b) => a.id - b.id)
    .map((s) => ({ text: s.text, speakerId: s.characterId }));
  return { chapterText, lines };
}

/* Task 8 — silver skeleton for an UNTUNED chapter. `lines` is seeded purely
   from the book's current attribution (same characterId→speakerId adapter
   map as buildLabelledChapter) — the corrected speakerId labels are authored
   later by a human labelling pass; this just marks the file silver and gives
   it a starting point. `sentences` is expected pre-filtered to the target
   chapter and sorted by id (the caller already has that per-chapter slice;
   unlike buildLabelledChapter there's no chapterId param here to filter by).
   When `priorChapterSentences` is supplied (the prior chapter's raw
   sentences, oldest last-N), the prior chapter's final two-speaker exchange
   is captured via the route's own `priorChapterBoundaryExchange` (fs-64) —
   reused, not reimplemented — and attached as `priorExchange` so a chunk-0
   review run over this fixture is production-faithful. Omitted or a
   non-exchange tail (fewer than two distinct trailing speakers) ⇒
   `priorExchange` is left off the fixture entirely (schema-optional). */
export function buildSilverSkeleton(
  chapterText: string,
  sentences: SentenceOutput[],
  roster: Array<{ id: string; name: string }>,
  priorChapterSentences?: Array<{
    id: number;
    characterId: string;
    text: string;
    excludeFromSynthesis?: boolean;
  }>,
): LabelledChapter {
  const lines = sentences
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((s) => ({ text: s.text, speakerId: s.characterId }));
  const priorExchange = priorChapterSentences
    ? priorChapterBoundaryExchange(priorChapterSentences, roster) ?? undefined
    : undefined;
  return {
    chapterText,
    lines,
    ...(priorExchange ? { priorExchange } : {}),
  };
}

export function buildRosterSnapshot(
  cast: Array<{ id: string; name?: string; gender?: 'male' | 'female' | 'neutral'; aliases?: string[] }>,
): RosterSnapshot {
  return {
    characters: cast.map((c) => {
      const out: RosterSnapshot['characters'][number] = { id: c.id, name: c.name ?? c.id };
      if (c.gender) out.gender = c.gender;
      if (c.aliases) out.aliases = c.aliases;
      return out;
    }),
  };
}
