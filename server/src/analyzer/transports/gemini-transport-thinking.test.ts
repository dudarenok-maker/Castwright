/* #3084 wave 2b — Gemini thinking visibility (spec §7). Drives GeminiTransport
   with an injected fake client (no vi.mock, no network). Chunks mirror the SDK:
   `text` is the concatenation of NON-thought text parts (the @google/genai
   GenerateContentResponse.text getter excludes thought parts), and the parts
   themselves carry `thought: true`. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  /* BACKOFFS_MS is read at module load — zero it before transport-retry.ts
     evaluates so a 3-attempt idle exhaustion finishes in ~1 s, not ~9 s. The
     single-attempt case below re-imports with real backoffs. */
  process.env.GEMINI_RETRY_BACKOFFS_MS = '0,0';
});

import type { GoogleGenAI } from '@google/genai';
import { GeminiTransport, GEMINI_THINKING_IDLE_TIMEOUT_MS, resolveGeminiThinkingIdleTimeoutMs } from './gemini-transport.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { listGeminiModels, _resetGeminiCatalogForTest, type GeminiModelsClient } from '../catalog/gemini-catalog.js';
import { allKnobs } from '../../config/registry.js';
import { coerceAndValidate } from '../../config/resolver.js';
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
async function* streamOf(items: unknown[], gapMs = 0, firstDelayMs = 0): AsyncGenerator<unknown> {
  if (firstDelayMs > 0) await new Promise((r) => setTimeout(r, firstDelayMs));
  for (const [i, item] of items.entries()) {
    if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    yield item;
  }
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

beforeEach(() => {
  geminiRateLimiter._reset();
  _resetGeminiCatalogForTest();
});
afterEach(() => {
  delete process.env.GEMINI_STREAM_IDLE_MS;
});

describe('GeminiTransport — thought summaries (#3084 wave 2b)', () => {
  it('asks a thinking model for thought summaries', async () => {
    const gen = vi.fn().mockResolvedValue(streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })]));
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(request());
    expect(gen.mock.calls[0][0].config.thinkingConfig).toEqual({ includeThoughts: true });
  });

  it('does not send thinkingConfig to a model that does not think (Gemma)', async () => {
    const gen = vi.fn().mockResolvedValue(streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })]));
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemma-4-31b-it', client: clientWith(gen) }).send(request());
    expect(gen.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('ignores the catalog thinking flag: a Gemma model listed as thinking still gets no thinkingConfig (P27)', async () => {
    const catalog = {
      models: {
        list: vi.fn(async () =>
          (async function* () {
            yield { name: 'models/gemma-4-31b-it', supportedActions: ['generateContent'], thinking: true };
          })(),
        ),
      },
    } as unknown as GeminiModelsClient;
    await listGeminiModels('test-key', { client: catalog });
    const gen = vi.fn().mockResolvedValue(streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP' })]));
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemma-4-31b-it', client: clientWith(gen) }).send(request());
    expect(gen.mock.calls[0][0].config.thinkingConfig).toBeUndefined();
  });

  it('keeps thought text out of the answer, flags reasoning, and reports thoughtsTokenCount as reasoningTokens', async () => {
    const gen = vi.fn().mockResolvedValue(
      streamOf([
        chunk([{ thought: true, text: 'Let me consider the speakers…' }]),
        chunk([{ thought: true, text: 'Narrator opens the scene.' }]),
        chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 1234 }),
      ]),
    );
    const result = await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(request());
    expect(result.text).toBe(ANSWER);
    expect(result.reasoningSeen).toBe(true);
    expect(result.finish).toBe('stop');
    expect(result.usage?.reasoningTokens).toBe(1234);
  });

  it('a model that does not think reports no reasoningTokens, even when the response carries thoughtsTokenCount (P27)', async () => {
    const gen = vi.fn().mockResolvedValue(
      streamOf([chunk([{ text: ANSWER }], { finishReason: 'STOP', thoughtsTokenCount: 50 })]),
    );
    const result = await new GeminiTransport({ apiKey: 'test-key', model: 'gemma-4-31b-it', client: clientWith(gen) }).send(request());
    expect(result.reasoningSeen).toBe(false);
    expect(result.usage?.reasoningTokens).toBeUndefined();
  });

  it('thought-only chunks feed the heartbeat with the answer byte count unchanged (P4)', async () => {
    const onChunk = vi.fn();
    const gen = vi.fn().mockResolvedValue(
      streamOf([
        chunk([{ thought: true, text: 'thinking' }]),
        chunk([{ thought: true, text: 'still thinking' }]),
        chunk([{ text: ANSWER }], { finishReason: 'STOP' }),
      ]),
    );
    await new GeminiTransport({ apiKey: 'test-key', model: 'gemini-3.6-flash', client: clientWith(gen) }).send(
      request({ call: { onChunk } }),
    );
    expect(onChunk).toHaveBeenCalledTimes(3);
    expect(onChunk.mock.calls[0][0]).toMatchObject({ receivedBytes: 0, receivedText: '' });
    expect(onChunk.mock.calls[1][0]).toMatchObject({ receivedBytes: 0, receivedText: '' });
    expect(onChunk.mock.calls[2][0]).toMatchObject({ receivedBytes: ANSWER.length, receivedText: ANSWER });
  });

describe('thinking window, request ceiling and the per-attempt timing log (#3084 wave 2b, P5)', () => {
  const transport = (model: string, gen: ReturnType<typeof vi.fn>, over: { requestCeilingMs?: number } = {}) =>
    new GeminiTransport({ apiKey: 'test-key', model, client: clientWith(gen), requestCeilingMs: 1_800_000, ...over });
  /** A stream whose chunks arrive at fixed offsets from the stream call. The
      timers are registered inside the mock, synchronously at call time, so a
      fake clock measures every offset from the stream call. */
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
  const answerAfter = (atMs: number) =>
    timedStream([{ atMs, item: chunk([{ text: ANSWER }], { finishReason: 'STOP' }) }]);
  const linesOf = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((call: unknown[]) => call.map(String).join(' '));
  const timingLines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    linesOf(spy).filter((line) => line.startsWith('[gemini] stream-timing'));

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.GEMINI_THINKING_IDLE_MS;
  });

  it('resolves 0 (automatic) per model, and a positive knob value for every model', () => {
    expect(GEMINI_THINKING_IDLE_TIMEOUT_MS).toBe(120_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.6-flash')).toBe(120_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.5-flash-lite')).toBe(120_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it')).toBe(45_000);
    process.env.GEMINI_STREAM_IDLE_MS = '200';
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it')).toBe(200);
    /* 150000 is deliberately distinct from both the automatic thinking
       default (120000) and the automatic non-thinking default (200, set
       above): a value equal to either default would not prove the knob's
       override took effect rather than the automatic path. */
    process.env.GEMINI_THINKING_IDLE_MS = '150000';
    expect(resolveGeminiThinkingIdleTimeoutMs('gemini-3.6-flash')).toBe(150_000);
    expect(resolveGeminiThinkingIdleTimeoutMs('gemma-4-31b-it')).toBe(150_000);
  });

  it('a thinking model whose thought parts arrive 60 s apart across multiple thinking windows, then answers, is not killed (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const thought = (n: number) => chunk([{ thought: true, text: `thought ${n}` }]);
    const gen = vi.fn().mockImplementation(
      timedStream([
        { atMs: 60_000, item: thought(1) },
        { atMs: 120_000, item: thought(2) },
        { atMs: 180_000, item: chunk([{ text: ANSWER }], { finishReason: 'STOP' }) },
      ]),
    );
    let text: string | undefined;
    const sent = transport('gemini-3.6-flash', gen).send(request()).then((r) => {
      text = r.text;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(gen).toHaveBeenCalledTimes(1); // precondition: the stream call happened before the clock moved
    await vi.advanceTimersByTimeAsync(179_999);
    expect(gen).toHaveBeenCalledTimes(1); // no watchdog kill, so no second attempt
    expect(text).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(text).toBe(ANSWER);
    await sent;
  });

  it('a thinking model silent for 121 s fails with AnalyzerTimeoutError after exactly ONE attempt: no retry warning, no onThrottle (fake clock)', async () => {
    /* Real backoffs for this case only: a regression that retried this error
       would log "retrying" and announce its >1 s backoff through onThrottle. */
    process.env.GEMINI_RETRY_BACKOFFS_MS = '6000,12000';
    vi.resetModules();
    const fresh = await import('./gemini-transport.js');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onThrottle = vi.fn();
    const gen = vi.fn().mockImplementation(answerAfter(121_000));
    let failure: unknown;
    const sent = new fresh.GeminiTransport({
      apiKey: 'test-key',
      model: 'gemini-3.6-flash',
      client: clientWith(gen),
      requestCeilingMs: 1_800_000,
    })
      .send(request({ call: { onThrottle } }))
      .catch((err: unknown) => {
        failure = err;
      });
    try {
      await vi.advanceTimersByTimeAsync(119_999);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toMatchObject({
        name: 'AnalyzerTimeoutError',
        reason: 'thinking-idle',
        transport: 'gemini',
        model: 'gemini-3.6-flash',
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gen).toHaveBeenCalledTimes(1);
      expect(linesOf(warn).filter((line) => line.includes('retrying'))).toEqual([]);
      expect(onThrottle).not.toHaveBeenCalled();
      await sent;
    } finally {
      process.env.GEMINI_RETRY_BACKOFFS_MS = '0,0';
    }
  });

  it('a model that does not think, whose first chunk would arrive at 46 s, is killed at 45 s and retried, as today (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(answerAfter(46_000));
    let failure: unknown;
    const sent = transport('gemma-4-31b-it', gen).send(request()).catch((err: unknown) => {
      failure = err;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(gen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(gen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    /* Killed at 45 s, before its 46 s chunk: today's retry rules started attempt 2. */
    expect(gen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(46_000);
    /* Attempt 2 is killed at 90 s; Gemini's 90 s maxTotalMs then ends the loop. */
    expect(failure).toMatchObject({ name: 'GeminiStreamIdleError', idleMs: 45_000 });
    expect(gen).toHaveBeenCalledTimes(2);
    await sent;
  });

  it('after answer text starts, a 46 s gap on a thinking model is killed at 45 s and retried, as today (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(
      timedStream([
        { atMs: 1_000, item: chunk([{ thought: true, text: 'thinking' }]) },
        { atMs: 2_000, item: chunk([{ text: '{"ok":' }]) },
        { atMs: 48_000, item: chunk([{ text: 'true}' }], { finishReason: 'STOP' }) },
      ]),
    );
    let failure: unknown;
    const sent = transport('gemini-3.6-flash', gen).send(request()).catch((err: unknown) => {
      failure = err;
    });
    await vi.advanceTimersByTimeAsync(46_999);
    expect(gen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    /* The answer text started at 2 s, so the 45 s idle window killed the gap at
       47 s, before the 48 s chunk, and today's retry rules started attempt 2. */
    expect(gen).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(47_000);
    /* Attempt 2 (started at 47 s) is killed at 94 s; the 90 s maxTotalMs ends the loop. */
    expect(failure).toMatchObject({ name: 'GeminiStreamIdleError', idleMs: 45_000 });
    expect(gen).toHaveBeenCalledTimes(2);
    await sent;
  });

  it('a positive knob value applies to every model: it spares a model that does not think past its idle window, and ends either kind at its value, once', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '200';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.GEMINI_THINKING_IDLE_MS = '1000';
    const spared = vi.fn().mockImplementation(answerAfter(600));
    const result = await transport('gemma-4-31b-it', spared).send(request());
    expect(result.text).toBe(ANSWER);
    expect(spared).toHaveBeenCalledTimes(1);

    process.env.GEMINI_THINKING_IDLE_MS = '300';
    for (const model of ['gemini-3.6-flash', 'gemma-4-31b-it']) {
      const killed = vi.fn().mockImplementation(answerAfter(900));
      await expect(transport(model, killed).send(request())).rejects.toMatchObject({
        name: 'AnalyzerTimeoutError',
        reason: 'thinking-idle',
      });
      expect(killed).toHaveBeenCalledTimes(1);
    }
  });

  it('silence past the request ceiling fails as AnalyzerTimeoutError, once, never retried (a thinking model)', async () => {
    const gen = vi.fn().mockImplementation(answerAfter(2_000));
    await expect(transport('gemini-3.6-flash', gen, { requestCeilingMs: 300 }).send(request())).rejects.toMatchObject({
      name: 'AnalyzerTimeoutError',
      reason: 'ceiling',
      transport: 'gemini',
    });
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('the ceiling also bounds a model that does not think', async () => {
    process.env.GEMINI_STREAM_IDLE_MS = '5000';
    const gen = vi.fn().mockImplementation(answerAfter(2_000));
    await expect(transport('gemma-4-31b-it', gen, { requestCeilingMs: 300 }).send(request())).rejects.toMatchObject({
      name: 'AnalyzerTimeoutError',
      reason: 'ceiling',
      transport: 'gemini',
    });
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('a caller abort during the wait for the first chunk is an abort, not a timeout', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const gen = vi.fn().mockImplementation(answerAfter(2_000));
    await expect(
      transport('gemini-3.6-flash', gen).send(request({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AnalysisAbortedError' });
  });

  it('both knobs ship with their bounds and defaults; the thinking window refuses 290 001 ms and says why', () => {
    const thinking = allKnobs().find((k) => k.key === 'analyzer.gemini.thinkingIdleTimeoutMs')!;
    expect(thinking).toMatchObject({
      env: 'GEMINI_THINKING_IDLE_MS',
      type: 'integer',
      min: 0,
      max: 290_000,
      default: 0,
    });
    expect(coerceAndValidate(thinking, '290000').ok).toBe(true);
    expect(coerceAndValidate(thinking, '290001').ok).toBe(false);
    expect(thinking.help).toContain('Maximum 290000');
    expect(thinking.help).toContain('300 s');
    expect(allKnobs().find((k) => k.key === 'analyzer.gemini.requestCeilingMs')).toMatchObject({
      env: 'ANALYZER_GEMINI_REQUEST_CEILING_MS',
      type: 'integer',
      min: 60_000,
      max: 14_400_000,
      default: 1_800_000,
    });
  });

  it('logs one timing line per attempt: model, firstChunkMs, firstAnswerMs and thought parts before the answer — never request or response text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gen = vi.fn().mockResolvedValue(
      streamOf([
        chunk([{ thought: true, text: 'SECRET-THOUGHT-1' }]),
        chunk([{ thought: true, text: 'SECRET-THOUGHT-2' }]),
        chunk([{ text: ANSWER }], { finishReason: 'STOP' }),
      ]),
    );
    await transport('gemini-3.6-flash', gen).send(
      request({ system: 'SECRET-SYSTEM', messages: [{ role: 'user', content: 'SECRET-CHAPTER' }] }),
    );
    const lines = timingLines(info);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[gemini\] stream-timing model=gemini-3\.6-flash firstChunkMs=\d+ firstAnswerMs=\d+ thoughtPartsBeforeAnswer=2$/,
    );
    const everything = info.mock.calls.flat().map(String).join('\n');
    for (const secret of ['SECRET-THOUGHT', 'SECRET-SYSTEM', 'SECRET-CHAPTER', ANSWER]) expect(everything).not.toContain(secret);
  });

  it('firstAnswerMs is when the answer text arrived, not the first chunk (fake clock)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(
      timedStream([
        { atMs: 5_000, item: chunk([{ thought: true, text: 'thinking' }]) },
        { atMs: 9_000, item: chunk([{ text: ANSWER }], { finishReason: 'STOP' }) },
      ]),
    );
    const sent = transport('gemini-3.6-flash', gen).send(request());
    await vi.advanceTimersByTimeAsync(9_000);
    await sent;
    expect(timingLines(info)).toEqual([
      '[gemini] stream-timing model=gemini-3.6-flash firstChunkMs=5000 firstAnswerMs=9000 thoughtPartsBeforeAnswer=1',
    ]);
  });

  it('logs firstChunkMs=none firstAnswerMs=none for an attempt that never saw a chunk', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gen = vi.fn().mockImplementation(answerAfter(2_000));
    await transport('gemini-3.6-flash', gen, { requestCeilingMs: 300 }).send(request()).catch(() => undefined);
    expect(timingLines(info)).toEqual([
      '[gemini] stream-timing model=gemini-3.6-flash firstChunkMs=none firstAnswerMs=none thoughtPartsBeforeAnswer=0',
    ]);
  });
});

});
