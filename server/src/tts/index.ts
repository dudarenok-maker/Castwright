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
import { engineForModelKey } from './model-keys.js';
import type { TtsModelKey } from './model-keys.js';

/* The model-key types + pure helpers (TtsEngine, TtsModelKey, TTS_MODEL_LABELS,
   resolveGeminiModelId, isTtsModelKey, engineForModelKey, sidecarModelId) live
   in the leaf module ./model-keys.js so the GeminiTtsProvider / SidecarTtsProvider
   classes can import them without forming an index ↔ provider cycle (that cycle
   was the source of the intermittent partial-`importOriginal` mock flake). The
   public `tts/index.js` surface is unchanged — re-export them here. */
export * from './model-keys.js';

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
  /** The voice name the caller REQUESTED, set only when the sidecar couldn't
      honour it and substituted a safe fallback (its `X-Voice-Substituted-From`
      header). Absent on a clean render. Lets the chapter assembler stamp the
      segment and the golden-audio gate fail on a silent voice fallback —
      previously the substitution was only `console.warn`'d, so it was
      unassertable. */
  voiceSubstitutedFrom?: string;
}

/** One sentence in a batched synth request (plan 112). Mirrors the per-call
    `{ text, voiceName }` pair; a batch may mix voices because the underlying
    Qwen `generate_voice_clone` takes a per-element prompt.

    fs-57 — on the 1.7B liveInstruct path each item optionally carries a
    delivery direction (`instruct`). Absent items carry no key; the sidecar
    substitutes NEUTRAL_INSTRUCT for those slots (PR2-Mi1). */
export interface SynthesizeBatchItem {
  text: string;
  voiceName: string;
  /** fs-57 — delivery direction for the 1.7B liveInstruct path. Absent
      when the gate is off or no instruct/emotion phrase applies. */
  instruct?: string;
  /** fs-57 — delivery emotion for the liveInstruct gain path. The sidecar
      uses this (not the voice name suffix) to look up the output gain on the
      liveInstruct path. Absent → unity gain (1.0). */
  emotion?: string;
}

export interface SynthesizeBatchInput {
  items: SynthesizeBatchItem[];
  modelKey: TtsModelKey;
  /** fs-57 — when true the sidecar activates the liveInstruct path for the
      whole batch (1.7B-only). Per-item `instruct` carries the phrase; absent
      items get the sidecar's NEUTRAL_INSTRUCT fill (PR2-Mi1). Default false
      (absent = off, back-compat). */
  liveInstruct?: boolean;
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
