/* StepDefaults spec — fs-21 wave 2.
   Verifies that the component renders 4 selects (engine, TTS model, analysis
   model, theme) pre-filled from the account slice, and that changing the theme
   select dispatches saveAccountSettings with the new defaultThemePreference. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import type { SetupReadiness } from '../../lib/api';

// ── mock the API so saveAccountSettings thunk stays in-memory ─────────────

const putUserSettingsMock = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      putUserSettings: (patch: unknown) => {
        putUserSettingsMock(patch);
        return Promise.resolve({
          ...accountSlice.getInitialState(),
          ...(patch as Record<string, unknown>),
        });
      },
    },
  };
});

import { StepDefaults } from './step-defaults';

// ── helpers ────────────────────────────────────────────────────────────────

function makeReadiness(overrides: Partial<SetupReadiness> = {}): SetupReadiness {
  return {
    ready: true,
    completedAt: null,
    blockers: { sidecar: 'pass', ffmpeg: 'pass', tts: 'pass', analyzer: 'pass' },
    info: { gpu: 'cuda · 1.2 / 8.0 GB' },
    ...overrides,
  };
}

function makeStore(
  preloaded: Partial<ReturnType<typeof accountSlice.getInitialState>> = {},
) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        ...preloaded,
      } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}

function renderStep(overrides: Partial<ReturnType<typeof accountSlice.getInitialState>> = {}) {
  const store = makeStore(overrides);
  render(
    <Provider store={store}>
      <StepDefaults readiness={makeReadiness()} />
    </Provider>,
  );
  return { store };
}

// ── tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  putUserSettingsMock.mockReset();
});

describe('StepDefaults', () => {
  it('renders a "Defaults" heading', () => {
    renderStep();
    expect(screen.getByRole('heading', { name: /defaults/i })).toBeInTheDocument();
  });

  it('renders 4 select controls (engine, TTS model, analysis model, theme)', () => {
    renderStep();
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(4);
  });

  it('pre-selects the engine from the account slice defaultTtsEngine', () => {
    renderStep({ defaultTtsEngine: 'gemini' });
    const select = screen.getByLabelText(/voice engine/i) as HTMLSelectElement;
    expect(select.value).toBe('gemini');
  });

  it('pre-selects the analysis model from the account slice', () => {
    renderStep({ defaultAnalysisModel: 'gemma-4-31b-it' });
    const select = screen.getByLabelText(/analysis model/i) as HTMLSelectElement;
    expect(select.value).toBe('gemma-4-31b-it');
  });

  it('pre-selects the theme from the account slice defaultThemePreference', () => {
    renderStep({ defaultThemePreference: 'dark' });
    const select = screen.getByLabelText(/theme/i) as HTMLSelectElement;
    expect(select.value).toBe('dark');
  });

  it('dispatches saveAccountSettings with defaultThemePreference when theme changes', async () => {
    renderStep({ defaultThemePreference: 'system' });
    const select = screen.getByLabelText(/theme/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'light' } });
    await waitFor(() => {
      expect(putUserSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({ defaultThemePreference: 'light' }),
      );
    });
  });

  it('dispatches saveAccountSettings with defaultTtsEngine when engine changes', async () => {
    renderStep({ defaultTtsEngine: 'local' });
    const select = screen.getByLabelText(/voice engine/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'gemini' } });
    await waitFor(() => {
      expect(putUserSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({ defaultTtsEngine: 'gemini' }),
      );
    });
  });

  it('dispatches saveAccountSettings with defaultTtsModelKeyExplicit:true when TTS model changes', async () => {
    renderStep({ defaultTtsModelKey: 'kokoro-v1', defaultTtsEngine: 'local' });
    const select = screen.getByLabelText(/voice model/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'qwen3-tts-0.6b' } });
    await waitFor(() => {
      expect(putUserSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultTtsModelKey: 'qwen3-tts-0.6b',
          defaultTtsModelKeyExplicit: true,
        }),
      );
    });
  });
});
