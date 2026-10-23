/* #3084 W4 — a free-text (persona) request through GeminiTransport keeps main's persona wire shape:
   the pre-transport call was `generateContent({ model, contents })` with no config at all. The stage
   request below is the control that proves the omission is gated on `freeText`, not blanket. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzerRateLimiter } from '../rate-limit.js';
import { _resetGeminiCatalogForTest } from '../catalog/gemini-catalog.js';
import { AnalyzerTimeoutError } from '../errors.js';

const generateContentStream = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContentStream };
  },
}));

async function* chunks(items: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const item of items) yield item;
}
const STOP = (text: string) => chunks([{ text, candidates: [{ finishReason: 'STOP' }] }]);

beforeEach(() => {
  generateContentStream.mockReset();
  analyzerRateLimiter._reset();
  /* prepare() warms the model catalog; the mocked client has no models.list, so reset the module state
     (and its listing timer) the failed warm-up would leave behind. */
  _resetGeminiCatalogForTest();
});

describe('GeminiTransport — free-text request', () => {
  it('omits systemInstruction, JSON mode, temperature, maxOutputTokens and thinkingConfig', async () => {
    generateContentStream.mockResolvedValue(STOP('A warm voice.'));
    const { GeminiAnalyzer } = await import('../gemini.js');
    const out = await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.1-flash-lite' }).runner.runFreeText({
      prompt: 'PROMPT',
    });
    expect(out).toBe('A warm voice.');
    const { model, contents, config } = generateContentStream.mock.calls[0][0] as {
      model: string;
      contents: unknown;
      config: Record<string, unknown>;
    };
    expect(model).toBe('gemini-3.1-flash-lite');
    expect(JSON.stringify(contents)).toContain('PROMPT');
    expect(config).not.toHaveProperty('systemInstruction');
    expect(config).not.toHaveProperty('responseMimeType');
    expect(config).not.toHaveProperty('responseJsonSchema');
    expect(config).not.toHaveProperty('temperature');
    expect(config).not.toHaveProperty('maxOutputTokens');
    /* gemini-3.1-flash-lite thinks by wave 2's id rule, so a STAGE request carries includeThoughts (CONTROL below). */
    expect(config).not.toHaveProperty('thinkingConfig');
  });

  it('acquires the limiter for the model with the persona estimate', async () => {
    generateContentStream.mockResolvedValue(STOP('x'));
    const acquire = vi.spyOn(analyzerRateLimiter, 'acquire');
    const { GeminiAnalyzer } = await import('../gemini.js');
    const prompt = 'P'.repeat(1001);
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.1-flash-lite' }).runner.runFreeText({ prompt });
    expect(acquire.mock.calls[0][0]).toBe('gemini-3.1-flash-lite');
    expect(acquire.mock.calls[0][1]).toBe(Math.ceil(1001 / 4) + 200);
    acquire.mockRestore();
  });

  it('reports no reasoning tokens: a free-text request asks for no thoughts, so its thoughtsTokenCount is not evidence (P27, A3)', async () => {
    /* A fresh generator per call: a resolved value would hand the second call an exhausted one. */
    generateContentStream.mockImplementation(async () =>
      chunks([{ text: 'A warm voice.', candidates: [{ finishReason: 'STOP' }], usageMetadata: { thoughtsTokenCount: 321 } }]),
    );
    const { GeminiTransport } = await import('./gemini-transport.js');
    const transport = new GeminiTransport({ apiKey: 'k', model: 'gemini-3.1-flash-lite' });
    const turn = { messages: [{ role: 'user' as const, content: 'P' }], estimatedInputTokens: 10, call: {} };
    const free = await transport.send({ ...turn, system: '', structuredOutput: { mode: 'off' }, temperature: undefined, freeText: {} });
    const stage = await transport.send({ ...turn, system: 'SYS', structuredOutput: { mode: 'json' }, temperature: 0.2, maxOutputTokens: 8192 });
    expect(free.usage?.reasoningTokens).toBeUndefined();
    /* CONTROL: this model thinks by wave 2's id rule, and the stage request asked for thoughts. */
    expect(stage.usage?.reasoningTokens).toBe(321);
  });

  it('CONTROL: a stage request still sends its system instruction, temperature, output cap and thought summaries', async () => {
    generateContentStream.mockResolvedValue(STOP('{}'));
    const { GeminiTransport } = await import('./gemini-transport.js');
    await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.1-flash-lite' }).send({
      system: 'SYS',
      messages: [{ role: 'user', content: 'P' }],
      structuredOutput: { mode: 'json' },
      temperature: 0.2,
      maxOutputTokens: 8192,
      estimatedInputTokens: 10,
      call: {},
    });
    const { config } = generateContentStream.mock.calls[0][0] as { config: Record<string, unknown> };
    expect(config).toHaveProperty('systemInstruction');
    expect(config.temperature).toBe(0.2);
    expect(config.maxOutputTokens).toBe(8192);
    expect(config.responseMimeType).toBe('application/json');
    expect(config.thinkingConfig).toEqual({ includeThoughts: true });
  });

  /* Owner decision 4.3-B1(b): a free-text request is bounded at min(request ceiling, absoluteMaxMs), and
     that ceiling is TERMINAL (GEMINI_RETRY_CLASSIFIER never retries an AnalyzerTimeoutError). */
  it('a free-text request stops at its absoluteMaxMs ceiling (one call, AnalyzerTimeoutError ceiling) though the request ceiling is 60 s', async () => {
    generateContentStream.mockImplementation(
      (params: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          params.config.abortSignal.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
          );
        }),
    );
    const { GeminiTransport } = await import('./gemini-transport.js');
    const t0 = Date.now();
    const err = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.1-flash-lite', requestCeilingMs: 60_000 })
      .send({
        system: '',
        messages: [{ role: 'user', content: 'P' }],
        structuredOutput: { mode: 'off' },
        temperature: undefined,
        estimatedInputTokens: 10,
        call: {},
        freeText: { absoluteMaxMs: 200 },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnalyzerTimeoutError);
    expect((err as AnalyzerTimeoutError).reason).toBe('ceiling');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a stage request is not cut by a free-text ceiling and succeeds after a 300 ms delay', async () => {
    generateContentStream.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return STOP('{}');
    });
    const { GeminiTransport } = await import('./gemini-transport.js');
    const out = await new GeminiTransport({ apiKey: 'k', model: 'gemini-3.1-flash-lite', requestCeilingMs: 60_000 }).send({
      system: 'SYS',
      messages: [{ role: 'user', content: 'P' }],
      structuredOutput: { mode: 'json' },
      temperature: 0.2,
      maxOutputTokens: 8192,
      estimatedInputTokens: 10,
      call: {},
    });
    expect(out.text).toBe('{}');
  });
});
