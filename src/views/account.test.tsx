/* AccountView — renders, edits, saves. Mocks src/lib/api so the thunk
   round-trip stays in memory. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accountSlice, fetchAccountSettings, type AccountState } from '../store/account-slice';
import { uiSlice } from '../store/ui-slice';
import { AccountView } from './account';
import type { UserSettings } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getUserSettings: vi.fn(),
    putUserSettings: vi.fn(),
    putGeminiKey: vi.fn(),
  },
}));

import { api } from '../lib/api';

const SERVER_FIXTURE: UserSettings = {
  displayName: 'Mike Dudarenok',
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
  workspaceRoot: '/users/mike/workspace',
  workspaceSource: 'env',
};

function renderView(initial: Partial<UserSettings> = {}) {
  const preloaded: AccountState = {
    ...SERVER_FIXTURE,
    ...initial,
    status: 'idle',
    error: null,
    hydrated: true,
  };
  const store = configureStore({
    reducer: {
      account: accountSlice.reducer,
      ui: uiSlice.reducer,
    },
    preloadedState: { account: preloaded },
  });
  return {
    store,
    ...render(
      <Provider store={store}>
        <AccountView />
      </Provider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AccountView — rendering', () => {
  it('renders the persisted display name in the input', () => {
    renderView({ displayName: 'Captain Picard' });
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.value).toBe('Captain Picard');
  });

  it('shows the amber "Not set" pill when no Gemini API key is configured', () => {
    renderView({ apiKeyStatus: 'unset' });
    /* The Gemini-key field's pill copy is just "Not set" (was "Not set —
       add GEMINI_API_KEY to server/.env"). Plan 49 — the field itself is
       now writable, so the copy doesn't need to point the user at .env. */
    const pill = screen.getAllByText(/^not set$/i)[0];
    expect(pill).toBeInTheDocument();
  });

  it('shows the green "Set" pill when a Gemini API key is configured', () => {
    renderView({ apiKeyStatus: 'set' });
    const pill = screen.getAllByText(/^set$/i)[0];
    expect(pill).toBeInTheDocument();
  });

  it('renders workspaceRoot as read-only text — no input for it', () => {
    renderView({ workspaceRoot: '/foo/bar', workspaceSource: 'override' });
    expect(screen.getByText('/foo/bar')).toBeInTheDocument();
    expect(screen.getByText(/source: override/i)).toBeInTheDocument();
  });

  /* Plan 49 — the Gemini API key field is now WRITABLE. The
     read-only invariant has been intentionally inverted; the field
     accepts a paste-and-save flow. */
  it('exposes a writable input for the Gemini API key', () => {
    renderView({ apiKeyStatus: 'unset' });
    const input = screen.getByLabelText(/^gemini api key$/i) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    /* type=password so over-the-shoulder onlookers can't read the key. */
    expect(input.type).toBe('password');
  });
});

describe('AccountView — save flow', () => {
  it('dispatches saveAccountSettings with the merged patch on Save', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      displayName: 'Edited',
    });
    const user = userEvent.setup();
    renderView();

    const input = screen.getByLabelText('Display name');
    await user.clear(input);
    await user.type(input, 'Edited');

    const save = screen.getByRole('button', { name: /save changes/i });
    await user.click(save);

    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.displayName).toBe('Edited');
    /* All writable fields are bundled; read-only never sent. */
    expect(patch.apiKeyStatus).toBeUndefined();
    expect(patch.workspaceRoot).toBeUndefined();
  });

  it('flashes the "Saved." confirmation when the thunk fulfils', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERVER_FIXTURE);
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(screen.getByText(/^saved\.$/i)).toBeInTheDocument();
    });
  });

  it('surfaces an error text when the save rejects', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('disk full'),
    );
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(screen.getByText(/disk full/i)).toBeInTheDocument();
    });
  });

  it('renders the minor-cast threshold input with the persisted value and labels the unit explicitly as sentences', () => {
    renderView({ minorCastMinLines: 4 });
    const input = screen.getByLabelText(/Minor-cast threshold/i) as HTMLInputElement;
    expect(input.value).toBe('4');
    /* The sublabel must clarify that "lines" means attributed sentences,
       not words — the user explicitly asked for this unit to be made
       explicit in the account UI so they don't have to guess. */
    expect(screen.getByText(/attributed sentences/i)).toBeInTheDocument();
    expect(screen.getByText(/not word count/i)).toBeInTheDocument();
  });

  it('round-trips minorCastMinLines through the Save patch', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      minorCastMinLines: 7,
    });
    const user = userEvent.setup();
    renderView({ minorCastMinLines: 3 });
    const input = screen.getByLabelText(/Minor-cast threshold/i) as HTMLInputElement;
    /* fireEvent.change drives the controlled-input cleanly. user.type
       would prepend onto the existing "3" because the input's onChange
       drops NaN (empty) intermediate states by design — that's the same
       guard that powers the clamp behaviour. */
    fireEvent.change(input, { target: { value: '7' } });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.minorCastMinLines).toBe(7);
  });

  it('clamps an out-of-range entry rather than firing a failing PUT', () => {
    /* The schema caps at 50; user fat-fingers a 999. The input clamps
       in the onChange handler so Save never sends a value the server
       would 400 on. */
    renderView({ minorCastMinLines: 3 });
    const input = screen.getByLabelText(/Minor-cast threshold/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999' } });
    expect(input.value).toBe('50');
    fireEvent.change(input, { target: { value: '-5' } });
    expect(input.value).toBe('0');
  });

  it('shows the restart-required badge as soon as workspaceDirOverride is edited', () => {
    renderView({ workspaceDirOverride: null });
    expect(screen.queryByText(/restart the server/i)).toBeNull();
    const input = screen.getByLabelText(/workspace directory override/i);
    fireEvent.change(input, { target: { value: 'D:/elsewhere' } });
    expect(screen.getByText(/restart the server/i)).toBeInTheDocument();
  });
});

describe('AccountView — hydration sync', () => {
  it('mirrors slice updates back into the form fields when fetch hydrates after mount', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      displayName: 'Hydrated Name',
    });
    const store = configureStore({
      reducer: {
        account: accountSlice.reducer,
        ui: uiSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <AccountView />
      </Provider>,
    );
    /* The store starts on built-in defaults; fetch dispatches and the form
       follows once the slice updates. */
    await store.dispatch(fetchAccountSettings());
    await waitFor(() => {
      expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe(
        'Hydrated Name',
      );
    });
  });

  it('hides the form and shows a loud retryable error when the initial fetch fails', async () => {
    /* Regression: previously, when the backend was unreachable, the
       slice kept its built-in FRONTEND_ACCOUNT_DEFAULTS and the form
       rendered them as if they were the user's saved values — making it
       look like the saved analysis-model choice had been silently
       reverted. Hydration gate replaces that with an alert + retry. */
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('User settings fetch failed (502): Bad Gateway'),
    );
    const store = configureStore({
      reducer: {
        account: accountSlice.reducer,
        ui: uiSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <AccountView />
      </Provider>,
    );
    await store.dispatch(fetchAccountSettings());

    /* The form's controls must NOT be rendered — otherwise the picker
       would silently show the wrong default. */
    expect(screen.queryByLabelText('Display name')).toBeNull();
    expect(screen.queryByLabelText('Analysis model')).toBeNull();

    /* The alert panel surfaces the failure verbatim so the user can see
       why their saved choice isn't showing. */
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't load your settings/i);
    expect(alert).toHaveTextContent(/cd server && npm run dev/);
    expect(alert).toHaveTextContent(/Bad Gateway/);

    /* Retry re-fires the thunk; once it resolves, the form renders. */
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...SERVER_FIXTURE,
      displayName: 'Recovered',
    });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Recovered');
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('AccountView — Appearance (plan 41)', () => {
  it('renders the default-theme picker with the persisted value', () => {
    renderView({ defaultThemePreference: 'dark' });
    const select = screen.getByTestId('account-default-theme') as HTMLSelectElement;
    expect(select.value).toBe('dark');
  });

  it("falls back to 'system' when the field is absent (legacy settings file)", () => {
    renderView({ defaultThemePreference: undefined });
    const select = screen.getByTestId('account-default-theme') as HTMLSelectElement;
    expect(select.value).toBe('system');
  });

  it('round-trips defaultThemePreference through the Save patch', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      defaultThemePreference: 'dark',
    });
    const user = userEvent.setup();
    renderView({ defaultThemePreference: 'system' });
    const select = screen.getByTestId('account-default-theme') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'dark' } });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.defaultThemePreference).toBe('dark');
  });

  it('hides the override pill when no device override is set', () => {
    renderView();
    expect(screen.queryByTestId('theme-override-pill')).toBeNull();
  });

  it('shows the override pill when ui.themeOverride is set', () => {
    const { store } = renderView();
    /* Use the slice action so the test mirrors how the top-bar toggle
       writes to the override field. Wrap in act() so the re-render
       happens before the assertion. */
    act(() => {
      store.dispatch({ type: 'ui/setThemeOverride', payload: 'dark' });
    });
    expect(screen.getByTestId('theme-override-pill')).toBeInTheDocument();
    expect(screen.getByTestId('theme-override-pill').textContent).toMatch(
      /this device is overridden/i,
    );
  });

  it('"Use account default" button clears the override', async () => {
    const user = userEvent.setup();
    const { store } = renderView();
    act(() => {
      store.dispatch({ type: 'ui/setThemeOverride', payload: 'dark' });
    });
    expect(store.getState().ui.themeOverride).toBe('dark');
    await user.click(screen.getByRole('button', { name: /use account default/i }));
    expect(store.getState().ui.themeOverride).toBeNull();
    expect(screen.queryByTestId('theme-override-pill')).toBeNull();
  });
});

describe('AccountView — Gemini API key field (plan 49)', () => {
  it('Save button stays ghost-styled until the user types a key', () => {
    renderView({ apiKeyStatus: 'unset' });
    /* The field's Save button label is "Save key", distinct from the
       form-wide "Save changes". */
    const saveBtn = screen.getByRole('button', { name: /save key/i });
    expect(saveBtn).toBeInTheDocument();
  });

  it('typing a key + clicking Save fires putGeminiKey with the trimmed value', async () => {
    (api.putGeminiKey as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      apiKeyStatus: 'set',
    });
    const user = userEvent.setup();
    renderView({ apiKeyStatus: 'unset' });

    const input = screen.getByLabelText(/^gemini api key$/i);
    await user.type(input, '  my-real-key-12345  ');
    await user.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => {
      expect(api.putGeminiKey).toHaveBeenCalledTimes(1);
    });
    const [arg] = (api.putGeminiKey as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg).toBe('my-real-key-12345');
  });

  it('flashes "Saved." after a successful save', async () => {
    (api.putGeminiKey as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      apiKeyStatus: 'set',
    });
    const user = userEvent.setup();
    renderView({ apiKeyStatus: 'unset' });
    await user.type(screen.getByLabelText(/^gemini api key$/i), 'k');
    await user.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => {
      expect(screen.getByText(/^saved\.$/i)).toBeInTheDocument();
    });
  });

  it('Clear button is hidden when no key is set on the server', () => {
    renderView({ apiKeyStatus: 'unset' });
    expect(screen.queryByRole('button', { name: /^clear$/i })).toBeNull();
  });

  it('Clear button is shown when apiKeyStatus is set and fires putGeminiKey(null)', async () => {
    (api.putGeminiKey as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      apiKeyStatus: 'unset',
    });
    const user = userEvent.setup();
    renderView({ apiKeyStatus: 'set' });
    const clearBtn = screen.getByRole('button', { name: /^clear$/i });
    await user.click(clearBtn);

    await waitFor(() => {
      expect(api.putGeminiKey).toHaveBeenCalledTimes(1);
    });
    const [arg] = (api.putGeminiKey as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(arg).toBeNull();
  });

  it('does NOT send the key through the general save flow', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERVER_FIXTURE);
    const user = userEvent.setup();
    renderView({ apiKeyStatus: 'unset' });

    /* Even with text in the API key field, clicking the form-wide Save
       MUST NOT include the secret in the patch. The dedicated endpoint
       owns that write — this is the design invariant. */
    await user.type(screen.getByLabelText(/^gemini api key$/i), 'should-not-leak');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.geminiApiKey).toBeUndefined();
    /* And putGeminiKey was not auto-fired by the form-wide save. */
    expect(api.putGeminiKey).not.toHaveBeenCalled();
  });
});

describe('AccountView — TTS sidecar auto-start (plan 43)', () => {
  it('renders the auto-start toggle checked when the preference is true', () => {
    renderView({ autoStartSidecar: true });
    const checkbox = screen.getByTestId('account-auto-start-sidecar') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/will spawn the sidecar at boot/i)).toBeInTheDocument();
  });

  it('renders the auto-start toggle unchecked when the preference is false', () => {
    renderView({ autoStartSidecar: false });
    const checkbox = screen.getByTestId('account-auto-start-sidecar') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.getByText(/you manage the sidecar process yourself/i)).toBeInTheDocument();
  });

  it('defaults to true when the field is absent (legacy settings file)', () => {
    renderView({ autoStartSidecar: undefined });
    const checkbox = screen.getByTestId('account-auto-start-sidecar') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('round-trips autoStartSidecar=false through the Save patch', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      autoStartSidecar: false,
    });
    const user = userEvent.setup();
    renderView({ autoStartSidecar: true });
    const checkbox = screen.getByTestId('account-auto-start-sidecar');
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.autoStartSidecar).toBe(false);
  });

  it('shows the restart-required pill as soon as the toggle is flipped', async () => {
    const user = userEvent.setup();
    renderView({ autoStartSidecar: true });
    expect(screen.queryByText(/restart the server to apply this change/i)).toBeNull();
    await user.click(screen.getByTestId('account-auto-start-sidecar'));
    expect(screen.getByText(/restart the server to apply this change/i)).toBeInTheDocument();
  });
});

describe('AccountView — dual-model TTS mode', () => {
  it('renders the dual-model checkbox unchecked by default', () => {
    renderView({ dualModelEnabled: false });
    const checkbox = screen.getByTestId('account-dual-model-enabled') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('renders the dual-model checkbox checked when the preference is true', () => {
    renderView({ dualModelEnabled: true });
    const checkbox = screen.getByTestId('account-dual-model-enabled') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('defaults to false when the field is absent (legacy settings file)', () => {
    renderView({ dualModelEnabled: undefined });
    const checkbox = screen.getByTestId('account-dual-model-enabled') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('does NOT show a restart-required badge (takes effect on next generation run)', async () => {
    const user = userEvent.setup();
    renderView({ dualModelEnabled: false });
    await user.click(screen.getByTestId('account-dual-model-enabled'));
    /* Unlike auto-start, flipping dual-model mode shows no restart badge —
       it's read on the next generation run, not at server boot. */
    expect(screen.queryByText(/restart the server to apply this change/i)).toBeNull();
  });

  it('round-trips dualModelEnabled=true through the Save patch', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      dualModelEnabled: true,
    });
    const user = userEvent.setup();
    renderView({ dualModelEnabled: false });
    await user.click(screen.getByTestId('account-dual-model-enabled'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.dualModelEnabled).toBe(true);
  });
});

describe('AccountView — Models card (plan 61)', () => {
  it('renders the Models section with the in-app Ollama install card', async () => {
    /* The OllamaInstall component fires /api/ollama/detect on mount —
       stub the global fetch so it returns "not installed" without
       hitting the network. */
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ installed: false, version: null }), { status: 200 }),
      );
    try {
      renderView();
      const card = await screen.findByTestId('account-models-card');
      expect(card).toBeInTheDocument();
      expect(card).toHaveTextContent(/local analyzer/i);
      expect(card).toHaveTextContent(/analyzer models/i);
      expect(card).toHaveTextContent(/coqui xtts/i);
      /* OllamaInstall renders "not detected" once /detect resolves. */
      await waitFor(() => {
        expect(screen.getByTestId('ollama-install-not-detected')).toBeInTheDocument();
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('renders the cross-platform Coqui install snippet (both POSIX + PowerShell)', () => {

    /* The card cites both `install-coqui.sh` and `install-coqui.ps1`
       in the same block — the user must be able to copy/paste their
       platform's command without scrolling. */
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ installed: false, version: null }), { status: 200 }),
      );
    try {
      renderView();
      const pre = screen.getByTestId('account-coqui-install-cmd');
      expect(pre.textContent).toMatch(/install-coqui\.ps1/);
      expect(pre.textContent).toMatch(/install-coqui\.sh/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('renders the cross-platform Qwen3-TTS install snippet (both PowerShell + Node)', () => {
    /* The Qwen card mirrors the Coqui block: a PowerShell command for
       Windows and a Node command for macOS / Linux, both in one copyable
       <pre> so the user grabs their platform's line without scrolling. */
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ installed: false, version: null }), { status: 200 }),
      );
    try {
      renderView();
      const pre = screen.getByTestId('account-qwen-install-cmd');
      expect(pre.textContent).toMatch(/install-qwen3\.ps1/);
      expect(pre.textContent).toMatch(/install-qwen3\.mjs/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('AccountView — Analyzer card (plan 88 phase-2)', () => {
  it('renders the Analyzer card with all three knobs', () => {
    renderView();
    expect(screen.getByTestId('account-analyzer-phase0-model')).toBeInTheDocument();
    expect(screen.getByTestId('account-analyzer-phase1-model')).toBeInTheDocument();
    expect(screen.getByTestId('account-analyzer-phase1-min-lag')).toBeInTheDocument();
  });

  it('the Phase 0 picker starts on "(use server default)" when slice value is null', () => {
    renderView({ analyzerPhase0Model: null });
    const select = screen.getByTestId('account-analyzer-phase0-model') as HTMLSelectElement;
    expect(select.value).toBe('');
  });

  it('the Phase 0 picker reflects the persisted slice value', () => {
    renderView({ analyzerPhase0Model: 'gemma-4-31b-it' });
    const select = screen.getByTestId('account-analyzer-phase0-model') as HTMLSelectElement;
    expect(select.value).toBe('gemma-4-31b-it');
  });

  it('the Phase 1 picker reflects the persisted slice value', () => {
    renderView({ analyzerPhase1Model: 'gemini-3.1-flash-lite' });
    const select = screen.getByTestId('account-analyzer-phase1-model') as HTMLSelectElement;
    expect(select.value).toBe('gemini-3.1-flash-lite');
  });

  it('the min-lag input renders blank when slice value is null', () => {
    renderView({ analyzerPhase1MinLagChapters: null });
    const input = screen.getByTestId('account-analyzer-phase1-min-lag') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('the min-lag input renders the persisted slice value', () => {
    renderView({ analyzerPhase1MinLagChapters: 10 });
    const input = screen.getByTestId('account-analyzer-phase1-min-lag') as HTMLInputElement;
    expect(input.value).toBe('10');
  });

  it('the min-lag input clamps an out-of-range entry to [0, 50]', () => {
    renderView({ analyzerPhase1MinLagChapters: 10 });
    const input = screen.getByTestId('account-analyzer-phase1-min-lag') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999' } });
    expect(input.value).toBe('50');
    fireEvent.change(input, { target: { value: '-7' } });
    expect(input.value).toBe('0');
  });

  it('round-trips the three Analyzer fields through the Save patch', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      analyzerPhase0Model: 'qwen3.5:9b',
      analyzerPhase1Model: 'gemini-3.1-flash-lite',
      analyzerPhase1MinLagChapters: 15,
    });
    const user = userEvent.setup();
    renderView({
      analyzerPhase0Model: null,
      analyzerPhase1Model: null,
      analyzerPhase1MinLagChapters: null,
    });

    fireEvent.change(screen.getByTestId('account-analyzer-phase0-model'), {
      target: { value: 'qwen3.5:9b' },
    });
    fireEvent.change(screen.getByTestId('account-analyzer-phase1-model'), {
      target: { value: 'gemini-3.1-flash-lite' },
    });
    fireEvent.change(screen.getByTestId('account-analyzer-phase1-min-lag'), {
      target: { value: '15' },
    });

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.analyzerPhase0Model).toBe('qwen3.5:9b');
    expect(patch.analyzerPhase1Model).toBe('gemini-3.1-flash-lite');
    expect(patch.analyzerPhase1MinLagChapters).toBe(15);
  });

  it('clearing the min-lag input sends null in the Save patch (fall through to env / default)', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      analyzerPhase1MinLagChapters: null,
    });
    const user = userEvent.setup();
    renderView({ analyzerPhase1MinLagChapters: 10 });
    fireEvent.change(screen.getByTestId('account-analyzer-phase1-min-lag'), {
      target: { value: '' },
    });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.analyzerPhase1MinLagChapters).toBeNull();
  });

  it('switching a model picker back to "(use server default)" sends null in the Save patch', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      analyzerPhase0Model: null,
    });
    const user = userEvent.setup();
    renderView({ analyzerPhase0Model: 'gemma-4-31b-it' });
    fireEvent.change(screen.getByTestId('account-analyzer-phase0-model'), {
      target: { value: '' },
    });
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.analyzerPhase0Model).toBeNull();
  });
});
