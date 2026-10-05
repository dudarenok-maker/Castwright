/* #3084 PR 3b — the analyzer for a named OpenAI-compatible endpoint. Same
   stage table and runner as OllamaAnalyzer / GeminiAnalyzer; only the
   transport, retry policy, request settings and schema adapter differ.
   Not constructed by selectAnalyzer until PR 3d. */
import type { Agent } from 'undici';
/* #3084 review pass 3, item 9 — TransportAnalyzer is W1's, created in its own
   module `./runner/transport-analyzer.js`, not `./runner/stage-runner.js`.
   StageRunner stays in stage-runner.js. */
import { StageRunner } from './runner/stage-runner.js';
import { TransportAnalyzer } from './runner/transport-analyzer.js';
import { OPENAI_RETRY_POLICY } from './runner/retry-policy.js';
import { adaptSchemaForOpenAI } from './runner/schema-adapters.js';
import type { EngineRequestSettings } from './runner/stage-runner.js';
import { OpenAITransport, resolveEndpointMaxOutputTokens } from './transports/openai-transport.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';

/** #3084 P24 — the request settings an endpoint's runner reads. `maxOutputTokens` is
    always a number: a manual value, or Auto's min(served output limit if known,
    contextTokens − margin). The transport takes each request's estimated input off
    Auto. PR 3c passes the served output limit its prepare() warms. */
export function openAIRequestSettings(endpoint: AnalyzerEndpoint, servedOutputLimit?: number): EngineRequestSettings {
  return {
    structuredOutput: endpoint.structuredOutput,
    maxOutputTokens: resolveEndpointMaxOutputTokens(endpoint, servedOutputLimit),
    /* No reasoning / extraParams: EngineRequestSettings has neither field until
       wave 5 (Task 5.1). Task 5.3 adds `reasoning:` and Task 5.10 adds `extraParams:` here. */
  };
}

export class OpenAIAnalyzer extends TransportAnalyzer {
  constructor(opts: { endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent }) {
    super(
      new StageRunner({
        transport: new OpenAITransport({
          endpoint: opts.endpoint,
          apiKey: opts.apiKey,
          model: opts.model,
          dispatcher: opts.dispatcher,
        }),
        policy: OPENAI_RETRY_POLICY,
        settings: () => openAIRequestSettings(opts.endpoint),
        adaptSchema: adaptSchemaForOpenAI,
      }),
    );
  }
}
