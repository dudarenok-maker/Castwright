/* Plan 41 — ThemeToggleButton cycles + dispatches.

   Pins the 3-state cycle (system → light → dark → system…) and the
   aria-label rotation per mode. Also confirms the toggle reads the
   account default when no override is set, so the icon never sits in
   a phantom "no choice" state. */

import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { ThemeToggleButton } from './theme-toggle';
import { uiSlice, type UiState } from '../store/ui-slice';
import { accountSlice, type AccountState } from '../store/account-slice';
import { DEFAULT_MODEL } from '../lib/models';
import { DEFAULT_TTS_MODEL } from '../lib/tts-models';
import { FRONTEND_ACCOUNT_DEFAULTS } from '../lib/account-defaults';

function makeStore({
  themeOverride = null as UiState['themeOverride'],
  accountDefault = 'system' as 'light' | 'dark' | 'system',
}: {
  themeOverride?: UiState['themeOverride'];
  accountDefault?: 'light' | 'dark' | 'system';
} = {}) {
  const uiPreloaded: UiState = {
    stage: { kind: 'books' },
    currentTrack: null,
    matchDetailFor: null,
    regenChapter: null,
    regenInitialScope: null,
    regenCharacterCtx: null,
    previewRegen: null,
    staleAudio: null,
    showRevisionPlayer: false,
    revisionHistoryFor: null,
    showDriftReport: false,
    driftReportCharacterFilter: null,
    previewMode: false,
    selectedModel: DEFAULT_MODEL,
    ttsModelKey: DEFAULT_TTS_MODEL,
    selectedModelExplicit: false,
    ttsModelKeyExplicit: false,
    themeOverride,
    reuploadingBookId: null,
    queueModalOpen: false,
    rebaselineModalOpen: false,
    rebaselineBookId: null,
  };
  const accountPreloaded: AccountState = {
    ...FRONTEND_ACCOUNT_DEFAULTS,
    apiKeyStatus: 'unset',
    workspaceRoot: '',
    workspaceSource: 'default',
    status: 'idle',
    error: null,
    hydrated: true,
    localAnalyzerModels: [],
    pullableModels: [],
    defaultThemePreference: accountDefault,
  };
  return configureStore({
    reducer: { ui: uiSlice.reducer, account: accountSlice.reducer },
    preloadedState: { ui: uiPreloaded, account: accountPreloaded },
  });
}

function renderToggle(opts: Parameters<typeof makeStore>[0] = {}) {
  const store = makeStore(opts);
  const view = render(
    <Provider store={store}>
      <ThemeToggleButton />
    </Provider>,
  );
  return { store, ...view };
}

describe('ThemeToggleButton — initial icon reflects effective mode', () => {
  it('renders the monitor (system) glyph when no override and account default is system', () => {
    renderToggle();
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-theme-mode', 'system');
  });

  it('renders the moon glyph when account default is dark and no override', () => {
    renderToggle({ accountDefault: 'dark' });
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-theme-mode', 'dark');
  });

  it('renders the sun glyph when override is light (override wins over account default)', () => {
    renderToggle({ themeOverride: 'light', accountDefault: 'dark' });
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-theme-mode', 'light');
  });
});

describe('ThemeToggleButton — click cycles system → light → dark → system', () => {
  it('system → light', () => {
    const { store } = renderToggle();
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(store.getState().ui.themeOverride).toBe('light');
  });

  it('light → dark', () => {
    const { store } = renderToggle({ themeOverride: 'light' });
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(store.getState().ui.themeOverride).toBe('dark');
  });

  it('dark → system', () => {
    const { store } = renderToggle({ themeOverride: 'dark' });
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(store.getState().ui.themeOverride).toBe('system');
  });

  it('three clicks back to where we started', () => {
    const { store } = renderToggle({ themeOverride: 'system' });
    const btn = screen.getByTestId('theme-toggle');
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(store.getState().ui.themeOverride).toBe('system');
  });
});

describe('ThemeToggleButton — aria-label rotates per mode', () => {
  it('system label calls out the next step is Light', () => {
    renderToggle();
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/system.*switch to light/i),
    );
  });

  it('light label calls out the next step is Dark', () => {
    renderToggle({ themeOverride: 'light' });
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/light.*switch to dark/i),
    );
  });

  it('dark label calls out the next step is System', () => {
    renderToggle({ themeOverride: 'dark' });
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/dark.*switch to system/i),
    );
  });
});
