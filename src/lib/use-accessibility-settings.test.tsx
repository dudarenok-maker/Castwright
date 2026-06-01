/* fe-2 — useAccessibilitySettings writes data-contrast + root font-size. */

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import type { ReactNode } from 'react';
import { settingsSlice, type SettingsState } from '../store/settings-slice';
import { useAccessibilitySettings } from './use-accessibility-settings';

function makeStore(settings: Partial<SettingsState>) {
  const base = settingsSlice.reducer(undefined, { type: '@@INIT' });
  return configureStore({
    reducer: { settings: settingsSlice.reducer },
    preloadedState: { settings: { ...base, ...settings } },
  });
}

function wrapperFor(store: ReturnType<typeof makeStore>) {
  function Wrapper({ children }: { children: ReactNode }) {
    return <Provider store={store}>{children}</Provider>;
  }
  return Wrapper;
}

afterEach(() => {
  delete document.documentElement.dataset.contrast;
  document.documentElement.style.fontSize = '';
});

describe('useAccessibilitySettings', () => {
  it('sets data-contrast="high" when high-contrast is on, and clears it when off', () => {
    const store = makeStore({ highContrast: true });
    renderHook(() => useAccessibilitySettings(), { wrapper: wrapperFor(store) });
    expect(document.documentElement.dataset.contrast).toBe('high');
  });

  it('leaves data-contrast unset when high-contrast is off', () => {
    const store = makeStore({ highContrast: false });
    renderHook(() => useAccessibilitySettings(), { wrapper: wrapperFor(store) });
    expect(document.documentElement.dataset.contrast).toBeUndefined();
  });

  it('scales the root font-size for larger text and leaves it default at normal', () => {
    const big = makeStore({ textScale: 'larger' });
    renderHook(() => useAccessibilitySettings(), { wrapper: wrapperFor(big) });
    expect(document.documentElement.style.fontSize).toBe('125%');

    const normal = makeStore({ textScale: 'normal' });
    renderHook(() => useAccessibilitySettings(), { wrapper: wrapperFor(normal) });
    expect(document.documentElement.style.fontSize).toBe('');
  });
});
