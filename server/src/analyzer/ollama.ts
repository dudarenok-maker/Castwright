/* Local Ollama analyzer. Header + OllamaTransport.send moved to
   transports/ollama-transport.ts (#3084 wave 1b). */

import { Agent } from 'undici';
import { describeAnalyzerConcurrency } from './analyzer-concurrency.js';
import { OllamaTransport } from './transports/ollama-transport.js';
import { resolveNumPredict } from './ollama-settings.js';
import { TransportAnalyzer } from './runner/transport-analyzer.js';
import { StageRunner } from './runner/stage-runner.js';
import { adaptSchemaForOllama } from './runner/schema-adapters.js';
import type { StructuredOutputMode } from './runner/transport.js';
import { OLLAMA_RETRY_POLICY } from './runner/retry-policy.js';
import { configValue } from '../config/resolver.js';
import { getCachedUserSettings } from '../workspace/user-settings.js';
import { resolveReasoningSetting } from './reasoning.js';
import { requestMaxOutputTokens, resolveExtraParamsSetting } from './runner/extra-params.js';
export { AnalysisAbortedError, LocalUnreachableError } from './errors.js';
export { ANALYZER_DISPATCHER, classifyConnectError, PERSONA_ABSOLUTE_MAX_MS } from './transports/ollama-transport.js';
export {
  resolveOllamaTemperature, resolveOllamaRetryTemperature,
  resolveKeepAliveSeconds, hasKeepAliveOverride, keepAliveFor,
  normalizeModelTag, resolveAnalyzerNumCtx, resolveAnalyzerNumGpu, resolveNumPredict,
  DEFAULT_TEMPERATURE, INVALID_JSON_RETRY_TEMPERATURE,
  ANALYZER_NUM_CTX, ANALYZER_NUM_GPU,
} from './ollama-settings.js';

if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
  console.log(describeAnalyzerConcurrency());
}

interface OllamaOptions {
  /** Base URL of the Ollama daemon (e.g. http://localhost:11434).
      Trailing slash already stripped by getResolvedOllamaUrl. */
  url: string;
  /** Model tag passed to /api/chat (e.g. `qwen3.5:9b`). */
  model: string;
  /** Injected undici dispatcher — for testing only. Defaults to the
      module-level ANALYZER_DISPATCHER singleton. */
  dispatcher?: Agent;
}

export class OllamaAnalyzer extends TransportAnalyzer {
  constructor(opts: OllamaOptions) {
    super(
      new StageRunner({
        transport: new OllamaTransport({ url: opts.url, model: opts.model, dispatcher: opts.dispatcher }),
        policy: OLLAMA_RETRY_POLICY,
        /* The mode is read per request (analyzer.ollama.structuredOutput); the
           output cap is num_predict, resolved per request. */
        settings: () => {
          const extraParams = resolveExtraParamsSetting(getCachedUserSettings(), { engine: 'local' });
          return {
            structuredOutput: configValue<StructuredOutputMode>('analyzer.ollama.structuredOutput'),
            /* P19 — num_predict, or the payload's own cap. */
            maxOutputTokens: requestMaxOutputTokens('ollama', extraParams, resolveNumPredict),
            reasoning: resolveReasoningSetting(getCachedUserSettings(), { engine: 'local', model: opts.model }),
            extraParams,
          };
        },
        adaptSchema: adaptSchemaForOllama,
      }),
    );
  }
}
