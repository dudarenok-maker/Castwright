/* Which Qwen base tiers ONE chapter's synth calls will use (#1393, plan 293 §2.1).

   The generation path used to keep `computeUsedQwenTiers(cast.characters, …)`,
   which walks the WHOLE cast: a silent Qwen cast member pinned its tier
   (blind-spot A), and so did a character that falls back to Kokoro
   (blind-spot B). This helper narrows the answer to the speakers of one
   chapter, with the render's Kokoro fallback taken into account.

   PURE: no fs, no network, no `await`. It composes the render's own
   primitives (`buildSentenceGroups`, `buildCastResolver`,
   `resolveCharacterEngine`, `resolveCharacterQwenTier`,
   `computeQwenKokoroFallbackSet`, `resolveNarratorCharacterId`) rather than
   re-implementing any of them. Nothing calls it yet. */

import type { SentenceOutput } from '../handoff/schemas.js';
import { buildCastResolver } from '../store/cast-resolve.js';
import type { CastIdHistory } from '../store/cast-id-history.js';
import type { TtsEngine } from './index.js';
import type { TtsModelKey } from './model-keys.js';
import { resolveCharacterEngine, resolveCharacterQwenTier } from './per-character-engine.js';
import { computeQwenKokoroFallbackSet } from './qwen-fallback-set.js';
import {
  buildSentenceGroups,
  resolveNarratorCharacterId,
  type CastCharacter,
} from './synthesise-chapter.js';

export interface ChapterQwenTierNeedsInput {
  sentences: SentenceOutput[];
  /** Hydrated cast, after the non-English engine forcing. */
  cast: CastCharacter[];
  castIdHistory?: Pick<CastIdHistory, 'supersededBy' | 'rejected' | 'rejectedPairs'>;
  defaultEngine: TtsEngine;
  /** The run key, canonicalised to Qwen. */
  runQwenModelKey: TtsModelKey;
  qwenUnavailable: boolean;
  includesTitleBeat: boolean;
  /** The caller's narrator id; defaults to `'narrator'` like the render. */
  narratorCharacterId?: string;
}

const hasVariantSlot = (c: CastCharacter): boolean =>
  Object.keys(c.overrideTtsVoices?.qwen?.variants ?? {}).length > 0;

export function chapterQwenTierNeeds(input: ChapterQwenTierNeedsInput): {
  keep06: boolean;
  keep17: boolean;
} {
  if (input.qwenUnavailable) return { keep06: false, keep17: false };

  const castById = new Map<string, CastCharacter>();
  for (const c of input.cast) if (!castById.has(c.id)) castById.set(c.id, c);
  const narratorId = resolveNarratorCharacterId(
    (id) => castById.has(id),
    input.narratorCharacterId ?? 'narrator',
  );
  const narrator: CastCharacter = castById.get(narratorId) ?? { id: narratorId, name: 'Narrator' };

  const resolver = buildCastResolver(input.cast, input.castIdHistory);
  const speakers = new Map<string, CastCharacter>();
  const add = (c: CastCharacter) => {
    if (!speakers.has(c.id)) speakers.set(c.id, c);
  };
  for (const g of buildSentenceGroups(input.sentences)) {
    const id = resolver.resolve(g.characterId)?.character.id;
    add((id !== undefined ? castById.get(id) : undefined) ?? narrator);
  }
  if (input.includesTitleBeat) add(narrator);

  const list = [...speakers.values()];
  const silent = new Set(computeQwenKokoroFallbackSet(list, input.defaultEngine).map((c) => c.id));

  let keep06 = false;
  let keep17 = false;
  for (const c of list) {
    if (resolveCharacterEngine(c, input.defaultEngine) !== 'qwen') continue;
    const tier = resolveCharacterQwenTier(c, input.runQwenModelKey);
    if (silent.has(c.id) && !(tier === 'qwen3-tts-0.6b' && hasVariantSlot(c))) continue;
    if (tier === 'qwen3-tts-0.6b') keep06 = true;
    if (tier === 'qwen3-tts-1.7b') keep17 = true;
  }
  return { keep06, keep17 };
}
