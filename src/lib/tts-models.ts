/* TTS model options exposed in the voice-library selector. The id matches
   the server's `modelKey` enum (see openapi.yaml VoiceSampleRequest); the
   server resolves it to a concrete Gemini model id via env so preview-suffix
   churn doesn't require a frontend change. */

import type { TtsModelKey } from './types';

export interface TtsModelOption {
  id: TtsModelKey;
  label: string;
  hint?: string;
}

export const TTS_MODEL_OPTIONS: TtsModelOption[] = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash TTS', hint: 'Default, broadly available' },
  { id: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash TTS', hint: 'Newer, preview' },
];

export const DEFAULT_TTS_MODEL: TtsModelKey = 'gemini-2.5-flash';
