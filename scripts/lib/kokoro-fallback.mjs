/* Deterministic Kokoro preset per character — the bundle's fallback cast so the
   demo generates on a box without Qwen. Mirrors the female/male × deep/mid/light
   buckets of server/src/tts/voice-mapping.ts KOKORO_PROFILE_VOICES; keep in sync
   if that catalog changes. */
export const KOKORO_BUCKETS = {
  'male-deep': ['am_onyx', 'bm_george'],
  'male-mid': ['am_michael', 'am_adam'],
  'male-light': ['am_eric', 'am_liam'],
  'female-deep': ['af_sarah', 'bf_emma'],
  'female-mid': ['af_bella', 'af_jessica'],
  'female-light': ['af_nicole', 'af_aoede'],
};

function stableHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/* gender: 'male'|'female'|'neutral'; ageRange: 'child'|'teen'|'adult'|'elderly'.
   Non-human / neutral falls back to a deep male register (best-effort; Kokoro
   has no non-human voice). child/teen → light, elderly → deep, else mid. */
export function pickKokoroPreset({ gender, ageRange, id }) {
  const g = gender === 'female' ? 'female' : 'male';
  const register =
    ageRange === 'child' || ageRange === 'teen'
      ? 'light'
      : ageRange === 'elderly'
        ? 'deep'
        : 'mid';
  const bucket = KOKORO_BUCKETS[`${g}-${register}`];
  return bucket[stableHash(String(id)) % bucket.length];
}
