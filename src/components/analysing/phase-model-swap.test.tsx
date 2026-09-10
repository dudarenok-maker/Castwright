// Pairs with docs/features/archive/95-analysing-multi-model-ui.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import { PhaseModelSwap } from './phase-model-swap';

const putUserSettingsMock = vi.fn();
const getOllamaHealthMock = vi.fn();

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
      getOllamaHealth: () => getOllamaHealthMock(),
    },
  };
});

beforeEach(() => {
  putUserSettingsMock.mockReset();
  getOllamaHealthMock.mockReset();
  getOllamaHealthMock.mockResolvedValue({ status: 'reachable', url: '', models: [], pullable: [] });
});

function mountStore(
  account: Partial<{
    analyzerPhase0Model: string | null;
    analyzerPhase1Model: string | null;
    localAnalyzerModels: Array<{ name: string }>;
  }>,
  ui?: Partial<{
    selectedModel: string;
    selectedModelExplicit: boolean;
    analyzerPhasePicks: Record<string, { phase0?: string; phase1?: string }>;
  }>,
) {
  return configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        ...account,
      } as ReturnType<typeof accountSlice.getInitialState>,
      ui: {
        ...uiSlice.getInitialState(),
        ...ui,
      } as ReturnType<typeof uiSlice.getInitialState>,
    },
  });
}

describe('PhaseModelSwap', () => {
  it('dispatches a per-run phase-0 pick and never touches saved settings', async () => {
    const store = mountStore({ analyzerPhase0Model: null });
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={0} isRunLive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'gemini-3.1-flash-lite' } });
    await waitFor(() => {
      expect(store.getState().ui.analyzerPhasePicks.m1?.phase0).toBe('gemini-3.1-flash-lite');
    });
    expect(putUserSettingsMock).not.toHaveBeenCalled();
  });

  it('dispatches a per-run phase-1 pick', async () => {
    const store = mountStore({ analyzerPhase1Model: null });
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={1} isRunLive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-1') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'gemma-4-31b-it' } });
    await waitFor(() => {
      expect(store.getState().ui.analyzerPhasePicks.m1?.phase1).toBe('gemma-4-31b-it');
    });
    expect(putUserSettingsMock).not.toHaveBeenCalled();
  });

  it('mapping the "(use saved default)" sentinel clears the pick', async () => {
    const store = mountStore(
      { analyzerPhase0Model: 'gemma-4-31b-it' },
      { analyzerPhasePicks: { m1: { phase0: 'gemini-3.1-flash-lite' } } },
    );
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={0} isRunLive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => {
      expect(store.getState().ui.analyzerPhasePicks.m1).toBeUndefined();
    });
  });

  it('shows the per-run pick in preference to the saved account default', () => {
    const store = mountStore(
      { analyzerPhase0Model: 'gemma-4-31b-it' },
      { analyzerPhasePicks: { m1: { phase0: 'gemini-3.1-flash-lite' } } },
    );
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={0} isRunLive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    expect(select.value).toBe('gemini-3.1-flash-lite');
  });

  it('is disabled (read-only) while a run is live for this manuscript', () => {
    const store = mountStore({ analyzerPhase0Model: null });
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={0} isRunLive={true} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it('does not dispatch a pick while disabled by a live run (control cannot fire onChange, but assert the guard anyway)', async () => {
    const store = mountStore({ analyzerPhase0Model: null });
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={0} isRunLive={true} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'gemini-3.1-flash-lite' } });
    await act(async () => {});
    expect(store.getState().ui.analyzerPhasePicks.m1).toBeUndefined();
  });

  it('is disabled when there is no manuscript id to key the pick on', () => {
    const store = mountStore({ analyzerPhase0Model: null });
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId={null} phaseId={0} isRunLive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  describe('per-run override active — the per-phase swap is shadowed', () => {
    /* When the user picks a per-run override (e.g. qwen3.5:4b on the
       analysis-failed card) the server collapses both phases to it, so the
       saved per-phase model is moot for this run. The dropdown must show the
       override and be disabled (the saved setting stays editable only after
       Reset to default) so it can't contradict the phase chip. */
    it('renders the override model, disabled, when an explicit per-run pick is active', () => {
      const store = mountStore(
        { analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { selectedModel: 'qwen3.5:4b', selectedModelExplicit: true },
      );
      render(
        <Provider store={store}>
          <PhaseModelSwap manuscriptId="m1" phaseId={1} isRunLive={true} />
        </Provider>,
      );
      const el = screen.getByTestId('phase-model-swap-1') as HTMLSelectElement;
      expect(el.disabled).toBe(true);
      expect(el.textContent).toContain('Qwen3.5 4B');
      expect(el.getAttribute('title')).toContain('Per-run override');
    });

    it('stays an editable picker when the override pick is not explicit (seeded default)', () => {
      const store = mountStore(
        { analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { selectedModel: 'qwen3.5:4b', selectedModelExplicit: false },
      );
      render(
        <Provider store={store}>
          <PhaseModelSwap manuscriptId="m1" phaseId={1} isRunLive={false} />
        </Provider>,
      );
      const el = screen.getByTestId('phase-model-swap-1') as HTMLSelectElement;
      expect(el.disabled).toBe(false);
    });
  });

  it('fetches live analyzer models when the picker is focused (lazy refresh on open)', async () => {
    /* A healthy run never auto-probes Ollama (cloud-no-probe invariant), so the
       slice can be stale. Opening the dropdown is an explicit user interaction —
       it MUST refresh the live tag list so a just-pulled model is selectable. */
    const store = mountStore({ analyzerPhase0Model: null, localAnalyzerModels: [] });
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={0} isRunLive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    expect(getOllamaHealthMock).not.toHaveBeenCalled();
    fireEvent.focus(select);
    await waitFor(() => {
      expect(getOllamaHealthMock).toHaveBeenCalled();
    });
  });

  it('renders a pulled-but-uncurated live tag as an option in the Local optgroup (dynamic union, not the static const)', () => {
    /* Seed a live tag the curated catalog does NOT carry. The picker must
       build its groups from buildModelOptionGroups(buildLocalModelOptions(...))
       off the slice — proving the dynamic union, not the static const. */
    const uncurated = 'gemma4-e4b-8gb:latest';
    const store = mountStore({
      analyzerPhase0Model: null,
      localAnalyzerModels: [{ name: uncurated }],
    });
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={0} isRunLive={false} />
      </Provider>,
    );
    const option = screen.getByRole('option', { name: uncurated });
    expect(option).toBeInTheDocument();
    expect((option as HTMLOptionElement).value).toBe(uncurated);
    /* It lives inside the Local Ollama optgroup, not Gemini. */
    const optgroup = option.closest('optgroup');
    expect(optgroup?.getAttribute('label')).toMatch(/local/i);
  });

  it('no-ops when the chosen value matches the currently-shown value', async () => {
    const store = mountStore({ analyzerPhase0Model: 'gemma-4-31b-it' });
    render(
      <Provider store={store}>
        <PhaseModelSwap manuscriptId="m1" phaseId={0} isRunLive={false} />
      </Provider>,
    );
    const select = screen.getByTestId('phase-model-swap-0') as HTMLSelectElement;
    /* Re-pick the same value — must NOT dispatch a pick. The change event still
       fires (React fires onChange on each interaction); the component
       guards inside. */
    fireEvent.change(select, { target: { value: 'gemma-4-31b-it' } });
    await act(async () => {});
    expect(store.getState().ui.analyzerPhasePicks.m1).toBeUndefined();
  });
});
