/* Client-side port of server/src/tts/voice-mapping.ts. Server is the source of
   truth — it picks the voice that actually gets synthesised. This module
   exists so the cast view can label characters that aren't in the voices
   library yet (fresh analysis, pre-confirm) without round-tripping to the
   backend just to render a chip.

   Keep the deterministic hash + the profile buckets in sync with
   server/src/tts/voice-mapping.ts, or the label here drifts from what the
   user hears. The Voice-library response (GET /api/voices) is authoritative;
   prefer reading `voice.ttsVoice` when it's available. */

import type { Character, Voice, TtsModelKey } from './types';

/* qwen is a BESPOKE per-character engine (plan 108) — no preset catalog;
   its "voice" is a designed voiceId living in overrideTtsVoices.qwen.name.
   Kept in this union so the engine-aware resolver below can label it
   ("Designed voice" / "No voice designed yet") instead of falsely picking
   a Coqui/Kokoro preset for it. */
export type TtsEngine = 'coqui' | 'gemini' | 'piper' | 'kokoro' | 'qwen';

export interface TtsVoiceAssignment {
  provider: TtsEngine;
  name: string;
  description: string;
}

type Gender = 'male' | 'female' | 'unknown';
type Register = 'deep' | 'mid' | 'light';
export type VoiceProfile =
  | 'male-deep'
  | 'male-mid'
  | 'male-light'
  | 'female-deep'
  | 'female-mid'
  | 'female-light'
  | 'narrator-warm'
  | 'narrator-cool';

export const GEMINI_PROFILE_VOICES: Record<VoiceProfile, string[]> = {
  'male-deep': ['Charon', 'Algieba'],
  'male-mid': ['Puck', 'Orus'],
  'male-light': ['Iapetus', 'Sadachbia'],
  'female-deep': ['Despina', 'Vindemiatrix'],
  'female-mid': ['Kore', 'Leda'],
  'female-light': ['Aoede', 'Callirrhoe'],
  'narrator-warm': ['Zephyr', 'Sulafat'],
  'narrator-cool': ['Algenib', 'Achernar'],
};

export const COQUI_PROFILE_VOICES: Record<VoiceProfile, string[]> = {
  'male-deep': ['Damien Black', 'Wulf Carlevaro'],
  'male-mid': ['Aaron Dreschner', 'Viktor Menelaos'],
  'male-light': ['Andrew Chipper', 'Royston Min'],
  'female-deep': ['Brenda Stern', 'Tammie Ema'],
  'female-mid': ['Daisy Studious', 'Sofia Hellen'],
  'female-light': ['Claribel Dervla', 'Alison Dietlinde'],
  'narrator-warm': ['Ana Florence', 'Henriette Usha'],
  'narrator-cool': ['Asya Anara', 'Gracie Wise'],
};

export const GEMINI_VOICE_DESCRIPTIONS: Record<string, string> = {
  Zephyr: 'Bright',
  Puck: 'Upbeat',
  Charon: 'Informative',
  Kore: 'Firm',
  Fenrir: 'Excitable',
  Leda: 'Youthful',
  Orus: 'Firm',
  Aoede: 'Breezy',
  Callirrhoe: 'Easy-going',
  Autonoe: 'Bright',
  Enceladus: 'Breathy',
  Iapetus: 'Clear',
  Umbriel: 'Easy-going',
  Algieba: 'Smooth',
  Despina: 'Smooth',
  Erinome: 'Clear',
  Algenib: 'Gravelly',
  Rasalgethi: 'Informative',
  Laomedeia: 'Upbeat',
  Achernar: 'Soft',
  Alnilam: 'Firm',
  Schedar: 'Even',
  Gacrux: 'Mature',
  Pulcherrima: 'Forward',
  Achird: 'Friendly',
  Zubenelgenubi: 'Casual',
  Vindemiatrix: 'Gentle',
  Sadachbia: 'Lively',
  Sadaltager: 'Knowledgeable',
  Sulafat: 'Warm',
};

export const COQUI_VOICE_DESCRIPTIONS: Record<string, string> = {
  'Damien Black': 'Deep · Male',
  'Wulf Carlevaro': 'Deep · Male',
  'Aaron Dreschner': 'Mid · Male',
  'Viktor Menelaos': 'Mid · Male',
  'Andrew Chipper': 'Light · Male',
  'Royston Min': 'Light · Male',
  'Brenda Stern': 'Deep · Female',
  'Tammie Ema': 'Deep · Female',
  'Daisy Studious': 'Mid · Female',
  'Sofia Hellen': 'Mid · Female',
  'Claribel Dervla': 'Light · Female',
  'Alison Dietlinde': 'Light · Female',
  'Ana Florence': 'Warm narrator',
  'Henriette Usha': 'Warm narrator',
  'Asya Anara': 'Cool narrator',
  'Gracie Wise': 'Cool narrator',
};

/* Kokoro v1 English subset. Same shape as the Coqui catalog — voice IDs
   are prefixed `af_` (American female), `am_` (American male), `bf_`
   (British female), `bm_` (British male). Mirror of
   server/src/tts/voice-mapping.ts KOKORO_PROFILE_VOICES; both must agree
   on which name lives in which bucket so client-side stub Voices get
   the same gradient the server stamps. */
export const KOKORO_PROFILE_VOICES: Record<VoiceProfile, string[]> = {
  'male-deep': ['am_onyx', 'bm_george'],
  'male-mid': ['am_michael', 'am_adam'],
  'male-light': ['am_eric', 'am_liam'],
  'female-deep': ['af_sarah', 'bf_emma'],
  'female-mid': ['af_bella', 'af_jessica'],
  'female-light': ['af_nicole', 'af_aoede'],
  'narrator-warm': ['af_heart', 'af_kore'],
  'narrator-cool': ['af_alloy', 'af_river'],
};

export const KOKORO_VOICE_DESCRIPTIONS: Record<string, string> = {
  am_onyx: 'Deep · Male · US',
  bm_george: 'Deep · Male · UK',
  am_michael: 'Mid · Male · US',
  am_adam: 'Mid · Male · US',
  am_eric: 'Light · Male · US',
  am_liam: 'Light · Male · US',
  af_sarah: 'Deep · Female · US',
  bf_emma: 'Deep · Female · UK',
  af_bella: 'Mid · Female · US',
  af_jessica: 'Mid · Female · US',
  af_nicole: 'Light · Female · US',
  af_aoede: 'Light · Female · US',
  af_heart: 'Warm narrator · US',
  af_kore: 'Warm narrator · US',
  af_alloy: 'Cool narrator · US',
  af_river: 'Cool narrator · US',
};

const MATCH_MALE_WORD = /\b(male|man|boy|gentleman|sir|mr|mister)\b/;
const MATCH_FEMALE_WORD = /\b(female|woman|girl|lady|miss|mrs|ms|madam)\b/;

const MALE_TOKENS = [
  'he',
  'him',
  'his',
  'himself',
  'mr',
  'mister',
  'sir',
  'father',
  'son',
  'brother',
  'uncle',
  'nephew',
  'man',
  'boy',
  'guy',
  'gentleman',
  'king',
  'prince',
  'lord',
  'duke',
];
const FEMALE_TOKENS = [
  'she',
  'her',
  'hers',
  'herself',
  'mrs',
  'ms',
  'miss',
  'madam',
  'mother',
  'daughter',
  'sister',
  'aunt',
  'niece',
  'woman',
  'girl',
  'gal',
  'lady',
  'queen',
  'princess',
  'duchess',
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

function inferGender(
  attrs: string[],
  description: string,
  role: string,
  explicit?: Character['gender'],
): Gender {
  if (explicit === 'male') return 'male';
  if (explicit === 'female') return 'female';
  if (explicit === 'neutral') return 'unknown';
  const lc = attrs.map((a) => a.toLowerCase());
  if (lc.some((a) => MATCH_FEMALE_WORD.test(a))) return 'female';
  if (lc.some((a) => MATCH_MALE_WORD.test(a))) return 'male';
  const text = `${description} ${role}`;
  if (!text.trim()) return 'unknown';
  const maleHits = countWordHits(text, MALE_TOKENS);
  const femaleHits = countWordHits(text, FEMALE_TOKENS);
  if (maleHits === 0 && femaleHits === 0) return 'unknown';
  if (maleHits >= femaleHits + 2) return 'male';
  if (femaleHits >= maleHits + 2) return 'female';
  if (maleHits > femaleHits) return 'male';
  if (femaleHits > maleHits) return 'female';
  return 'unknown';
}

function inferRegister(
  attrs: string[],
  age: Character['ageRange'] | undefined,
  tone: Character['tone'] | undefined,
): Register {
  if (age === 'child' || age === 'teen') return 'light';
  if (age === 'elderly') return 'deep';
  const lc = attrs.map((a) => a.toLowerCase());
  if (lc.some((a) => /\b(bass|baritone|deep|gravelly|growl)\b/.test(a))) return 'deep';
  if (lc.some((a) => /\b(soprano|treble|tenor|light|high|squeak)\b/.test(a))) return 'light';
  if (tone) {
    if ((tone.authority ?? 50) >= 75 && (tone.pace ?? 50) <= 50) return 'deep';
    if ((tone.emotion ?? 50) >= 70 && (tone.pace ?? 50) >= 60) return 'light';
  }
  return 'mid';
}

export interface PickInput {
  id: string;
  name?: string;
  attributes?: string[];
  description?: string;
  role?: string;
  gender?: Character['gender'];
  ageRange?: Character['ageRange'];
  tone?: Character['tone'];
}

export function inferProfile(input: PickInput): VoiceProfile {
  const lid = input.id.toLowerCase();
  const isNarrator =
    lid === 'narrator' ||
    lid === 'char-narrator' ||
    (input.name ?? '').toLowerCase() === 'narrator';
  /* Narrator only short-circuits to the warm/cool buckets when the user
     hasn't explicitly chosen a gender. Once Male or Female is set, fall
     through to the regular gender×register pipeline so the dropdown
     actually moves the synthesised voice. Neutral keeps narrator behaviour
     since the regular pipeline also lands there for unknown gender. */
  const isExplicitlyGendered = input.gender === 'male' || input.gender === 'female';
  if (isNarrator && !isExplicitlyGendered) {
    const t = input.tone;
    if (t && (t.warmth ?? 50) >= 55 && (t.authority ?? 50) <= 75) return 'narrator-warm';
    return 'narrator-cool';
  }
  const gender = inferGender(
    input.attributes ?? [],
    input.description ?? '',
    input.role ?? '',
    input.gender,
  );
  const register = inferRegister(input.attributes ?? [], input.ageRange, input.tone);
  if (gender === 'male')
    return register === 'deep' ? 'male-deep' : register === 'light' ? 'male-light' : 'male-mid';
  if (gender === 'female')
    return register === 'deep'
      ? 'female-deep'
      : register === 'light'
        ? 'female-light'
        : 'female-mid';
  const t = input.tone;
  if (t && (t.warmth ?? 50) >= 60) return 'narrator-warm';
  return 'narrator-cool';
}

function catalogForEngine(engine: TtsEngine): Record<VoiceProfile, string[]> {
  if (engine === 'gemini') return GEMINI_PROFILE_VOICES;
  if (engine === 'kokoro') return KOKORO_PROFILE_VOICES;
  /* coqui and piper share the Coqui catalog (piper has no static table yet). */
  return COQUI_PROFILE_VOICES;
}

function describeVoice(engine: TtsEngine, name: string): string {
  if (engine === 'gemini') return GEMINI_VOICE_DESCRIPTIONS[name] ?? 'Prebuilt voice';
  if (engine === 'kokoro') return KOKORO_VOICE_DESCRIPTIONS[name] ?? 'Local voice';
  return COQUI_VOICE_DESCRIPTIONS[name] ?? 'Local voice';
}

/* Engine-aware resolver. Defaults to 'coqui' to match the UI's default
   modelKey — callers that know the selected engine should pass it
   explicitly so the labels match what the user will actually hear. */
export function resolveTtsVoiceForCharacter(
  c: Character,
  engine: TtsEngine = 'coqui',
): TtsVoiceAssignment {
  /* Qwen has no preset catalog — the resolved voice is the designed
     voiceId pinned in overrideTtsVoices.qwen (mirrors the server's
     pickVoiceForEngine('qwen', …) which fails fast without one). Label
     it like the server's describeVoiceAssignment so the drawer/cast row
     copy matches. */
  if (engine === 'qwen') {
    const designed = c.overrideTtsVoices?.qwen?.name;
    return {
      provider: 'qwen',
      name: designed ?? '',
      description: designed ? 'Designed voice' : 'No voice designed yet',
    };
  }
  const profile = resolveProfileForCharacter(c);
  const id = c.voiceId ?? c.id;
  const options = catalogForEngine(engine)[profile];
  const name = options[stableHash(id) % options.length];
  return {
    provider: engine,
    name,
    description: describeVoice(engine, name),
  };
}

/* Row-label resolver for the cast view. A library voice's preset descriptor
   normally wins, but a character pinned to the bespoke Qwen engine (plan 108)
   must show its designed/Qwen line, not a Coqui/Kokoro preset. For a REUSED qwen
   voice the character's own override is empty and the bespoke voice rides on the
   matched library Voice (itself a qwen voice) — so fall back to it, otherwise the
   row reads "No voice designed yet" despite a real designed voice existing on the
   matched Voice (e.g. Lord Vane → qwen-lord-vane). Only the empty-name stub
   remains when nothing resolves. */
export function resolveDisplayTtsVoice(
  c: Character,
  voice: Voice | undefined,
  projectEngine: TtsEngine,
): TtsVoiceAssignment {
  if (c.ttsEngine === 'qwen') {
    const own = resolveTtsVoiceForCharacter(c, 'qwen');
    if (own.name) return own;
    if (voice?.ttsVoice?.provider === 'qwen' && voice.ttsVoice.name) return voice.ttsVoice;
    return own;
  }
  return voice?.ttsVoice ?? resolveTtsVoiceForCharacter(c, projectEngine);
}

/* The single model key the Qwen bespoke engine routes through. Mirror of
   the server's engineForModelKey: any 'qwen…' key maps to engine 'qwen'. */
export const QWEN_MODEL_KEY: TtsModelKey = 'qwen3-tts-0.6b';

/* Resolve the modelKey a sample/audition should use for a character whose
   effective engine may diverge from the project default. Qwen is the only
   per-character override that diverges (the picker offers kokoro|qwen), and
   it needs its own model key so the server routes to the bespoke engine
   instead of the project's Kokoro/Coqui key. Every non-qwen engine keeps the
   project key — that key already routes to the engine the character uses. */
export function sampleModelKeyForEngine(
  effectiveEngine: TtsEngine,
  projectModelKey: TtsModelKey,
): TtsModelKey {
  return effectiveEngine === 'qwen' ? QWEN_MODEL_KEY : projectModelKey;
}

/* Profile-only resolver — same mapping as resolveTtsVoiceForCharacter,
   exposed so the compare modal can label the inferred bucket
   ('male-deep', 'narrator-warm', etc.) on each side. */
export function resolveProfileForCharacter(c: Character): VoiceProfile {
  return inferProfile({
    id: c.voiceId ?? c.id,
    name: c.name,
    attributes: c.attributes,
    description: c.description,
    role: c.role,
    gender: c.gender,
    ageRange: c.ageRange,
    tone: c.tone,
  });
}
