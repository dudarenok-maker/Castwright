/* GeminiAnalyzer — a TransportAnalyzer over transports/gemini-transport.ts
   (free-tier Google API via @google/genai). Prompt building, inbox/outbox
   traceability, validation with the shared Zod schemas and the single
   validation retry live in runner/stage-runner.ts; this engine's retry shape
   is GEMINI_RETRY_POLICY (runner/retry-policy.ts). */

import { GeminiTransport } from './transports/gemini-transport.js';
import { TransportAnalyzer } from './runner/transport-analyzer.js';
import { StageRunner } from './runner/stage-runner.js';
import { adaptSchemaForGemini } from './runner/schema-adapters.js';
import type { StructuredOutputMode } from './runner/transport.js';
import { GEMINI_RETRY_POLICY } from './runner/retry-policy.js';
import { configValue } from '../config/resolver.js';
import { resolveGeminiMaxOutputTokens } from './capacity.js';
import { getCachedUserSettings } from '../workspace/user-settings.js';
import { resolveReasoningSetting } from './reasoning.js';
import { requestMaxOutputTokens, resolveExtraParamsSetting } from './runner/extra-params.js';

/* Re-exports for backward compatibility — callers and tests that imported
   these from gemini.ts still resolve after the wave-1 extraction. */
export { loadSkill, buildSystemInstruction, languagePreamble, estimateInputTokens } from './runner/prompt.js';
export type { SkillName } from './runner/prompt.js';
export { parseAndValidate, stripCodeFences, repairUnescapedQuotes, trimTrailingProse,
  repairStructuralPunctuation, buildRetryMessage, summariseDetail, persistResponse,
  type ParseResult,
} from './runner/parse.js';
export { GeminiStreamIdleError, resolveGeminiTemperature,
  STREAM_IDLE_TIMEOUT_MS, MAX_RESPONSE_BYTES, appendBounded, resolveStreamIdleTimeoutMs,
} from './transports/gemini-transport.js';
export { BACKOFFS_MS, parseRetryDelayMs } from './runner/transport-retry.js';
export { nextUtcMidnight } from './rate-limit.js';

interface GeminiOptions {
  apiKey: string;
  model: string;
}

export class GeminiAnalyzer extends TransportAnalyzer {
  constructor(opts: GeminiOptions) {
    super(
      new StageRunner({
        transport: new GeminiTransport({ apiKey: opts.apiKey, model: opts.model }),
        policy: GEMINI_RETRY_POLICY,
        /* The mode is read per request (analyzer.gemini.structuredOutput).
           maxOutputTokens reads the catalog the transport's prepare() warmed. */
        settings: () => {
          const extraParams = resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'gemini' });
          return {
            structuredOutput: configValue<StructuredOutputMode>('analyzer.gemini.structuredOutput'),
            /* P19 — the model's output limit, or the payload's own cap. */
            maxOutputTokens: requestMaxOutputTokens('gemini', extraParams, () => resolveGeminiMaxOutputTokens(opts.model)),
            reasoning: resolveReasoningSetting(getCachedUserSettings(), { engine: 'gemini', model: opts.model }),
            extraParams,
          };
        },
        adaptSchema: adaptSchemaForGemini,
      }),
    );
  }
}
