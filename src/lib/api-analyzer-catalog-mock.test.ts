import { describe, it, expect, afterEach } from 'vitest';
import { mockGetAnalyzerModels, mockTestAnalyzerModel } from './api';
import type { ModelCapabilityRecord, UserSettings } from './types';

const endpoint = {
  id: 'lab-server', name: 'Lab server', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', concurrency: 1, requestCeilingMs: 1_800_000,
  structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 32768,
} as NonNullable<UserSettings['analyzerEndpoints']>[number];

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__SEED_ENDPOINT_MODELS__;
  delete g.__SEED_ANALYZER_CAPABILITIES__;
});

describe('mockGetAnalyzerModels (#3084)', () => {
  it('lists one group per saved endpoint with seeded models and the W3 test plan', async () => {
    (globalThis as Record<string, unknown>).__SEED_ENDPOINT_MODELS__ = { 'lab-server': ['qwen3-30b'] };
    const catalog = await mockGetAnalyzerModels(false, { analyzerEndpoints: [endpoint], analyzerCapabilitiesByModel: {}, apiKeyStatus: 'unset' });
    const group = catalog.groups.find((g) => g.kind === 'endpoint');
    expect(group).toMatchObject({ id: 'lab-server', label: 'Lab server', status: 'ok' });
    expect(group?.models[0]).toMatchObject({ id: 'openai:lab-server::qwen3-30b', label: 'qwen3-30b', engine: 'openai', testPlan: { configured: 2, all: 3, attempts: 3 } });
    expect(Object.keys(catalog)).toEqual(['groups']);
    expect(catalog.groups.find((g) => g.kind === 'gemini')).toMatchObject({ status: 'fallback', models: [] });
  });

  it('labels from a seeded Test record for the same server URL', async () => {
    const rec: ModelCapabilityRecord = { serverUrl: 'http://127.0.0.1:8080/v1', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: { schema: { 'model-default': 'ignored' } }, reasoning: {} };
    (globalThis as Record<string, unknown>).__SEED_ENDPOINT_MODELS__ = { 'lab-server': ['qwen3-30b'] };
    (globalThis as Record<string, unknown>).__SEED_ANALYZER_CAPABILITIES__ = { 'openai:lab-server::qwen3-30b': rec };
    const catalog = await mockGetAnalyzerModels(false, { analyzerEndpoints: [endpoint], analyzerCapabilitiesByModel: {}, apiKeyStatus: 'unset' });
    const entry = catalog.groups.find((g) => g.kind === 'endpoint')?.models[0];
    expect(entry?.capability).toEqual(rec);
    expect(entry?.structuredOutput.label).toBe('schema (not enforced)');
    expect(entry?.structuredOutput.outcome).toBe('ignored');
  });

  it('mockTestAnalyzerModel returns a record for the configured mode, filed under the level the engine sends', async () => {
    const local = await mockTestAnalyzerModel({ modelId: 'qwen3.5:4b', scope: 'configured' });
    expect(local.control).toEqual({ ok: true });
    expect(local.structuredOutput.schema).toEqual({ off: 'enforced' });
  });
});
