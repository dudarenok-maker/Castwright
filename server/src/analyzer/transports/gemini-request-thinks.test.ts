/* #3084 wave 5 (P27, N1) — a Gemini request thinks when its level says so, not only when its id does.
   One function, geminiRequestThinks, decides both includeThoughts and the thinking window, so a Gemma 4
   request at `on` is not killed mid-think by the 45 s idle window, and a Gemma 4 request at `off` does
   not wait 120 s (F2, F6) on a request that never thinks. A 2.5 id has no row (F2) and always falls back
   to the static id rule, whatever level is saved for it. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* Zero retry backoffs, set before the transport module loads (W2's suite does the same). */
vi.hoisted(() => {
  process.env.GEMINI_RETRY_BACKOFFS_MS = '0,0';
});

import type { GoogleGenAI } from '@google/genai';
import { GeminiTransport, GEMINI_THINKING_IDLE_TIMEOUT_MS, resolveGeminiThinkingIdleTimeoutMs } from './gemini-transport.js';
import { mapFinish } from '../runner/finish.js';
import { AnalyzerReasoningOverflowError, AnalyzerTruncatedError } from '../errors.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { _resetGeminiCatalogForTest } from '../catalog/gemini-catalog.js';
import type { TransportRequest } from '../runner/transport.js';

type Part = { text?: string; thought?: boolean };
function chunk(parts: Part[], extra: { finishReason?: string; thoughtsTokenCount?: number } = {}) {
  const answer = parts.filter((p) => p.thought !== true).map((p) => p.text ?? '').join('');
  return {
    text: answer === '' ? undefined : answer,
    candidates: [{ content: { parts }, ...(extra.finishReason ? { finishReason: extra.finishReason } : {}) }],
    ...(extra.thoughtsTokenCount !== undefined ? { usageMetadata: { thoughtsTokenCount: extra.thoughtsTokenCount } } : {}),
  };
}
function clientWith(generateContentStream: ReturnType<typeof vi.fn>): GoogleGenAI {
  return {
    models: { generateContentStream, list: vi.fn(async () => { throw new Error('offline'); }) },
  } as unknown as GoogleGenAI;
}
const request = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 'system instruction',
  messages: [{ role: 'user', content: 'chapter' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  maxOutputTokens: 8192,
  estimatedInputTokens: 50,
  call: {},
  ...over,
});
const ANSWER = '{"ok":true}';
/** Chunks arrive at fixed offsets from the stream call; the timers are registered synchronously at call time. */
const timedStream = (schedule: Array<{ atMs: number; item: unknown }>) => () => {
  const ready = schedule.map(({ atMs }) => new Promise<void>((resolve) => setTimeout(resolve, atMs)));
  return Promise.resolve(
    (async function* () {
      for (const [i, { item }] of schedule.entries()) {
        await ready[i];
        yield item;
      }
    })(),
  );
};
const answerAfter = (atMs: number) => timedStream([{ atMs, item: chunk([{ text: ANSWER }], { finishReason: 'STOP' }) }]);
const transport = (model: string, gen: ReturnType<typeof vi.fn>) =>
  new GeminiTransport({ apiKey: 'test-key', model, client: clientWith(gen), requestCeilingMs: 1_800_000 });

beforeEach(() => {
  geminiRateLimiter._reset();
  _resetGeminiCatalogForTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.GEMINI_STREAM_IDLE_MS;
  delete process.env.GEMINI_THINKING_IDLE_MS;
});

describe('a Gemini request thinks per its level (P27, N1)', () => {
  it('resolves the window per request: Gemma 4 at on thinks, Gemma 4 at off does not, 3.6 Flash at low or model-default does', () => {
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it', 'on')).toBe(GEMINI_THINKING_IDLE_TIMEOUT_MS);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it', 'off')).toBe(45_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.6-flash', 'low')).toBe(GEMINI_THINKING_IDLE_TIMEOUT_MS);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.6-flash', 'model-default')).toBe(GEMINI_THINKING_IDLE_TIMEOUT_MS);
    /* No level: wave 2's id rule, unchanged. */
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it')).toBe(45_000);
    /* F2 — a 2.5 id has no row, so any saved level falls back to the id rule, same as no level at all. */
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-2.5-flash', 'off')).toBe(resolveGeminiThinkingIdleTimeoutMs('gemini-2.5-flash'));
  });

  it('Gemma 4 at on: the request asks for thought summaries, and a 60 s silent think is not killed (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const gen = vi.fn().mockImplementation(answerAfter(60_000));
    let text: string | undefined;
    const sent = transport('gemma-4-31b-it', gen)
      .send(request({ reasoning: 'on' }))
      .then((r) => {
        text = r.text;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(gen).toHaveBeenCalledTimes(1);
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: true });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(gen).toHaveBeenCalledTimes(1); // no watchdog kill, so no second attempt
    expect(text).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await sent;
    expect(text).toBe(ANSWER);
  });

  it('gemini-3.6-flash at model-default keeps the thinking window: a 60 s silence is not killed (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const gen = vi.fn().mockImplementation(answerAfter(60_000));
    let text: string | undefined;
    const sent = transport('gemini-3.6-flash', gen)
      .send(request({ reasoning: 'model-default' }))
      .then((r) => {
        text = r.text;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ includeThoughts: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await sent;
    expect(gen).toHaveBeenCalledTimes(1);
    expect(text).toBe(ANSWER);
  });

  it("gemma-4-31b-it at off gets today's idle window and no thought summaries: a 60 s silence is killed at 45 s and retried (fake clock)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(answerAfter(60_000));
    const sent = transport('gemma-4-31b-it', gen)
      .send(request({ reasoning: 'off' }))
      .catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(0);
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(gen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(gen.mock.calls.length).toBeGreaterThan(1); // killed by the 45 s idle window, then retried
    await vi.advanceTimersByTimeAsync(600_000);
    await sent;
  });

  it('a Gemma 4 request at on reports thoughtsTokenCount as reasoning tokens; at off it does not (its request asked for no thoughts)', async () => {
    const withThoughts = () =>
      Promise.resolve(
        (async function* () {
          yield chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 321 });
        })(),
      );
    const on = await transport('gemma-4-31b-it', vi.fn().mockImplementation(withThoughts)).send(request({ reasoning: 'on' }));
    const off = await transport('gemma-4-31b-it', vi.fn().mockImplementation(withThoughts)).send(request({ reasoning: 'off' }));
    expect(on.usage?.reasoningTokens).toBe(321);
    expect(off.usage?.reasoningTokens).toBeUndefined();
  });

  it('a free-text request counts thoughtsTokenCount only when its own wire asked for thoughts (A3)', async () => {
    const withThoughts = () =>
      Promise.resolve(
        (async function* () {
          yield chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 321 });
        })(),
      );
    const free = (reasoning: 'model-default' | 'low') =>
      request({ system: '', structuredOutput: { mode: 'off' }, temperature: undefined, maxOutputTokens: undefined, freeText: {}, reasoning });
    const gen = vi.fn().mockImplementation(withThoughts);
    const t = transport('gemini-3.6-flash', gen);
    const atDefault = await t.send(free('model-default'));
    const atLow = await t.send(free('low'));
    /* A persona request at model-default sends no thinkingConfig (W4), so its count is not evidence… */
    expect('thinkingConfig' in (gen.mock.calls[0][0].config as Record<string, unknown>)).toBe(false);
    expect(atDefault.usage?.reasoningTokens).toBeUndefined();
    /* …while a level that thinks sends includeThoughts, and then it is. */
    expect(gen.mock.calls[1][0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: true });
    expect(atLow.usage?.reasoningTokens).toBe(321);
  });
});

describe('an empty MAX_TOKENS finish: Gemma at on overflows, Gemma at off or its default splits (G1, P27 as amended)', () => {
  /* One stream for all three: an empty answer cut off at the cap, with thought tokens reported and no
     thought parts. Only the request's own level decides whether that count is reasoning evidence. */
  const truncatedAfterThinking = () =>
    Promise.resolve(
      (async function* () {
        yield chunk([], { finishReason: 'MAX_TOKENS', thoughtsTokenCount: 900 });
      })(),
    );
  const thrownFinish = async (reasoning: 'on' | 'off' | undefined): Promise<unknown> => {
    const result = await transport('gemma-4-31b-it', vi.fn().mockImplementation(truncatedAfterThinking)).send(request({ reasoning }));
    try {
      mapFinish(result, { kind: 'gemini', model: 'gemma-4-31b-it' });
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it('at on the thought tokens are evidence, so the finish is a reasoning overflow that stops the run (P6, P20)', async () => {
    const err = await thrownFinish('on');
    expect(err).toBeInstanceOf(AnalyzerReasoningOverflowError);
    expect((err as AnalyzerReasoningOverflowError).reasoningTokens).toBe(900);
  });

  it.each([['off'], [undefined]] as const)('at %s the request asked for no thoughts, so the same finish splits (#528 recovery)', async (reasoning) => {
    const err = await thrownFinish(reasoning);
    expect(err).toBeInstanceOf(AnalyzerTruncatedError);
    expect(err).not.toBeInstanceOf(AnalyzerReasoningOverflowError);
  });
});
