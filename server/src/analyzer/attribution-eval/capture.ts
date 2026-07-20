import type { LabelledChapter } from './schema.js';
import type { RosterSnapshot } from './roster-schema.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

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
