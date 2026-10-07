import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetEndpointRuntimeForTest,
  endpointSemaphore,
  forgetEndpointModel,
  noteEndpointModelUsed,
  servedModels,
} from './endpoint-runtime.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';

const ep = (id: string, concurrency: number): AnalyzerEndpoint => ({
  id,
  name: id,
  baseUrl: 'http://127.0.0.1:8080/v1',
  gpu: 'any',
  concurrency,
  requestCeilingMs: 1_800_000,
  structuredOutput: 'schema',
  reasoningStyle: 'not_controllable',
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32768,
});

beforeEach(() => _resetEndpointRuntimeForTest());

describe('endpoint runtime (#3084 PR 3b)', () => {
  it('keeps one semaphore per endpoint id, sized by its concurrency', () => {
    expect(endpointSemaphore(ep('a', 2))).toBe(endpointSemaphore(ep('a', 2)));
    expect(endpointSemaphore(ep('a', 2)).max).toBe(2);
    expect(endpointSemaphore(ep('b', 1))).not.toBe(endpointSemaphore(ep('a', 2)));
  });

  it('resizes the existing semaphore when the saved concurrency changes', async () => {
    const s = endpointSemaphore(ep('a', 1));
    const release = await s.acquire();
    expect(endpointSemaphore(ep('a', 3))).toBe(s);
    expect(s.max).toBe(3);
    release();
  });

  it('keeps every model sent to each endpoint (P3): first-sent order, no duplicates, nothing before the first', () => {
    expect(servedModels('a')).toEqual([]);
    noteEndpointModelUsed('a', 'qwen3:30b');
    noteEndpointModelUsed('a', 'gemma3:12b');
    noteEndpointModelUsed('a', 'qwen3:30b');
    expect(servedModels('a')).toEqual(['qwen3:30b', 'gemma3:12b']);
    expect(servedModels('b')).toEqual([]);
  });

  it('forgetEndpointModel removes one model, or the whole set when model is undefined; unknown endpoints are a no-op', () => {
    noteEndpointModelUsed('a', 'qwen3:30b');
    noteEndpointModelUsed('a', 'gemma3:12b');
    forgetEndpointModel('a', 'qwen3:30b');
    expect(servedModels('a')).toEqual(['gemma3:12b']);
    forgetEndpointModel('a', undefined);
    expect(servedModels('a')).toEqual([]);
    expect(() => forgetEndpointModel('nope', 'qwen3:30b')).not.toThrow();
    expect(() => forgetEndpointModel('nope', undefined)).not.toThrow();
  });

  it('servedModels still returns a fresh copy after forgetEndpointModel (no aliasing into the internal set)', () => {
    noteEndpointModelUsed('a', 'qwen3:30b');
    const first = servedModels('a');
    forgetEndpointModel('a', 'qwen3:30b');
    expect(first).toEqual(['qwen3:30b']);
    expect(servedModels('a')).toEqual([]);
  });
});
