/* useLocalAnalyzerGuard — verifies the three branches:
     - Gemini engine: proceed bypasses the modal entirely.
     - Local engine + no active stream: proceed bypasses the modal.
     - Local engine + active stream: modal opens; Confirm pauses generation
       then calls proceed; Cancel does neither.
   Pairs with docs/features/NN-sticky-generation.md. */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { chaptersSlice, type ActiveStreamSnapshot } from '../store/chapters-slice';
import { librarySlice } from '../store/library-slice';
import { useLocalAnalyzerGuard } from './use-local-analyzer-guard';

function makeStore(opts: { selectedModel: string; activeStream: ActiveStreamSnapshot | null }) {
  const store = configureStore({
    reducer: {
      ui:       uiSlice.reducer,
      chapters: chaptersSlice.reducer,
      library:  librarySlice.reducer,
    },
  });
  store.dispatch(uiSlice.actions.setSelectedModel(opts.selectedModel));
  if (opts.activeStream) {
    store.dispatch(chaptersSlice.actions.setActiveStream(opts.activeStream));
  }
  return store;
}

const liveSnapshot: ActiveStreamSnapshot = {
  bookId: 'Marlow_book',
  modelKey: 'coqui-xtts-v2',
  done: 2,
  total: 5,
  inProgress: 1,
  lastTickAt: Date.now(),
  halted: false,
};

function Harness({ onProceed }: { onProceed: () => void }) {
  const { guard, modal } = useLocalAnalyzerGuard();
  return (
    <>
      <button onClick={() => guard(onProceed)}>Trigger</button>
      {modal}
    </>
  );
}

describe('useLocalAnalyzerGuard', () => {
  it('passes through immediately when the user has a Gemini engine selected', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed}/></Provider>);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Pause audio generation to analyse?')).not.toBeInTheDocument();
    expect(store.getState().chapters.paused).toBe(false);
  });

  it('passes through immediately when a local engine is selected but no generation is active', () => {
    const store = makeStore({ selectedModel: 'qwen3.5:4b', activeStream: null });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed}/></Provider>);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Pause audio generation to analyse?')).not.toBeInTheDocument();
  });

  it('opens the confirm modal when local engine is selected AND a stream is active; Confirm pauses then proceeds', () => {
    const store = makeStore({ selectedModel: 'qwen3.5:4b', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed}/></Provider>);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    /* Modal renders, proceed not yet called. */
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
    expect(proceed).not.toHaveBeenCalled();
    expect(store.getState().chapters.paused).toBe(false);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause and analyse' }));
    });

    /* Pause dispatched (middleware would close the SSE handle on next
       reconcile) and the import proceed fired. */
    expect(store.getState().chapters.paused).toBe(true);
    expect(proceed).toHaveBeenCalledTimes(1);
    /* Modal is gone. */
    expect(screen.queryByText('Pause audio generation to analyse?')).not.toBeInTheDocument();
  });

  it('opens the modal and Cancel closes it without dispatching setPaused or running proceed', () => {
    const store = makeStore({ selectedModel: 'qwen3.5:9b', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed}/></Provider>);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));

    expect(proceed).not.toHaveBeenCalled();
    expect(store.getState().chapters.paused).toBe(false);
    expect(screen.queryByText('Pause audio generation to analyse?')).not.toBeInTheDocument();
  });

  it('falls back to the bookId in the body when the library has no matching entry', () => {
    const store = makeStore({ selectedModel: 'llama3.1:8b', activeStream: liveSnapshot });
    render(<Provider store={store}><Harness onProceed={vi.fn()}/></Provider>);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    /* The bookId 'Marlow_book' is rendered as the fallback identifier
       inside the dialog body. */
    expect(screen.getByText(/Marlow_book/)).toBeInTheDocument();
  });
});
