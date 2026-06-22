/* Pure, provider-independent TTS model-key helpers and types.
 *
 * Extracted from ./index.js to break a runtime import cycle: index.ts imports
 * the GeminiTtsProvider / SidecarTtsProvider classes, and those provider
 * modules need these leaf helpers (resolveGeminiModelId / sidecarModelId).
 * When they pulled the helpers from ./index.js, gemini/sidecar ↔ index formed
 * a cycle, so `importOriginal('../tts/index.js')` in the route tests could
 * return a partially-initialised namespace under parallel load — the
 * intermittent `No "isTtsModelKey" export is defined on the mock` flake that
 * was failing the cross-OS release gate. This module imports nothing, so it's
 * a true leaf; index.ts re-exports everything here (`export * from
 * './model-keys.js'`) so the public `tts/index.js` surface is unchanged.
 */

/* Engine groupings. Local engines all share the sidecar provider; only the
   `model` field on the sidecar request differs. Gemini is its own provider
   (direct Google API). */
export type TtsEngine = 'coqui' | 'piper' | 'kokoro' | 'gemini' | 'qwen';

/* UI-stable namespaced keys. The engine half drives provider selection; the
   model half is forwarded to the engine as-is. New local engines/voices slot
   in here without touching the picker logic. */
export type TtsModelKey =
  | 'coqui-xtts-v2' // local default
  | 'piper-en-us-medium' // future local
  | 'kokoro-v1' // future local
  | 'qwen3-tts-0.6b' // local bespoke-voice engine (plan 108)
  | 'qwen3-tts-1.7b' // local higher-quality Qwen variant (fs-55)
  | 'gemini-2.5-flash' // cloud fallback
  | 'gemini-3.1-flash';

export const TTS_MODEL_LABELS: Record<TtsModelKey, string> = {
  'coqui-xtts-v2': 'Coqui XTTS v2 (local)',
  'piper-en-us-medium': 'Piper en-US medium (local)',
  'kokoro-v1': 'Kokoro v1 (local)',
  'qwen3-tts-0.6b': 'Qwen3-TTS 0.6B (local)',
  'qwen3-tts-1.7b': 'Qwen3-TTS 1.7B (local, higher quality)',
  'gemini-2.5-flash': 'Gemini 2.5 Flash TTS',
  'gemini-3.1-flash': 'Gemini 3.1 Flash TTS',
};

/* Map UI-stable Gemini keys to actual model ids via env so preview-suffix
   churn doesn't require a code change. Local engines don't need this — the
   sidecar resolves model names itself. */
export function resolveGeminiModelId(key: TtsModelKey): string {
  if (key === 'gemini-2.5-flash') {
    return process.env.GEMINI_TTS_MODEL_25 ?? 'gemini-2.5-flash-preview-tts';
  }
  if (key === 'gemini-3.1-flash') {
    return process.env.GEMINI_TTS_MODEL_31 ?? 'gemini-3.1-flash-preview-tts';
  }
  throw new Error(`resolveGeminiModelId called with non-Gemini key: ${key}`);
}

export function isTtsModelKey(value: unknown): value is TtsModelKey {
  return (
    value === 'coqui-xtts-v2' ||
    value === 'piper-en-us-medium' ||
    value === 'kokoro-v1' ||
    value === 'qwen3-tts-0.6b' ||
    value === 'qwen3-tts-1.7b' ||
    value === 'gemini-2.5-flash' ||
    value === 'gemini-3.1-flash'
  );
}

export function engineForModelKey(key: TtsModelKey): TtsEngine {
  if (key.startsWith('coqui-')) return 'coqui';
  if (key.startsWith('piper-')) return 'piper';
  if (key.startsWith('kokoro-')) return 'kokoro';
  if (key.startsWith('qwen')) return 'qwen';
  return 'gemini';
}

/* The canonical model key for an engine — the inverse of `engineForModelKey`.
   Gemini has two UI-stable variants, so its canonical key is whichever Gemini
   key the run requested (falling back to 2.5 when the request wasn't Gemini).
   Used to stamp a chapter's `audioModelKey` with the engine the audio ACTUALLY
   rendered in (per-character routing, plan 108) rather than the request default
   (the false-drift fix, 2026-06-07). */
export function canonicalModelKeyForEngine(
  engine: TtsEngine,
  requestModelKey: TtsModelKey,
): TtsModelKey {
  switch (engine) {
    case 'kokoro':
      return 'kokoro-v1';
    case 'qwen':
      return requestModelKey.startsWith('qwen') ? requestModelKey : 'qwen3-tts-0.6b';
    case 'coqui':
      return 'coqui-xtts-v2';
    case 'piper':
      return 'piper-en-us-medium';
    case 'gemini':
      return requestModelKey.startsWith('gemini-') ? requestModelKey : 'gemini-2.5-flash';
  }
}

/* For sidecar requests, derive the engine-side model id from the namespaced
   key. `coqui-xtts-v2` → `xtts_v2`, `piper-en-us-medium` → `en-us-medium`. */
export function sidecarModelId(key: TtsModelKey): string {
  if (key === 'coqui-xtts-v2') return 'xtts_v2';
  if (key === 'piper-en-us-medium') return 'en-us-medium';
  if (key === 'kokoro-v1') return 'v1';
  // Qwen ignores the model field at synth (voice = designed voiceId), but the
  // sidecar /synthesize contract requires a non-empty model string.
  if (key === 'qwen3-tts-0.6b') return '0.6b';
  if (key === 'qwen3-tts-1.7b') return '1.7b';
  throw new Error(`sidecarModelId called with non-local key: ${key}`);
}
