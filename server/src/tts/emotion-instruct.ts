import type { Emotion } from '../handoff/schemas';

/* fs-57 §4.1 — synth-side fallback: when a 1.7B liveInstruct sentence has an
   emotion but no explicit instruct, derive an English delivery phrase. Kept
   here (not the analyzer) so the phrase vocabulary can evolve without
   re-analysis. neutral/absent ⇒ no instruct (plain ICL clone). */
const PHRASES: Record<Exclude<Emotion, 'neutral'>, string> = {
  whisper: 'in a soft, breathy whisper',
  angry: 'in an angry, raised voice',
  excited: 'with bright, energetic excitement',
  sad: 'in a subdued, downcast tone',
};

export function emotionToInstruct(emotion: Emotion | undefined): string | undefined {
  if (!emotion || emotion === 'neutral') return undefined;
  return PHRASES[emotion];
}
