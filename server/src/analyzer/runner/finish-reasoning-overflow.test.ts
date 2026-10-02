/* #3084 wave 2b — reasoning overflow vs truncation (spec §7). A `length` finish
   with an empty answer and reasoning evidence cannot be fixed by splitting the
   chunk (splitting never shrinks reasoning), so it fails as its own class. With
   no evidence it stays AnalyzerTruncatedError: an empty MAX_TOKENS on a
   non-thinking model (Gemma, gemini.ts:784-804) IS a size problem. */
import { describe, it, expect } from 'vitest';
import { mapFinish, hasReasoningEvidence } from './finish.js';
import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError } from '../errors.js';
import type { TransportResult } from './transport.js';

const ctx = { kind: 'gemini' as const, model: 'gemini-3.6-flash' };
const lengthResult = (over: Partial<TransportResult> = {}): TransportResult => ({
  text: '',
  reasoningSeen: false,
  finish: 'length',
  receivedBytes: 0,
  ...over,
});
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('mapFinish — reasoning overflow vs truncation (#3084 wave 2b)', () => {
  it('length + empty answer + reasoning tokens → AnalyzerReasoningOverflowError carrying the count', () => {
    const err = thrownBy(() => mapFinish(lengthResult({ usage: { reasoningTokens: 8100 } }), ctx));
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect(err).toMatchObject({ transport: 'gemini', model: 'gemini-3.6-flash', reasoningTokens: 8100 });
  });

  it('length + empty answer + reasoningSeen (thought parts / reasoning deltas) → overflow', () => {
    expect(thrownBy(() => mapFinish(lengthResult({ reasoningSeen: true }), ctx))).toBeInstanceOf(
      AnalyzerReasoningOverflowError,
    );
  });

  it('length + only an unterminated <think> block → overflow', () => {
    const r = lengthResult({ text: '<think>The narrator speaks first, then', receivedBytes: 38 });
    expect(thrownBy(() => mapFinish(r, { kind: 'ollama', model: 'qwen3.5:4b' }))).toBeInstanceOf(
      AnalyzerReasoningOverflowError,
    );
  });

  it('length + empty answer + NO evidence (Gemma empty MAX_TOKENS) → AnalyzerTruncatedError, so the chunk still splits', () => {
    expect(thrownBy(() => mapFinish(lengthResult(), { kind: 'gemini', model: 'gemma-4-31b-it' }))).toBeInstanceOf(
      AnalyzerTruncatedError,
    );
  });

  it('length + whitespace-only answer + no evidence → AnalyzerTruncatedError', () => {
    expect(thrownBy(() => mapFinish(lengthResult({ text: '  \n', receivedBytes: 3 }), ctx))).toBeInstanceOf(
      AnalyzerTruncatedError,
    );
  });

  it('length + partial answer text, even with reasoning evidence → AnalyzerTruncatedError', () => {
    const r = lengthResult({ text: '{"characters":[{"id":"narr', receivedBytes: 26, usage: { reasoningTokens: 500 } });
    expect(thrownBy(() => mapFinish(r, ctx))).toBeInstanceOf(AnalyzerTruncatedError);
  });

  it('the overflow error is NOT an AnalyzerTruncatedError (no chunker may split it)', () => {
    expect(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 1)).not.toBeInstanceOf(AnalyzerTruncatedError);
  });

  it('a stop finish still returns the answer text', () => {
    const r: TransportResult = { text: '{"ok":true}', reasoningSeen: true, finish: 'stop', receivedBytes: 11, usage: { reasoningTokens: 900 } };
    expect(mapFinish(r, ctx)).toBe('{"ok":true}');
  });
});

describe('hasReasoningEvidence', () => {
  it('is false with zero reasoning tokens and nothing seen', () => {
    expect(hasReasoningEvidence(lengthResult({ usage: { reasoningTokens: 0 } }))).toBe(false);
  });
  it('is true for reasoning tokens or reasoningSeen alone', () => {
    expect(hasReasoningEvidence(lengthResult({ usage: { reasoningTokens: 1 } }))).toBe(true);
    expect(hasReasoningEvidence(lengthResult({ reasoningSeen: true }))).toBe(true);
  });
});
