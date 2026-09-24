/* GeminiAnalyzer — a TransportAnalyzer over transports/gemini-transport.ts
   (free-tier Google API via @google/genai). Prompt building, inbox/outbox
   traceability, validation with the shared Zod schemas and the single
   validation retry live in runner/stage-runner.ts; this engine's retry shape
   is GEMINI_RETRY_POLICY (runner/retry-policy.ts). */

import { GeminiTransport } from './transports/gemini-transport.js';
import { TransportAnalyzer } from './runner/transport-analyzer.js';
import { StageRunner, identitySchemaAdapter } from './runner/stage-runner.js';
import { GEMINI_RETRY_POLICY } from './runner/retry-policy.js';
import { resolveGeminiMaxOutputTokens } from './capacity.js';

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
        /* Structured output stays 'json' (wave 3 resolves it from
           analyzer.gemini.structuredOutput). maxOutputTokens reads the catalog
           the transport's prepare() warmed. */
        settings: () => ({ structuredOutput: 'json', maxOutputTokens: resolveGeminiMaxOutputTokens(opts.model) }),
        adaptSchema: identitySchemaAdapter,
      }),
    );
  }
}
