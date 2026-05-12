/* Frontend-facing list of Gemini models the user can pick on the upload
   screen. The id is the literal string passed to the server, which forwards
   it to @google/genai's `models.generateContent({ model })`. Verified
   2026-05 via the v1beta ListModels endpoint. */

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'gemma-4-31b-it',           label: 'Gemma 4 31B',           hint: 'Open-weights, default — separate quota bucket from Gemini' },
  { id: 'gemma-4-26b-a4b-it',       label: 'Gemma 4 26B',           hint: 'Open-weights, A4B variant' },
  { id: 'gemini-2.5-flash',         label: 'Gemini 2.5 Flash',      hint: 'Fast, balanced, 20/day free tier' },
  { id: 'gemini-3-flash-preview',   label: 'Gemini 3 Flash',        hint: 'Newer, preview' },
  { id: 'gemini-3.1-flash-lite',    label: 'Gemini 3.1 Flash Lite', hint: 'Cheapest, lowest latency' },
];

export const DEFAULT_MODEL = 'gemma-4-31b-it';
