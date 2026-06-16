/* Plan 41 — useTheme + resolveTheme resolution precedence.

   Pins the rule: override > account default > system, with the
   transient 'system' value re-resolved through matchMedia. The hook
   also writes <html data-theme="…"> as a side-effect; that's covered
   here via a manual render through a real store. */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { type ReactNode } from 'react';
import { resolveTheme, useTheme } from './use-theme';
import { uiSlice, uiActions, type UiState } from '../store/ui-slice';
import { accountSlice, type AccountState } from '../store/account-slice';
import { DEFAULT_MODEL } from './models';
import { DEFAULT_TTS_MODEL } from './tts-models';
import { FRONTEND_ACCOUNT_DEFAULTS } from './account-defaults';

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

function setSystemTheme(isDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('dark') ? isDark : !isDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('resolveTheme — precedence rule', () => {
  it('override "dark" wins over account default "light" and system "light"', () => {
    expect(resolveTheme('dark', 'light', 'light')).toBe('dark');
  });

  it('override "light" wins over account default "dark" and system "dark"', () => {
    expect(resolveTheme('light', 'dark', 'dark')).toBe('light');
  });

  it('null override falls through to account default "dark"', () => {
    expect(resolveTheme(null, 'dark', 'light')).toBe('dark');
  });

  it('null override + account default "system" resolves through systemTheme=dark', () => {
    expect(resolveTheme(null, 'system', 'dark')).toBe('dark');
  });

  it('null override + account default "system" resolves through systemTheme=light', () => {
    expect(resolveTheme(null, 'system', 'light')).toBe('light');
  });

  it('override "system" re-resolves through system theme even when account default is pinned', () => {
    /* This is the path that lets the top-bar "System" cycle position
       re-enable OS-driven flips on a device whose account default is
       Light or Dark. */
    expect(resolveTheme('system', 'dark', 'dark')).toBe('dark');
    expect(resolveTheme('system', 'light', 'dark')).toBe('dark');
  });
});

describe('useTheme — DOM side-effect + store reactivity', () => {
  beforeEach(() => {
    setSystemTheme(false);
    document.documentElement.removeAttribute('data-theme');
  });

  function wrapWith(store: ReturnType<typeof makeStore>) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return <Provider store={store}>{children}</Provider>;
    };
  }

  it('writes data-theme="light" by default (no override, account=system, OS=light)', () => {
    const store = makeStore();
    renderHook(() => useTheme(), { wrapper: wrapWith(store) });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('writes data-theme="dark" when account default is pinned to dark', () => {
    const store = makeStore({ accountDefault: 'dark' });
    renderHook(() => useTheme(), { wrapper: wrapWith(store) });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('writes data-theme="dark" when the override is set even though account default is light', () => {
    const store = makeStore({ themeOverride: 'dark', accountDefault: 'light' });
    renderHook(() => useTheme(), { wrapper: wrapWith(store) });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('flips data-theme when ui.themeOverride changes mid-session', () => {
    const store = makeStore({ accountDefault: 'light' });
    renderHook(() => useTheme(), { wrapper: wrapWith(store) });
    expect(document.documentElement.dataset.theme).toBe('light');
    /* Wrap each dispatch in act() so React's effect (which writes
       dataset.theme) flushes synchronously before the assertion. */
    act(() => {
      store.dispatch(uiActions.setThemeOverride('dark'));
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
    act(() => {
      store.dispatch(uiActions.clearThemeOverride());
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('resolves system override against the matchMedia result', () => {
    setSystemTheme(true); /* OS prefers dark */
    const store = makeStore({ themeOverride: 'system', accountDefault: 'light' });
    renderHook(() => useTheme(), { wrapper: wrapWith(store) });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
