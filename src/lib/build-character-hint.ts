/* Packs a Character into the shape the server's voice-mapping wants.
   Evidence quotes drive the sample script (so each voice reads a real line
   from the manuscript); gender/ageRange/tone/description steer the
   prebuilt-voice picker. Fields the analyzer didn't fill in are omitted —
   server handles missing data.

   The optional `overrides` lets callers (drawer, compare modal) feed dirty
   un-saved edits without mutating the source Character. Each override key
   replaces the value when provided; pass `undefined` to fall back to the
   character's stored value. */

import type { Character } from './types';
import type { VoiceSampleArgs } from './api';

type CharacterHint = NonNullable<VoiceSampleArgs['characterHint']>;
type HintOverrides = Partial<Pick<Character, 'gender' | 'ageRange' | 'tone'>>;

export function buildCharacterHint(c: Character, overrides?: HintOverrides): CharacterHint {
  const evidence = (c.evidence ?? [])
    .map((e) => e.quote)
    .filter((q): q is string => typeof q === 'string' && q.length > 0);
  const gender = overrides && 'gender' in overrides ? overrides.gender : c.gender;
  const ageRange = overrides && 'ageRange' in overrides ? overrides.ageRange : c.ageRange;
  const tone = overrides && 'tone' in overrides ? overrides.tone : c.tone;
  return {
    description: c.description,
    role: c.role,
    gender,
    ageRange,
    tone,
    evidence: evidence.length ? evidence : undefined,
  };
}
