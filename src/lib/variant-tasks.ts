/* fe-32 — demand-driven variant work-list. Mirrors `countMissingVariants`
   (src/lib/voice-status.ts): for each Qwen character that HAS a base voice, the
   in-use emotions (from `usedEmotionsByCharacter`) that don't yet have a designed
   variant. A character missing its base is excluded — a variant needs a base. */
import type { Character, Emotion } from './types';

function isQwenWithBase(c: Character): boolean {
  return c.ttsEngine === 'qwen' && !!c.overrideTtsVoices?.qwen?.name;
}

export interface VariantTask {
  characterId: string;
  emotions: Emotion[];
}

export function buildVariantTasks(
  characters: Character[],
  usedEmotions: Map<string, Set<string>>,
): VariantTask[] {
  const tasks: VariantTask[] = [];
  for (const c of characters) {
    if (!isQwenWithBase(c)) continue;
    const used = usedEmotions.get(c.id);
    if (!used || used.size === 0) continue;
    const designed = new Set(Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}));
    const emotions = [...used].filter((e) => !designed.has(e)) as Emotion[];
    if (emotions.length > 0) tasks.push({ characterId: c.id, emotions });
  }
  return tasks;
}

export function variantWorkCounts(
  characters: Character[],
  usedEmotions: Map<string, Set<string>>,
): number {
  return buildVariantTasks(characters, usedEmotions).reduce((n, t) => n + t.emotions.length, 0);
}
