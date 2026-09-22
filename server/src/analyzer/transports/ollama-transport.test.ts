import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { TransportRequest } from '../runner/transport.js';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});
const { splitMock } = vi.hoisted(() => ({ splitMock: vi.fn() }));
vi.mock('../../gpu/ollama-gpu-split.js', () => ({ detectOllamaGpuSplit: splitMock }));

function ndjson(lines: object[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}
const req = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 'SYS',
  messages: [{ role: 'user', content: 'hi' }],
  structuredOutput: { mode: 'schema', name: 's', schema: { type: 'object' } },
  temperature: 0.2,
  estimatedInputTokens: 0,
  call: {},
  ...over,
});
const bodyOf = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as { body: string }).body);
const OK_LINES = [{ message: { content: '{"a":1}' }, done: false }, { message: { content: '' }, done: true, done_reason: 'stop' }];

beforeAll(() => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
});
afterAll(() => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
});
beforeEach(() => {
  fetchMock.mockReset();
  splitMock.mockReset();
  splitMock.mockResolvedValue({ reachable: true, split: false, deviceIndices: [], totalUsedMb: 0, wouldFitSingleDevice: false, dataUnavailable: false });
});

describe('OllamaTransport (#3084 wave 1)', () => {
  it('prepends the system message only when system is non-empty', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    const t = new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    fetchMock.mockResolvedValueOnce(ndjson(OK_LINES)).mockResolvedValueOnce(ndjson(OK_LINES));
    await t.send(req());
    await t.send(req({ system: '' }));
    expect(bodyOf(0).messages).toEqual([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
    expect(bodyOf(1).messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('maps structured output: schema → format object, json → "json", off → no format key', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    const t = new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    fetchMock.mockImplementation(async () => ndjson(OK_LINES));
    await t.send(req());
    await t.send(req({ structuredOutput: { mode: 'json' } }));
    await t.send(req({ structuredOutput: { mode: 'off' } }));
    expect(bodyOf(0).format).toEqual({ type: 'object' });
    expect(bodyOf(1).format).toBe('json');
    expect('format' in bodyOf(2)).toBe(false);
    expect(bodyOf(0).think).toBe(false);
  });

  it('maxOutputTokens overrides num_predict; undefined keeps resolveNumPredict()', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    const { resolveNumPredict } = await import('../ollama-settings.js');
    const t = new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' });
    fetchMock.mockImplementation(async () => ndjson(OK_LINES));
    await t.send(req());
    await t.send(req({ maxOutputTokens: 777 }));
    expect(bodyOf(0).options.num_predict).toBe(resolveNumPredict());
    expect(bodyOf(1).options.num_predict).toBe(777);
    expect(bodyOf(1).options.temperature).toBe(0.2);
  });

  it('stop returns text, finish, raw reason and bytes, and runs GPU-split detection', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    fetchMock.mockResolvedValueOnce(ndjson(OK_LINES));
    const r = await new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' }).send(req());
    expect(r).toEqual({ text: '{"a":1}', reasoningSeen: false, finish: 'stop', finishReason: 'stop', receivedBytes: 7 });
    expect(splitMock).toHaveBeenCalledTimes(1);
  });

  it('length with text returns finish length WITHOUT GPU-split detection or eval-timing telemetry, and frees the slot', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    const conc = await import('../analyzer-concurrency.js');
    fetchMock.mockResolvedValueOnce(
      ndjson([
        { message: { content: '{"a":' }, done: false },
        { message: { content: '' }, done: true, done_reason: 'length', eval_count: 5, eval_duration: 1, prompt_eval_count: 1, prompt_eval_duration: 1, load_duration: 0 },
      ]),
    );
    const onEvalTiming = vi.fn();
    const r = await new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' }).send(req({ call: { onEvalTiming } }));
    expect(r).toEqual({ text: '{"a":', reasoningSeen: false, finish: 'length', finishReason: 'length', receivedBytes: 5 });
    expect(splitMock).not.toHaveBeenCalled();
    expect(onEvalTiming).not.toHaveBeenCalled();
    expect(conc.analyzerConcurrency.inFlight).toBe(0);
  });

  it('an empty stream returns text "" without throwing (mapFinish owns the empty-response error)', async () => {
    const { OllamaTransport } = await import('./ollama-transport.js');
    fetchMock.mockResolvedValueOnce(ndjson([{ message: { content: '' }, done: true, done_reason: 'length' }]));
    const r = await new OllamaTransport({ url: 'http://localhost:11434', model: 'qwen3.5:9b' }).send(req());
    expect(r).toMatchObject({ text: '', finish: 'length', receivedBytes: 0 });
    expect(splitMock).not.toHaveBeenCalled();
  });
});
