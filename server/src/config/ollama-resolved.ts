/* #3141 step 1 — Ollama URL/model resolution, split out of workspace/user-
   settings.ts into its own leaf module. Both values resolve through the
   config resolver (env -> saved Advanced Settings override -> registry
   default), which needs `configValue` from config/resolver.ts; resolver.ts
   itself imports `readConfigOverrides` FROM workspace/user-settings.ts. A
   third module depending on both one-directional edges (this file) keeps
   the graph acyclic instead of closing a cycle by having user-settings.ts
   import back from resolver.ts — a closed cycle there broke
   vi.mock('../workspace/user-settings.js', ...importOriginal...) for every
   OTHER module that mocks it (observed in embed-client.test.ts,
   transcribe-client.test.ts, and analyzer/ollama.test.ts's
   vi.mock('../config/resolver.js', ...) replacing the module resolver.ts
   would have needed to register through). */

import { configValue } from './resolver.js';
import { getCachedDefaultAnalysisModelIfSet } from '../workspace/user-settings.js';

/** Hardcoded Ollama tag used as the terminal fallback in
    getResolvedOllamaModel. Cannot be derived from
    DEFAULT_USER_SETTINGS.defaultAnalysisModel any more — that default
    is now a Gemini id (no colon), and Ollama's /api/chat would 404 on it.
    Keep this in sync with src/lib/models.ts MODEL_OPTIONS local entries
    (qwen3.5:4b is still the smallest local option). */
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b';

/** Resolved through the config resolver (#3141 step 1): OLLAMA_URL env →
    saved Advanced Settings override (`analyzer.ollama.url`) → registry
    default. The Account `ollamaUrl` field is no longer read here. */
export function getResolvedOllamaUrl(): string {
  const raw = configValue<string>('analyzer.ollama.url');
  return raw.replace(/\/+$/, '');
}

/** Ollama model tag passed to /api/chat. Resolution chain:
      1. cached `defaultAnalysisModel` if it has Ollama tag shape (':')
      2. config resolver (#3141 step 1): OLLAMA_MODEL env → saved Advanced
         Settings override (`analyzer.ollama.model`) → registry default
         (DEFAULT_OLLAMA_MODEL, `qwen3.5:4b`)
    The per-request `model` override (see selectAnalyzer) trumps both.
    Only a `:`-tagged saved model is honoured for step 1 — a Gemini id
    saved as defaultAnalysisModel (engine=gemini) must not be handed to
    Ollama, so it falls through to step 2. */
export function getResolvedOllamaModel(): string {
  const fromSettings = getCachedDefaultAnalysisModelIfSet();
  if (fromSettings && fromSettings.includes(':')) return fromSettings;
  return configValue<string>('analyzer.ollama.model');
}
