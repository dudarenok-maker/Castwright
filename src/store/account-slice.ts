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

/** A locally-installed analyzer tag, as reported by Ollama's tag list. */
export interface LocalAnalyzerTag {
  name: string;
  size?: number;
}

export interface AccountState extends UserSettings {
  status: AccountStatus;
  /** Surfacing fetch / save errors. Cleared on the next successful round-trip. */
  error: string | null;
  /** Set true once the server payload has hydrated this slice. Lets callers
      distinguish "still showing built-in defaults" from "user has confirmed". */
  hydrated: boolean;
  /** Live analyzer tags installed locally (from Ollama's tag list). Empty when
      Ollama is unreachable. Populated by `fetchAnalyzerModels`. */
  localAnalyzerModels: LocalAnalyzerTag[];
  /** Curated install list (server's single source). Populated by
      `fetchAnalyzerModels`; the pickers + Model Manager read this. */
  pullableModels: string[];
}

const initialState: AccountState = {
  ...FRONTEND_ACCOUNT_DEFAULTS,
  apiKeyStatus: 'unset',
  workspaceRoot: '',
  workspaceSource: 'default',
  status: 'idle',
  error: null,
  hydrated: false,
  localAnalyzerModels: [],
  pullableModels: [],
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

/* Plan 49 — dedicated save thunk for the Gemini API key. Pass `null` to
   clear. Re-hydrates the slice from the server response so apiKeyStatus
   flips immediately in the UI. */
export const saveGeminiApiKey = createAsyncThunk<UserSettings, string | null>(
  'account/saveGeminiKey',
  async (key) => {
    return api.putGeminiKey(key);
  },
);

/* Dynamic analyzer-model discovery — hits the mockable `api.getOllamaHealth()`
   so it works under VITE_USE_MOCKS + e2e. Splits the response into the live
   local tags (empty when Ollama is unreachable) and the server's curated
   `pullable` install list. The pickers + Model Manager read both off state. */
export const fetchAnalyzerModels = createAsyncThunk('account/fetchAnalyzerModels', async () => {
  const health = await api.getOllamaHealth();
  const localTags: LocalAnalyzerTag[] =
    health.status === 'reachable' && Array.isArray(health.models)
      ? health.models.map((name) => ({ name }))
      : [];
  return { localTags, pullable: Array.isArray(health.pullable) ? health.pullable : [] };
});

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
    /* Plan 88 phase-2 — Account-tab Analyzer card. `null` clears the
       saved value so the server-side selector falls through to env /
       hardcoded default. */
    setAnalyzerPhase0Model: (s, a: PayloadAction<string | null>) => {
      s.analyzerPhase0Model = a.payload;
    },
    setAnalyzerPhase1Model: (s, a: PayloadAction<string | null>) => {
      s.analyzerPhase1Model = a.payload;
    },
    setAnalyzerPhase1MinLagChapters: (s, a: PayloadAction<number | null>) => {
      s.analyzerPhase1MinLagChapters = a.payload;
    },
    /* Dual-model TTS mode — when true the sidecar may keep two TTS
       engines resident in GPU memory at once. Off by default; toggled
       from the Account view's TTS-sidecar card. */
    setDualModelEnabled: (s, a: PayloadAction<boolean>) => {
      s.dualModelEnabled = a.payload;
    },
    /* Eager-load Kokoro at sidecar startup — when false the sidecar is
       spawned with PRELOAD_KOKORO=0 so Kokoro warms on demand, freeing
       ~1 GB VRAM. Toggled from the Account view's TTS-sidecar card;
       takes effect on the next sidecar restart. */
    setEagerLoadKokoro: (s, a: PayloadAction<boolean>) => {
      s.eagerLoadKokoro = a.payload;
    },
    /* Eager-load Qwen Base at sidecar startup — when false the sidecar is
       spawned with PRELOAD_QWEN=0 so Qwen warms on demand. Only governs the
       sidecar when Qwen is the default engine. Toggled from the Account view's
       TTS-sidecar card; takes effect on the next sidecar restart. */
    setEagerLoadQwen: (s, a: PayloadAction<boolean>) => {
      s.eagerLoadQwen = a.payload;
    },
    /* Plan 111 — number of chapters the generation queue synthesises
       concurrently (1–4, default 2). Set from the Account view's TTS-sidecar
       card; read by the queue dispatcher. Queue/synthesis concurrency only —
       the GPU semaphore is the separate VRAM guard. */
    setGenerationWorkers: (s, a: PayloadAction<number>) => {
      s.generationWorkers = a.payload;
    },
    /* srv-2 — per-book state.json auto-backup preferences. Toggled from the
       Account view's Backups card; persisted via the same Save thunk. */
    setBackupEnabled: (s, a: PayloadAction<boolean>) => {
      s.backupEnabled = a.payload;
    },
    setBackupCadence: (s, a: PayloadAction<UserSettings['backupCadence']>) => {
      s.backupCadence = a.payload;
    },
    setBackupRetention: (s, a: PayloadAction<number>) => {
      s.backupRetention = a.payload;
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
      })
      .addCase(saveGeminiApiKey.pending, (s) => {
        s.status = 'saving';
        s.error = null;
      })
      .addCase(saveGeminiApiKey.fulfilled, (s, a) => {
        Object.assign(s, a.payload);
        s.status = 'idle';
        s.error = null;
        s.hydrated = true;
      })
      .addCase(saveGeminiApiKey.rejected, (s, a) => {
        s.status = 'error';
        s.error = a.error.message ?? 'Failed to save Gemini API key.';
      })
      .addCase(fetchAnalyzerModels.fulfilled, (state, action) => {
        state.localAnalyzerModels = action.payload.localTags;
        state.pullableModels = action.payload.pullable;
      });
  },
});

export const accountActions = accountSlice.actions;

/* Default chapter lag between Phase 0 cast detection and Phase 1
   attribution — matches the server's `DEFAULT_PHASE1_MIN_LAG_CHAPTERS`
   (server/src/analyzer/select-analyzer.ts). A real constant the client
   can mirror, unlike the per-phase model defaults (which depend on
   server env the client can't see — see selectAnalyzerSplitIsActive). */
export const PHASE1_MIN_LAG_DEFAULT = 10;

/* Whether the user has configured a two-model per-phase split. Mirrors the
   user-settings half of the server's `isPerPhaseModelSelectionActive`. The
   frontend can't see the server's `ANALYZER_PHASE{0,1}_MODEL` env vars, so an
   env-only split won't register here — the chip then shows the honest
   "Server default" label rather than guessing a model. */
export function selectAnalyzerSplitIsActive(account: AccountState): boolean {
  return !!(account.analyzerPhase0Model || account.analyzerPhase1Model);
}

/* Raw saved per-phase model, or null = "fall through to the server default."
   No fabricated default — the chip decides what to show when null so it can
   stay honest about single-model vs split runs (plan 118). */
export function selectAnalyzerPhase0Model(account: AccountState): string | null {
  return account.analyzerPhase0Model ?? null;
}

export function selectAnalyzerPhase1Model(account: AccountState): string | null {
  return account.analyzerPhase1Model ?? null;
}

export function selectAnalyzerPhase1MinLag(account: AccountState): number {
  return account.analyzerPhase1MinLagChapters ?? PHASE1_MIN_LAG_DEFAULT;
}
