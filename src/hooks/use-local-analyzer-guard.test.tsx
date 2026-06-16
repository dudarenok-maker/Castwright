/* useLocalAnalyzerGuard — verifies the three branches:
     - Gemini engine: proceed bypasses the modal entirely.
     - Local engine + no active stream: proceed bypasses the modal.
     - Local engine + active stream: modal opens; Confirm pauses generation
       then calls proceed; Cancel does neither.
   Pairs with docs/features/NN-sticky-generation.md. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { chaptersSlice, type ActiveStreamSnapshot } from '../store/chapters-slice';
import { librarySlice } from '../store/library-slice';
import { useLocalAnalyzerGuard } from './use-local-analyzer-guard';
import { haltActiveGeneration } from '../store/queue-thunks';

/* The guard's confirm dispatches haltActiveGeneration (requestStreamHalt +
   setQueuePaused) — its end-to-end behaviour is unit-tested in
   queue-thunks.test.ts. Here we mock it to a plain no-op action so we can
   assert the guard fires it on confirm (and only on confirm) without wiring
   the queue slice + /api/queue/pause fetch into this hook test. */
vi.mock('../store/queue-thunks', () => ({
  haltActiveGeneration: vi.fn(() => ({ type: 'test/haltActiveGeneration' })),
}));

beforeEach(() => {
  vi.mocked(haltActiveGeneration).mockClear();
});

function makeStore(opts: { selectedModel: string; activeStream: ActiveStreamSnapshot | null }) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer,
      library: librarySlice.reducer,
    },
  });
  store.dispatch(uiSlice.actions.setSelectedModel(opts.selectedModel));
  if (opts.activeStream) {
    store.dispatch(chaptersSlice.actions.setActiveStream(opts.activeStream));
  }
  return store;
}

const liveSnapshot: ActiveStreamSnapshot = {
  streamKey: 'marlow_book::1',
  bookId: 'marlow_book',
  chapterId: 1,
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
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Pause audio generation to analyse?')).not.toBeInTheDocument();
    expect(haltActiveGeneration).not.toHaveBeenCalled();
  });

  it('passes through immediately when a local engine is selected but no generation is active', () => {
    const store = makeStore({ selectedModel: 'qwen3.5:4b', activeStream: null });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Pause audio generation to analyse?')).not.toBeInTheDocument();
  });

  it('opens the confirm modal when local engine is selected AND a stream is active; Confirm pauses then proceeds', () => {
    const store = makeStore({ selectedModel: 'qwen3.5:4b', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    /* Modal renders, proceed not yet called. */
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
    expect(proceed).not.toHaveBeenCalled();
    expect(haltActiveGeneration).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause and analyse' }));
    });

    /* Halt dispatched (the middleware closes the SSE handle + the queue is
       paused) and the import proceed fired. */
    expect(haltActiveGeneration).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);
    /* Modal is gone. */
    expect(screen.queryByText('Pause audio generation to analyse?')).not.toBeInTheDocument();
  });

  it('opens the modal and Cancel closes it without halting generation or running proceed', () => {
    const store = makeStore({ selectedModel: 'qwen3.5:9b', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));

    expect(proceed).not.toHaveBeenCalled();
    expect(haltActiveGeneration).not.toHaveBeenCalled();
    expect(screen.queryByText('Pause audio generation to analyse?')).not.toBeInTheDocument();
  });

  it('opens the confirm dialog for an UNCURATED local tag while a stream is active', () => {
    /* A dynamically-pulled Ollama tag (colon-bearing, not in MODEL_OPTIONS).
       The old MODEL_OPTIONS.find(...).engine lookup mis-classified it as
       'gemini' and skipped the guard; engineForModelId keys off the ':'. */
    const store = makeStore({
      selectedModel: 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL',
      activeStream: liveSnapshot,
    });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));

    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('falls back to the bookId in the body when the library has no matching entry', () => {
    const store = makeStore({ selectedModel: 'llama3.1:8b', activeStream: liveSnapshot });
    render(
      <Provider store={store}>
        <Harness onProceed={vi.fn()} />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    /* The bookId 'marlow_book' is rendered as the fallback identifier
       inside the dialog body. */
    expect(screen.getByText(/marlow_book/)).toBeInTheDocument();
  });
});
