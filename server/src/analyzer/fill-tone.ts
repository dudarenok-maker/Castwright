import { normaliseNameKey } from '../util/safe-id.js';
import type { CharacterOutput } from '../handoff/schemas.js';

type Axis = 'warmth' | 'pace' | 'authority' | 'emotion';

/* Keyword → axis deltas off a neutral 50 baseline. Keys are normaliseNameKey'd
   (script-exact, case-insensitive) EN + RU descriptors. Extend from corpus. */
const NUDGES: Record<string, Partial<Record<Axis, number>>> = {
  [normaliseNameKey('weary')]: { pace: -15, emotion: -10 },
  [normaliseNameKey('tired')]: { pace: -15, emotion: -10 },
  [normaliseNameKey('усталый')]: { pace: -15, emotion: -10 },
  [normaliseNameKey('устал')]: { pace: -15, emotion: -10 },
  [normaliseNameKey('pragmatic')]: { authority: 15, warmth: -10 },
  [normaliseNameKey('прагматичный')]: { authority: 15, warmth: -10 },
  [normaliseNameKey('playful')]: { emotion: 15, pace: 10 },
  [normaliseNameKey('игривый')]: { emotion: 15, pace: 10 },
  [normaliseNameKey('wise')]: { authority: 15, warmth: 10 },
  [normaliseNameKey('мудрый')]: { authority: 15, warmth: 10 },
  [normaliseNameKey('наставнический')]: { authority: 15, warmth: 10 },
  [normaliseNameKey('silent')]: { pace: -10, emotion: -10 },
  [normaliseNameKey('observant')]: { pace: -10, emotion: -10 },
  [normaliseNameKey('немногословный')]: { pace: -10, emotion: -10 },
  [normaliseNameKey('enigmatic')]: { warmth: -5, authority: 5, emotion: -5 },
  [normaliseNameKey('загадочный')]: { warmth: -5, authority: 5, emotion: -5 },
  // …extend as real runs surface more descriptor words.
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function fillToneFromAttributes(ch: CharacterOutput): CharacterOutput {
  const derived: Record<Axis, number> = { warmth: 50, pace: 50, authority: 50, emotion: 50 };
  for (const attr of ch.attributes ?? []) {
    const nudge = NUDGES[normaliseNameKey(attr)];
    if (!nudge) continue;
    for (const axis of Object.keys(nudge) as Axis[]) {
      derived[axis] += nudge[axis]!;
    }
  }
  const existing = ch.tone ?? {};
  const tone = {
    warmth: existing.warmth ?? clamp(derived.warmth),
    pace: existing.pace ?? clamp(derived.pace),
    authority: existing.authority ?? clamp(derived.authority),
    emotion: existing.emotion ?? clamp(derived.emotion),
  };
  return { ...ch, tone };
}
