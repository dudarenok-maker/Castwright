/* #3084 wave 2 — EngineCapacity: the per-model sizing descriptor the chunk-
   budget resolvers take instead of an engine name (spec §6). It carries
   TODAY's formula family so budgets stay byte-identical
   (capacity-pinning.test.ts):
     context    — Ollama: analyzer.stage{1,2}.localInputFraction × contextTokens
                  at 2 chars/token, no reservation (stage1-chunk.ts,
                  stage2-chunk.ts).
     requestCap — Gemini: cloudBodyCharBudget at perRequestInputCap, with the
                  existing token/char reservations (token-budget.ts).
                  perRequestInputCap is analyzer.gemini.maxInputTokensPerRequest
                  alone here; PR 2b bounds it by the model's TPM.
   Ollama's contextTokens is num_ctx AS SENT — deliberately not clamped to
   /api/show's native context before on-box measurement (register row
   "Capacity recalibration"). Endpoints (context family + optional cap) arrive
   in wave 3. Must not import ollama.ts: ollama.ts's settings provider will
   import this module in a later wave. */
import { configValue } from '../config/resolver.js';
import { resolveMaxInputTokensPerRequest } from './token-budget.js';

export interface EngineCapacity {
  family: 'context' | 'requestCap';
  contextTokens: number;
  /** The model's own output-token limit when known; null = unlimited/unknown (Ollama). */
  maxOutputTokens: number | null;
  /** Request-cap family: the per-request input-token cap budgets are sized to. */
  perRequestInputCap?: number;
}

/** Gemini's output cap when the model's limit is unknown (spec §7: "8192 when
    the listing is unavailable"). */
export const GEMINI_FALLBACK_MAX_OUTPUT_TOKENS = 8192;

export const TODAY_LOCAL_CAPACITY = (
  numCtx: number = configValue<number>('analyzer.ollama.numCtx'),
): EngineCapacity => ({ family: 'context', contextTokens: numCtx, maxOutputTokens: null });

export function resolveCapacity(sel: { engine: 'local' | 'gemini'; model: string }): EngineCapacity {
  if (sel.engine === 'local') return TODAY_LOCAL_CAPACITY();
  const cap = resolveMaxInputTokensPerRequest();
  return {
    family: 'requestCap',
    contextTokens: cap,
    maxOutputTokens: GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
    perRequestInputCap: cap,
  };
}
