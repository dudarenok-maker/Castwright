/* Gemini analyzer — sends the same prompts the human would have run by hand
   through google.generativeai's free tier. Writes the prompt to inbox and the
   raw response to outbox for traceability (both gitignored), validates with
   the shared Zod schemas, and retries ONCE with the validation errors fed
   back as a follow-up turn before giving up. Drives the SSE progress bar
   via a setInterval ticking onWaiting while the API call is in flight. */

import { GeminiTransport } from './transports/gemini-transport.js';
import { TransportAnalyzer } from './runner/transport-analyzer.js';
import { StageRunner, identitySchemaAdapter, type EngineRequestSettings } from './runner/stage-runner.js';
import { GEMINI_RETRY_POLICY } from './runner/retry-policy.js';

/* Re-exports for backward compatibility — callers and tests that imported
   these from gemini.ts still resolve after the wave-1 extraction. */
export { loadSkill, buildSystemInstruction, languagePreamble, estimateInputTokens } from './runner/prompt.js';
export type { SkillName } from './runner/prompt.js';
export { parseAndValidate, stripCodeFences, repairUnescapedQuotes, trimTrailingProse,
  repairStructuralPunctuation, buildRetryMessage, summariseDetail, persistResponse,
  type ParseResult,
} from './runner/parse.js';
export { GeminiStreamIdleError, resolveMaxOutputTokens, resolveGeminiTemperature,
  STREAM_IDLE_TIMEOUT_MS, MAX_RESPONSE_BYTES, appendBounded, resolveStreamIdleTimeoutMs,
} from './transports/gemini-transport.js';
export { BACKOFFS_MS, parseRetryDelayMs } from './runner/transport-retry.js';
export { nextUtcMidnight } from './rate-limit.js';

interface GeminiOptions {
  apiKey: string;
  model: string;
}

/* W1: structured output is always 'json' (responseMimeType only, today's
   default); wave 3 resolves it from analyzer.gemini.structuredOutput. */
const GEMINI_W1_SETTINGS: EngineRequestSettings = { structuredOutput: 'json', maxOutputTokens: undefined };

export class GeminiAnalyzer extends TransportAnalyzer {
  constructor(opts: GeminiOptions) {
    super(
      new StageRunner({
        transport: new GeminiTransport({ apiKey: opts.apiKey, model: opts.model }),
        policy: GEMINI_RETRY_POLICY,
        settings: () => GEMINI_W1_SETTINGS,
        adaptSchema: identitySchemaAdapter,
      }),
    );
  }
}
