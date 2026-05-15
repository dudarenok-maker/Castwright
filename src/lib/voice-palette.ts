/* Voice gradient palette.

   Each prebuilt TTS voice maps to a unique 2-stop gradient. Two voices that
   sit in the same profile bucket (e.g. male-mid) get adjacent slots so the
   bucket is recognisable as a colour family while individual voices stay
   distinct. Coqui and Gemini voices in the same bucket+slot share a
   gradient so flipping the engine doesn't reshuffle the cast view.

   Keep in sync with server/src/tts/voice-palette.ts — the server stamps
   Voice.gradient at scan time; this client mirror handles stub voices
   (characters that don't yet have a library record) in the cast view and
   profile drawer. The two tables must agree on per-voice gradient, or the
   swatch will jump when stub data flips to server-derived data. */

import {
  COQUI_PROFILE_VOICES,
  GEMINI_PROFILE_VOICES,
  type VoiceProfile,
} from './tts-voice-mapping';

/* 8 buckets × 2 slots = 16 distinct gradients. Hue ranges are mnemonic:
   blues → deep male, greens → mid male, teals → light male,
   purples → deep female, roses → mid female, peaches → light female,
   golds → warm narrator, slates → cool narrator. */
export const BUCKET_GRADIENTS: Record<VoiceProfile, [[string, string], [string, string]]> = {
  'male-deep':     [['#2C4760', '#0E1A26'], ['#42647E', '#172A3A']],
  'male-mid':      [['#4A7B6B', '#1F3A2E'], ['#6B9482', '#2E4D3D']],
  'male-light':    [['#5BA3B0', '#1F5562'], ['#7AC0CC', '#357A87']],
  'female-deep':   [['#6E3B7A', '#2B0E33'], ['#8B4F8C', '#3A1A40']],
  'female-mid':    [['#C25A8C', '#6B1F4D'], ['#D67399', '#7A2E5E']],
  'female-light':  [['#F79A83', '#A43C6C'], ['#F4B49B', '#C16557']],
  'narrator-warm': [['#D4A04E', '#7B5A26'], ['#C68B5A', '#6E4925']],
  'narrator-cool': [['#6B6663', '#1A1A1A'], ['#8B8682', '#3A3835']],
};

const FALLBACK_PALETTE: ReadonlyArray<[string, string]> = [
  ['#3C194F', '#0F0E0D'],
  ['#F79A83', '#A43C6C'],
  ['#7C5C8C', '#3C194F'],
  ['#6B6663', '#1A1A1A'],
  ['#4A6878', '#1F3441'],
  ['#C28BA8', '#7A3A5C'],
  ['#A8D5BA', '#4A7B6B'],
  ['#D4A04E', '#7B5A26'],
];

function hashGradient(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return FALLBACK_PALETTE[Math.abs(h) % FALLBACK_PALETTE.length];
}

function lookupBucketSlot(name: string): [VoiceProfile, 0 | 1] | null {
  for (const profile of Object.keys(COQUI_PROFILE_VOICES) as VoiceProfile[]) {
    const idx = COQUI_PROFILE_VOICES[profile].indexOf(name);
    if (idx === 0 || idx === 1) return [profile, idx];
  }
  for (const profile of Object.keys(GEMINI_PROFILE_VOICES) as VoiceProfile[]) {
    const idx = GEMINI_PROFILE_VOICES[profile].indexOf(name);
    if (idx === 0 || idx === 1) return [profile, idx];
  }
  return null;
}

/* Return the gradient for a resolved prebuilt-voice name. Falls back to a
   hash of `fallbackSeed` (typically the character / voice id) so unknown
   voices still get a stable colour rather than a default grey. */
export function gradientForTtsVoice(
  name: string | undefined,
  fallbackSeed?: string,
): [string, string] {
  if (name) {
    const hit = lookupBucketSlot(name);
    if (hit) return BUCKET_GRADIENTS[hit[0]][hit[1]];
  }
  return hashGradient(fallbackSeed ?? name ?? '');
}
