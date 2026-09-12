// #3141 step 5 — a small, focused sibling of analysing.test.tsx's own
// "request-model gating" describe block, kept in its own file per the issue's
// instruction: analysing.test.tsx's full suite is too slow to run inside a
// 30s foreground command budget even filtered with -t.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { analysisSlice } from '../store/analysis-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { AnalysingView } from './analysing';
import { api } from '../lib/api';
import type { AnalyseOpts, AnalyseResponse } from '../lib/api';

let capturedOpts: AnalyseOpts | undefined;

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      /* Never-resolving so the view stays mounted mid-stream, same pattern as
         analysing.test.tsx's own mock. */
      analyseManuscript: (_id: string, opts?: AnalyseOpts) => {
        capturedOpts = opts;
        return new Promise<AnalyseResponse>(() => {});
      },
      getOllamaHealth: vi.fn(),
    },
  };
});

beforeEach(() => {
  capturedOpts = undefined;
});

function makeStore(opts: {
  phase0Pick?: string;
  phase1Pick?: string;
  splitActive?: boolean;
  explicit?: boolean;
}) {
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      analysis: analysisSlice.reducer,
      account: accountSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        selectedModel: 'gemini-2.5-flash',
        selectedModelExplicit: opts.explicit ?? false,
        analyzerPhasePicks:
          opts.phase0Pick || opts.phase1Pick
            ? { m1: { phase0: opts.phase0Pick, phase1: opts.phase1Pick } }
            : {},
      } as ReturnType<typeof uiSlice.getInitialState>,
      account: {
        ...accountSlice.getInitialState(),
        defaultAnalysisModel: 'gemini-2.5-flash',
        analyzerPhase0Model: opts.splitActive ? 'gemma-4-31b-it' : null,
        analyzerPhase1Model: opts.splitActive ? 'gemini-3.1-flash-lite' : null,
      } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}

async function renderAndStart(store: ReturnType<typeof makeStore>) {
  render(
    <Provider store={store}>
      <AnalysingView
        manuscriptId="m1"
        title="the Coalfall Commission"
        model="gemini-2.5-flash"
        onComplete={() => {}}
      />
    </Provider>,
  );
  const startBtn = await screen.findByRole('button', { name: /start analysis/i });
  await act(async () => {
    fireEvent.click(startBtn);
  });
  await waitFor(() => expect(capturedOpts).toBeDefined());
}

describe('AnalysingView — per-run phase-model picks reach the start request (#3141 step 5)', () => {
  it('sends phase0Model/phase1Model from the picks, and omits model (split-mode gating)', async () => {
    const store = makeStore({ phase0Pick: 'gemma-4-31b-it', phase1Pick: 'gemini-3.1-flash-lite' });
    await renderAndStart(store);
    expect(capturedOpts?.phase0Model).toBe('gemma-4-31b-it');
    expect(capturedOpts?.phase1Model).toBe('gemini-3.1-flash-lite');
    expect(capturedOpts?.model).toBeUndefined();
  });

  it('clears the manuscript\'s picks once the request has been sent', async () => {
    const store = makeStore({ phase0Pick: 'gemma-4-31b-it' });
    await renderAndStart(store);
    expect(store.getState().ui.analyzerPhasePicks.m1).toBeUndefined();
  });

  it('sends no phase model fields when no pick is set', async () => {
    const store = makeStore({});
    await renderAndStart(store);
    expect(capturedOpts?.phase0Model).toBeUndefined();
    expect(capturedOpts?.phase1Model).toBeUndefined();
    expect(capturedOpts?.model).toBe('gemini-2.5-flash');
  });

  it('does not send a phase pick when an explicit per-run override is active (the override collapses the split server-side)', async () => {
    const store = makeStore({ phase0Pick: 'gemma-4-31b-it', explicit: true });
    await renderAndStart(store);
    expect(capturedOpts?.phase0Model).toBeUndefined();
    expect(capturedOpts?.model).toBe('gemini-2.5-flash');
  });

  it('a pick counts as split mode even with no saved per-phase settings: omits `model`', async () => {
    const store = makeStore({ phase1Pick: 'gemini-3.1-flash-lite', splitActive: false });
    await renderAndStart(store);
    expect(capturedOpts?.model).toBeUndefined();
    expect(capturedOpts?.phase1Model).toBe('gemini-3.1-flash-lite');
  });

  it('when only one phase is picked, the un-picked phase gets the account defaultAnalysisModel (#3192 C2)', async () => {
    // Strengthened per N9: selectedModel, defaultAnalysisModel, and model prop are now DIFFERENT
    // so a regression that substitutes the wrong one of the three is actually caught.
    // Account has a distinct defaultAnalysisModel, but user picks only Phase 1.
    // The un-picked Phase 0 should explicitly receive the account default, not selectedModel or the model prop.
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          selectedModel: 'gemini-2.5-flash-ui',
          selectedModelExplicit: false,
          analyzerPhasePicks: {
            m1: { phase0: undefined, phase1: 'gemini-3.1-flash-lite' },
          },
        } as ReturnType<typeof uiSlice.getInitialState>,
        account: {
          ...accountSlice.getInitialState(),
          defaultAnalysisModel: 'gemini-2.5-flash-account',
          // No per-phase split configured
          analyzerPhase0Model: null,
          analyzerPhase1Model: null,
        } as ReturnType<typeof accountSlice.getInitialState>,
      },
    });
    await renderAndStart(store);
    // Phase 1 is explicitly picked
    expect(capturedOpts?.phase1Model).toBe('gemini-3.1-flash-lite');
    // Phase 0 (un-picked) should get the account's defaultAnalysisModel, not selectedModel or the model prop
    expect(capturedOpts?.phase0Model).toBe('gemini-2.5-flash-account');
    // The single-model field should not be sent in split mode
    expect(capturedOpts?.model).toBeUndefined();
  });

  it('C3 (N9 strengthened): a saved per-phase override on the un-picked phase must survive a pick on the other phase (#3192 C3)', async () => {
    // Strengthened per N9: make the three values (selectedModel, account.defaultAnalysisModel, model prop)
    // distinct so the test can distinguish which one was actually sent.
    // Repro: saved split with Phase 0 override = gemma-4-31b-it, Phase 1 override = gemini-3.1-flash-lite.
    // User picks ONLY Phase 1 for this run (same as the saved value, just to isolate the logic).
    // Phase 0's saved override must be sent, not discarded in favor of the account default.
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          selectedModel: 'gemini-2.5-flash-ui',
          selectedModelExplicit: false,
          analyzerPhasePicks: {
            m1: { phase0: undefined, phase1: 'gemini-3.1-flash-lite' },
          },
        } as ReturnType<typeof uiSlice.getInitialState>,
        account: {
          ...accountSlice.getInitialState(),
          defaultAnalysisModel: 'gemini-2.5-flash-account',
          // Saved split: Phase 0 = Gemma (cast detection), Phase 1 = Gemini (attribution)
          analyzerPhase0Model: 'gemma-4-31b-it',
          analyzerPhase1Model: 'gemini-3.1-flash-lite',
        } as ReturnType<typeof accountSlice.getInitialState>,
      },
    });
    await renderAndStart(store);
    // Phase 1 is picked (overriding the saved value, but with the same value in this test)
    expect(capturedOpts?.phase1Model).toBe('gemini-3.1-flash-lite');
    // Phase 0 (un-picked) MUST use its saved override (gemma), NOT the account default
    expect(capturedOpts?.phase0Model).toBe('gemma-4-31b-it');
    expect(capturedOpts?.model).toBeUndefined();
  });

  it('C4: effectiveModelIds must mirror the actual request so the readiness gate catches local models (#3192 C4)', async () => {
    // Repro at shipped defaults: defaultAnalysisModel = qwen3.5:4b (local Ollama).
    // No saved split. User picks Phase 1 to a cloud model for this run only.
    // effectiveModelIds must include qwen3.5:4b for Phase 0 so the isLocalAnalyzer gate
    // sees it and gates on Ollama health, not fires immediately against a cold Ollama.
    // Mock Ollama as reachable with qwen3.5:4b resident so the button is clickable.
    vi.mocked(api.getOllamaHealth).mockResolvedValue({
      status: 'reachable',
      url: 'http://localhost:11434',
      resident: ['qwen3.5:4b'],
      models: ['qwen3.5:4b'],
    });
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        analysis: analysisSlice.reducer,
        account: accountSlice.reducer,
        bookMeta: bookMetaSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          selectedModel: 'qwen3.5:4b',
          selectedModelExplicit: false,
          analyzerPhasePicks: {
            // Only Phase 1 is picked
            m1: { phase0: undefined, phase1: 'gemini-3.1-flash-lite' },
          },
        } as ReturnType<typeof uiSlice.getInitialState>,
        account: {
          ...accountSlice.getInitialState(),
          // Shipped default: local Ollama model
          defaultAnalysisModel: 'qwen3.5:4b',
          // No saved split
          analyzerPhase0Model: null,
          analyzerPhase1Model: null,
        } as ReturnType<typeof accountSlice.getInitialState>,
      },
    });
    await renderAndStart(store);
    expect(capturedOpts?.phase0Model).toBe('qwen3.5:4b');
    expect(capturedOpts?.phase1Model).toBe('gemini-3.1-flash-lite');
    expect(capturedOpts?.model).toBeUndefined();
  });

  it('N10: picks survive when selectedModelExplicit is true (the explicit override collapses the split)', async () => {
    // N7's gate: picks should be cleared only when they were actually sent.
    // When selectedModelExplicit is true, picks are NOT sent (collapsed server-side),
    // so they should NOT be cleared either.
    const store = makeStore({ phase0Pick: 'gemma-4-31b-it', explicit: true });
    await renderAndStart(store);
    // Picks should NOT be cleared
    expect(store.getState().ui.analyzerPhasePicks.m1).toEqual({ phase0: 'gemma-4-31b-it', phase1: undefined });
  });
});
