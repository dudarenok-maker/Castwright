/* fs-1 — in-app upgrade slice. Drives the Account → Application updates card:
   stage a picked zip, confirm, apply, and poll the apply state. The success
   toast + post-restart version flip are handled in the card (it watches
   useAppInfo); this slice owns the staging/applying lifecycle. */

import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import type { UpgradeStageResult, UpgradeStatePayload } from '../lib/types';

export type UpgradeStatus = 'idle' | 'staging' | 'staged' | 'applying' | 'error';

export interface UpgradeState {
  status: UpgradeStatus;
  candidate: UpgradeStageResult | null;
  serverState: UpgradeStatePayload | null;
  error: string | null;
}

const initialState: UpgradeState = {
  status: 'idle',
  candidate: null,
  serverState: null,
  error: null,
};

export const stageUpgrade = createAsyncThunk<UpgradeStageResult, File>(
  'upgrade/stage',
  async (file) => api.upgradeStage(file),
);

export const applyUpgrade = createAsyncThunk<void>('upgrade/apply', async () => {
  await api.upgradeApply();
});

export const abortUpgrade = createAsyncThunk<void>('upgrade/abort', async () => {
  await api.upgradeAbort();
});

export const pollUpgradeState = createAsyncThunk<UpgradeStatePayload>(
  'upgrade/pollState',
  async () => api.upgradeState(),
);

export const upgradeSlice = createSlice({
  name: 'upgrade',
  initialState,
  reducers: {
    /* Reset to idle (Cancel on the confirm dialog, or after a success). */
    resetUpgrade: () => initialState,
    setApplying: (s) => {
      s.status = 'applying';
      s.error = null;
    },
    setUpgradeError: (s, a: PayloadAction<string>) => {
      s.status = 'error';
      s.error = a.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(stageUpgrade.pending, (s) => {
        s.status = 'staging';
        s.error = null;
        s.candidate = null;
      })
      .addCase(stageUpgrade.fulfilled, (s, a) => {
        s.status = 'staged';
        s.candidate = a.payload;
      })
      .addCase(stageUpgrade.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Staging failed.';
      })
      .addCase(applyUpgrade.pending, (s) => {
        s.status = 'applying';
        s.error = null;
      })
      .addCase(applyUpgrade.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Apply failed.';
      })
      .addCase(abortUpgrade.fulfilled, () => initialState)
      .addCase(pollUpgradeState.fulfilled, (s, a) => {
        s.serverState = a.payload;
        if (a.payload.phase === 'error') {
          s.status = 'error';
          s.error = a.payload.error ?? 'Upgrade failed during apply.';
        }
      });
  },
});

export const upgradeActions = upgradeSlice.actions;
