/* #3084 PR 3b — the mock endpoint API mirrors the server's refusals so the
   PR 3d e2e (mock mode) exercises the same rules. Module state persists across
   tests in this file, so every test uses its own endpoint id. */
import { describe, it, expect, vi } from 'vitest';
import styleLevels from '../../server/src/analyzer/__fixtures__/reasoning-style-levels.json';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { api, AnalyzerEndpointError, _setMockUserSettingsForTest } = await import('./api');

const input = (id: string, baseUrl = 'http://127.0.0.1:8080/v1') => ({ id, name: `Box ${id}`, baseUrl, contextTokens: 32768 });

async function refusal(p: Promise<unknown>) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(AnalyzerEndpointError);
  return e as InstanceType<typeof AnalyzerEndpointError>;
}

describe('mock analyzer endpoint API', () => {
  it('creates with contract defaults and unset key status', async () => {
    const s = await api.createAnalyzerEndpoint(input('m-create'));
    expect(s.analyzerEndpoints?.find((e) => e.id === 'm-create')).toMatchObject({
      gpu: 'any',
      concurrency: 1,
      requestCeilingMs: 1_800_000,
      structuredOutput: 'schema',
      reasoningStyle: 'not_controllable',
      reasoning: 'model-default',
      maxOutputTokens: 0,
    });
    expect(s.analyzerEndpointKeyStatus?.['m-create']).toBe('unset');
  });

  it('mirrors the server refusals', async () => {
    await api.createAnalyzerEndpoint(input('m-dup'));
    expect((await refusal(api.createAnalyzerEndpoint(input('m-dup')))).code).toBe('duplicate-id');
    expect((await refusal(api.createAnalyzerEndpoint({ ...input('m-bad'), id: 'Bad_Id' }))).code).toBe('invalid');
    expect(
      (await refusal(api.createAnalyzerEndpoint({ ...input('m-nocontext'), contextTokens: undefined as unknown as number }))).code,
    ).toBe('invalid');
    expect(
      (await refusal(api.createAnalyzerEndpoint({ ...input('m-unload'), unloadUrl: 'http://127.0.0.1:9999/api/models/unload/{model}' }))).code,
    ).toBe('unload-off-origin');
  });

  it('key status follows the origin; the key is never returned', async () => {
    await api.createAnalyzerEndpoint(input('m-key'));
    const withKey = await api.putAnalyzerEndpointKey('m-key', 'sk-mock-secret-1234');
    expect(withKey.analyzerEndpointKeyStatus?.['m-key']).toBe('set');
    expect(JSON.stringify(withKey)).not.toContain('sk-mock-secret-1234');
    const moved = await api.updateAnalyzerEndpoint('m-key', input('m-key', 'http://127.0.0.1:9090/v1'));
    expect(moved.analyzerEndpointKeyStatus?.['m-key']).toBe('origin-mismatch');
  });

  it('refuses a key containing a control character, as the server does, without echoing or saving it (P22)', async () => {
    await api.createAnalyzerEndpoint(input('m-ctrl'));
    const r = await refusal(api.putAnalyzerEndpointKey('m-ctrl', 'sk-mock-ctrl-1\r\nX-Injected: 1'));
    expect(r.code).toBe('invalid');
    expect(`${r.message} ${JSON.stringify(r.issues)}`).not.toContain('sk-mock-ctrl-1');
    expect((await api.getUserSettings()).analyzerEndpointKeyStatus?.['m-ctrl']).toBe('unset');
  });

  it('refuses to delete an endpoint that a saved setting or a model-id override references, as the server does, then deletes it once unreferenced', async () => {
    await api.createAnalyzerEndpoint(input('m-ref'));
    _setMockUserSettingsForTest({
      defaultAnalysisModel: 'openai:m-ref::qwen3',
      configOverrides: { 'analyzer.phase1.model': 'openai:m-ref::m', 'analyzer.phase0.model': 'openai:m-ref2::m' },
    });
    const r = await refusal(api.deleteAnalyzerEndpoint('m-ref'));
    expect(r.code).toBe('referenced');
    expect(r.issues).toEqual([
      { path: [], message: 'Account setting "defaultAnalysisModel"' },
      { path: [], message: 'Advanced setting "analyzer.phase1.model"' },
    ]);
    _setMockUserSettingsForTest({ defaultAnalysisModel: '', configOverrides: {} });
    const s = await api.deleteAnalyzerEndpoint('m-ref');
    expect(s.analyzerEndpoints?.some((e) => e.id === 'm-ref')).toBe(false);
  });

  it('refuses to delete an endpoint the saved fallback target names, as the server does (MODEL_ID_CONFIG_KNOBS has four knobs)', async () => {
    await api.createAnalyzerEndpoint(input('m-fallback'));
    _setMockUserSettingsForTest({ configOverrides: { 'analyzer.fallback.target': 'openai:m-fallback::m' } });
    const r = await refusal(api.deleteAnalyzerEndpoint('m-fallback'));
    expect(r.code).toBe('referenced');
    expect(r.issues).toEqual([{ path: [], message: 'Advanced setting "analyzer.fallback.target"' }]);
    _setMockUserSettingsForTest({ configOverrides: {} });
    const s = await api.deleteAnalyzerEndpoint('m-fallback');
    expect(s.analyzerEndpoints?.some((e) => e.id === 'm-fallback')).toBe(false);
  });

  it('allows deleting an endpoint named only by the read-only effective analyzerPhase0Model/analyzerPhase1Model fields, as the server does (A5; #3525 review)', async () => {
    await api.createAnalyzerEndpoint(input('m-effective'));
    _setMockUserSettingsForTest({
      analyzerPhase0Model: 'openai:m-effective::qwen3',
      analyzerPhase1Model: 'openai:m-effective::qwen3',
    } as Parameters<typeof _setMockUserSettingsForTest>[0]);
    const s = await api.deleteAnalyzerEndpoint('m-effective');
    expect(s.analyzerEndpoints?.some((e) => e.id === 'm-effective')).toBe(false);
    _setMockUserSettingsForTest({ analyzerPhase0Model: null, analyzerPhase1Model: null } as Parameters<typeof _setMockUserSettingsForTest>[0]);
  });

  it('until PR 5b, refuses a non-empty payload, as the server does', async () => {
    const p = await refusal(api.createAnalyzerEndpoint({ ...input('m-payload'), extraParams: { top_k: 20 } }));
    expect(p.issues).toEqual([
      { path: ['extraParams'], message: 'custom request parameters cannot be saved until PR 5b enables them' },
    ]);
  });

  it('accepts a reasoning level its control style offers and refuses one it does not, as the server does', async () => {
    const r = await refusal(api.createAnalyzerEndpoint({ ...input('m-reasoning'), reasoning: 'high' }));
    expect(r).toMatchObject({
      code: 'invalid',
      issues: [{ path: ['reasoning'], message: 'Reasoning "high" is not offered by the not_controllable control style (offered: model-default).' }],
    });
    /* The same table as the server (reasoning.ts, pinned to this fixture by reasoning.test.ts). */
    for (const [style, levels] of Object.entries(styleLevels)) {
      for (const level of ['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high']) {
        const id = `m-lvl-${style.replace(/_/g, '-')}-${level}`;
        const outcome = await api
          .createAnalyzerEndpoint({ ...input(id), reasoningStyle: style, reasoning: level } as never)
          .then(() => 'accepted', () => 'refused');
        expect([style, level, outcome]).toEqual([style, level, levels.includes(level) ? 'accepted' : 'refused']);
      }
    }
  });

  it('an update judges the level only when it or its style changes, as the server does (A7)', async () => {
    _setMockUserSettingsForTest({
      analyzerEndpoints: [
        {
          id: 'm-a7', name: 'Box m-a7', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', concurrency: 1, requestCeilingMs: 1_800_000,
          structuredOutput: 'schema', reasoningStyle: 'enable_thinking', reasoning: 'high', maxOutputTokens: 0, contextTokens: 32768,
        },
      ],
    });
    const base = { ...input('m-a7'), reasoningStyle: 'enable_thinking' as const, reasoning: 'high' };
    const renamed = await api.updateAnalyzerEndpoint('m-a7', { ...base, name: 'Renamed' });
    expect(renamed.analyzerEndpoints?.find((e) => e.id === 'm-a7')).toMatchObject({ name: 'Renamed', reasoning: 'high' });
    const restyled = await api.updateAnalyzerEndpoint('m-a7', { ...base, reasoningStyle: 'reasoning_effort' });
    expect(restyled.analyzerEndpoints?.find((e) => e.id === 'm-a7')).toMatchObject({ reasoningStyle: 'reasoning_effort', reasoning: 'high' });
    _setMockUserSettingsForTest({
      analyzerEndpoints: [{ ...restyled.analyzerEndpoints![0], reasoningStyle: 'enable_thinking' }],
    });
    const refused = await refusal(api.updateAnalyzerEndpoint('m-a7', { ...base, reasoning: 'none' }));
    expect(refused.issues).toEqual([
      { path: ['reasoning'], message: 'Reasoning "none" is not offered by the enable_thinking control style (offered: model-default, off, on).' },
    ]);
  });

  it('the general PUT cannot write analyzerEndpoints (same as the server FORBIDDEN_KEYS)', async () => {
    const before = (await api.getUserSettings()).analyzerEndpoints ?? [];
    await api.putUserSettings({ analyzerEndpoints: [] } as never);
    expect((await api.getUserSettings()).analyzerEndpoints).toEqual(before);
  });

  it('mock acknowledgeDroppedEndpointEntries removes only the named entries (#3084 F5 review, item 7)', async () => {
    _setMockUserSettingsForTest({
      droppedEndpointEntries: [
        { archiveId: 'ack-1', kind: 'endpoint', endpointId: 'a', issues: ['baseUrl: invalid_format'], droppedAt: new Date().toISOString() },
        { archiveId: 'ack-2', kind: 'endpoint', endpointId: 'b', issues: ['baseUrl: invalid_format'], droppedAt: new Date().toISOString() },
      ] as never,
    });
    const s = await api.acknowledgeDroppedEndpointEntries(['ack-1']);
    expect(s.droppedEndpointEntries?.map((e) => e.archiveId)).toEqual(['ack-2']);
  });
});
