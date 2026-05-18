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
