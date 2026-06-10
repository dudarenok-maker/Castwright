/* fe-32 — demand-driven variant work-list. For each Qwen-effective character,
   the in-use emotions (from `usedEmotionsByCharacter`) that don't yet have a
   designed variant. A base voice is NOT required to be COUNTED: the bulk "Both"
   run designs the base first, then its variants, so a not-yet-voiced character
   still represents real variant demand. `hasBase` records whether the task is
   actionable on its own (the "Emotion variants" scope can only synthesise a
   variant on top of an existing base — mirroring the server's design gate in
   cast-design.ts, which skips a variant when the character has no qwen name). */
import type { Character, Emotion } from './types';

export interface VariantTask {
  characterId: string;
  emotions: Emotion[];
  /** True when the character already has a designed Qwen base voice, so its
      variants are designable right now. False = blocked behind a missing base
      (needs the "Both" scope, which designs the base first). */
  hasBase: boolean;
}

/** Build the variant work-list. `isQwen` is supplied by the caller so this
    matches the cast view's "Needs variants" chip exactly (effective project
    engine OR a matched Qwen library voice) — the picker count can't disagree
    with the rows. */
export function buildVariantTasks(
  characters: Character[],
  usedEmotions: Map<string, Set<string>>,
  isQwen: (c: Character) => boolean,
): VariantTask[] {
  const tasks: VariantTask[] = [];
  for (const c of characters) {
    if (!isQwen(c)) continue;
    const used = usedEmotions.get(c.id);
    if (!used || used.size === 0) continue;
    const designed = new Set(Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}));
    const emotions = [...used].filter((e) => !designed.has(e)) as Emotion[];
    if (emotions.length > 0) {
      tasks.push({ characterId: c.id, emotions, hasBase: !!c.overrideTtsVoices?.qwen?.name });
    }
  }
  return tasks;
}

export interface VariantWorkCounts {
  /** Total (character × emotion) variant tasks across the whole cast. */
  totalTasks: number;
  /** Tasks for characters that already have a base voice — designable now. */
  readyTasks: number;
  /** Tasks blocked behind a missing base voice. */
  blockedTasks: number;
  /** Distinct characters whose variant tasks are blocked behind a missing base. */
  blockedChars: number;
}

/** Split a variant work-list into ready (has base) vs blocked (needs a base
    designed first) tallies, for the scope picker's "N ready · M need a base". */
export function variantWorkCounts(tasks: VariantTask[]): VariantWorkCounts {
  let totalTasks = 0;
  let readyTasks = 0;
  let blockedTasks = 0;
  let blockedChars = 0;
  for (const t of tasks) {
    totalTasks += t.emotions.length;
    if (t.hasBase) {
      readyTasks += t.emotions.length;
    } else {
      blockedTasks += t.emotions.length;
      blockedChars += 1;
    }
  }
  return { totalTasks, readyTasks, blockedTasks, blockedChars };
}
