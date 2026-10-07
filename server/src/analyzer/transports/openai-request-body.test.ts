import { describe, expect, it } from 'vitest';
import { buildOpenAIRequestBody, endpointAutoOutputMargin, resolveEndpointMaxOutputTokens } from './openai-transport.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
import type { TransportRequest } from '../runner/transport.js';

const endpoint = (over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint => ({
  id: 'lab',
  name: 'Lab',
  baseUrl: 'http://127.0.0.1:8080/v1',
  gpu: 'any',
  concurrency: 1,
  requestCeilingMs: 1_800_000,
  structuredOutput: 'schema',
  reasoningStyle: 'not_controllable',
  reasoning: 'model-default',
  maxOutputTokens: 0,
  contextTokens: 32_768,
  ...over,
});

const req = (over: Partial<TransportRequest> = {}): TransportRequest => ({
  system: 's',
  messages: [{ role: 'user', content: 'u' }],
  structuredOutput: { mode: 'off' },
  temperature: 0.2,
  estimatedInputTokens: 10,
  call: {},
  ...over,
});

describe('endpoint Auto max_tokens (#3084 P24)', () => {
  it('the margin is max(1024, 10% of the context)', () => {
    expect(endpointAutoOutputMargin(8_192)).toBe(1_024);
    expect(endpointAutoOutputMargin(32_768)).toBe(3_277);
  });

  it('the engine-level cap is min(served output limit if known, context − margin); a manual value is kept', () => {
    expect(resolveEndpointMaxOutputTokens(endpoint())).toBe(29_491);
    expect(resolveEndpointMaxOutputTokens(endpoint(), 8_192)).toBe(8_192);
    expect(resolveEndpointMaxOutputTokens(endpoint({ maxOutputTokens: 4_096 }))).toBe(4_096);
  });

  it('Auto on the wire also takes the estimated input off: min(cap, context − estimated input − margin)', () => {
    const ep = endpoint();
    const cap = resolveEndpointMaxOutputTokens(ep);
    expect(buildOpenAIRequestBody(ep, 'm', req({ maxOutputTokens: cap, estimatedInputTokens: 20_000 })).max_tokens).toBe(9_491);
    expect(buildOpenAIRequestBody(ep, 'm', req({ maxOutputTokens: 8_192, estimatedInputTokens: 10 })).max_tokens).toBe(8_192);
  });

  it('never sends less than 1, and sends a manual value as resolved', () => {
    expect(buildOpenAIRequestBody(endpoint(), 'm', req({ maxOutputTokens: 29_491, estimatedInputTokens: 40_000 })).max_tokens).toBe(1);
    const manual = endpoint({ maxOutputTokens: 4_096, contextTokens: 8_192 });
    expect(buildOpenAIRequestBody(manual, 'm', req({ maxOutputTokens: 4_096, estimatedInputTokens: 6_000 })).max_tokens).toBe(4_096);
  });
});
