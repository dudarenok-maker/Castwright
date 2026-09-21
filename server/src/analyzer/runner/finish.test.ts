import { describe, it, expect } from 'vitest';
import { mapFinish, withThinkEvidence } from './finish.js';
import { AnalyzerTruncatedError, GeminiContentBlockedError } from '../errors.js';
import type { TransportResult } from './transport.js';

const res = (over: Partial<TransportResult>): TransportResult => ({
  text: '',
  reasoningSeen: false,
  finish: 'stop',
  receivedBytes: 0,
  ...over,
});
const OLLAMA = { kind: 'ollama', model: 'qwen3.5:9b' } as const;
const GEMINI = { kind: 'gemini', model: 'gemma-4-31b-it' } as const;

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('mapFinish — wave 1 reproduces each engine\'s pre-W1 finish handling', () => {
  it('ollama stop with text returns the text', () => {
    expect(mapFinish(res({ text: '{"a":1}', receivedBytes: 7 }), OLLAMA)).toBe('{"a":1}');
  });

  it('ollama empty stop throws the empty-response Error', () => {
    const err = thrown(() => mapFinish(res({}), OLLAMA));
    expect(err).not.toBeInstanceOf(AnalyzerTruncatedError);
    expect((err as Error).message).toBe('Ollama qwen3.5:9b returned an empty response.');
  });

  it('ollama EMPTY length is still the empty-response Error (emptiness is checked before done_reason)', () => {
    const err = thrown(() => mapFinish(res({ finish: 'length', finishReason: 'length' }), OLLAMA));
    expect(err).not.toBeInstanceOf(AnalyzerTruncatedError);
    expect((err as Error).message).toBe('Ollama qwen3.5:9b returned an empty response.');
  });

  it('ollama non-empty length throws AnalyzerTruncatedError(ollama, length, bytes) with no token count', () => {
    const err = thrown(() =>
      mapFinish(res({ text: '{"characters":[{"id":"narr', finish: 'length', finishReason: 'length', receivedBytes: 26 }), OLLAMA),
    );
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'ollama', reason: 'length', receivedBytes: 26, outputTokens: undefined });
  });

  it('gemini blocked throws GeminiContentBlockedError naming the reason', () => {
    const err = thrown(() => mapFinish(res({ finish: 'blocked', blockReason: 'RECITATION' }), GEMINI));
    expect(err).toBeInstanceOf(GeminiContentBlockedError);
    expect(err).toMatchObject({ model: 'gemma-4-31b-it', reason: 'RECITATION' });
  });

  it('gemini empty MAX_TOKENS is truncation with 0 bytes and the output token count (splittable, not a block)', () => {
    const err = thrown(() =>
      mapFinish(res({ finish: 'length', finishReason: 'MAX_TOKENS', usage: { outputTokens: 8192 } }), GEMINI),
    );
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'gemini', reason: 'MAX_TOKENS', receivedBytes: 0, outputTokens: 8192 });
  });

  it('gemini non-empty SAFETY is truncation, not a block (a non-empty abnormal stop splits today)', () => {
    const err = thrown(() =>
      mapFinish(res({ text: '{"a":', finish: 'length', finishReason: 'SAFETY', receivedBytes: 5 }), GEMINI),
    );
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).toMatchObject({ engine: 'gemini', reason: 'SAFETY', receivedBytes: 5 });
  });

  it('gemini stop returns the text', () => {
    expect(mapFinish(res({ text: 'x', receivedBytes: 1 }), GEMINI)).toBe('x');
  });
});

describe('withThinkEvidence (#3084)', () => {
  it('marks reasoningSeen for an unterminated leading <think>', () => {
    expect(withThinkEvidence(res({ text: '<think>hmm', finish: 'length', receivedBytes: 10 })).reasoningSeen).toBe(true);
  });
  it('returns the same object for a terminated block or plain text', () => {
    const terminated = res({ text: '<think>x</think>{}' });
    const plain = res({ text: '{}' });
    expect(withThinkEvidence(terminated)).toBe(terminated);
    expect(withThinkEvidence(plain)).toBe(plain);
  });
});
