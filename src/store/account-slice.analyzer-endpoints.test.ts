import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.stubEnv('VITE_USE_MOCKS', 'true');
const { accountSlice, createAnalyzerEndpoint, updateAnalyzerEndpoint, saveAnalyzerEndpointKey, deleteAnalyzerEndpoint } = await import('./account-slice');
const { api } = await import('../lib/api');

describe('account slice analyzer-endpoint thunks (#3084 PR 3b)', () => {
  it('swaps the settings response into state on each write', async () => {
    const store = configureStore({ reducer: { account: accountSlice.reducer } });
    await store.dispatch(createAnalyzerEndpoint({ id: 'slice-lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }));
    expect(store.getState().account.analyzerEndpoints?.map((e) => e.id)).toContain('slice-lab');
    await store.dispatch(saveAnalyzerEndpointKey({ endpointId: 'slice-lab', key: 'sk-slice-1234' }));
    expect(store.getState().account.analyzerEndpointKeyStatus?.['slice-lab']).toBe('set');
    await store.dispatch(deleteAnalyzerEndpoint('slice-lab'));
    expect(store.getState().account.analyzerEndpoints?.map((e) => e.id)).not.toContain('slice-lab');
    expect(store.getState().account.status).toBe('idle');
  });

  it('records a refusal as an error without changing endpoints', async () => {
    const store = configureStore({ reducer: { account: accountSlice.reducer } });
    await store.dispatch(createAnalyzerEndpoint({ id: 'slice-dup', name: 'Dup', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }));
    const before = store.getState().account.analyzerEndpoints;
    await store.dispatch(createAnalyzerEndpoint({ id: 'slice-dup', name: 'Dup', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }));
    expect(store.getState().account.status).toBe('error');
    expect(store.getState().account.error).toContain('already exists');
    expect(store.getState().account.analyzerEndpoints).toEqual(before);
  });

  /* #3084 F5 defect — found in review. Without a typed rejectValue and a catch
     for AnalyzerEndpointError, createAsyncThunk's default rejection path drops
     `issues` (miniSerializeError keeps only name/message/stack/code), so
     .unwrap() rejects with a plain object that has no issues at all. */
  it('a refused create rejects .unwrap() with EXACTLY the {error, code, issues} payload — not the raw AnalyzerEndpointError instance (#3084 F5 review pass 2, item 4)', async () => {
    const store = configureStore({ reducer: { account: accountSlice.reducer } });
    await store.dispatch(
      createAnalyzerEndpoint({ id: 'slice-bad', name: 'Bad', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }),
    );
    const rejection = await store
      .dispatch(createAnalyzerEndpoint({ id: 'slice-bad', name: 'Bad', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }))
      .unwrap()
      .then(
        () => null,
        (e: unknown) => e,
      );
    /* toEqual, not toMatchObject: a plain {error, code, issues} object passes,
       but the RAW AnalyzerEndpointError instance (which also carries `code`
       and `issues` as its own fields, so a toMatchObject on just those two
       would pass either way) fails — it additionally carries `message`,
       `name` and `status`, and is missing `error`. This is what actually
       distinguishes "rejectAnalyzerEndpointError built the payload" from
       "rejectWithValue(e as never) forwarded the raw error", which an
       earlier draft's toMatchObject assertion could not tell apart. */
    expect(rejection).toEqual({
      error: 'An analyzer endpoint with id "slice-bad" already exists.',
      code: 'duplicate-id',
      issues: [],
    });
  });

  it('a non-refusal rejection still rejects .unwrap() as before, with no issues array (F5)', async () => {
    const store = configureStore({ reducer: { account: accountSlice.reducer } });
    await store.dispatch(createAnalyzerEndpoint({ id: 'slice-network', name: 'N', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 }));
    const spy = vi.spyOn(api, 'updateAnalyzerEndpoint').mockRejectedValueOnce(new TypeError('network down'));
    const rejection = await store
      .dispatch(
        updateAnalyzerEndpoint({
          endpointId: 'slice-network',
          input: { id: 'slice-network', name: 'N', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 8192 },
        }),
      )
      .unwrap()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((rejection as { message: string }).message).toBe('network down');
    expect(rejection).not.toHaveProperty('issues');
    spy.mockRestore();
  });
});
