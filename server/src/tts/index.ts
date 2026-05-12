/* TTS provider abstraction — parallels the analyzer pattern in
   src/analyzer/index.ts. Only Gemini is wired this round; the factory shape
   exists so a manual cowork mode (file-drop) or a local Piper backend can
   slot in later without touching callers. */

import { GeminiTtsProvider } from './gemini.js';

export interface SynthesizeInput {
  text: string;
  voiceName: string;
  modelKey: TtsModelKey;
}

export interface SynthesizeOutput {
  pcm: Buffer;
  sampleRate: number;
  mimeType: string;
}

export interface TtsProvider {
  synthesize(input: SynthesizeInput): Promise<SynthesizeOutput>;
}

/* The two model options exposed to the UI. Map UI-stable keys to actual
   Gemini model ids, which are read from env so preview-suffix churn doesn't
   require a code change. */
export type TtsModelKey = 'gemini-2.5-flash' | 'gemini-3.1-flash';

export const TTS_MODEL_LABELS: Record<TtsModelKey, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash TTS',
  'gemini-3.1-flash': 'Gemini 3.1 Flash TTS',
};

export function resolveModelId(key: TtsModelKey): string {
  if (key === 'gemini-2.5-flash') {
    return process.env.GEMINI_TTS_MODEL_25 ?? 'gemini-2.5-flash-preview-tts';
  }
  return process.env.GEMINI_TTS_MODEL_31 ?? 'gemini-3.1-flash-preview-tts';
}

export function isTtsModelKey(value: unknown): value is TtsModelKey {
  return value === 'gemini-2.5-flash' || value === 'gemini-3.1-flash';
}

export function selectTtsProvider(): TtsProvider {
  const mode = (process.env.TTS_PROVIDER ?? 'gemini').toLowerCase();
  if (mode !== 'gemini') {
    throw new Error(`Unknown TTS_PROVIDER mode: ${mode}. Only 'gemini' is supported this round.`);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('TTS_PROVIDER=gemini requires GEMINI_API_KEY to be set (see server/.env.example).');
  }
  return new GeminiTtsProvider({ apiKey });
}
