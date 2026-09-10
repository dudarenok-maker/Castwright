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
});
