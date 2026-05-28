/* TTS provider abstraction. The interface is engine-agnostic — every provider
   takes `{ text, voiceName, modelKey }` and returns raw 16-bit PCM. The
   factory routes per-call by inspecting the modelKey prefix, so a single
   server can serve a mix of local and cloud requests without restart.

   Local engines speak to a sidecar HTTP service (server/tts-sidecar/) started
   separately by the user (`npm run tts:sidecar`). Gemini stays available as a
   manually-selected fallback when the user wants to bypass the local engine. */

import { GeminiTtsProvider } from './gemini.js';
import { SidecarTtsProvider } from './sidecar.js';
import { getResolvedSidecarUrl, getResolvedGeminiApiKey } from '../workspace/user-settings.js';

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

/** One sentence in a batched synth request (plan 112). Mirrors the per-call
    `{ text, voiceName }` pair; a batch may mix voices because the underlying
    Qwen `generate_voice_clone` takes a per-element prompt. */
export interface SynthesizeBatchItem {
  text: string;
  voiceName: string;
}

export interface SynthesizeBatchInput {
  items: SynthesizeBatchItem[];
  modelKey: TtsModelKey;
  signal?: AbortSignal;
}

export interface SynthesizeBatchOutput {
  /** One PCM blob per input item, SAME order. */
  pcms: Buffer[];
  /** Single sample rate shared by the whole batch (one batched forward). */
  sampleRate: number;
  /** Sidecar's forward-compute wall for this batch, ms. Drives live per-batch
      RTF telemetry (plan 127). Undefined if the sidecar didn't report it. */
  genMs?: number;
  /** Total audio the batch produced, ms (the RTF denominator). */
  audioMs?: number;
}

export interface TtsProvider {
  synthesize(input: SynthesizeInput): Promise<SynthesizeOutput>;
  /** TRUE batching (plan 112) — OPTIONAL. Synthesises N sentences in one
      batched model forward and returns one PCM blob per item, in order. Only
      providers backed by a list-capable engine (Qwen via the sidecar)
      implement it; callers MUST feature-detect (`provider.synthesizeBatch`)
      and fall back to per-call `synthesize` when it's absent (Gemini, or
      batching disabled). Keeping it optional preserves the engine-agnostic
      single-call contract every other consumer relies on. */
  synthesizeBatch?(input: SynthesizeBatchInput): Promise<SynthesizeBatchOutput>;
}

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
  | 'gemini-2.5-flash' // cloud fallback
  | 'gemini-3.1-flash';

export const TTS_MODEL_LABELS: Record<TtsModelKey, string> = {
  'coqui-xtts-v2': 'Coqui XTTS v2 (local)',
  'piper-en-us-medium': 'Piper en-US medium (local)',
  'kokoro-v1': 'Kokoro v1 (local)',
  'qwen3-tts-0.6b': 'Qwen3-TTS 0.6B (local)',
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

/* For sidecar requests, derive the engine-side model id from the namespaced
   key. `coqui-xtts-v2` → `xtts_v2`, `piper-en-us-medium` → `en-us-medium`. */
export function sidecarModelId(key: TtsModelKey): string {
  if (key === 'coqui-xtts-v2') return 'xtts_v2';
  if (key === 'piper-en-us-medium') return 'en-us-medium';
  if (key === 'kokoro-v1') return 'v1';
  // Qwen ignores the model field at synth (voice = designed voiceId), but the
  // sidecar /synthesize contract requires a non-empty model string.
  if (key === 'qwen3-tts-0.6b') return '0.6b';
  throw new Error(`sidecarModelId called with non-local key: ${key}`);
}

/* Picks the right provider for a single synthesise call. Gemini key →
   GeminiTtsProvider (resolves the API key at call-time via the env →
   user-settings → null chain); local key → SidecarTtsProvider pointed at
   LOCAL_TTS_URL. */
export function selectTtsProvider(modelKey: TtsModelKey): TtsProvider {
  const engine = engineForModelKey(modelKey);
  if (engine === 'gemini') {
    const apiKey = getResolvedGeminiApiKey();
    if (!apiKey) {
      throw new Error(
        'Gemini TTS selected but no API key is configured. ' +
          'Set it from Account → Server configuration → Gemini API key, ' +
          'or add it to server/.env for CI / power users.',
      );
    }
    return new GeminiTtsProvider({ apiKey });
  }
  /* Live-resolved from user-settings.json → LOCAL_TTS_URL env → localhost. */
  const url = getResolvedSidecarUrl();
  return new SidecarTtsProvider({ url, engine });
}
