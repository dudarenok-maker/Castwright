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

/* fs-25 — per-quote emotion variant selection. A variant is just another
   designed Qwen voiceId, so the only synth-time lever is picking a different
   voice name; the sidecar contract is untouched. */
export function pickEmotionVariantVoice(
  engine: TtsEngine,
  variants: Partial<Record<string, { name: string }>> | null | undefined,
  emotion: string | undefined,
  baseVoice: string,
): string {
  /* STRICT no-op for every engine except Qwen — emotion is never read on
     Kokoro/XTTS, so a tagged chapter on those engines resolves byte-identical
     voices to today. This is the load-bearing safety gate (plan 177 invariant 3). */
  if (engine !== 'qwen') return baseVoice;
  if (!emotion || emotion === 'neutral') return baseVoice;
  const variant = variants?.[emotion]?.name;
  /* Missing/blank variant → fall back to the base (neutral) voice; never throws,
     so a tagged-but-undesigned emotion can't fail the chapter (invariant 5). */
  return variant && variant.trim() ? variant : baseVoice;
}

export interface VoiceLike {
  id: string;
  /** srv-43 — immutable per-voice identity (nanoid) minted at design time. */
  voiceUuid?: string;
  character?: string;
  attributes?: string[];
  /** Per-engine user-set voice overrides. The synth engine reads its own
      slot at render time; if present, the picker bypasses attribute
      inference and returns the override name directly. Absent slots fall
      through to engine-specific profile inference.

      Why a map: switching the project's TTS engine (Coqui ↔ Kokoro) used
      to lose all manual cast assignments because the old singular
      `overrideTtsVoice: { engine, name }` field was ignored when its
      engine didn't match the synth engine. With a map, each engine
      carries its own assignment and switches preserve the cast. */
  overrideTtsVoices?: Partial<Record<TtsEngine, { name: string }>> | null;
  /** @deprecated Legacy singular field. Read paths normalise this into
      `overrideTtsVoices` at load time (see normaliseVoiceOverrides in
      server/src/routes/voices.ts); writes always emit the plural form.
      Kept on the type so older fixtures and in-flight cast.json files
      still satisfy the type checker. */
  overrideTtsVoice?: { engine: TtsEngine; name: string } | null;
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
  | 'male-deep'
  | 'male-mid'
  | 'male-light'
  | 'female-deep'
  | 'female-mid'
  | 'female-light'
  | 'narrator-warm'
  | 'narrator-cool';

/* Hand-picked from Gemini's published prebuilt voice list. Each profile gets
   two options so close-together voices in the cast don't collide; we pick
   via a stable hash of the voice id. */
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

/* XTTS v2 baked speaker names — best-effort gender/register fits from the
   Coqui speaker manifest. Two per profile so the same hash trick spreads
   neighbouring characters apart. The user can tune this catalog after a
   listen pass; the profile inference upstream is the load-bearing part.

   Exported (vs the parallel GEMINI_PROFILE_VOICES which is module-local)
   so coqui-catalog-audit.ts can diff this against the model's actual
   speaker manifest at server startup — drift between this table and the
   model's manifest manifests as mid-chapter "index out of range in self"
   embedding-lookup errors. The auditor surfaces the drift at boot. */
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

/* Kokoro v1 baked voice names — English subset only. Voice IDs are
   prefixed `af_` (American female), `am_` (American male), `bf_`
   (British female), and `bm_` (British male). Selection criteria:
   surface high-quality narration voices first, spread across gender x
   register so the profile inference upstream picks distinguishable
   choices for neighbouring characters. The sidecar's English-only
   filter (KokoroEngine.ENGLISH_VOICE_PREFIXES) keeps this table aligned
   with what /speakers actually returns; auditEngineCatalog flags any
   drift between the two. */
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

/* Profile-coded labels for the Kokoro catalog — same shape as
   COQUI_VOICE_DESCRIPTIONS (Kokoro doesn't publish personality
   descriptors either). The accent suffix (`US` / `UK`) is the one piece
   of information beyond gender/register that's actually visible in the
   voice ID, so we surface it. */
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

/* Public personality labels for Gemini's 30 prebuilt voices, as published in
   https://ai.google.dev/gemini-api/docs/speech-generation#voices. */
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

/* Profile-coded labels for the XTTS catalog. Coqui doesn't publish
   personality descriptors so we synthesise one from the profile (engine-aware
   labels keep the cast view honest about what the user will actually hear). */
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

export interface TtsVoiceAssignment {
  provider: TtsEngine;
  name: string;
  description: string;
}

/** Engine-aware: returns the prebuilt voice name (no description). Callers
    inside the synth pipeline only need the name; the UI-facing
    resolveVoiceAssignment wraps this with the description.

    Override resolution order:
    1. `overrideTtsVoices[engine].name` if set (and non-empty) → return
       it verbatim. This is the per-engine slot — each character can
       carry independent assignments for every engine.
    2. Legacy `overrideTtsVoice` if it matches the engine → return its
       name. Kept so cast.json files written by older clients still
       resolve correctly until they're re-saved through the normaliser.
    3. Profile inference against this engine's catalog. */
export function pickVoiceForEngine(
  engine: TtsEngine,
  voice: VoiceLike,
  hint?: CharacterHint,
): string {
  const slotName = voice.overrideTtsVoices?.[engine]?.name;
  if (slotName) return slotName;
  if (
    voice.overrideTtsVoice &&
    voice.overrideTtsVoice.engine === engine &&
    voice.overrideTtsVoice.name
  ) {
    return voice.overrideTtsVoice.name;
  }
  /* Qwen voices are BESPOKE (designed per character, plan 108) — there is NO
     profile catalog to infer from. A character on the Qwen engine MUST carry
     an explicit designed voiceId in overrideTtsVoices.qwen; with none, there's
     nothing to pick. Return '' so the cast view can show "no voice designed
     yet"; the generation path treats a Qwen character without a designed voice
     as an error or routes it to the default engine (plan 108 Wave 2b). */
  if (engine === 'qwen') return '';
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
  if (engine === 'coqui') return COQUI_PROFILE_VOICES;
  if (engine === 'kokoro') return KOKORO_PROFILE_VOICES;
  if (engine === 'gemini') return GEMINI_PROFILE_VOICES;
  /* Piper falls back to Coqui until/unless its own table lands — keeps
     the picker total over the TtsEngine union without forcing inferred
     voices that don't exist in Piper's manifest. */
  return COQUI_PROFILE_VOICES;
}

function describeVoice(engine: TtsEngine, name: string): string {
  if (engine === 'gemini') return GEMINI_VOICE_DESCRIPTIONS[name] ?? 'Prebuilt voice';
  if (engine === 'coqui') return COQUI_VOICE_DESCRIPTIONS[name] ?? 'Local voice';
  if (engine === 'kokoro') return KOKORO_VOICE_DESCRIPTIONS[name] ?? 'Local voice';
  /* Qwen voices are designed bespoke per character — no static descriptor
     table. An empty name means none has been designed yet. */
  if (engine === 'qwen') return name ? 'Designed voice' : 'No voice designed yet';
  return 'Local voice';
}

function inferProfile(voice: VoiceLike, hint?: CharacterHint): VoiceProfile {
  /* Narrator is its own bucket — *unless* the user explicitly chose Male
     or Female in the profile drawer, in which case the dropdown wins and
     we route through the regular gender×register pipeline. Neutral keeps
     the narrator behaviour (regular pipeline lands there too for unknown
     gender). Match by id or by name so generated and library voices both
     resolve here. */
  const isNarrator =
    voice.id === 'narrator' ||
    voice.id === 'char-narrator' ||
    (voice.character ?? '').toLowerCase() === 'narrator';
  const isExplicitlyGendered = hint?.gender === 'male' || hint?.gender === 'female';
  if (isNarrator && !isExplicitlyGendered) {
    /* Warm narrator (high warmth + low authority) vs cool narrator
       (high authority + low emotion). */
    const t = hint?.tone;
    if (t && (t.warmth ?? 50) >= 55 && (t.authority ?? 50) <= 75) return 'narrator-warm';
    return 'narrator-cool';
  }

  const gender = inferGender(voice, hint);
  const register = inferRegister(voice, hint);

  if (gender === 'male')
    return register === 'deep' ? 'male-deep' : register === 'light' ? 'male-light' : 'male-mid';
  if (gender === 'female')
    return register === 'deep'
      ? 'female-deep'
      : register === 'light'
        ? 'female-light'
        : 'female-mid';

  /* Unknown gender — use tone as a soft signal, otherwise fall back to a
     narrator voice (which is safer than always picking the same neutral). */
  const t = hint?.tone;
  if (t && (t.warmth ?? 50) >= 60) return 'narrator-warm';
  return 'narrator-cool';
}

function inferGender(voice: VoiceLike, hint?: CharacterHint): Gender {
  /* 0) Explicit override from the analyzer — bypass everything else. */
  if (hint?.gender === 'male') return 'male';
  if (hint?.gender === 'female') return 'female';
  if (hint?.gender === 'neutral') return 'unknown';

  /* 1) Explicit attribute tags — but use word boundaries so "Female"
     doesn't accidentally match "male". */
  const attrs = (voice.attributes ?? []).map((a) => a.toLowerCase());
  if (attrs.some((a) => MATCH_FEMALE_WORD.test(a))) return 'female';
  if (attrs.some((a) => MATCH_MALE_WORD.test(a))) return 'male';

  /* 2) Prose description — count gendered pronoun hits. Strong signal
     because the analyzer's description always refers to the character
     by their pronouns. */
  const text = `${hint?.description ?? ''} ${hint?.role ?? ''}`;
  if (!text.trim()) return 'unknown';
  const maleHits = countWordHits(text, MALE_TOKENS);
  const femaleHits = countWordHits(text, FEMALE_TOKENS);
  if (maleHits === 0 && femaleHits === 0) return 'unknown';
  if (maleHits >= femaleHits + 2) return 'male';
  if (femaleHits >= maleHits + 2) return 'female';
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

  const attrs = (voice.attributes ?? []).map((a) => a.toLowerCase());
  if (attrs.some((a) => /\b(bass|baritone|deep|gravelly|growl)\b/.test(a))) return 'deep';
  if (attrs.some((a) => /\b(soprano|treble|tenor|light|high|squeak)\b/.test(a))) return 'light';

  /* Tone fallback: high authority + low pace ≈ deep register; high emotion
     + high pace ≈ light register. */
  const t = hint?.tone;
  if (t) {
    if ((t.authority ?? 50) >= 75 && (t.pace ?? 50) <= 50) return 'deep';
    if ((t.emotion ?? 50) >= 70 && (t.pace ?? 50) >= 60) return 'light';
  }
  return 'mid';
}

/* Use \b word boundaries so "female" doesn't match the substring inside
   "male" and vice versa. Lowercased input. */
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

/* Tiny deterministic string hash — DJB2. Enough to distribute IDs across
   the 2-option buckets without pulling in crypto. */
function stableHash(s: string): number {
  let h = 5381;
  // Constant loop bound (ids are far under 4096) so the iteration count never
  // derives from a request-controlled length.
  const n = Math.min(s.length, 4096);
  for (let i = 0; i < n; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/* Static self-consistency report for an engine's catalog. Catches the
   "wrong voices used for wrong models" class of bug at its source: the
   PROFILE_VOICES table and the VOICE_DESCRIPTIONS table for each engine
   are supposed to stay in lockstep (every routed voice has a description,
   every described voice is plausibly routable), but nothing enforces it.
   When they drift, the cast view shows a voice that the picker will
   never actually choose, or the picker chooses a voice with no
   description in the UI. Pure function — call it at startup, log the
   result, or fail tests on it. */
export interface CatalogConsistency {
  engine: TtsEngine;
  /** Names referenced in PROFILE_VOICES but missing from VOICE_DESCRIPTIONS —
      the picker can choose them but the cast view has no label for them. */
  missingDescriptions: string[];
  /** Names described but never routed — orphan entries in the
      DESCRIPTIONS table that nothing in PROFILE_VOICES points at. Not
      load-bearing for synthesis, but a signal the table is stale. */
  unrouted: string[];
  /** Total names listed by PROFILE_VOICES (deduped across profiles). */
  routedCount: number;
}

export function auditEngineCatalog(engine: TtsEngine): CatalogConsistency {
  /* Qwen has no static catalog to audit — its voices are designed bespoke per
     character at runtime (plan 108). Nothing to diff; report an empty audit. */
  if (engine === 'qwen') {
    return { engine, missingDescriptions: [], unrouted: [], routedCount: 0 };
  }
  const profiles =
    engine === 'gemini'
      ? GEMINI_PROFILE_VOICES
      : engine === 'coqui'
        ? COQUI_PROFILE_VOICES
        : engine === 'kokoro'
          ? KOKORO_PROFILE_VOICES
          : COQUI_PROFILE_VOICES; // piper still shares Coqui's table (see catalogForEngine)
  const descriptions =
    engine === 'gemini'
      ? GEMINI_VOICE_DESCRIPTIONS
      : engine === 'coqui'
        ? COQUI_VOICE_DESCRIPTIONS
        : engine === 'kokoro'
          ? KOKORO_VOICE_DESCRIPTIONS
          : COQUI_VOICE_DESCRIPTIONS;

  const routed = new Set<string>();
  for (const opts of Object.values(profiles)) {
    for (const n of opts) routed.add(n);
  }
  const described = new Set(Object.keys(descriptions));

  const missingDescriptions = [...routed].filter((n) => !described.has(n)).sort();
  const unrouted = [...described].filter((n) => !routed.has(n)).sort();
  return {
    engine,
    missingDescriptions,
    unrouted,
    routedCount: routed.size,
  };
}
