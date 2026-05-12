/* Client-side port of server/src/tts/voice-mapping.ts. Server is the source of
   truth — it picks the voice that actually gets synthesised. This module
   exists so the cast view can label characters that aren't in the voices
   library yet (fresh analysis, pre-confirm) without round-tripping to the
   backend just to render a chip.

   Keep the deterministic hash + the profile buckets in sync with
   server/src/tts/voice-mapping.ts, or the label here drifts from what the
   user hears. The Voice-library response (GET /api/voices) is authoritative;
   prefer reading `voice.ttsVoice` when it's available. */

import type { Character } from './types';

export interface TtsVoiceAssignment {
  provider: 'gemini';
  name: string;
  description: string;
}

type Gender = 'male' | 'female' | 'unknown';
type Register = 'deep' | 'mid' | 'light';
type VoiceProfile =
  | 'male-deep' | 'male-mid' | 'male-light'
  | 'female-deep' | 'female-mid' | 'female-light'
  | 'narrator-warm' | 'narrator-cool';

const PROFILE_VOICES: Record<VoiceProfile, string[]> = {
  'male-deep':      ['Charon', 'Algieba'],
  'male-mid':       ['Puck', 'Orus'],
  'male-light':     ['Iapetus', 'Sadachbia'],
  'female-deep':    ['Despina', 'Vindemiatrix'],
  'female-mid':     ['Kore', 'Leda'],
  'female-light':   ['Aoede', 'Callirrhoe'],
  'narrator-warm':  ['Zephyr', 'Sulafat'],
  'narrator-cool':  ['Algenib', 'Achernar'],
};

export const GEMINI_VOICE_DESCRIPTIONS: Record<string, string> = {
  Zephyr: 'Bright', Puck: 'Upbeat', Charon: 'Informative', Kore: 'Firm',
  Fenrir: 'Excitable', Leda: 'Youthful', Orus: 'Firm', Aoede: 'Breezy',
  Callirrhoe: 'Easy-going', Autonoe: 'Bright', Enceladus: 'Breathy',
  Iapetus: 'Clear', Umbriel: 'Easy-going', Algieba: 'Smooth',
  Despina: 'Smooth', Erinome: 'Clear', Algenib: 'Gravelly',
  Rasalgethi: 'Informative', Laomedeia: 'Upbeat', Achernar: 'Soft',
  Alnilam: 'Firm', Schedar: 'Even', Gacrux: 'Mature',
  Pulcherrima: 'Forward', Achird: 'Friendly', Zubenelgenubi: 'Casual',
  Vindemiatrix: 'Gentle', Sadachbia: 'Lively', Sadaltager: 'Knowledgeable',
  Sulafat: 'Warm',
};

const MATCH_MALE_WORD   = /\b(male|man|boy|gentleman|sir|mr|mister)\b/;
const MATCH_FEMALE_WORD = /\b(female|woman|girl|lady|miss|mrs|ms|madam)\b/;

const MALE_TOKENS = [
  'he', 'him', 'his', 'himself',
  'mr', 'mister', 'sir', 'father', 'son', 'brother', 'uncle', 'nephew',
  'man', 'boy', 'guy', 'gentleman', 'king', 'prince', 'lord', 'duke',
];
const FEMALE_TOKENS = [
  'she', 'her', 'hers', 'herself',
  'mrs', 'ms', 'miss', 'madam', 'mother', 'daughter', 'sister', 'aunt', 'niece',
  'woman', 'girl', 'gal', 'lady', 'queen', 'princess', 'duchess',
];

function countWordHits(text: string, tokens: string[]): number {
  const lc = text.toLowerCase();
  let total = 0;
  for (const tok of tokens) {
    const re = new RegExp(`\\b${tok}\\b`, 'g');
    const matches = lc.match(re);
    if (matches) total += matches.length;
  }
  return total;
}

function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function inferGender(attrs: string[], description: string, role: string, explicit?: Character['gender']): Gender {
  if (explicit === 'male')   return 'male';
  if (explicit === 'female') return 'female';
  if (explicit === 'neutral') return 'unknown';
  const lc = attrs.map(a => a.toLowerCase());
  if (lc.some(a => MATCH_FEMALE_WORD.test(a))) return 'female';
  if (lc.some(a => MATCH_MALE_WORD.test(a)))   return 'male';
  const text = `${description} ${role}`;
  if (!text.trim()) return 'unknown';
  const maleHits   = countWordHits(text, MALE_TOKENS);
  const femaleHits = countWordHits(text, FEMALE_TOKENS);
  if (maleHits === 0 && femaleHits === 0) return 'unknown';
  if (maleHits   >= femaleHits + 2) return 'male';
  if (femaleHits >= maleHits   + 2) return 'female';
  if (maleHits > femaleHits) return 'male';
  if (femaleHits > maleHits) return 'female';
  return 'unknown';
}

function inferRegister(attrs: string[], age: Character['ageRange'] | undefined, tone: Character['tone'] | undefined): Register {
  if (age === 'child' || age === 'teen') return 'light';
  if (age === 'elderly') return 'deep';
  const lc = attrs.map(a => a.toLowerCase());
  if (lc.some(a => /\b(bass|baritone|deep|gravelly|growl)\b/.test(a))) return 'deep';
  if (lc.some(a => /\b(soprano|treble|tenor|light|high|squeak)\b/.test(a))) return 'light';
  if (tone) {
    if ((tone.authority ?? 50) >= 75 && (tone.pace ?? 50) <= 50) return 'deep';
    if ((tone.emotion ?? 50)   >= 70 && (tone.pace ?? 50) >= 60) return 'light';
  }
  return 'mid';
}

interface PickInput {
  id: string;
  name?: string;
  attributes?: string[];
  description?: string;
  role?: string;
  gender?: Character['gender'];
  ageRange?: Character['ageRange'];
  tone?: Character['tone'];
}

function inferProfile(input: PickInput): VoiceProfile {
  const lid = input.id.toLowerCase();
  const isNarrator = lid === 'narrator' || lid === 'char-narrator' || (input.name ?? '').toLowerCase() === 'narrator';
  if (isNarrator) {
    const t = input.tone;
    if (t && (t.warmth ?? 50) >= 55 && (t.authority ?? 50) <= 75) return 'narrator-warm';
    return 'narrator-cool';
  }
  const gender = inferGender(input.attributes ?? [], input.description ?? '', input.role ?? '', input.gender);
  const register = inferRegister(input.attributes ?? [], input.ageRange, input.tone);
  if (gender === 'male')   return register === 'deep'  ? 'male-deep'   : register === 'light' ? 'male-light'   : 'male-mid';
  if (gender === 'female') return register === 'deep'  ? 'female-deep' : register === 'light' ? 'female-light' : 'female-mid';
  const t = input.tone;
  if (t && (t.warmth ?? 50) >= 60) return 'narrator-warm';
  return 'narrator-cool';
}

export function resolveTtsVoiceForCharacter(c: Character): TtsVoiceAssignment {
  const id = c.voiceId ?? c.id;
  const profile = inferProfile({
    id,
    name: c.name,
    attributes: c.attributes,
    description: c.description,
    role: c.role,
    gender: c.gender,
    ageRange: c.ageRange,
    tone: c.tone,
  });
  const options = PROFILE_VOICES[profile];
  const name = options[stableHash(id) % options.length];
  return {
    provider: 'gemini',
    name,
    description: GEMINI_VOICE_DESCRIPTIONS[name] ?? 'Prebuilt voice',
  };
}
