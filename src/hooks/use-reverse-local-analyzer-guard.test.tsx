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
import { accountSlice } from '../store/account-slice';
import { configSlice } from '../store/config-slice';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { useReverseLocalAnalyzerGuard } from './use-reverse-local-analyzer-guard';
import type { LibraryBook } from '../lib/types';

function makeStore(opts: { activeStream: AnalysisStreamSnapshot | null; books?: LibraryBook[] }) {
  const store = configureStore({
    reducer: {
      analysis: analysisSlice.reducer,
      library: librarySlice.reducer,
      account: accountSlice.reducer,
      config: configSlice.reducer,
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
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

  const endpointSnapshot = (gpu?: string): AnalysisStreamSnapshot => ({ ...liveLocalSnapshot, engine: 'openai', ...(gpu ? { gpu } : {}) });

  it('#3084 — an endpoint run on gpu none never prompts', () => {
    const store = makeStore({ activeStream: endpointSnapshot('none') });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('#3084 — an endpoint run on a GPU prompts (TTS card unknown → fail closed)', () => {
    const store = makeStore({ activeStream: endpointSnapshot('cuda:1') });
    render(<Provider store={store}><Harness onProceed={vi.fn()} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();
  });

  it('#3084 — a cold-boot endpoint snapshot without gpu prompts', () => {
    const store = makeStore({ activeStream: endpointSnapshot() });
    render(<Provider store={store}><Harness onProceed={vi.fn()} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();
  });

  it('#3084 wave 3d review pass 4 (J) — a run that started on an off-card endpoint and switched to Ollama prompts without a reload', () => {
    const store = makeStore({ activeStream: endpointSnapshot('none') });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} /></Provider>);
    /* Before the switch: gpu none never prompts. */
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
    /* The server's next phase event names the run engine after the switch to Ollama. */
    act(() => {
      store.dispatch(analysisSlice.actions.applyAnalysisSnapshotTick({ manuscriptId: 'm_marlow', engine: 'local' }));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  /* #3710 F4 — generation uses the SESSION picker (ui.ttsModelKey), not the account default. */
  const seedDevices = (store: ReturnType<typeof makeStore>) => {
    const knob = (key: string, effective: string) => ({ key, effective, source: 'override', locked: false, overridden: true });
    store.dispatch({
      type: 'config/fetch/fulfilled',
      payload: {
        groups: [],
        descriptors: [],
        values: { 'tts.kokoro.device': knob('tts.kokoro.device', 'cpu'), 'tts.qwen.device': knob('tts.qwen.device', 'cuda:0') },
        cudaEnvShadow: false,
        envCleanupCandidates: [],
      },
    });
  };

  it('#3710 F4 — account default kokoro on cpu, session picker on Qwen cuda:0, endpoint on cuda:0 → prompts', () => {
    const store = makeStore({ activeStream: endpointSnapshot('cuda:0') });
    seedDevices(store);
    store.dispatch({ type: 'account/fetch/fulfilled', payload: { defaultTtsModelKey: 'kokoro-v1', resolvedTtsModelKey: 'kokoro-v1' } });
    store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-0.6b'));
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('#3710 F4 — session picker on cpu Kokoro with a Qwen account default does not prompt for a cuda:0 endpoint', () => {
    const store = makeStore({ activeStream: endpointSnapshot('cuda:0') });
    seedDevices(store);
    store.dispatch({ type: 'account/fetch/fulfilled', payload: { defaultTtsModelKey: 'qwen3-tts-0.6b', resolvedTtsModelKey: 'qwen3-tts-0.6b' } });
    store.dispatch(uiSlice.actions.setTtsModelKey('kokoro-v1'));
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('#3710 F4 — a character pinned to Qwen while the session model is cpu Kokoro fails closed (prompts)', () => {
    const store = makeStore({ activeStream: endpointSnapshot('cuda:0') });
    seedDevices(store);
    store.dispatch(uiSlice.actions.setTtsModelKey('kokoro-v1'));
    store.dispatch(castSlice.actions.setCharacters([{ id: 'c1', name: 'Ann', ttsEngine: 'qwen' }] as never));
    render(<Provider store={store}><Harness onProceed={vi.fn()} /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause analysis to generate?')).toBeInTheDocument();
  });
});
