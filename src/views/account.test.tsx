/* AccountView â€” renders, edits, saves. Mocks src/lib/api so the thunk
   round-trip stays in memory. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accountSlice, fetchAccountSettings, type AccountState } from '../store/account-slice';
import { uiSlice } from '../store/ui-slice';
import { settingsSlice } from '../store/settings-slice';
import { upgradeSlice } from '../store/upgrade-slice';
import { AccountView } from './account';
import type { UserSettings } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getUserSettings: vi.fn(),
    putUserSettings: vi.fn(),
    putGeminiKey: vi.fn(),
    /* UpgradeCard (rendered inside AccountView) checks for updates on mount;
       fail-open so these tests don't touch the network. */
    getUpdateStatus: vi.fn().mockResolvedValue({
      reachable: false,
      currentVersion: '',
      latestVersion: null,
      updateAvailable: false,
      url: null,
    }),
  },
}));

import { api } from '../lib/api';

const SERVER_FIXTURE: UserSettings = {
  displayName: 'Castwright',
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
    localAnalyzerModels: [],
    pullableModels: [],
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
        <MemoryRouter>
          <AccountView />
        </MemoryRouter>
      </Provider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AccountView â€” rendering', () => {
  it('renders the persisted display name in the input', () => {
    renderView({ displayName: 'Captain Picard' });
    const input = screen.getByLabelText('Display name') as HTMLInputElement;
    expect(input.value).toBe('Captain Picard');
  });

  it('renders workspaceRoot as read-only text â€” no input for it', () => {
    renderView({ workspaceRoot: '/foo/bar', workspaceSource: 'override' });
    expect(screen.getByText('/foo/bar')).toBeInTheDocument();
    expect(screen.getByText(/source: override/i)).toBeInTheDocument();
  });

  it('paints the Open Model Manager button with the theme-safe ink/canvas token', () => {
    /* Regression: the button shipped `bg-ink text-white`, which renders
       white-on-near-white once --ink inverts in dark mode (the fs-23 dark-CTA
       fix idiom is `bg-ink text-canvas`, as on the Admin sibling button). */
    renderView();
    const button = screen.getByTestId('account-model-manager-pointer');
    expect(button.className).toContain('bg-ink');
    expect(button.className).toContain('text-canvas');
    expect(button.className).not.toContain('text-white');
  });
});

describe('AccountView â€” save flow', () => {
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
       not words â€” the user explicitly asked for this unit to be made
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
       drops NaN (empty) intermediate states by design â€” that's the same
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

describe('AccountView â€” hydration sync', () => {
  it('mirrors slice updates back into the form fields when fetch hydrates after mount', async () => {
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      displayName: 'Hydrated Name',
    });
    const store = configureStore({
      reducer: {
        account: accountSlice.reducer,
        ui: uiSlice.reducer,
        settings: settingsSlice.reducer,
        upgrade: upgradeSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <MemoryRouter>
          <AccountView />
        </MemoryRouter>
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
       rendered them as if they were the user's saved values â€” making it
       look like the saved analysis-model choice had been silently
       reverted. Hydration gate replaces that with an alert + retry. */
    (api.getUserSettings as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('User settings fetch failed (502): Bad Gateway'),
    );
    const store = configureStore({
      reducer: {
        account: accountSlice.reducer,
        ui: uiSlice.reducer,
        settings: settingsSlice.reducer,
        upgrade: upgradeSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <MemoryRouter>
          <AccountView />
        </MemoryRouter>
      </Provider>,
    );
    await store.dispatch(fetchAccountSettings());

    /* The form's controls must NOT be rendered â€” otherwise the picker
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

describe('AccountView â€” Appearance (plan 41)', () => {
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

describe('AccountView â€” Advanced (power-user) card (fe-2)', () => {
  it('shows the default play/pause binding (Space) and the four controls', () => {
    renderView();
    const card = within(screen.getByTestId('account-advanced-card'));
    expect(card.getByTestId('account-play-pause-binding').textContent).toBe('Space');
    expect(card.getByTestId('account-high-contrast')).toBeInTheDocument();
    expect(card.getByTestId('account-text-scale')).toBeInTheDocument();
    expect(card.getByTestId('account-autosave-debounce')).toBeInTheDocument();
  });

  it('rebinds play/pause to a pressed key and reflects it in the slice', () => {
    const { store } = renderView();
    fireEvent.click(screen.getByTestId('account-rebind-play-pause'));
    fireEvent.keyDown(window, { key: 'k' });
    expect(store.getState().settings.keybindings['play-pause']).toBe('K');
    expect(screen.getByTestId('account-play-pause-binding').textContent).toBe('K');
  });

  it('Reset restores the default Space binding', () => {
    const { store } = renderView();
    fireEvent.click(screen.getByTestId('account-rebind-play-pause'));
    fireEvent.keyDown(window, { key: 'k' });
    expect(store.getState().settings.keybindings['play-pause']).toBe('K');
    fireEvent.click(screen.getByTestId('account-reset-play-pause'));
    expect(store.getState().settings.keybindings['play-pause']).toBe('Space');
  });

  it('toggles high-contrast and changes text scale through the slice', () => {
    const { store } = renderView();
    fireEvent.click(screen.getByTestId('account-high-contrast'));
    expect(store.getState().settings.highContrast).toBe(true);
    fireEvent.change(screen.getByTestId('account-text-scale'), { target: { value: 'larger' } });
    expect(store.getState().settings.textScale).toBe('larger');
  });

  it('commits a clamped autosave debounce on blur-sm', () => {
    const { store } = renderView();
    const input = screen.getByTestId('account-autosave-debounce');
    fireEvent.change(input, { target: { value: '2000' } });
    fireEvent.blur(input);
    expect(store.getState().settings.autosaveDebounceMs).toBe(2000);
    /* Above the ceiling clamps. */
    fireEvent.change(input, { target: { value: '999999' } });
    fireEvent.blur(input);
    expect(store.getState().settings.autosaveDebounceMs).toBe(10_000);
  });

  it('toggles auto-advance through the slice (fe-23)', () => {
    const { store } = renderView();
    expect(store.getState().settings.autoAdvance).toBe(true);
    fireEvent.click(screen.getByTestId('account-auto-advance'));
    expect(store.getState().settings.autoAdvance).toBe(false);
  });

  it('rebinds skip-forward and skip-back through the slice (fe-24)', () => {
    const { store } = renderView();
    fireEvent.click(screen.getByTestId('account-rebind-skip-forward'));
    fireEvent.keyDown(window, { key: 'p' });
    expect(store.getState().settings.keybindings['skip-forward']).toBe('P');
    expect(screen.getByTestId('account-skip-forward-binding').textContent).toBe('P');

    fireEvent.click(screen.getByTestId('account-rebind-skip-back'));
    fireEvent.keyDown(window, { key: 'b' });
    expect(store.getState().settings.keybindings['skip-back']).toBe('B');
    expect(screen.getByTestId('account-skip-back-binding').textContent).toBe('B');
  });

  it('commits clamped skip deltas on blur (fe-24)', () => {
    const { store } = renderView();
    const fwd = screen.getByTestId('account-skip-forward-sec');
    fireEvent.change(fwd, { target: { value: '45' } });
    fireEvent.blur(fwd);
    expect(store.getState().settings.skipForwardSec).toBe(45);
    /* Above the ceiling clamps to 120. */
    fireEvent.change(fwd, { target: { value: '999' } });
    fireEvent.blur(fwd);
    expect(store.getState().settings.skipForwardSec).toBe(120);

    const back = screen.getByTestId('account-skip-back-sec');
    fireEvent.change(back, { target: { value: '1' } });
    fireEvent.blur(back);
    /* Below the floor clamps to 5. */
    expect(store.getState().settings.skipBackSec).toBe(5);
  });
});

describe('AccountView — Re-run setup pointer (fs-21)', () => {
  it('renders the Re-run setup button with the theme-safe ink/canvas token', () => {
    renderView();
    const button = screen.getByTestId('account-rerun-setup');
    expect(button.className).toContain('bg-ink');
    expect(button.className).toContain('text-canvas');
    expect(button.className).not.toContain('text-white');
  });

  it('clicking Re-run setup dispatches openSetup and transitions ui.stage to setup', async () => {
    const user = userEvent.setup();
    const { store } = renderView();
    const button = screen.getByTestId('account-rerun-setup');
    await user.click(button);
    expect(store.getState().ui.stage.kind).toBe('setup');
  });
});

describe('AccountView — settings-accordion shell', () => {
  it('renders server-persisted sections as collapsible accordion sections and Save still dispatches', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(SERVER_FIXTURE);
    const user = userEvent.setup();
    renderView();

    /* Each server-persisted section header is an aria-expanded button (SettingsSection).
       Spot-check a few to confirm accordion structure is in place. The nav rail also
       renders buttons with the same label text, so we look for the aria-expanded
       attribute that only section header toggles carry. */
    const expandedBtns = screen.getAllByRole('button', { expanded: true });
    const expandedLabels = expandedBtns.map(
      (b) => b.getAttribute('aria-label') ?? b.textContent ?? '',
    );
    expect(expandedLabels.some((l) => /profile/i.test(l))).toBe(true);
    expect(expandedLabels.some((l) => /cast analysis/i.test(l))).toBe(true);
    expect(expandedLabels.some((l) => /workspace/i.test(l))).toBe(true);

    /* All sections default OPEN so controls are immediately accessible. */
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();

    /* Save still dispatches through the existing thunk path. */
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
  });

  it('lists the button-only sections in the side-nav too (Models / Advanced / Help / First-run)', () => {
    /* Regression: these four cards used to sit OUTSIDE the accordion, so the
       side-nav didn't cover them. They now live inside it with scroll-link ids,
       so the mobile jump <select> (and desktop rail) carry an entry for each. */
    renderView();
    for (const label of [
      'Models & engines',
      'Advanced configuration',
      'Help & troubleshooting',
      'First-run setup',
    ]) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }
    /* And each card carries the scroll-target id the nav points at. */
    expect(document.getElementById('cfg-section-acct-models')).not.toBeNull();
    expect(document.getElementById('cfg-section-acct-setup')).not.toBeNull();
  });
});
