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
  },
}));

import { api } from '../lib/api';

const SERVER_FIXTURE: UserSettings = {
  displayName:          'Mike Dudarenok',
  defaultAnalysisModel: 'gemma-4-31b-it',
  defaultTtsEngine:     'local',
  defaultTtsModelKey:   'coqui-xtts-v2',
  sidecarUrl:           'http://localhost:9000',
  analysisEngine:       'local',
  ollamaUrl:            'http://localhost:11434',
  workspaceDirOverride: null,
  minorCastMinLines:    3,
  apiKeyStatus:         'unset',
  workspaceRoot:        '/users/mike/workspace',
  workspaceSource:      'env',
};

function renderView(initial: Partial<UserSettings> = {}) {
  const preloaded: AccountState = {
    ...SERVER_FIXTURE,
    ...initial,
    status:   'idle',
    error:    null,
    hydrated: true,
  };
  const store = configureStore({
    reducer: {
      account: accountSlice.reducer,
      ui:      uiSlice.reducer,
    },
    preloadedState: { account: preloaded },
  });
  return {
    store,
    ...render(<Provider store={store}><AccountView/></Provider>),
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

  it('shows the amber pill when GEMINI_API_KEY is not set', () => {
    renderView({ apiKeyStatus: 'unset' });
    expect(screen.getByText(/not set/i)).toBeInTheDocument();
  });

  it('shows the green pill when GEMINI_API_KEY is set', () => {
    renderView({ apiKeyStatus: 'set' });
    expect(screen.getByText(/set in server\/\.env/i)).toBeInTheDocument();
  });

  it('renders workspaceRoot as read-only text — no input for it', () => {
    renderView({ workspaceRoot: '/foo/bar', workspaceSource: 'override' });
    expect(screen.getByText('/foo/bar')).toBeInTheDocument();
    expect(screen.getByText(/source: override/i)).toBeInTheDocument();
  });

  it('does not expose any input for the Gemini API key (read-only invariant)', () => {
    renderView();
    /* No textbox (input/textarea) is associated with an "API key"
       label. We can't use queryByLabelText alone — the analyzer-engine
       sublabel mentions "GEMINI_API_KEY" and "API key" as descriptive
       prose, so any combobox whose accessible name includes the sublabel
       (e.g. the Analyzer-engine select) would false-positive a naive
       /api key/i regex. Anchor on the label *start* to target only
       widgets whose primary label is the API-key field. */
    expect(screen.queryByRole('textbox', { name: /^gemini api key/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /^gemini api key/i })).toBeNull();
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
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'));
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
        ui:      uiSlice.reducer,
      },
    });
    render(<Provider store={store}><AccountView/></Provider>);
    /* The store starts on built-in defaults; fetch dispatches and the form
       follows once the slice updates. */
    await store.dispatch(fetchAccountSettings());
    await waitFor(() => {
      expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Hydrated Name');
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
        ui:      uiSlice.reducer,
      },
    });
    render(<Provider store={store}><AccountView/></Provider>);
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
    expect(screen.getByTestId('theme-override-pill').textContent).toMatch(/this device is overridden/i);
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

  it("defaults to true when the field is absent (legacy settings file)", () => {
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
