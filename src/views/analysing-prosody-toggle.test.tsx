// Task 12 — fs-65 Phase 3: analysis-form "Expressive directions" toggle (on by default)
// Pairs with: docs/superpowers/plans/2026-06-25-phase3-prosody-and-scriptreview-chunking.md § Task 12

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { analysisSlice } from '../store/analysis-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice, bookMetaActions } from '../store/book-meta-slice';
import { AnalysingView } from './analysing';
import type { BookStateResponse } from '../lib/types';

/* ── api mock ────────────────────────────────────────────────────────────── */

const putBookStateSpy = vi.fn();
const getOllamaHealthSpy = vi.fn();
const getSidecarHealthSpy = vi.fn();

let getBookStateImpl: ((bookId: string) => Promise<BookStateResponse | null>) | undefined;

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      analyseManuscript: () => new Promise(() => {}),
      runAnalysisForChapters: () => new Promise(() => {}),
      getBookState: (bookId: string) =>
        getBookStateImpl ? getBookStateImpl(bookId) : Promise.resolve(null),
      getDroppedQuotes: () => Promise.resolve({ manuscriptId: 'm1', batches: [] }),
      getOllamaHealth: () => getOllamaHealthSpy(),
      getSidecarHealth: () => getSidecarHealthSpy(),
      loadAnalyzer: () => Promise.resolve({ status: 'ready' as const }),
      unloadAnalyzer: () => Promise.resolve({ status: 'unloaded' as const }),
      loadSidecar: () => Promise.resolve({ status: 'ready' as const }),
      unloadSidecar: () => Promise.resolve({ status: 'idle' as const }),
      putBookState: (...args: unknown[]) => putBookStateSpy(...args),
    },
  };
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

function makeStore(prosodyEnabled?: boolean) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      analysis: analysisSlice.reducer,
      account: accountSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
    },
  });
  if (prosodyEnabled !== undefined) {
    store.dispatch(
      bookMetaActions.setProsodyEnabled({ bookId: 'book-1', value: prosodyEnabled }),
    );
  }
  return store;
}

function renderView(opts: { bookId?: string | null; prosodyEnabled?: boolean } = {}) {
  const { bookId = 'book-1', prosodyEnabled } = opts;
  const store = makeStore(prosodyEnabled);
  const result = render(
    <Provider store={store}>
      <AnalysingView
        manuscriptId="m1"
        bookId={bookId}
        title="The Coalfall Commission"
        wordCount={2440}
        onComplete={() => {}}
      />
    </Provider>,
  );
  return { store, ...result };
}

beforeEach(() => {
  putBookStateSpy.mockReset().mockResolvedValue(undefined);
  getBookStateImpl = undefined;
  getSidecarHealthSpy
    .mockReset()
    .mockResolvedValue({ status: 'reachable', url: '(test)', modelLoaded: false });
  getOllamaHealthSpy.mockReset().mockResolvedValue({
    status: 'reachable',
    url: '(test)',
    models: ['qwen3.5:4b'],
    expectedModel: 'qwen3.5:4b',
    modelPulled: true,
    resident: ['qwen3.5:4b'],
    modelResident: true,
  });
});

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('Expressive directions toggle — analysing form (Task 12 / fs-65)', () => {
  it('renders CHECKED by default when no stored value (eager default)', async () => {
    renderView(); // no prosodyEnabled override → store has undefined
    const toggle = await screen.findByRole('checkbox', { name: /expressive directions/i });
    expect(toggle).toBeChecked();
  });

  it('renders CHECKED when stored value is true', async () => {
    renderView({ prosodyEnabled: true });
    const toggle = await screen.findByRole('checkbox', { name: /expressive directions/i });
    expect(toggle).toBeChecked();
  });

  it('renders UNCHECKED when stored value is false', async () => {
    renderView({ prosodyEnabled: false });
    const toggle = await screen.findByRole('checkbox', { name: /expressive directions/i });
    expect(toggle).not.toBeChecked();
  });

  it('unchecking dispatches setProsodyEnabled({value:false}) and issues PUT with false', async () => {
    const { store } = renderView(); // starts checked (undefined → eager)
    const toggle = await screen.findByRole('checkbox', { name: /expressive directions/i });

    fireEvent.click(toggle);

    // Redux store updated
    const state = store.getState().bookMeta.prosodyEnabled['book-1'];
    expect(state).toBe(false);

    // Durable PUT issued with prosodyEnabled: false
    await waitFor(() => {
      expect(putBookStateSpy).toHaveBeenCalledWith('book-1', {
        slice: 'state',
        patch: { prosodyEnabled: false },
      });
    });
  });

  it('re-checking dispatches setProsodyEnabled({value:true}) and issues PUT with true', async () => {
    renderView({ prosodyEnabled: false }); // start unchecked
    const toggle = await screen.findByRole('checkbox', { name: /expressive directions/i });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();

    await waitFor(() => {
      expect(putBookStateSpy).toHaveBeenCalledWith('book-1', {
        slice: 'state',
        patch: { prosodyEnabled: true },
      });
    });
  });

  it('hides the toggle when bookId is null', async () => {
    renderView({ bookId: null });
    // Toggle should not be rendered at all
    await waitFor(() => {
      expect(
        screen.queryByRole('checkbox', { name: /expressive directions/i }),
      ).not.toBeInTheDocument();
    });
  });

  it('renders helper text about background annotation', async () => {
    renderView();
    await screen.findByRole('checkbox', { name: /expressive directions/i });
    expect(screen.getByText(/runs in the background after analysis/i)).toBeInTheDocument();
  });
});
