/* Config slice — advanced settings knob store.
   The server is the source of truth; this slice holds a hydrated copy.
   Prompt thunks live here alongside the knob thunks so the UI has a
   single import point for all config mutations. */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import type { ConfigGroup, KnobDescriptor, ConfigValues, PromptState } from '../lib/types';
import { api } from '../lib/api';

export type ConfigStatus = 'idle' | 'loading' | 'saving' | 'error';

export interface ConfigState {
  groups: ConfigGroup[];
  descriptors: KnobDescriptor[];
  values: ConfigValues;
  status: ConfigStatus;
  error: string | null;
  hydrated: boolean;
}

const initialState: ConfigState = {
  groups: [],
  descriptors: [],
  values: {},
  status: 'idle',
  error: null,
  hydrated: false,
};

/* ── thunks ─────────────────────────────────────────────────────────────── */

export const fetchConfig = createAsyncThunk('config/fetch', async () => {
  return api.getConfig();
});

export const saveOverride = createAsyncThunk<
  { applied: string[]; values: ConfigValues },
  { key: string; value: number | boolean | string }
>('config/saveOverride', async ({ key, value }) => {
  const result = await api.putConfig({ [key]: value });
  return { applied: result.applied, values: result.values };
});

export const resetKnob = createAsyncThunk<ConfigValues, string>(
  'config/resetKnob',
  async (key) => {
    const result = await api.resetConfig({ keys: [key] });
    return result.values;
  },
);

export const resetGroup = createAsyncThunk<ConfigValues, string>(
  'config/resetGroup',
  async (groupId) => {
    const result = await api.resetConfig({ group: groupId });
    return result.values;
  },
);

export const resetAllConfig = createAsyncThunk<ConfigValues, void>(
  'config/resetAll',
  async () => {
    const result = await api.resetConfig({ all: true });
    return result.values;
  },
);

export const restartSidecar = createAsyncThunk<{ ok: boolean; error?: string }, void>(
  'config/restartSidecar',
  async () => {
    return api.restartSidecar();
  },
);

export const forkPrompt = createAsyncThunk<PromptState, { id: string; text: string }>(
  'config/forkPrompt',
  async ({ id, text }) => {
    return api.putPrompt(id, text);
  },
);

export const revertPrompt = createAsyncThunk<PromptState, string>(
  'config/revertPrompt',
  async (id) => {
    return api.resetPrompt(id);
  },
);

/* ── slice ──────────────────────────────────────────────────────────────── */

export const configSlice = createSlice({
  name: 'config',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      /* fetchConfig */
      .addCase(fetchConfig.pending, (s) => {
        s.status = 'loading';
        s.error = null;
      })
      .addCase(fetchConfig.fulfilled, (s, a) => {
        s.groups = a.payload.groups;
        s.descriptors = a.payload.descriptors;
        s.values = a.payload.values;
        s.status = 'idle';
        s.error = null;
        s.hydrated = true;
      })
      .addCase(fetchConfig.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to load config.';
      })
      /* saveOverride */
      .addCase(saveOverride.pending, (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addCase(saveOverride.fulfilled, (s, a) => {
        s.values = a.payload.values;
        s.status = 'idle';
        s.error = null;
      })
      .addCase(saveOverride.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to save config override.';
      })
      /* resetKnob */
      .addCase(resetKnob.pending, (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addCase(resetKnob.fulfilled, (s, a) => {
        s.values = a.payload;
        s.status = 'idle';
        s.error = null;
      })
      .addCase(resetKnob.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to reset knob.';
      })
      /* resetGroup */
      .addCase(resetGroup.pending, (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addCase(resetGroup.fulfilled, (s, a) => {
        s.values = a.payload;
        s.status = 'idle';
        s.error = null;
      })
      .addCase(resetGroup.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to reset group.';
      })
      /* resetAllConfig */
      .addCase(resetAllConfig.pending, (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addCase(resetAllConfig.fulfilled, (s, a) => {
        s.values = a.payload;
        s.status = 'idle';
        s.error = null;
      })
      .addCase(resetAllConfig.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to reset all config.';
      })
      /* restartSidecar — status stays idle on success; the UI handles the
         transient "restarting" copy via a local flag, not the slice. */
      .addCase(restartSidecar.pending, (s) => {
        s.error = null;
      })
      .addCase(restartSidecar.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to restart sidecar.';
      })
      /* forkPrompt — prompt thunks don't mutate slice state directly (prompts
         are per-knob data the UI fetches on demand); we just clear saving
         status so the knob row can unblock. */
      .addCase(forkPrompt.pending, (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addCase(forkPrompt.fulfilled, (s) => {
        s.status = 'idle';
        s.error = null;
      })
      .addCase(forkPrompt.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to save prompt.';
      })
      /* revertPrompt */
      .addCase(revertPrompt.pending, (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addCase(revertPrompt.fulfilled, (s) => {
        s.status = 'idle';
        s.error = null;
      })
      .addCase(revertPrompt.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to revert prompt.';
      });
  },
});

/* ── selectors ──────────────────────────────────────────────────────────── */

/** True when any `restart-sidecar` knob has an active user override.
    Drives the "Restart sidecar to apply" banner in the UI.
    Accepts any state shape that has a `config` sub-key (works with both the
    full RootState and the lightweight test-store `{ config: ... }`). */
export function selectRestartPending(state: { config: ConfigState }): boolean {
  const { descriptors, values } = state.config;
  return descriptors.some(
    (d) => d.apply === 'restart-sidecar' && values[d.key]?.overridden === true,
  );
}

/** True when any `restart-server` knob has an active user override. */
export function selectRestartServerPending(state: { config: ConfigState }): boolean {
  const { descriptors, values } = state.config;
  return descriptors.some(
    (d) => d.apply === 'restart-server' && values[d.key]?.overridden === true,
  );
}
