/* Frontend-facing list of analysis models. Each entry's `engine` tag tells
   the server which dispatch path to take when the id is sent as a per-
   request `model` override (Ollama tags always contain `:`, Gemini ids
   never do — see selectAnalyzer in server/src/analyzer/index.ts).

   The user picks from these in three places:
     - upload screen "Analysis model" dropdown
     - re-parse modal "Analyse with"
     - analysing view's per-run override
   Account view's "Default analysis model" also reads this list. */

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
  engine: 'local' | 'gemini';
}

export const MODEL_OPTIONS: ModelOption[] = [
  /* --- Local (Ollama, default) --------------------------------------- */
  { id: 'qwen3.5:9b',             label: 'Qwen3.5 9B (local)',     hint: 'Recommended default — ~6.6 GB VRAM, strong JSON adherence', engine: 'local' },
  { id: 'qwen3.5:4b',             label: 'Qwen3.5 4B (local)',     hint: 'Smaller/faster, weaker on edge cases',                       engine: 'local' },
  { id: 'llama3.1:8b',            label: 'Llama 3.1 8B (local)',   hint: 'Alternative local model — must be pulled separately',       engine: 'local' },
  /* --- Gemini API (direct or fallback) ------------------------------- */
  { id: 'gemma-4-31b-it',         label: 'Gemma 4 31B',            hint: 'Open-weights via Gemini API — separate quota from gemini-*', engine: 'gemini' },
  { id: 'gemma-4-26b-a4b-it',     label: 'Gemma 4 26B',            hint: 'Open-weights, A4B variant',                                  engine: 'gemini' },
  { id: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash',       hint: 'Fast, balanced, 20/day free tier',                           engine: 'gemini' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash',         hint: 'Newer, preview',                                             engine: 'gemini' },
  { id: 'gemini-3.1-flash-lite',  label: 'Gemini 3.1 Flash Lite',  hint: 'Cheapest, lowest latency',                                   engine: 'gemini' },
];

export const DEFAULT_MODEL = 'qwen3.5:9b';

/* Grouped form for <optgroup>-rendering pickers. Keeps the optgroup labels
   in one place so the upload / re-parse / analysing pickers stay in sync. */
export const MODEL_OPTION_GROUPS: Array<{ engine: 'local' | 'gemini'; label: string; models: ModelOption[] }> = [
  { engine: 'local',  label: 'Local (Ollama)', models: MODEL_OPTIONS.filter(m => m.engine === 'local') },
  { engine: 'gemini', label: 'Gemini API',     models: MODEL_OPTIONS.filter(m => m.engine === 'gemini') },
];
