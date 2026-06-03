/* fs-25 — legacy inline audio-tag → structured emotion seed.

   The previous per-quote work injected bracketed cues (`[shouting]`, `[excited]`,
   …) into `sentence.text` (parsers/audio-tags.ts). Those tags drove ZERO local
   audio (every local engine strips them via normaliseForTts) and were only a
   display layer. fs-25 retires them in favour of the structured `Sentence.emotion`
   field. This module absorbs the heuristic signal: map the emotion-equivalent
   tags onto the emotion enum and strip ALL known tags from the stored text.

   Used at two sites:
   - new books: applied as sentences are persisted to the analysis cache, so
     freshly-parsed `[tags]` become `emotion` + clean text (idempotent);
   - existing books: the one-time migration (scripts/migrate-emotion-from-tags.mjs).

   Non-emotion paralinguistic cues (emphatic/laughs/sighs/hesitant) have no
   emotion equivalent — they map to null and are simply stripped. */

import { AUDIO_TAGS, type AudioTag } from '../parsers/audio-tags.js';
import type { Emotion } from './schemas.js';

/** Map the legacy audio-tag vocabulary onto the fs-25 emotion enum. Only the
    emotion-equivalent tags map; the rest are paralinguistic/emphasis cues with
    no emotion (null → stripped, no emotion set). */
export const EMOTION_FROM_TAG: Record<AudioTag, Emotion | null> = {
  shouting: 'angry',
  whispers: 'whisper',
  excited: 'excited',
  emphatic: null,
  laughs: null,
  sighs: null,
  hesitant: null,
};

const ALL_TAGS_RE = new RegExp(`\\s*\\[(?:${AUDIO_TAGS.join('|')})\\]\\s*`, 'gi');
const TAG_TOKEN_RE = new RegExp(`\\[(${AUDIO_TAGS.join('|')})\\]`, 'gi');

/** Strip every known inline audio tag from `text`, and — only when
    `currentEmotion` is unset — derive an emotion from the first emotion-mapping
    tag present. Pure + idempotent: clean text returns unchanged with the
    passed-through emotion. `currentEmotion` (a manual or analyzer-set value)
    always wins; the tag heuristic never overrides it. */
export function extractInlineEmotion(
  text: string,
  currentEmotion?: Emotion,
): { text: string; emotion?: Emotion } {
  let emotion = currentEmotion;
  if (!emotion) {
    for (const m of text.matchAll(TAG_TOKEN_RE)) {
      const mapped = EMOTION_FROM_TAG[m[1].toLowerCase() as AudioTag];
      if (mapped) {
        emotion = mapped;
        break;
      }
    }
  }
  const cleaned = text.replace(ALL_TAGS_RE, ' ').replace(/\s+/g, ' ').trim();
  return { text: cleaned, emotion };
}
