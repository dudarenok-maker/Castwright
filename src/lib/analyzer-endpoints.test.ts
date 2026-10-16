import { describe, it, expect } from 'vitest';
import { defaultGpuForBaseUrl, endpointForModelId, analyzerSharesTtsDevice, ttsDeviceKeyFor, reportedTtsDevicesFrom, snapshotGpuFor } from './analyzer-endpoints';
import type { AnalyzerEndpoint, ConfigValues } from './types';

const ep = (id: string, gpu: string): AnalyzerEndpoint =>
  ({ id, name: id, baseUrl: 'http://127.0.0.1:8080/v1', gpu, concurrency: 1, requestCeilingMs: 1_800_000, structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 8192 }) as AnalyzerEndpoint;

const knob = (key: string, effective: string) => ({ key, effective, source: 'override' as const, locked: false, overridden: true });

describe('defaultGpuForBaseUrl (#3084)', () => {
  it.each([
    ['http://localhost:8080/v1', 'any'],
    ['http://127.0.0.1:8080/v1', 'any'],
    ['http://[::1]:8080/v1', 'any'],
    ['http://192.168.1.20:8080/v1', 'none'],
    ['https://openrouter.ai/api/v1', 'none'],
    ['not a url', 'none'],
  ])('%s → %s', (url, expected) => {
    expect(defaultGpuForBaseUrl(url)).toBe(expected);
  });
});

describe('analyzerSharesTtsDevice (#3084)', () => {
  it.each([
    ['local shares', { engine: 'local', endpointGpu: undefined, ttsDeviceKey: 'cuda:1' }, true],
    ['gemini never', { engine: 'gemini', endpointGpu: undefined, ttsDeviceKey: 'cuda:0' }, false],
    ['endpoint any', { engine: 'openai', endpointGpu: 'any', ttsDeviceKey: 'cuda:1' }, true],
    ['endpoint same card', { engine: 'openai', endpointGpu: 'cuda:0', ttsDeviceKey: 'cuda:0' }, true],
    ['endpoint other card', { engine: 'openai', endpointGpu: 'cuda:1', ttsDeviceKey: 'cuda:0' }, false],
    ['endpoint none', { engine: 'openai', endpointGpu: 'none', ttsDeviceKey: undefined }, false],
    ['endpoint missing from settings fails closed', { engine: 'openai', endpointGpu: undefined, ttsDeviceKey: 'cuda:0' }, true],
    ['TTS card unknown fails closed', { engine: 'openai', endpointGpu: 'cuda:1', ttsDeviceKey: undefined }, true],
    /* N5 — an engine the sidecar runs on CPU holds no card, so nothing shares it. */
    ['TTS on cpu shares nothing, even with an any endpoint', { engine: 'openai', endpointGpu: 'any', ttsDeviceKey: 'cpu' }, false],
    ['TTS on cpu, endpoint pinned to a card', { engine: 'openai', endpointGpu: 'cuda:0', ttsDeviceKey: 'cpu' }, false],
    ['Ollama still shares while TTS is on cpu (unchanged)', { engine: 'local', endpointGpu: undefined, ttsDeviceKey: 'cpu' }, true],
  ] as const)('%s', (_n, input, expected) => {
    expect(analyzerSharesTtsDevice(input)).toBe(expected);
  });
});

describe('ttsDeviceKeyFor / reportedTtsDevicesFrom / endpointForModelId / snapshotGpuFor (#3084)', () => {
  const values: ConfigValues = { 'tts.kokoro.device': knob('tts.kokoro.device', 'cuda:1'), 'tts.qwen.device': knob('tts.qwen.device', 'auto') };
  const reported = { qwenDeviceKey: 'cuda:0', families: { qwen: 'cuda', kokoro: 'cpu', coqui: 'cuda' } };
  it('reads a pinned cuda:N for the TTS engine, unknown otherwise', () => {
    expect(ttsDeviceKeyFor('kokoro-v1', values)).toBe('cuda:1');
    expect(ttsDeviceKeyFor('qwen3-tts-0.6b', values)).toBeUndefined();
    expect(ttsDeviceKeyFor('kokoro-v1', undefined)).toBeUndefined();
    expect(ttsDeviceKeyFor(undefined, values)).toBeUndefined();
  });

  it('N5 — an auto knob takes the device the sidecar resolved; a pinned knob still wins', () => {
    /* tts.qwen.device is `auto`, and the sidecar says the resident Qwen sits on cuda:0. */
    expect(ttsDeviceKeyFor('qwen3-tts-0.6b', values, reported)).toBe('cuda:0');
    /* Kokoro is pinned to cuda:1, so its reported `cpu` family does not override the knob. */
    expect(ttsDeviceKeyFor('kokoro-v1', values, reported)).toBe('cuda:1');
    /* With no knob value at all, the reported family answers: Kokoro is on no card. */
    expect(ttsDeviceKeyFor('kokoro-v1', undefined, reported)).toBe('cpu');
    /* A cuda FAMILY with no card index stays unknown, so the guards keep failing closed. */
    expect(ttsDeviceKeyFor('coqui-xtts-v2', undefined, reported)).toBeUndefined();
    /* Qwen not resident → no card reported → unknown. */
    expect(ttsDeviceKeyFor('qwen3-tts-0.6b', values, { ...reported, qwenDeviceKey: null })).toBeUndefined();
  });

  it('N5 — reportedTtsDevicesFrom reads a reachable /health snapshot only', () => {
    expect(reportedTtsDevicesFrom(null)).toBeNull();
    expect(reportedTtsDevicesFrom({ status: 'unreachable', url: '' })).toBeNull();
    expect(
      reportedTtsDevicesFrom({
        status: 'reachable',
        url: '',
        qwenDeviceKey: 'cuda:1',
        devices: { qwen: 'cuda', kokoro: 'cpu', coqui: null },
      }),
    ).toEqual({ qwenDeviceKey: 'cuda:1', families: { qwen: 'cuda', kokoro: 'cpu', coqui: null } });
  });
  it('finds the endpoint of an endpoint id only', () => {
    const settings = { analyzerEndpoints: [ep('lab', 'cuda:0')] };
    expect(endpointForModelId(settings, 'openai:lab::m')?.gpu).toBe('cuda:0');
    expect(endpointForModelId(settings, 'qwen3.5:4b')).toBeUndefined();
    expect(endpointForModelId(settings, 'openai:gone::m')).toBeUndefined();
  });
  it('collapses a run to one gpu tag', () => {
    const settings = { analyzerEndpoints: [ep('a', 'cuda:0'), ep('b', 'cuda:1'), ep('n', 'none')] };
    expect(snapshotGpuFor(['openai:a::m'], settings)).toBe('cuda:0');
    expect(snapshotGpuFor(['openai:a::m', 'openai:b::m'], settings)).toBe('any');
    expect(snapshotGpuFor(['openai:n::m', 'gemini-3.6-flash'], settings)).toBe('none');
    expect(snapshotGpuFor(['openai:gone::m'], settings)).toBe('any');
    expect(snapshotGpuFor(['qwen3.5:4b'], settings)).toBeUndefined();
  });
});
