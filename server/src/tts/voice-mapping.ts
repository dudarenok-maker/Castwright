/* Map a frontend Voice (or a character stub) to an engine-specific prebuilt
   voice name. Deterministic so the same character always gets the same voice
   across sessions, regardless of engine. The analyzer's character attributes
   are *personality traits* (e.g. "sarcastic", "patient"), not voice
   descriptors, so the bulk of the signal comes from the character's prose
   description (he/she pronouns) and the optional tone metrics.

   Profile inference is engine-agnostic — only the final lookup table changes
   between engines. To add a new engine, add a PROFILE_VOICES table and a
   DESCRIPTIONS table and extend pickVoiceForEngine. */

import type { TtsEngine } from './index.js';

export interface VoiceLike {
  id: string;
  character?: string;
  attributes?: string[];
}

export interface CharacterHint {
  /** Free-text description from the analyzer. Scanned for gendered pronouns
      and common gender-coded nouns. */
  description?: string;
  /** Character's role label, e.g. "Protagonist", "Healer". Sometimes carries
      gendered terms ("Father", "Lady") so it's worth scanning. */
  role?: string;
  /** Explicit overrides from the analyzer schema (Character.gender /
      Character.ageRange). When present they bypass description scanning. */
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  /** Analyzer's 0–100 tone metrics. Used as a tiebreaker when the prose
      doesn't give us a clean gender signal. */
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  /** Real lines from the manuscript (analyzer's `evidence` quotes). When
      present, the sample-text picker uses the best-length one instead of a
      generic intro line so each character actually sounds like themselves. */
  evidence?: string[];
}

type Gender = 'male' | 'female' | 'unknown';
type Register = 'deep' | 'mid' | 'light';
type VoiceProfile =
  | 'male-deep' | 'male-mid' | 'male-light'
  | 'female-deep' | 'female-mid' | 'female-light'
  | 'narrator-warm' | 'narrator-cool';

/* Hand-picked from Gemini's published prebuilt voice list. Each profile gets
   two options so close-together voices in the cast don't collide; we pick
   via a stable hash of the voice id. */
const GEMINI_PROFILE_VOICES: Record<VoiceProfile, string[]> = {
  'male-deep':      ['Charon', 'Algieba'],
  'male-mid':       ['Puck', 'Orus'],
  'male-light':     ['Iapetus', 'Sadachbia'],
  'female-deep':    ['Despina', 'Vindemiatrix'],
  'female-mid':     ['Kore', 'Leda'],
  'female-light':   ['Aoede', 'Callirrhoe'],
  'narrator-warm':  ['Zephyr', 'Sulafat'],
  'narrator-cool':  ['Algenib', 'Achernar'],
};

/* XTTS v2 baked speaker names — best-effort gender/register fits from the
   Coqui speaker manifest. Two per profile so the same hash trick spreads
   neighbouring characters apart. The user can tune this catalog after a
   listen pass; the profile inference upstream is the load-bearing part. */
const COQUI_PROFILE_VOICES: Record<VoiceProfile, string[]> = {
  'male-deep':      ['Damien Black', 'Wulf Carlevaro'],
  'male-mid':       ['Aaron Dreschner', 'Viktor Menelaos'],
  'male-light':     ['Andrew Chipper', 'Royston Min'],
  'female-deep':    ['Brenda Stern', 'Tammie Ema'],
  'female-mid':     ['Daisy Studious', 'Sofia Hellen'],
  'female-light':   ['Claribel Dervla', 'Alison Dietlinde'],
  'narrator-warm':  ['Ana Florence', 'Henriette Usha'],
  'narrator-cool':  ['Asya Anara', 'Gracie Wise'],
};

/* Public personality labels for Gemini's 30 prebuilt voices, as published in
   https://ai.google.dev/gemini-api/docs/speech-generation#voices. */
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

/* Profile-coded labels for the XTTS catalog. Coqui doesn't publish
   personality descriptors so we synthesise one from the profile (engine-aware
   labels keep the cast view honest about what the user will actually hear). */
export const COQUI_VOICE_DESCRIPTIONS: Record<string, string> = {
  'Damien Black': 'Deep · Male', 'Wulf Carlevaro': 'Deep · Male',
  'Aaron Dreschner': 'Mid · Male', 'Viktor Menelaos': 'Mid · Male',
  'Andrew Chipper': 'Light · Male', 'Royston Min': 'Light · Male',
  'Brenda Stern': 'Deep · Female', 'Tammie Ema': 'Deep · Female',
  'Daisy Studious': 'Mid · Female', 'Sofia Hellen': 'Mid · Female',
  'Claribel Dervla': 'Light · Female', 'Alison Dietlinde': 'Light · Female',
  'Ana Florence': 'Warm narrator', 'Henriette Usha': 'Warm narrator',
  'Asya Anara': 'Cool narrator', 'Gracie Wise': 'Cool narrator',
};

export interface TtsVoiceAssignment {
  provider: TtsEngine;
  name: string;
  description: string;
}

/** Engine-aware: returns the prebuilt voice name (no description). Callers
    inside the synth pipeline only need the name; the UI-facing
    resolveVoiceAssignment wraps this with the description. */
export function pickVoiceForEngine(
  engine: TtsEngine,
  voice: VoiceLike,
  hint?: CharacterHint,
): string {
  const profile = inferProfile(voice, hint);
  const table = catalogForEngine(engine);
  const options = table[profile];
  const idx = stableHash(voice.id) % options.length;
  return options[idx];
}

/** Convenience wrapper: pick a voice and wrap it with its descriptor for the
    cast view. Engine is required — there's no single "right" voice without
    knowing which engine will run the synth. */
export function resolveVoiceAssignment(
  engine: TtsEngine,
  voice: VoiceLike,
  hint?: CharacterHint,
): TtsVoiceAssignment {
  const name = pickVoiceForEngine(engine, voice, hint);
  return {
    provider: engine,
    name,
    description: describeVoice(engine, name),
  };
}

function catalogForEngine(engine: TtsEngine): Record<VoiceProfile, string[]> {
  if (engine === 'coqui')  return COQUI_PROFILE_VOICES;
  if (engine === 'gemini') return GEMINI_PROFILE_VOICES;
  /* Piper/Kokoro fall back to the Coqui catalog until their own tables land
     — keeps the picker total over the TtsEngine union while we incrementally
     wire those engines in. */
  return COQUI_PROFILE_VOICES;
}

function describeVoice(engine: TtsEngine, name: string): string {
  if (engine === 'gemini') return GEMINI_VOICE_DESCRIPTIONS[name] ?? 'Prebuilt voice';
  if (engine === 'coqui')  return COQUI_VOICE_DESCRIPTIONS[name] ?? 'Local voice';
  return 'Local voice';
}

function inferProfile(voice: VoiceLike, hint?: CharacterHint): VoiceProfile {
  /* Narrator is its own thing — match by id or by name so generated and
     library voices both land in the narrator bucket. */
  const isNarrator =
    voice.id === 'narrator' ||
    voice.id === 'char-narrator' ||
    (voice.character ?? '').toLowerCase() === 'narrator';
  if (isNarrator) {
    /* Warm narrator (high warmth + low authority) vs cool narrator
       (high authority + low emotion). */
    const t = hint?.tone;
    if (t && (t.warmth ?? 50) >= 55 && (t.authority ?? 50) <= 75) return 'narrator-warm';
    return 'narrator-cool';
  }

  const gender = inferGender(voice, hint);
  const register = inferRegister(voice, hint);

  if (gender === 'male')   return register === 'deep'  ? 'male-deep'   : register === 'light' ? 'male-light'   : 'male-mid';
  if (gender === 'female') return register === 'deep'  ? 'female-deep' : register === 'light' ? 'female-light' : 'female-mid';

  /* Unknown gender — use tone as a soft signal, otherwise fall back to a
     narrator voice (which is safer than always picking the same neutral). */
  const t = hint?.tone;
  if (t && (t.warmth ?? 50) >= 60) return 'narrator-warm';
  return 'narrator-cool';
}

function inferGender(voice: VoiceLike, hint?: CharacterHint): Gender {
  /* 0) Explicit override from the analyzer — bypass everything else. */
  if (hint?.gender === 'male')   return 'male';
  if (hint?.gender === 'female') return 'female';
  if (hint?.gender === 'neutral') return 'unknown';

  /* 1) Explicit attribute tags — but use word boundaries so "Female"
     doesn't accidentally match "male". */
  const attrs = (voice.attributes ?? []).map(a => a.toLowerCase());
  if (attrs.some(a => MATCH_FEMALE_WORD.test(a))) return 'female';
  if (attrs.some(a => MATCH_MALE_WORD.test(a)))   return 'male';

  /* 2) Prose description — count gendered pronoun hits. Strong signal
     because the analyzer's description always refers to the character
     by their pronouns. */
  const text = `${hint?.description ?? ''} ${hint?.role ?? ''}`;
  if (!text.trim()) return 'unknown';
  const maleHits   = countWordHits(text, MALE_TOKENS);
  const femaleHits = countWordHits(text, FEMALE_TOKENS);
  if (maleHits === 0 && femaleHits === 0) return 'unknown';
  if (maleHits   >= femaleHits + 2) return 'male';
  if (femaleHits >= maleHits   + 2) return 'female';
  /* Close call — go with whichever has more hits, else unknown. */
  if (maleHits > femaleHits) return 'male';
  if (femaleHits > maleHits) return 'female';
  return 'unknown';
}

function inferRegister(voice: VoiceLike, hint?: CharacterHint): Register {
  /* Coarse age → register mapping. Children and teens get a lighter voice;
     elderly characters get a deeper one. Adult is mid. */
  if (hint?.ageRange === 'child' || hint?.ageRange === 'teen') return 'light';
  if (hint?.ageRange === 'elderly') return 'deep';

  const attrs = (voice.attributes ?? []).map(a => a.toLowerCase());
  if (attrs.some(a => /\b(bass|baritone|deep|gravelly|growl)\b/.test(a))) return 'deep';
  if (attrs.some(a => /\b(soprano|treble|tenor|light|high|squeak)\b/.test(a))) return 'light';

  /* Tone fallback: high authority + low pace ≈ deep register; high emotion
     + high pace ≈ light register. */
  const t = hint?.tone;
  if (t) {
    if ((t.authority ?? 50) >= 75 && (t.pace ?? 50) <= 50) return 'deep';
    if ((t.emotion ?? 50)   >= 70 && (t.pace ?? 50) >= 60) return 'light';
  }
  return 'mid';
}

/* Use \b word boundaries so "female" doesn't match the substring inside
   "male" and vice versa. Lowercased input. */
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

/* Tiny deterministic string hash — DJB2. Enough to distribute IDs across
   the 2-option buckets without pulling in crypto. */
function stableHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
