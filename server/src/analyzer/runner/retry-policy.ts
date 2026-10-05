/* Per-transport validation-retry policy (#3084 wave 1). The stage runner owns
   the attempt loop; these objects hold every place the two pre-extraction
   runners differed, so each engine's behaviour is unchanged. */
import { AnalysisAbortedError, AnalyzerUnreachableError, LocalUnreachableError } from '../errors.js';
import { resolveOllamaRetryTemperature, resolveOllamaTemperature } from '../ollama-settings.js';
import { resolveGeminiTemperature } from '../transports/gemini-transport.js';
import { buildRetryMessage, type ParseResult } from './parse.js';
import type { ChatMessage } from './transport.js';

type ParseFailure = Extract<ParseResult<unknown>, { ok: false }>;

export interface ValidationRetryPolicy {
  readonly name: 'ollama' | 'gemini' | 'openai';
  /** Temperature of the first attempt (and of escalation's single attempt). */
  initialTemperature(): number;
  buildRetry(input: { messages: ChatMessage[]; firstRaw: string; failure: ParseFailure }): {
    messages: ChatMessage[];
    temperature: number;
  };
  /** Write handoff `attemptN.raw.txt` forensics on a failed attempt. */
  readonly writesRawAttempts: boolean;
  /** Log "required JSON cleanup" when a response only parsed after repair. */
  readonly warnsOnRepair: boolean;
  /** Errors the best-effort escalation pass must rethrow rather than resolve null. */
  escalationRethrows(err: unknown): boolean;
}

function replayAndCorrect(messages: ChatMessage[], firstRaw: string, failure: ParseFailure): ChatMessage[] {
  return [...messages, { role: 'assistant', content: firstRaw }, { role: 'user', content: buildRetryMessage(failure) }];
}

export const OLLAMA_RETRY_POLICY: ValidationRetryPolicy = {
  name: 'ollama',
  initialTemperature: () => resolveOllamaTemperature(),
  buildRetry({ messages, firstRaw, failure }) {
    /* invalid-json: replaying broken bytes at low temperature regenerates the
       same bytes (observed failing at the same byte position twice), so drop
       the assistant turn and raise the temperature. schema-validation:
       replay-and-correct at the first-attempt temperature. */
    if (failure.kind === 'invalid-json') {
      return { messages, temperature: resolveOllamaRetryTemperature() };
    }
    return { messages: replayAndCorrect(messages, firstRaw, failure), temperature: resolveOllamaTemperature() };
  },
  writesRawAttempts: true,
  warnsOnRepair: true,
  escalationRethrows: (err) => err instanceof AnalysisAbortedError || err instanceof LocalUnreachableError,
};

export const GEMINI_RETRY_POLICY: ValidationRetryPolicy = {
  name: 'gemini',
  initialTemperature: () => resolveGeminiTemperature(),
  buildRetry: ({ messages, firstRaw, failure }) => ({
    messages: replayAndCorrect(messages, firstRaw, failure),
    temperature: resolveGeminiTemperature(),
  }),
  writesRawAttempts: false,
  warnsOnRepair: false,
  escalationRethrows: (err) => err instanceof AnalysisAbortedError,
};

/* #3084 PR 3b — OpenAI-compatible endpoints use Ollama's retry SHAPE
   (ollama.ts:560-572): invalid JSON drops the assistant turn and raises the
   temperature so the sampler can leave the failure path; a schema failure
   replays the output with the field list. Endpoints carry no temperature
   field, so the temperatures are these constants (= the Ollama knob defaults,
   registry.ts:27 and :37). */
export const OPENAI_DEFAULT_TEMPERATURE = 0.2;
export const OPENAI_RETRY_TEMPERATURE = 0.6;

export const OPENAI_RETRY_POLICY: ValidationRetryPolicy = {
  name: 'openai',
  initialTemperature: () => OPENAI_DEFAULT_TEMPERATURE,
  buildRetry({ messages, firstRaw, failure }) {
    if (failure.kind === 'invalid-json') {
      return { messages, temperature: OPENAI_RETRY_TEMPERATURE };
    }
    return {
      messages: [...messages, { role: 'assistant', content: firstRaw }, { role: 'user', content: buildRetryMessage(failure) }],
      temperature: OPENAI_DEFAULT_TEMPERATURE,
    };
  },
  writesRawAttempts: true,
  warnsOnRepair: true,
  escalationRethrows: (err) => err instanceof AnalysisAbortedError || err instanceof AnalyzerUnreachableError,
};
