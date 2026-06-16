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
  fetchAnalyzerModels,
  selectAnalyzerSplitIsActive,
  selectAnalyzerPhase0Model,
  selectAnalyzerPhase1Model,
  selectAnalyzerPhase1MinLag,
} from './account-slice';
import type { UserSettings } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getUserSettings: vi.fn(),
    putUserSettings: vi.fn(),
    getOllamaHealth: vi.fn().mockResolvedValue({
      status: 'reachable',
      url: '(mock)',
      models: ['qwen3.5:4b'],
      pullable: ['qwen3.5:4b', 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL'],
    }),
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

  it('setEagerLoadQwen toggles the Qwen eager-load flag', () => {
    const a = accountSlice.reducer(undefined, accountActions.setEagerLoadQwen(false));
    expect(a.eagerLoadQwen).toBe(false);
    const b = accountSlice.reducer(a, accountActions.setEagerLoadQwen(true));
    expect(b.eagerLoadQwen).toBe(true);
  });

  it('setGenerationWorkers sets the queue-worker count', () => {
    const a = accountSlice.reducer(undefined, accountActions.setGenerationWorkers(4));
    expect(a.generationWorkers).toBe(4);
    const b = accountSlice.reducer(a, accountActions.setGenerationWorkers(1));
    expect(b.generationWorkers).toBe(1);
  });
});

describe('accountSlice — generationWorkers (plan 111)', () => {
  it('hydrates generationWorkers from the server fetch response', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      generationWorkers: 3,
    });
    const store = makeStore();
    await store.dispatch(fetchAccountSettings());
    expect(store.getState().account.generationWorkers).toBe(3);
  });

  it('round-trips generationWorkers through saveAccountSettings', async () => {
    const putSpy = api.putUserSettings as unknown as ReturnType<typeof vi.fn>;
    putSpy.mockResolvedValue({ ...SERVER_FIXTURE, generationWorkers: 4 });
    const store = makeStore();
    await store.dispatch(saveAccountSettings({ generationWorkers: 4 }));
    expect(putSpy).toHaveBeenCalledWith({ generationWorkers: 4 });
    expect(store.getState().account.generationWorkers).toBe(4);
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

describe('accountSlice — eager-load Qwen flag', () => {
  it('hydrates eagerLoadQwen from the server fetch response', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      eagerLoadQwen: false,
    });
    const store = makeStore();
    await store.dispatch(fetchAccountSettings());
    expect(store.getState().account.eagerLoadQwen).toBe(false);
  });

  it('round-trips eagerLoadQwen through saveAccountSettings', async () => {
    const putSpy = api.putUserSettings as unknown as ReturnType<typeof vi.fn>;
    putSpy.mockResolvedValue({ ...SERVER_FIXTURE, eagerLoadQwen: false });
    const store = makeStore();
    await store.dispatch(saveAccountSettings({ eagerLoadQwen: false }));
    expect(putSpy).toHaveBeenCalledWith({ eagerLoadQwen: false });
    expect(store.getState().account.eagerLoadQwen).toBe(false);
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

describe('accountSlice — fetchAnalyzerModels (dynamic analyzer models)', () => {
  it('fetchAnalyzerModels populates localAnalyzerModels + pullableModels', async () => {
    const store = makeStore();
    await store.dispatch(fetchAnalyzerModels());
    const s = store.getState().account;
    expect(s.localAnalyzerModels.map((t) => t.name)).toEqual(
      expect.arrayContaining(['qwen3.5:4b']),
    );
    expect(s.pullableModels).toEqual(
      expect.arrayContaining(['gemma-4-E4B-it-GGUF:UD-Q4_K_XL']),
    );
  });

  it('leaves the local group empty when Ollama is unreachable (pullable still set)', async () => {
    (api.getOllamaHealth as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'unreachable',
      url: '',
      pullable: ['qwen3.5:4b'],
    });
    const store = makeStore();
    await store.dispatch(fetchAnalyzerModels());
    expect(store.getState().account.localAnalyzerModels).toEqual([]);
    expect(store.getState().account.pullableModels).toEqual(['qwen3.5:4b']);
  });
});

describe('per-phase analyzer selectors (plan 118)', () => {
  const base = accountSlice.getInitialState();

  it('selectAnalyzerSplitIsActive is false when both per-phase models are null', () => {
    expect(
      selectAnalyzerSplitIsActive({ ...base, analyzerPhase0Model: null, analyzerPhase1Model: null }),
    ).toBe(false);
  });

  it('selectAnalyzerSplitIsActive is true when either per-phase model is set', () => {
    expect(selectAnalyzerSplitIsActive({ ...base, analyzerPhase0Model: 'gemma-4-31b-it' })).toBe(
      true,
    );
    expect(selectAnalyzerSplitIsActive({ ...base, analyzerPhase1Model: 'gemini-3.1-flash-lite' })).toBe(
      true,
    );
  });

  it('per-phase model selectors return the raw saved value or null — no fabricated default', () => {
    expect(selectAnalyzerPhase0Model({ ...base, analyzerPhase0Model: null })).toBeNull();
    expect(selectAnalyzerPhase1Model({ ...base, analyzerPhase1Model: null })).toBeNull();
    expect(selectAnalyzerPhase0Model({ ...base, analyzerPhase0Model: 'gemma-4-31b-it' })).toBe(
      'gemma-4-31b-it',
    );
  });

  it('selectAnalyzerPhase1MinLag defaults to 10 and honours an override', () => {
    expect(selectAnalyzerPhase1MinLag({ ...base, analyzerPhase1MinLagChapters: null })).toBe(10);
    expect(selectAnalyzerPhase1MinLag({ ...base, analyzerPhase1MinLagChapters: 4 })).toBe(4);
  });
});
