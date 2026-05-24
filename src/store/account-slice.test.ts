/* account-slice — covers the granular setter reducers and the
   fetch/save thunk lifecycle. Avoids touching the live api by mocking
   src/lib/api at the module level. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  accountSlice,
  accountActions,
  fetchAccountSettings,
  saveAccountSettings,
} from './account-slice';
import type { UserSettings } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getUserSettings: vi.fn(),
    putUserSettings: vi.fn(),
  },
}));

import { api } from '../lib/api';

const SERVER_FIXTURE: UserSettings = {
  displayName: 'Test User',
  defaultAnalysisModel: 'gemini-2.5-flash',
  defaultTtsEngine: 'gemini',
  defaultTtsModelKey: 'gemini-2.5-flash',
  sidecarUrl: 'http://localhost:9001',
  analysisEngine: 'local',
  ollamaUrl: 'http://localhost:11434',
  workspaceDirOverride: null,
  minorCastMinLines: 3,
  analyzerPhase0Model: null,
  analyzerPhase1Model: null,
  analyzerPhase1MinLagChapters: null,
  apiKeyStatus: 'set',
  workspaceRoot: '/some/path',
  workspaceSource: 'env',
};

function makeStore() {
  return configureStore({
    reducer: { account: accountSlice.reducer },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('accountSlice — granular setters', () => {
  it('setDisplayName updates the displayName field', () => {
    const next = accountSlice.reducer(undefined, accountActions.setDisplayName('Captain Picard'));
    expect(next.displayName).toBe('Captain Picard');
  });

  it('setWorkspaceDirOverride accepts null to clear the override', () => {
    const a = accountSlice.reducer(undefined, accountActions.setWorkspaceDirOverride('D:/library'));
    expect(a.workspaceDirOverride).toBe('D:/library');
    const b = accountSlice.reducer(a, accountActions.setWorkspaceDirOverride(null));
    expect(b.workspaceDirOverride).toBeNull();
  });

  it("setCoverPickerDefaultTab flips between 'search' and 'upload' (plan 40)", () => {
    const a = accountSlice.reducer(undefined, accountActions.setCoverPickerDefaultTab('upload'));
    expect(a.coverPickerDefaultTab).toBe('upload');
    const b = accountSlice.reducer(a, accountActions.setCoverPickerDefaultTab('search'));
    expect(b.coverPickerDefaultTab).toBe('search');
  });

  /* Plan 88 phase-2 — Account-tab Analyzer card setters. The three
     setters mirror the server-side precedence chain at the slice
     level: `null` clears the saved value (server falls through to
     env / hardcoded default); a non-null value persists. */
  it('setAnalyzerPhase0Model accepts a model id or null', () => {
    const a = accountSlice.reducer(
      undefined,
      accountActions.setAnalyzerPhase0Model('gemma-4-31b-it'),
    );
    expect(a.analyzerPhase0Model).toBe('gemma-4-31b-it');
    const b = accountSlice.reducer(a, accountActions.setAnalyzerPhase0Model(null));
    expect(b.analyzerPhase0Model).toBeNull();
  });

  it('setAnalyzerPhase1Model accepts a model id or null', () => {
    const a = accountSlice.reducer(
      undefined,
      accountActions.setAnalyzerPhase1Model('gemini-3.1-flash-lite'),
    );
    expect(a.analyzerPhase1Model).toBe('gemini-3.1-flash-lite');
    const b = accountSlice.reducer(a, accountActions.setAnalyzerPhase1Model(null));
    expect(b.analyzerPhase1Model).toBeNull();
  });

  it('setAnalyzerPhase1MinLagChapters accepts a positive integer or null', () => {
    const a = accountSlice.reducer(
      undefined,
      accountActions.setAnalyzerPhase1MinLagChapters(15),
    );
    expect(a.analyzerPhase1MinLagChapters).toBe(15);
    const b = accountSlice.reducer(a, accountActions.setAnalyzerPhase1MinLagChapters(0));
    expect(b.analyzerPhase1MinLagChapters).toBe(0);
    const c = accountSlice.reducer(b, accountActions.setAnalyzerPhase1MinLagChapters(null));
    expect(c.analyzerPhase1MinLagChapters).toBeNull();
  });

  it('setDualModelEnabled toggles the dual-model flag', () => {
    const a = accountSlice.reducer(undefined, accountActions.setDualModelEnabled(true));
    expect(a.dualModelEnabled).toBe(true);
    const b = accountSlice.reducer(a, accountActions.setDualModelEnabled(false));
    expect(b.dualModelEnabled).toBe(false);
  });

  it('setEagerLoadKokoro toggles the eager-load flag', () => {
    const a = accountSlice.reducer(undefined, accountActions.setEagerLoadKokoro(false));
    expect(a.eagerLoadKokoro).toBe(false);
    const b = accountSlice.reducer(a, accountActions.setEagerLoadKokoro(true));
    expect(b.eagerLoadKokoro).toBe(true);
  });
});

describe('accountSlice — dual-model flag', () => {
  it('hydrates dualModelEnabled from the server fetch response', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      dualModelEnabled: true,
    });
    const store = makeStore();
    await store.dispatch(fetchAccountSettings());
    expect(store.getState().account.dualModelEnabled).toBe(true);
  });

  it('round-trips dualModelEnabled through saveAccountSettings', async () => {
    const putSpy = api.putUserSettings as unknown as ReturnType<typeof vi.fn>;
    putSpy.mockResolvedValue({ ...SERVER_FIXTURE, dualModelEnabled: true });
    const store = makeStore();
    await store.dispatch(saveAccountSettings({ dualModelEnabled: true }));
    expect(putSpy).toHaveBeenCalledWith({ dualModelEnabled: true });
    expect(store.getState().account.dualModelEnabled).toBe(true);
  });
});

describe('accountSlice — eager-load Kokoro flag', () => {
  it('hydrates eagerLoadKokoro from the server fetch response', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      eagerLoadKokoro: false,
    });
    const store = makeStore();
    await store.dispatch(fetchAccountSettings());
    expect(store.getState().account.eagerLoadKokoro).toBe(false);
  });

  it('round-trips eagerLoadKokoro through saveAccountSettings', async () => {
    const putSpy = api.putUserSettings as unknown as ReturnType<typeof vi.fn>;
    putSpy.mockResolvedValue({ ...SERVER_FIXTURE, eagerLoadKokoro: false });
    const store = makeStore();
    await store.dispatch(saveAccountSettings({ eagerLoadKokoro: false }));
    expect(putSpy).toHaveBeenCalledWith({ eagerLoadKokoro: false });
    expect(store.getState().account.eagerLoadKokoro).toBe(false);
  });
});

describe('accountSlice — Analyzer card (plan 88 phase-2)', () => {
  it('hydrates the three analyzer fields from the server fetch response', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      analyzerPhase0Model: 'gemma-4-31b-it',
      analyzerPhase1Model: 'gemini-3.1-flash-lite',
      analyzerPhase1MinLagChapters: 10,
    });
    const store = makeStore();
    await store.dispatch(fetchAccountSettings());
    const s = store.getState().account;
    expect(s.analyzerPhase0Model).toBe('gemma-4-31b-it');
    expect(s.analyzerPhase1Model).toBe('gemini-3.1-flash-lite');
    expect(s.analyzerPhase1MinLagChapters).toBe(10);
  });

  it('round-trips the three analyzer fields through saveAccountSettings', async () => {
    const putSpy = api.putUserSettings as unknown as ReturnType<typeof vi.fn>;
    putSpy.mockResolvedValue({
      ...SERVER_FIXTURE,
      analyzerPhase0Model: 'qwen3.5:9b',
      analyzerPhase1Model: 'gemini-3-flash-preview',
      analyzerPhase1MinLagChapters: 5,
    });
    const store = makeStore();
    await store.dispatch(
      saveAccountSettings({
        analyzerPhase0Model: 'qwen3.5:9b',
        analyzerPhase1Model: 'gemini-3-flash-preview',
        analyzerPhase1MinLagChapters: 5,
      }),
    );
    expect(putSpy).toHaveBeenCalledWith({
      analyzerPhase0Model: 'qwen3.5:9b',
      analyzerPhase1Model: 'gemini-3-flash-preview',
      analyzerPhase1MinLagChapters: 5,
    });
    const s = store.getState().account;
    expect(s.analyzerPhase0Model).toBe('qwen3.5:9b');
    expect(s.analyzerPhase1Model).toBe('gemini-3-flash-preview');
    expect(s.analyzerPhase1MinLagChapters).toBe(5);
  });
});

describe('accountSlice — coverPickerDefaultTab (plan 40)', () => {
  it('hydrates from the server fetch response', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      coverPickerDefaultTab: 'upload',
    });
    const store = makeStore();
    await store.dispatch(fetchAccountSettings());
    expect(store.getState().account.coverPickerDefaultTab).toBe('upload');
  });

  it('round-trips through saveAccountSettings', async () => {
    const putSpy = api.putUserSettings as unknown as ReturnType<typeof vi.fn>;
    putSpy.mockResolvedValue({ ...SERVER_FIXTURE, coverPickerDefaultTab: 'upload' });
    const store = makeStore();
    await store.dispatch(saveAccountSettings({ coverPickerDefaultTab: 'upload' }));
    expect(putSpy).toHaveBeenCalledWith({ coverPickerDefaultTab: 'upload' });
    expect(store.getState().account.coverPickerDefaultTab).toBe('upload');
  });
});

describe('accountSlice — fetch lifecycle', () => {
  it('marks status loading while in flight and idle on resolve, hydrating server fields', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERVER_FIXTURE);
    const store = makeStore();
    const promise = store.dispatch(fetchAccountSettings());
    expect(store.getState().account.status).toBe('loading');
    await promise;
    const s = store.getState().account;
    expect(s.status).toBe('idle');
    expect(s.hydrated).toBe(true);
    expect(s.displayName).toBe('Test User');
    expect(s.apiKeyStatus).toBe('set');
    expect(s.workspaceRoot).toBe('/some/path');
  });

  it('captures error text when the fetch rejects', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom'),
    );
    const store = makeStore();
    await store.dispatch(fetchAccountSettings());
    const s = store.getState().account;
    expect(s.status).toBe('error');
    expect(s.error).toBe('boom');
    expect(s.hydrated).toBe(false);
  });
});

describe('accountSlice — save lifecycle', () => {
  it('PUTs the patch and hydrates the response shape', async () => {
    const putSpy = api.putUserSettings as unknown as ReturnType<typeof vi.fn>;
    putSpy.mockResolvedValue({ ...SERVER_FIXTURE, displayName: 'Saved Name' });
    const store = makeStore();
    const promise = store.dispatch(saveAccountSettings({ displayName: 'Saved Name' }));
    expect(store.getState().account.status).toBe('saving');
    await promise;
    expect(putSpy).toHaveBeenCalledWith({ displayName: 'Saved Name' });
    const s = store.getState().account;
    expect(s.displayName).toBe('Saved Name');
    expect(s.status).toBe('idle');
  });

  it('surfaces save errors without clobbering the hydrated flag', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERVER_FIXTURE);
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('disk full'),
    );
    const store = makeStore();
    await store.dispatch(fetchAccountSettings());
    expect(store.getState().account.hydrated).toBe(true);
    await store.dispatch(saveAccountSettings({ displayName: 'Anything' }));
    const s = store.getState().account;
    expect(s.status).toBe('error');
    expect(s.error).toBe('disk full');
    expect(s.hydrated).toBe(true);
  });
});
