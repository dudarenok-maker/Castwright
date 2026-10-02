import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TransportRequest } from '../runner/transport.js';

const generateContentStream = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContentStream };
  },
}));

async function* stream<T>(items: T[], delayMs = 0): AsyncGenerator<T> {
  for (const item of items) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield item;
  }
}
const req = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 'SYS',
  messages: [{ role: 'user', content: 'hi' }],
  structuredOutput: { mode: 'json' },
  temperature: 0.2,
  estimatedInputTokens: 100,
  call: {},
  ...over,
});
const ORIGINAL_IDLE = process.env.GEMINI_STREAM_IDLE_MS;

beforeEach(async () => {
  generateContentStream.mockReset();
  const { geminiRateLimiter } = await import('../rate-limit.js');
  geminiRateLimiter._reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (ORIGINAL_IDLE === undefined) delete process.env.GEMINI_STREAM_IDLE_MS;
  else process.env.GEMINI_STREAM_IDLE_MS = ORIGINAL_IDLE;
});

describe('GeminiTransport (#3084 wave 1)', () => {
  it('builds today\'s request: model turn mapping, verbatim system, json mime type, no thinkingConfig', async () => {
    generateContentStream.mockImplementation(async () => stream([{ text: '{}' }]));
    const { GeminiTransport } = await import('./gemini-transport.js');
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-shape' });
    await t.send(
      req({
        system: '',
        messages: [
          { role: 'user', content: 'p' },
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'fix' },
        ],
      }),
    );
    const args = generateContentStream.mock.calls[0][0];
    expect(args.model).toBe('gemma-gt-shape');
    expect(args.contents).toEqual([
      { role: 'user', parts: [{ text: 'p' }] },
      { role: 'model', parts: [{ text: 'a' }] },
      { role: 'user', parts: [{ text: 'fix' }] },
    ]);
    expect(args.config.systemInstruction).toBe('');
    expect(args.config.responseMimeType).toBe('application/json');
    expect(args.config.temperature).toBe(0.2);
    expect(args.config.maxOutputTokens).toBe(8192); // no req.maxOutputTokens → GEMINI_FALLBACK_MAX_OUTPUT_TOKENS
    expect(args.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect('thinkingConfig' in args.config).toBe(false);
    expect('responseJsonSchema' in args.config).toBe(false);
  });

  it('maps structured output off → no mime type, schema → mime type + responseJsonSchema', async () => {
    generateContentStream.mockImplementation(async () => stream([{ text: '{}' }]));
    const { GeminiTransport } = await import('./gemini-transport.js');
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-modes' });
    await t.send(req({ structuredOutput: { mode: 'off' } }));
    await t.send(req({ structuredOutput: { mode: 'schema', name: 's', schema: { type: 'object' } } }));
    expect('responseMimeType' in generateContentStream.mock.calls[0][0].config).toBe(false);
    expect(generateContentStream.mock.calls[1][0].config).toMatchObject({
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
    });
  });

  it('thought parts set reasoningSeen, keep the idle watchdog alive, and never enter text', async () => {
    /* No onChunk assertion. Wave 1 requests no thought summaries, so production
       never sends it thought parts; what onChunk does with a thought-only chunk
       is wave 2's P4 heartbeat, pinned in wave 2 Task 2.7. */
    process.env.GEMINI_STREAM_IDLE_MS = '150';
    const thought = { text: undefined, candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] } }] };
    generateContentStream.mockResolvedValueOnce(
      stream(
        [thought, thought, thought, thought, { text: '{"a":1}', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"a":1}' }] } }] }],
        100,
      ),
    );
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-thought' }).send(req());
    expect(r.text).toBe('{"a":1}');
    expect(r.reasoningSeen).toBe(true);
    expect(r.finish).toBe('stop');
  });

  it('no thought parts → reasoningSeen false; STOP reconciles prompt tokens with the limiter', async () => {
    generateContentStream.mockResolvedValueOnce(
      stream([{ text: '{"a":1}', usageMetadata: { promptTokenCount: 1234 }, candidates: [{ finishReason: 'STOP' }] }]),
    );
    const { geminiRateLimiter } = await import('../rate-limit.js');
    const spy = vi.spyOn(geminiRateLimiter, 'recordActualTokens');
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-usage' }).send(req());
    expect(r).toMatchObject({ text: '{"a":1}', reasoningSeen: false, finish: 'stop', receivedBytes: 7, usage: { inputTokens: 1234 } });
    expect(spy).toHaveBeenCalledWith('gemma-gt-usage', 1234);
  });

  it('empty MAX_TOKENS → finish length with 0 bytes; the limiter is NOT reconciled (pre-W1 only reconciled a returned text)', async () => {
    generateContentStream.mockResolvedValueOnce(
      stream([{ text: '', usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8192 }, candidates: [{ finishReason: 'MAX_TOKENS' }] }]),
    );
    const { geminiRateLimiter } = await import('../rate-limit.js');
    const spy = vi.spyOn(geminiRateLimiter, 'recordActualTokens');
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-maxtok' }).send(req());
    expect(r).toMatchObject({ text: '', finish: 'length', finishReason: 'MAX_TOKENS', receivedBytes: 0, usage: { outputTokens: 8192 } });
    expect(spy).not.toHaveBeenCalled();
  });

  it('empty RECITATION → finish blocked naming the reason; non-empty SAFETY → finish length', async () => {
    generateContentStream
      .mockResolvedValueOnce(stream([{ text: '', candidates: [{ finishReason: 'RECITATION' }] }]))
      .mockResolvedValueOnce(stream([{ text: '{"a":', candidates: [{ finishReason: 'SAFETY' }] }]));
    const { GeminiTransport } = await import('./gemini-transport.js');
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-stops' });
    expect(await t.send(req())).toMatchObject({ finish: 'blocked', blockReason: 'RECITATION' });
    expect(await t.send(req())).toMatchObject({ finish: 'length', finishReason: 'SAFETY', receivedBytes: 5 });
  });

  it('a non-empty truncation (finish length) logs [gemini] output truncated — pr-review-gate pass 1 finding 3', async () => {
    generateContentStream.mockResolvedValueOnce(
      stream([
        {
          text: '{"a":',
          usageMetadata: { candidatesTokenCount: 8192 },
          candidates: [{ finishReason: 'MAX_TOKENS' }],
        },
      ]),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-truncwarn' }).send(req());
    expect(r).toMatchObject({ finish: 'length', finishReason: 'MAX_TOKENS', receivedBytes: 5 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[gemini\] output truncated reason=MAX_TOKENS bytes=5 tokens=8192 model=gemma-gt-truncwarn$/),
    );
  });

  it('empty-buffer MAX_TOKENS (finish length, 0 bytes) also logs the truncation warning, at bytes=0', async () => {
    generateContentStream.mockResolvedValueOnce(
      stream([{ text: '', usageMetadata: { candidatesTokenCount: 8192 }, candidates: [{ finishReason: 'MAX_TOKENS' }] }]),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { GeminiTransport } = await import('./gemini-transport.js');
    await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-emptymaxtok' }).send(req());
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[gemini\] output truncated reason=MAX_TOKENS bytes=0 tokens=8192 model=gemma-gt-emptymaxtok$/),
    );
  });

  it('finish blocked (content block, never a truncation) does NOT log a truncation warning', async () => {
    generateContentStream.mockResolvedValueOnce(stream([{ text: '', candidates: [{ finishReason: 'RECITATION' }] }]));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-blockednowarn' }).send(req());
    expect(r.finish).toBe('blocked');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('finish blocked logs the structured [gemini] generate failed dump — pr-review-gate pass 2 finding 3', async () => {
    generateContentStream.mockResolvedValueOnce(stream([{ text: '', candidates: [{ finishReason: 'RECITATION' }] }]));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GeminiTransport } = await import('./gemini-transport.js');
    const r = await new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-blockedlog' }).send(
      req({ messages: [{ role: 'user', content: 'y'.repeat(300) }] }),
    );
    expect(r.finish).toBe('blocked');
    expect(errorSpy).toHaveBeenCalledWith('[gemini] generate failed', {
      model: 'gemma-gt-blockedlog',
      blockReason: 'RECITATION',
      userTurnLength: 300,
      userTurnHead: 'y'.repeat(200),
    });
  });

  it('a no-retry error logs the structured [gemini] generate failed dump before rethrowing — pr-review-gate pass 1 finding 2', async () => {
    const upstream = Object.assign(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"bad request"}}'), {
      status: 400,
      name: 'ApiError',
    });
    generateContentStream.mockRejectedValueOnce(upstream);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { GeminiTransport } = await import('./gemini-transport.js');
    await expect(
      new GeminiTransport({ apiKey: 'k', model: 'gemma-gt-noretrylog' }).send(req({ messages: [{ role: 'user', content: 'x'.repeat(300) }] })),
    ).rejects.toBe(upstream);
    expect(errorSpy).toHaveBeenCalledWith('[gemini] generate failed', {
      model: 'gemma-gt-noretrylog',
      status: 400,
      name: 'ApiError',
      message: upstream.message,
      userTurnLength: 300,
      userTurnHead: 'x'.repeat(200),
    });
    /* withTransportRetry classifies 400 as no-retry — exactly one wire call. */
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it('prepare(): a models.list() that never settles releases the request after 10 s, leaving Auto at the 8192 fallback (#3084 P26)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { GeminiTransport } = await import('./gemini-transport.js');
    const { _resetGeminiCatalogForTest } = await import('../catalog/gemini-catalog.js');
    const { resolveGeminiMaxOutputTokens } = await import('../capacity.js');
    _resetGeminiCatalogForTest();
    const list = vi.fn(() => new Promise<never>(() => {}));
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: { models: { generateContentStream, list } } as never });
    let released = false;
    void t.prepare().then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect(resolveGeminiMaxOutputTokens('gemini-3.6-flash')).toBe(8192);
  });

  it('prepare(signal): aborting (pause) releases the wait at once, and the SDK request carries the 10 s timeout and an abort signal (#3084 P26)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { GeminiTransport } = await import('./gemini-transport.js');
    const { _resetGeminiCatalogForTest } = await import('../catalog/gemini-catalog.js');
    _resetGeminiCatalogForTest();
    const list = vi.fn(() => new Promise<never>(() => {}));
    const t = new GeminiTransport({ apiKey: 'k', model: 'gemini-3.6-flash', client: { models: { generateContentStream, list } } as never });
    const controller = new AbortController();
    let released = false;
    void t.prepare(controller.signal).then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(released).toBe(false);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toBe(true);
    expect(list).toHaveBeenCalledWith({ config: { httpOptions: { timeout: 10_000 }, abortSignal: expect.any(AbortSignal) } });
  });
});