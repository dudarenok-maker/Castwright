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
import { getEndpointServedLimits } from './catalog/endpoint-served-limits.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { AnalyzerReasoningOverflowError } from './errors.js';
import type { StageCall } from './types.js';

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
  private readonly endpoint: AnalyzerEndpoint;

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
        /* P15 / P24: the served output limit prepare() warmed for this base URL (undefined when
           unknown); openAIRequestSettings keeps maxOutputTokens a number either way. */
        settings: () => openAIRequestSettings(opts.endpoint, getEndpointServedLimits(opts.endpoint.baseUrl, opts.model)?.maxOutputTokens),
        adaptSchema: adaptSchemaForOpenAI,
      }),
    );
    this.endpoint = opts.endpoint;
  }

  /* #3084 F7 (Task 3b.1b) — the runner that raises AnalyzerReasoningOverflowError is
     transport-agnostic and has no endpoint, so this class stamps its own id. This
     catches an overflow THROWN out of a stage call (every method below but the
     escalation one). */
  private async withEndpointId<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AnalyzerReasoningOverflowError && err.endpointId === undefined) {
        err.endpointId = this.endpoint.id;
      }
      throw err;
    }
  }

  /* #3084 F7 (Task 3b.1b) — wraps the escalation call's onReasoningOverflow. The
     escalation path REPORTS an overflow through this hook and stores it, never
     throwing it, so this is the only point this class touches that error before the
     route rethrows the same object outside the analyzer. */
  private withEndpointIdHook(call: StageCall): StageCall {
    return {
      ...call,
      onReasoningOverflow: (err: AnalyzerReasoningOverflowError) => {
        if (err.endpointId === undefined) err.endpointId = this.endpoint.id;
        call.onReasoningOverflow?.(err);
      },
    };
  }

  runStage1(...args: Parameters<TransportAnalyzer['runStage1']>): ReturnType<TransportAnalyzer['runStage1']> {
    return this.withEndpointId(() => super.runStage1(...args));
  }

  runStage1Chapter(...args: Parameters<TransportAnalyzer['runStage1Chapter']>): ReturnType<TransportAnalyzer['runStage1Chapter']> {
    return this.withEndpointId(() => super.runStage1Chapter(...args));
  }

  runStage2Chapter(...args: Parameters<TransportAnalyzer['runStage2Chapter']>): ReturnType<TransportAnalyzer['runStage2Chapter']> {
    return this.withEndpointId(() => super.runStage2Chapter(...args));
  }

  runEmotionChapter(...args: Parameters<TransportAnalyzer['runEmotionChapter']>): ReturnType<TransportAnalyzer['runEmotionChapter']> {
    return this.withEndpointId(() => super.runEmotionChapter(...args));
  }

  runNonStoryClassification(
    ...args: Parameters<TransportAnalyzer['runNonStoryClassification']>
  ): ReturnType<TransportAnalyzer['runNonStoryClassification']> {
    return this.withEndpointId(() => super.runNonStoryClassification(...args));
  }

  runScriptReviewChapter(...args: Parameters<TransportAnalyzer['runScriptReviewChapter']>): ReturnType<TransportAnalyzer['runScriptReviewChapter']> {
    return this.withEndpointId(() => super.runScriptReviewChapter(...args));
  }

  runStage3Chapter(...args: Parameters<TransportAnalyzer['runStage3Chapter']>): ReturnType<TransportAnalyzer['runStage3Chapter']> {
    return this.withEndpointId(() => super.runStage3Chapter(...args));
  }

  runAttributionEscalation(
    manuscriptId: string,
    chapterId: number,
    windowIndex: number,
    prompt: string,
    call: StageCall,
  ): ReturnType<TransportAnalyzer['runAttributionEscalation']> {
    return this.withEndpointId(() =>
      super.runAttributionEscalation(manuscriptId, chapterId, windowIndex, prompt, this.withEndpointIdHook(call)),
    );
  }
}
