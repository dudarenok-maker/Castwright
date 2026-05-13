/* TTS provider abstraction. The interface is engine-agnostic — every provider
   takes `{ text, voiceName, modelKey }` and returns raw 16-bit PCM. The
   factory routes per-call by inspecting the modelKey prefix, so a single
   server can serve a mix of local and cloud requests without restart.

   Local engines speak to a sidecar HTTP service (server/tts-sidecar/) started
   separately by the user (`npm run tts:sidecar`). Gemini stays available as a
   manually-selected fallback when the user wants to bypass the local engine. */

import { GeminiTtsProvider } from './gemini.js';
import { SidecarTtsProvider } from './sidecar.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

export interface SynthesizeInput {
  text: string;
  voiceName: string;
  modelKey: TtsModelKey;
  /** Optional abort signal — providers that can honour it should pass it
      through to their underlying HTTP/SDK call so a mid-call cancellation
      (e.g. server-side per-book mutex aborting a stale generation handler)
      doesn't leave a slow synth call running to completion. */
  signal?: AbortSignal;
}

export interface SynthesizeOutput {
  pcm: Buffer;
  sampleRate: number;
  mimeType: string;
}

export interface TtsProvider {
  synthesize(input: SynthesizeInput): Promise<SynthesizeOutput>;
}

/* Engine groupings. Local engines all share the sidecar provider; only the
   `model` field on the sidecar request differs. Gemini is its own provider
   (direct Google API). */
export type TtsEngine = 'coqui' | 'piper' | 'kokoro' | 'gemini';

/* UI-stable namespaced keys. The engine half drives provider selection; the
   model half is forwarded to the engine as-is. New local engines/voices slot
   in here without touching the picker logic. */
export type TtsModelKey =
  | 'coqui-xtts-v2'        // local default
  | 'piper-en-us-medium'   // future local
  | 'kokoro-v1'            // future local
  | 'gemini-2.5-flash'     // cloud fallback
  | 'gemini-3.1-flash';

export const TTS_MODEL_LABELS: Record<TtsModelKey, string> = {
  'coqui-xtts-v2':     'Coqui XTTS v2 (local)',
  'piper-en-us-medium': 'Piper en-US medium (local)',
  'kokoro-v1':         'Kokoro v1 (local)',
  'gemini-2.5-flash':  'Gemini 2.5 Flash TTS',
  'gemini-3.1-flash':  'Gemini 3.1 Flash TTS',
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
    value === 'gemini-2.5-flash' ||
    value === 'gemini-3.1-flash'
  );
}

export function engineForModelKey(key: TtsModelKey): TtsEngine {
  if (key.startsWith('coqui-'))  return 'coqui';
  if (key.startsWith('piper-'))  return 'piper';
  if (key.startsWith('kokoro-')) return 'kokoro';
  return 'gemini';
}

/* For sidecar requests, derive the engine-side model id from the namespaced
   key. `coqui-xtts-v2` → `xtts_v2`, `piper-en-us-medium` → `en-us-medium`. */
export function sidecarModelId(key: TtsModelKey): string {
  if (key === 'coqui-xtts-v2')        return 'xtts_v2';
  if (key === 'piper-en-us-medium')   return 'en-us-medium';
  if (key === 'kokoro-v1')            return 'v1';
  throw new Error(`sidecarModelId called with non-local key: ${key}`);
}

/* Picks the right provider for a single synthesise call. Gemini key →
   GeminiTtsProvider (requires GEMINI_API_KEY at the time of the call, not at
   server boot); local key → SidecarTtsProvider pointed at LOCAL_TTS_URL. */
export function selectTtsProvider(modelKey: TtsModelKey): TtsProvider {
  const engine = engineForModelKey(modelKey);
  if (engine === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini TTS selected but GEMINI_API_KEY is not set. Add it to server/.env or switch to a local engine.');
    }
    return new GeminiTtsProvider({ apiKey });
  }
  /* Live-resolved from user-settings.json → LOCAL_TTS_URL env → localhost. */
  const url = getResolvedSidecarUrl();
  return new SidecarTtsProvider({ url, engine });
}
