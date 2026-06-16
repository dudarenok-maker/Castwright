// Pairs with docs/features/archive/95-analysing-multi-model-ui.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
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

function mountStore(
  initial: Partial<{
    analyzerPhase0Model: string | null;
    analyzerPhase1Model: string | null;
    localAnalyzerModels: Array<{ name: string }>;
  }>,
  ui?: Partial<{ selectedModel: string; selectedModelExplicit: boolean }>,
) {
  return configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        ...initial,
      } as ReturnType<typeof accountSlice.getInitialState>,
      ui: {
        ...uiSlice.getInitialState(),
        ...ui,
      } as ReturnType<typeof uiSlice.getInitialState>,
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
          <PhaseModelSwap phaseId={1} isActive={true} />
        </Provider>,
      );
      const el = screen.getByTestId('phase-model-swap-1') as HTMLSelectElement;
      expect(el.disabled).toBe(true);
      expect(el.textContent).toContain('Qwen3.5 4B');
      expect(el.getAttribute('title')).toContain('Per-run override');
    });

    it('does not persist a per-phase change while the override shadows it', async () => {
      const store = mountStore(
        { analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { selectedModel: 'qwen3.5:4b', selectedModelExplicit: true },
      );
      render(
        <Provider store={store}>
          <PhaseModelSwap phaseId={1} isActive={true} />
        </Provider>,
      );
      const el = screen.getByTestId('phase-model-swap-1') as HTMLSelectElement;
      /* Disabled selects don't fire onChange, but assert the guard anyway. */
      fireEvent.change(el, { target: { value: 'gemma-4-31b-it' } });
      await act(async () => {});
      expect(putUserSettingsMock).not.toHaveBeenCalled();
    });

    it('stays an editable picker when the pick is not explicit (seeded default)', () => {
      const store = mountStore(
        { analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { selectedModel: 'qwen3.5:4b', selectedModelExplicit: false },
      );
      render(
        <Provider store={store}>
          <PhaseModelSwap phaseId={1} isActive={false} />
        </Provider>,
      );
      const el = screen.getByTestId('phase-model-swap-1') as HTMLSelectElement;
      expect(el.disabled).toBe(false);
    });
  });

  it('renders a pulled-but-uncurated live tag as an option in the Local optgroup (dynamic union, not the static const)', () => {
    /* Seed a live tag the curated catalog does NOT carry. The picker must
       build its groups from buildModelOptionGroups(buildLocalModelOptions(...))
       off the slice — proving the dynamic union, not the static const. */
    const uncurated = 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL';
    const store = mountStore({
      analyzerPhase0Model: null,
      localAnalyzerModels: [{ name: uncurated }],
    });
    render(
      <Provider store={store}>
        <PhaseModelSwap phaseId={0} isActive={false} />
      </Provider>,
    );
    const option = screen.getByRole('option', { name: uncurated });
    expect(option).toBeInTheDocument();
    expect((option as HTMLOptionElement).value).toBe(uncurated);
    /* It lives inside the Local Ollama optgroup, not Gemini. */
    const optgroup = option.closest('optgroup');
    expect(optgroup?.getAttribute('label')).toMatch(/local/i);
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
