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

import { configValue, resolveKnob } from './resolver.js';
import { getKnob } from './registry.js';
import { getCachedDefaultAnalysisModelIfSet } from '../workspace/user-settings.js';
import { inferEngineFromModelId } from '../analyzer/model-id.js';

/** Resolved through the config resolver (#3141 step 1): OLLAMA_URL env →
    saved Advanced Settings override (`analyzer.ollama.url`) → registry
    default. The Account `ollamaUrl` field is no longer read here. */
export function getResolvedOllamaUrl(): string {
  const raw = configValue<string>('analyzer.ollama.url');
  return raw.replace(/\/+$/, '');
}

/** Ollama model tag passed to /api/chat. Resolution chain (80be2f1d):
      1. cached `defaultAnalysisModel`, if it has Ollama tag shape (':')
      2. config resolver: OLLAMA_MODEL env → saved Advanced Settings
         override (`analyzer.ollama.model`) → registry default
    The per-request `model` override (see selectAnalyzer) trumps both.
    #3084 P23 (review pass 3, A3): main's own step-1 check ("has a colon")
    also accepts an `openai:<endpointId>::<model>` id, which contains a
    colon too — so does an env/override value at step 2. Both tiers are
    guarded here with the shared grammar (analyzer/model-id.ts): an
    endpoint id is never an Ollama tag, so it is treated as absent at
    whichever tier it appears, falling through to the tier below it (never
    a raw env read — resolveKnob/getKnob only, so direct-env-reader-guard
    stays satisfied). */
export function getResolvedOllamaModel(): string {
  const fromSettings = getCachedDefaultAnalysisModelIfSet();
  if (fromSettings && fromSettings.includes(':') && inferEngineFromModelId(fromSettings) !== 'openai') {
    return fromSettings;
  }
  const knob = getKnob('analyzer.ollama.model');
  const resolved = String(resolveKnob(knob).effective);
  if (inferEngineFromModelId(resolved) === 'openai') return String(knob.default);
  return resolved;
}
