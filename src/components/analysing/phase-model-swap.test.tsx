// Pairs with docs/features/archive/95-analysing-multi-model-ui.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import { PhaseModelSwap } from './phase-model-swap';

const putUserSettingsMock = vi.fn();

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      putUserSettings: (patch: unknown) => {
        putUserSettingsMock(patch);
        /* Return the patch as the new settings — mirrors the mock-api
           behaviour without depending on the in-memory mock store. */
        return Promise.resolve({
          ...accountSlice.getInitialState(),
          ...(patch as Record<string, unknown>),
        });
      },
    },
  };
});

beforeEach(() => {
  putUserSettingsMock.mockReset();
});

function mountStore(initial: Partial<{
  analyzerPhase0Model: string | null;
  analyzerPhase1Model: string | null;
}>) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        ...initial,
      } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}

describe('PhaseModelSwap', () => {
  it('dispatches saveAccountSettings with the phase-0 patch when the user picks a model', async () => {
    const store = mountStore({ analyzerPhase0Model: null });
    render(
      <Provider store={store}>
        <PhaseModelSwap phaseId={0} isActive={true} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'gemini-3.1-flash-lite' } });
    await waitFor(() => {
      expect(putUserSettingsMock).toHaveBeenCalledWith({ analyzerPhase0Model: 'gemini-3.1-flash-lite' });
    });
    /* Toast appears after the dispatch. The active-run wording mentions
       the current chapter finishes on the previous model. */
    const toast = await screen.findByTestId('phase-model-swap-0-toast');
    expect(toast.textContent).toContain('Applies from the next chapter');
  });

  it('dispatches saveAccountSettings with the phase-1 patch and the inactive-run toast wording', async () => {
    const store = mountStore({ analyzerPhase1Model: null });
    render(
      <Provider store={store}>
        <PhaseModelSwap phaseId={1} isActive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-1') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'gemma-4-31b-it' } });
    await waitFor(() => {
      expect(putUserSettingsMock).toHaveBeenCalledWith({ analyzerPhase1Model: 'gemma-4-31b-it' });
    });
    const toast = await screen.findByTestId('phase-model-swap-1-toast');
    expect(toast.textContent).toBe('Applies from next chapter');
  });

  it('mapping the "(use server default)" sentinel persists null', async () => {
    const store = mountStore({ analyzerPhase0Model: 'gemma-4-31b-it' });
    render(
      <Provider store={store}>
        <PhaseModelSwap phaseId={0} isActive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => {
      expect(putUserSettingsMock).toHaveBeenCalledWith({ analyzerPhase0Model: null });
    });
  });

  it('no-ops when the chosen value matches the current persisted value', async () => {
    const store = mountStore({ analyzerPhase0Model: 'gemma-4-31b-it' });
    render(
      <Provider store={store}>
        <PhaseModelSwap phaseId={0} isActive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    /* Re-pick the same value — must NOT fire a save. The change event still
       fires (React fires onChange on each interaction); the component
       guards inside. */
    fireEvent.change(select, { target: { value: 'gemma-4-31b-it' } });
    /* Settle any microtasks; without this the assertion might race a
       not-yet-fired save dispatch. */
    await act(async () => {});
    expect(putUserSettingsMock).not.toHaveBeenCalled();
  });
});
