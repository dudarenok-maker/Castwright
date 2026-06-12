/* useReverseLocalAnalyzerGuard — verifies the four branches:
     - No active analysis: proceed bypasses the modal.
     - Active remote (gemini) analysis: proceed bypasses the modal.
     - Active local analysis: modal opens; Confirm dispatches
       analysisActions.setPaused({ manuscriptId }) then calls proceed;
       Cancel does neither.
     - Title fallback chain: body uses the snapshot's bookTitle when set,
       else the library entry, else the bookId.

   Pairs with docs/features/archive/32-sticky-analysis.md (D2). */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { analysisSlice, type AnalysisStreamSnapshot } from '../store/analysis-slice';
import { librarySlice } from '../store/library-slice';
import { useReverseLocalAnalyzerGuard } from './use-reverse-local-analyzer-guard';
import type { LibraryBook } from '../lib/types';

function makeStore(opts: { activeStream: AnalysisStreamSnapshot | null; books?: LibraryBook[] }) {
  const store = configureStore({
    reducer: {
      analysis: analysisSlice.reducer,
      library: librarySlice.reducer,
    },
  });
  if (opts.activeStream) {
    store.dispatch(analysisSlice.actions.setActiveStream(opts.activeStream));
  }
  for (const book of opts.books ?? []) {
    store.dispatch(librarySlice.actions.addBook(book));
  }
  return store;
}

const liveLocalSnapshot: AnalysisStreamSnapshot = {
  bookId: 'b_marlow',
  manuscriptId: 'm_marlow',
  bookTitle: 'the Coalfall Commission',
  engine: 'local',
  phaseId: 0,
  phaseLabel: 'Detecting characters',
  phaseProgress: 0.25,
  remainingMs: 12000,
  lastTickAt: Date.now(),
  state: 'running',
};

const liveGeminiSnapshot: AnalysisStreamSnapshot = {
  ...liveLocalSnapshot,
  engine: 'gemini',
};

function Harness({ onProceed }: { onProceed: () => void }) {
  const { guard, modal } = useReverseLocalAnalyzerGuard();
  return (
    <>
      <button onClick={() => guard(onProceed)}>Trigger</button>
      {modal}
    </>
  );
}

describe('useReverseLocalAnalyzerGuard', () => {
  it('passes through immediately when no analysis is active', () => {
    const store = makeStore({ activeStream: null });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Pause analysis to generate?')).not.toBeInTheDocument();
    expect(store.getState().analysis.activeStream).toBeNull();
  });

  it('passes through immediately when the active analysis is on a remote (Gemini) engine', () => {
    const store = makeStore({ activeStream: liveGeminiSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Pause analysis to generate?')).not.toBeInTheDocument();
    /* Remote analysis must NOT be paused by the guard. */
    expect(store.getState().analysis.activeStream?.state).toBe('running');
  });

  it('opens the confirm modal when a LOCAL analysis is active; Confirm pauses then proceeds', () => {
    const store = makeStore({ activeStream: liveLocalSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();
    expect(proceed).not.toHaveBeenCalled();
    expect(store.getState().analysis.activeStream?.state).toBe('running');

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause and generate' }));
    });

    /* setPaused dispatched (middleware would fire pauseAnalysis +
       close the SSE handle) AND proceed fired. */
    expect(store.getState().analysis.activeStream?.state).toBe('paused');
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Pause analysis to generate?')).not.toBeInTheDocument();
  });

  it('opens the modal and Cancel closes it without dispatching setPaused or running proceed', () => {
    const store = makeStore({ activeStream: liveLocalSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));

    expect(proceed).not.toHaveBeenCalled();
    expect(store.getState().analysis.activeStream?.state).toBe('running');
    expect(screen.queryByText('Pause analysis to generate?')).not.toBeInTheDocument();
  });

  it('falls back to the library book title when the snapshot has no bookTitle field', () => {
    const snapshotWithoutTitle: AnalysisStreamSnapshot = {
      ...liveLocalSnapshot,
      bookTitle: undefined,
    };
    const store = makeStore({
      activeStream: snapshotWithoutTitle,
      books: [
        {
          bookId: 'b_marlow',
          manuscriptId: 'm_marlow',
          title: 'Library Title for Marlow',
          author: 'Della Renwick',
          series: 'The Hollow Tide',
          chapters: [],
          cast: [],
          status: 'analysing',
          coverGradient: ['#fff', '#000'],
          castConfirmed: false,
          isStandalone: false,
          seriesPosition: null,
        },
      ] as unknown as LibraryBook[],
    });
    render(
      <Provider store={store}>
        <Harness onProceed={vi.fn()} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText(/Library Title for Marlow/)).toBeInTheDocument();
  });

  it('falls back to the bookId in the body when the library has no matching entry and the snapshot has no title', () => {
    const snapshotWithoutTitle: AnalysisStreamSnapshot = {
      ...liveLocalSnapshot,
      bookTitle: undefined,
    };
    const store = makeStore({ activeStream: snapshotWithoutTitle });
    render(
      <Provider store={store}>
        <Harness onProceed={vi.fn()} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText(/b_marlow/)).toBeInTheDocument();
  });
});
