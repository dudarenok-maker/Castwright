/* #3084 wave 2b — Gemini thinking visibility (spec §7). Drives GeminiTransport
   with an injected fake client (no vi.mock, no network). Chunks mirror the SDK:
   `text` is the concatenation of NON-thought text parts (the @google/genai
   GenerateContentResponse.text getter excludes thought parts), and the parts
   themselves carry `thought: true`. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import { GeminiTransport } from './gemini-transport.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { listGeminiModels, _resetGeminiCatalogForTest, type GeminiModelsClient } from '../catalog/gemini-catalog.js';
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
});
