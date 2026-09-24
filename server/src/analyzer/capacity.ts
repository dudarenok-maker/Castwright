/* #3084 wave 2 — EngineCapacity: the per-model sizing descriptor the chunk-
   budget resolvers take instead of an engine name (spec §6). It carries
   TODAY's formula family so budgets stay byte-identical
   (capacity-pinning.test.ts):
     context    — Ollama: analyzer.stage{1,2}.localInputFraction × contextTokens
                  at 2 chars/token, no reservation (stage1-chunk.ts,
                  stage2-chunk.ts).
     requestCap — Gemini: cloudBodyCharBudget at perRequestInputCap, with the
                  existing token/char reservations (token-budget.ts).
                  perRequestInputCap = min(analyzer.gemini.maxInputTokensPerRequest,
                  model TPM) (#3084 wave 2b).
   Ollama's contextTokens is num_ctx AS SENT — deliberately not clamped to
   /api/show's native context before on-box measurement. A register row
   "Capacity recalibration" will track this in wave 2b. Gemini's context/output limits come from the cached model
   list (catalog/gemini-catalog.ts); endpoints (context family + optional cap)
   arrive in wave 3. Must not import ollama.ts: ollama.ts's settings provider will
   import this module in a later wave. */
import { configValue } from '../config/resolver.js';
import { getCachedGeminiModelInfo } from './catalog/gemini-catalog.js';
import { resolveLimits } from './rate-limit.js';
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
  const listed = getCachedGeminiModelInfo(sel.model);
  return {
    family: 'requestCap',
    contextTokens: listed?.inputTokenLimit ?? cap,
    maxOutputTokens: listed?.outputTokenLimit ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
    /* #3084 wave 2b (spec §6) — size the request to the smaller of the registry
       cap and the model's per-minute token limit, so one request never exceeds
       a TPM an operator lowered (env GEMINI_TPM_<SLUG> or a saved rate.tpm.*
       override). tpm is Infinity for "unlimited", which leaves the cap. */
    perRequestInputCap: Math.min(cap, resolveLimits(sel.model).tpm),
  };
}

/** The maxOutputTokens a Gemini request sends (spec §7). 0 (the default) is
    Auto: the model's listed outputTokenLimit, else 8192. An explicit value keeps
    its meaning, clamped to the listed limit when known. Synchronous — the
    transport's prepare() warms the catalog before the runner reads settings. */
export function resolveGeminiMaxOutputTokens(model: string): number {
  const limit = getCachedGeminiModelInfo(model)?.outputTokenLimit;
  const configured = configValue<number>('analyzer.gemini.maxOutputTokens');
  if (configured === 0) return limit ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS;
  return limit !== undefined ? Math.min(configured, limit) : configured;
}
