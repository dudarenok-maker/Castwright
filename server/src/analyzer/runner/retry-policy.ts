/* Per-transport validation-retry policy (#3084 wave 1). The stage runner owns
   the attempt loop; these objects hold every place the two pre-extraction
   runners differed, so each engine's behaviour is unchanged. */
import { AnalysisAbortedError, LocalUnreachableError } from '../errors.js';
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
  /** Today's exact post-retry failure text; `detail` is "<kind> — <summarised detail>". */
  finalFailureMessage(input: { model: string; key: string; detail: string }): string;
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
  finalFailureMessage: ({ model, key, detail }) => `Ollama ${model} ${key} failed validation after retry: ${detail}`,
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
  finalFailureMessage: ({ key, detail }) => `Gemini ${key} failed validation after retry: ${detail}`,
};
