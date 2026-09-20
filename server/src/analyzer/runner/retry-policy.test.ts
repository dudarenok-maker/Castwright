import { describe, it, expect } from 'vitest';
import { OLLAMA_RETRY_POLICY, GEMINI_RETRY_POLICY } from './retry-policy.js';
import { buildRetryMessage, type ParseResult } from './parse.js';
import { resolveOllamaTemperature, resolveOllamaRetryTemperature } from '../ollama-settings.js';
import { resolveGeminiTemperature } from '../transports/gemini-transport.js';
import { AnalysisAbortedError, AnalyzerHttpError, LocalUnreachableError } from '../errors.js';
import { DailyQuotaExhaustedError } from '../rate-limit.js';
import type { ChatMessage } from './transport.js';

type Failure = Extract<ParseResult<unknown>, { ok: false }>;
const FIRST: ChatMessage[] = [{ role: 'user', content: '# prompt' }];
const INVALID_JSON: Failure = { ok: false, kind: 'invalid-json', detail: 'Unexpected end of JSON input' };
const SCHEMA: Failure = { ok: false, kind: 'schema-validation', detail: [] };
const ERRORS = {
  abort: new AnalysisAbortedError('x'),
  unreachable: new LocalUnreachableError('down'),
  http: new AnalyzerHttpError('ollama', 500, 'b', 'm'),
  quota: new DailyQuotaExhaustedError('gemma-x', new Date()),
  plain: new Error('empty'),
};

describe('OLLAMA_RETRY_POLICY', () => {
  it('invalid-json drops the assistant turn and uses the retry temperature', () => {
    expect(OLLAMA_RETRY_POLICY.buildRetry({ messages: FIRST, firstRaw: '{"a"', failure: INVALID_JSON })).toEqual({
      messages: FIRST,
      temperature: resolveOllamaRetryTemperature(),
    });
  });

  it('schema-validation replays the output + buildRetryMessage at the first-attempt temperature', () => {
    expect(OLLAMA_RETRY_POLICY.buildRetry({ messages: FIRST, firstRaw: 'RAW', failure: SCHEMA })).toEqual({
      messages: [...FIRST, { role: 'assistant', content: 'RAW' }, { role: 'user', content: buildRetryMessage(SCHEMA) }],
      temperature: resolveOllamaTemperature(),
    });
  });

  it('first-attempt temperature, raw forensics and repair warnings', () => {
    expect(OLLAMA_RETRY_POLICY.name).toBe('ollama');
    expect(OLLAMA_RETRY_POLICY.initialTemperature()).toBe(resolveOllamaTemperature());
    expect(OLLAMA_RETRY_POLICY.writesRawAttempts).toBe(true);
    expect(OLLAMA_RETRY_POLICY.warnsOnRepair).toBe(true);
  });

  it('escalation rethrows abort and LocalUnreachableError only', () => {
    expect(OLLAMA_RETRY_POLICY.escalationRethrows(ERRORS.abort)).toBe(true);
    expect(OLLAMA_RETRY_POLICY.escalationRethrows(ERRORS.unreachable)).toBe(true);
    expect(OLLAMA_RETRY_POLICY.escalationRethrows(ERRORS.http)).toBe(false);
    expect(OLLAMA_RETRY_POLICY.escalationRethrows(ERRORS.plain)).toBe(false);
  });

  it('final failure message names model and key', () => {
    expect(OLLAMA_RETRY_POLICY.finalFailureMessage({ model: 'qwen3.5:9b', key: '1-ch1', detail: 'schema-validation — []' })).toBe(
      'Ollama qwen3.5:9b 1-ch1 failed validation after retry: schema-validation — []',
    );
  });
});

describe('GEMINI_RETRY_POLICY', () => {
  it.each([
    ['invalid-json', INVALID_JSON],
    ['schema-validation', SCHEMA],
  ] as const)('%s replays the output + buildRetryMessage at the same temperature', (_label, failure) => {
    expect(GEMINI_RETRY_POLICY.buildRetry({ messages: FIRST, firstRaw: 'RAW', failure })).toEqual({
      messages: [...FIRST, { role: 'assistant', content: 'RAW' }, { role: 'user', content: buildRetryMessage(failure) }],
      temperature: resolveGeminiTemperature(),
    });
  });

  it('first-attempt temperature; no raw forensics; no repair warnings', () => {
    expect(GEMINI_RETRY_POLICY.name).toBe('gemini');
    expect(GEMINI_RETRY_POLICY.initialTemperature()).toBe(resolveGeminiTemperature());
    expect(GEMINI_RETRY_POLICY.writesRawAttempts).toBe(false);
    expect(GEMINI_RETRY_POLICY.warnsOnRepair).toBe(false);
  });

  it('escalation rethrows abort only — a daily-quota or unreachable error resolves null', () => {
    expect(GEMINI_RETRY_POLICY.escalationRethrows(ERRORS.abort)).toBe(true);
    expect(GEMINI_RETRY_POLICY.escalationRethrows(ERRORS.quota)).toBe(false);
    expect(GEMINI_RETRY_POLICY.escalationRethrows(ERRORS.unreachable)).toBe(false);
    expect(GEMINI_RETRY_POLICY.escalationRethrows(ERRORS.plain)).toBe(false);
  });

  it('final failure message names the key but not the model', () => {
    expect(GEMINI_RETRY_POLICY.finalFailureMessage({ model: 'gemma-x', key: '1-ch1', detail: 'invalid-json — x' })).toBe(
      'Gemini 1-ch1 failed validation after retry: invalid-json — x',
    );
  });
});
