/* fs-23 — Model Manager view. Inventory rows, residency badges, the Load/Unload
   action wiring, and a smoke check that the moved settings form renders. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accountSlice, type AccountState } from '../store/account-slice';
import { uiSlice } from '../store/ui-slice';
import { settingsSlice } from '../store/settings-slice';
import { upgradeSlice } from '../store/upgrade-slice';
import { ModelManagerView } from './model-manager';
import { api, type ModelInventoryResponse } from '../lib/api';
import type { UserSettings } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getModelInventory: vi.fn(),
    loadSidecar: vi.fn(),
    unloadSidecar: vi.fn(),
    loadAnalyzer: vi.fn(),
    unloadAnalyzer: vi.fn(),
    getUserSettings: vi.fn(),
    putUserSettings: vi.fn(),
    putGeminiKey: vi.fn(),
  },
}));

const mockInventory = vi.mocked(api.getModelInventory);
const mockLoad = vi.mocked(api.loadSidecar);
const mockUnload = vi.mocked(api.unloadSidecar);

const SETTINGS_FIXTURE: UserSettings = {
  displayName: 'Mike',
  defaultAnalysisModel: 'gemma-4-31b-it',
  defaultTtsEngine: 'local',
  defaultTtsModelKey: 'coqui-xtts-v2',
  sidecarUrl: 'http://localhost:9000',
  analysisEngine: 'local',
  ollamaUrl: 'http://localhost:11434',
  workspaceDirOverride: null,
  minorCastMinLines: 3,
  analyzerPhase0Model: null,
  analyzerPhase1Model: null,
  analyzerPhase1MinLagChapters: null,
  apiKeyStatus: 'unset',
  workspaceRoot: '/ws',
  workspaceSource: 'env',
};

const INVENTORY: ModelInventoryResponse = {
  ts: '2026-06-06T00:00:00.000Z',
  sidecarReachable: true,
  items: [
    {
      id: 'kokoro',
      kind: 'tts',
      label: 'Kokoro v1',
      present: true,
      sizeBytes: 346_030_080,
      diskPath: 'server/tts-sidecar/voices/kokoro',
      loaded: true,
      isDefaultEngine: true,
      isFallbackEngine: true,
      removable: true,
      updatable: true,
    },
    {
      id: 'qwen-base',
      kind: 'tts',
      label: 'Qwen3-TTS Base (0.6B)',
      present: true,
      sizeBytes: 1_283_457_024,
      diskPath: 'hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-Base',
      loaded: false,
      isDefaultEngine: false,
      isFallbackEngine: false,
      removable: true,
      updatable: true,
    },
    {
      id: 'coqui',
      kind: 'tts',
      label: 'Coqui XTTS v2',
      present: false,
      sizeBytes: null,
      diskPath: 'voices/coqui',
      loaded: false,
      isDefaultEngine: false,
      isFallbackEngine: false,
      removable: false,
      updatable: true,
    },
  ],
};

function renderManager(initial: Partial<UserSettings> = {}) {
  const preloaded: AccountState = {
    ...SETTINGS_FIXTURE,
    ...initial,
    status: 'idle',
    error: null,
    hydrated: true,
  };
  const store = configureStore({
    reducer: {
      account: accountSlice.reducer,
      ui: uiSlice.reducer,
      settings: settingsSlice.reducer,
      upgrade: upgradeSlice.reducer,
    },
    preloadedState: { account: preloaded },
  });
  return {
    store,
    ...render(
      <Provider store={store}>
        <ModelManagerView />
      </Provider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInventory.mockResolvedValue(INVENTORY);
  mockLoad.mockResolvedValue({ status: 'ready' });
  mockUnload.mockResolvedValue({ status: 'idle' });
  /* The moved installers + ModelsCard fetch on mount; keep them quiet. */
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ModelManagerView — inventory', () => {
  it('renders a row per model with size and disk path', async () => {
    renderManager();
    const board = await screen.findByTestId('model-inventory');
    expect(within(board).getByTestId('model-row-kokoro')).toBeInTheDocument();
    expect(within(board).getByTestId('model-row-qwen-base')).toBeInTheDocument();
    expect(within(board).getByText(/330 MB/)).toBeInTheDocument(); // 346030080 bytes
    expect(within(board).getByText(/models--Qwen--Qwen3-TTS/)).toBeInTheDocument();
  });

  it('shows the residency badge per model', async () => {
    renderManager();
    const kokoro = await screen.findByTestId('model-row-kokoro');
    expect(within(kokoro).getByText('Loaded')).toBeInTheDocument();
    expect(within(screen.getByTestId('model-row-qwen-base')).getByText('Installed')).toBeInTheDocument();
    expect(within(screen.getByTestId('model-row-coqui')).getByText('Not installed')).toBeInTheDocument();
  });

  it('flags the default and fallback engines', async () => {
    renderManager();
    const kokoro = await screen.findByTestId('model-row-kokoro');
    expect(within(kokoro).getByText('Default')).toBeInTheDocument();
    expect(within(kokoro).getByText('Fallback')).toBeInTheDocument();
  });

  it('loads an installed-but-unloaded engine via the control pill', async () => {
    renderManager();
    const qwen = await screen.findByTestId('model-row-qwen-base');
    within(qwen).getByRole('button', { name: /load model/i }).click();
    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith({ engine: 'qwen' }));
  });

  it('unloads a resident engine via the control pill', async () => {
    renderManager();
    const kokoro = await screen.findByTestId('model-row-kokoro');
    within(kokoro).getByRole('button', { name: /stop/i }).click();
    await waitFor(() => expect(mockUnload).toHaveBeenCalledWith({ engine: 'kokoro' }));
  });

  it('offers no Load control for a not-installed model', async () => {
    renderManager();
    const coqui = await screen.findByTestId('model-row-coqui');
    expect(within(coqui).queryByRole('button', { name: /load model/i })).toBeNull();
  });
});

describe('ModelManagerView — moved settings form', () => {
  it('renders the moved TTS-sidecar + analyzer-split + models cards', async () => {
    renderManager();
    expect(await screen.findByTestId('account-auto-start-sidecar')).toBeInTheDocument();
    expect(screen.getByTestId('analyzer-split-status')).toBeInTheDocument();
    expect(screen.getByTestId('account-models-card')).toBeInTheDocument();
    expect(screen.getByTestId('account-sidecar-url')).toBeInTheDocument();
  });

  it('flags an invalid (public-host) sidecar URL', async () => {
    renderManager();
    const input = (await screen.findByTestId('account-sidecar-url')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'http://evil.example.com:9000' } });
    expect(screen.getByTestId('sidecar-url-invalid')).toBeInTheDocument();
  });
});

/* ── Moved-from-Account coverage (fs-23) ──────────────────────────────────
   These behaviours used to live in account.test.tsx; they moved here with the
   ModelSettingsForm. The form Saves a PARTIAL patch via api.putUserSettings and
   the Gemini key via api.putGeminiKey. */

const putUserSettings = vi.mocked(api.putUserSettings);
const putGeminiKey = vi.mocked(api.putGeminiKey);

describe('ModelManagerView — Gemini API key field', () => {
  it('typing a key + Save key fires putGeminiKey with the trimmed value', async () => {
    putGeminiKey.mockResolvedValue({ ...SETTINGS_FIXTURE, apiKeyStatus: 'set' });
    const user = userEvent.setup();
    renderManager({ apiKeyStatus: 'unset' });
    await user.type(await screen.findByLabelText(/^gemini api key$/i), '  key-123  ');
    await user.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => expect(putGeminiKey).toHaveBeenCalledTimes(1));
    expect(putGeminiKey.mock.calls[0][0]).toBe('key-123');
  });

  it('Clear fires putGeminiKey(null) when a key is set', async () => {
    putGeminiKey.mockResolvedValue({ ...SETTINGS_FIXTURE, apiKeyStatus: 'unset' });
    const user = userEvent.setup();
    renderManager({ apiKeyStatus: 'set' });
    await user.click(await screen.findByRole('button', { name: /^clear$/i }));
    await waitFor(() => expect(putGeminiKey).toHaveBeenCalledTimes(1));
    expect(putGeminiKey.mock.calls[0][0]).toBeNull();
  });

  it('does NOT send the key through the general Save changes flow', async () => {
    putUserSettings.mockResolvedValue(SETTINGS_FIXTURE);
    const user = userEvent.setup();
    renderManager({ apiKeyStatus: 'unset' });
    await user.type(await screen.findByLabelText(/^gemini api key$/i), 'should-not-leak');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(putUserSettings).toHaveBeenCalledTimes(1));
    expect((putUserSettings.mock.calls[0][0] as Record<string, unknown>).geminiApiKey).toBeUndefined();
    expect(putGeminiKey).not.toHaveBeenCalled();
  });
});

describe('ModelManagerView — TTS sidecar preferences', () => {
  it('renders auto-start checked / unchecked from the preference', async () => {
    renderManager({ autoStartSidecar: false });
    const cb = (await screen.findByTestId('account-auto-start-sidecar')) as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('defaults auto-start to true when the field is absent', async () => {
    renderManager({ autoStartSidecar: undefined });
    expect(((await screen.findByTestId('account-auto-start-sidecar')) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('shows the restart-required pill when auto-start is flipped', async () => {
    const user = userEvent.setup();
    renderManager({ autoStartSidecar: true });
    expect(screen.queryByText(/restart the server to apply this change/i)).toBeNull();
    await user.click(await screen.findByTestId('account-auto-start-sidecar'));
    expect(screen.getByText(/restart the server to apply this change/i)).toBeInTheDocument();
  });

  it('round-trips autoStartSidecar=false + dualModelEnabled through the Save patch', async () => {
    putUserSettings.mockResolvedValue(SETTINGS_FIXTURE);
    const user = userEvent.setup();
    renderManager({ autoStartSidecar: true, dualModelEnabled: false });
    await user.click(await screen.findByTestId('account-auto-start-sidecar'));
    await user.click(screen.getByTestId('account-dual-model-enabled'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(putUserSettings).toHaveBeenCalledTimes(1));
    const patch = putUserSettings.mock.calls[0][0];
    expect(patch.autoStartSidecar).toBe(false);
    expect(patch.dualModelEnabled).toBe(true);
  });

  it('shows the Qwen eager-load toggle when Qwen is the default engine', async () => {
    renderManager({ defaultTtsModelKey: 'qwen3-tts-0.6b', resolvedTtsModelKey: 'qwen3-tts-0.6b' });
    expect(await screen.findByTestId('account-eager-load-qwen')).toBeInTheDocument();
    expect(screen.queryByTestId('account-eager-load-kokoro')).toBeNull();
  });

  it('shows the Kokoro eager-load toggle for a non-Qwen default engine', async () => {
    renderManager({ defaultTtsModelKey: 'kokoro-v1', resolvedTtsModelKey: 'kokoro-v1' });
    expect(await screen.findByTestId('account-eager-load-kokoro')).toBeInTheDocument();
    expect(screen.queryByTestId('account-eager-load-qwen')).toBeNull();
  });

  it('clamps generation workers to [1, 4] and round-trips the value', async () => {
    putUserSettings.mockResolvedValue(SETTINGS_FIXTURE);
    const user = userEvent.setup();
    renderManager({ generationWorkers: 2 });
    const input = (await screen.findByTestId('account-generation-workers')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9' } });
    expect(input.value).toBe('4'); // clamped
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(putUserSettings).toHaveBeenCalledTimes(1));
    expect(putUserSettings.mock.calls[0][0].generationWorkers).toBe(4);
  });
});

describe('ModelManagerView — analyzer split', () => {
  it('reflects persisted phase pickers + min-lag', async () => {
    renderManager({
      analyzerPhase0Model: 'gemma-4-31b-it',
      analyzerPhase1Model: 'gemini-3.1-flash-lite',
      analyzerPhase1MinLagChapters: 5,
    });
    expect(((await screen.findByTestId('account-analyzer-phase0-model')) as HTMLSelectElement).value).toBe(
      'gemma-4-31b-it',
    );
    expect((screen.getByTestId('account-analyzer-phase1-min-lag') as HTMLInputElement).value).toBe('5');
  });

  it('round-trips the analyzer fields, sending null for a blanked min-lag', async () => {
    putUserSettings.mockResolvedValue(SETTINGS_FIXTURE);
    const user = userEvent.setup();
    renderManager({ analyzerPhase1MinLagChapters: 5 });
    fireEvent.change(await screen.findByTestId('account-analyzer-phase1-min-lag'), {
      target: { value: '' },
    });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(putUserSettings).toHaveBeenCalledTimes(1));
    expect(putUserSettings.mock.calls[0][0].analyzerPhase1MinLagChapters).toBeNull();
  });
});

describe('ModelManagerView — installers', () => {
  it('renders the in-app installer cards for Coqui / Qwen / Whisper', async () => {
    renderManager();
    const card = await screen.findByTestId('account-models-card');
    expect(within(card).getByRole('heading', { name: /Coqui XTTS v2/i, level: 3 })).toBeInTheDocument();
    expect(
      within(card).getByRole('heading', { name: /Qwen3-TTS \(bespoke/i, level: 3 }),
    ).toBeInTheDocument();
    expect(within(card).getByRole('heading', { name: /Whisper ASR/i, level: 3 })).toBeInTheDocument();
  });
});
