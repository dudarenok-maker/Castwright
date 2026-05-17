/* Account slice — user-level account defaults + non-secret env overrides.
   Server is the source of truth; this slice holds a hydrated copy so the
   top-bar avatar can render the display name and the book-hydration path
   can read defaults synchronously.

   Persistence: explicit save via thunk (not the per-book persistence
   middleware, which is keyed by bookId — account state is user-wide). */

import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type { UserSettings, UserSettingsPatch } from '../lib/types';
import { FRONTEND_ACCOUNT_DEFAULTS } from '../lib/account-defaults';
import { api } from '../lib/api';

export type AccountStatus = 'idle' | 'loading' | 'saving' | 'error';

export interface AccountState extends UserSettings {
  status: AccountStatus;
  /** Surfacing fetch / save errors. Cleared on the next successful round-trip. */
  error: string | null;
  /** Set true once the server payload has hydrated this slice. Lets callers
      distinguish "still showing built-in defaults" from "user has confirmed". */
  hydrated: boolean;
}

const initialState: AccountState = {
  ...FRONTEND_ACCOUNT_DEFAULTS,
  apiKeyStatus: 'unset',
  workspaceRoot: '',
  workspaceSource: 'default',
  status: 'idle',
  error: null,
  hydrated: false,
};

export const fetchAccountSettings = createAsyncThunk<UserSettings>('account/fetch', async () => {
  return api.getUserSettings();
});

export const saveAccountSettings = createAsyncThunk<UserSettings, UserSettingsPatch>(
  'account/save',
  async (patch) => {
    return api.putUserSettings(patch);
  },
);

export const accountSlice = createSlice({
  name: 'account',
  initialState,
  reducers: {
    /* Granular setters let the Account view dispatch onChange without the
       Save button locally batching everything. Kept synchronous so the
       form mirrors what the user sees. The PUT thunk fires on Save and
       re-hydrates the server-derived fields. */
    setDisplayName: (s, a: PayloadAction<string>) => {
      s.displayName = a.payload;
    },
    setDefaultAnalysisModel: (s, a: PayloadAction<string>) => {
      s.defaultAnalysisModel = a.payload;
    },
    setDefaultTtsEngine: (s, a: PayloadAction<UserSettings['defaultTtsEngine']>) => {
      s.defaultTtsEngine = a.payload;
    },
    setDefaultTtsModelKey: (s, a: PayloadAction<UserSettings['defaultTtsModelKey']>) => {
      s.defaultTtsModelKey = a.payload;
    },
    setSidecarUrl: (s, a: PayloadAction<string>) => {
      s.sidecarUrl = a.payload;
    },
    setWorkspaceDirOverride: (s, a: PayloadAction<string | null>) => {
      s.workspaceDirOverride = a.payload;
    },
    setCoverPickerDefaultTab: (s, a: PayloadAction<UserSettings['coverPickerDefaultTab']>) => {
      s.coverPickerDefaultTab = a.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchAccountSettings.pending, (s) => {
        s.status = 'loading';
        s.error = null;
      })
      .addCase(fetchAccountSettings.fulfilled, (s, a) => {
        Object.assign(s, a.payload);
        s.status = 'idle';
        s.error = null;
        s.hydrated = true;
      })
      .addCase(fetchAccountSettings.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to load account settings.';
      })
      .addCase(saveAccountSettings.pending, (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addCase(saveAccountSettings.fulfilled, (s, a) => {
        Object.assign(s, a.payload);
        s.status = 'idle';
        s.error = null;
        s.hydrated = true;
      })
      .addCase(saveAccountSettings.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to save account settings.';
      });
  },
});

export const accountActions = accountSlice.actions;
