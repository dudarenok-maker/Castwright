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
import { accountSlice } from '../store/account-slice';
import { configSlice, fetchConfig } from '../store/config-slice';
import type { TtsReportedDevices } from '../lib/analyzer-endpoints';

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

function makeStore(opts: {
  selectedModel: string;
  activeStream: ActiveStreamSnapshot | null;
  /** N8 — further live generations, each able to sit on its own card. */
  extraStreams?: ActiveStreamSnapshot[];
  endpoints?: unknown[];
  ttsDevice?: string;
  /** N5 — what the sidecar's last /health reported. */
  reported?: TtsReportedDevices;
}) {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer, chapters: chaptersSlice.reducer, library: librarySlice.reducer, account: accountSlice.reducer, config: configSlice.reducer },
  });
  store.dispatch(uiSlice.actions.setSelectedModel(opts.selectedModel));
  if (opts.activeStream) store.dispatch(chaptersSlice.actions.setActiveStream(opts.activeStream));
  for (const extra of opts.extraStreams ?? []) store.dispatch(chaptersSlice.actions.setActiveStream(extra));
  if (opts.endpoints) store.dispatch({ type: 'account/fetch/fulfilled', payload: { analyzerEndpoints: opts.endpoints } });
  if (opts.ttsDevice) {
    store.dispatch(
      fetchConfig.fulfilled(
        { groups: [], descriptors: [], values: { 'tts.coqui.device': { key: 'tts.coqui.device', effective: opts.ttsDevice, source: 'override', locked: false, overridden: true } }, restartPending: false, cudaEnvShadow: false, envCleanupCandidates: [] },
        '',
        undefined,
      ),
    );
  }
  if (opts.reported) store.dispatch(configSlice.actions.ttsDevicesReported(opts.reported));
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

function Harness({ onProceed, modelId }: { onProceed: () => void; modelId?: string }) {
  const { guard, modal } = useLocalAnalyzerGuard({ modelId });
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

  it('modelId overrides ui.selectedModel: a local model under test prompts even when a Gemini model is selected', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} modelId="qwen3.5:4b" />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('modelId overrides ui.selectedModel: a Gemini model under test passes through with a local model selected', () => {
    const store = makeStore({ selectedModel: 'qwen3.5:4b', activeStream: liveSnapshot });
    const proceed = vi.fn();
    render(
      <Provider store={store}>
        <Harness onProceed={proceed} modelId="gemini-3.6-flash" />
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  const lab = (gpu: string) => [{ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu, concurrency: 1, requestCeilingMs: 1_800_000, structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 8192 }];

  it('prompts for an endpoint on the TTS card', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot, endpoints: lab('cuda:0'), ttsDevice: 'cuda:0' });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
  });

  it('passes through for an endpoint on another card', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot, endpoints: lab('cuda:1'), ttsDevice: 'cuda:0' });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('passes through for an endpoint with gpu none', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot, endpoints: lab('none') });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('fails closed for an endpoint id missing from settings', () => {
    const store = makeStore({ selectedModel: 'gemini-2.5-flash', activeStream: liveSnapshot, endpoints: [], ttsDevice: 'cuda:0' });
    render(<Provider store={store}><Harness onProceed={vi.fn()} modelId="openai:gone::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
  });

  it('#3084 N5 — an auto TTS engine uses the card the sidecar reported: an endpoint on the other card passes through', () => {
    /* No tts.qwen.device override at all; the sidecar says the resident Qwen is on cuda:1. */
    const store = makeStore({
      selectedModel: 'gemini-2.5-flash',
      activeStream: { ...liveSnapshot, modelKey: 'qwen3-tts-0.6b' },
      endpoints: lab('cuda:0'),
      reported: { qwenDeviceKey: 'cuda:1', families: { qwen: 'cuda' } },
    });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it('#3084 N5 — a TTS engine the sidecar runs on CPU shares no card, so even an any endpoint passes through', () => {
    const store = makeStore({
      selectedModel: 'gemini-2.5-flash',
      activeStream: { ...liveSnapshot, modelKey: 'kokoro-v1' },
      endpoints: lab('any'),
      reported: { qwenDeviceKey: null, families: { kokoro: 'cpu' } },
    });
    const proceed = vi.fn();
    render(<Provider store={store}><Harness onProceed={proceed} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("#3084 N8 — compares every live generation, not only the first: a second book on the endpoint's card prompts", () => {
    /* Stream 1: Kokoro, reported on CPU. Stream 2: Coqui, pinned to cuda:0 — the card this
       endpoint shares. Reading only the first stream would let the analysis start. */
    const store = makeStore({
      selectedModel: 'gemini-2.5-flash',
      activeStream: { ...liveSnapshot, streamKey: 'b1::1', bookId: 'b1', modelKey: 'kokoro-v1' },
      extraStreams: [{ ...liveSnapshot, streamKey: 'b2::1', bookId: 'b2', modelKey: 'coqui-xtts-v2' }],
      endpoints: lab('cuda:0'),
      ttsDevice: 'cuda:0', // tts.coqui.device
      reported: { qwenDeviceKey: null, families: { kokoro: 'cpu' } },
    });
    render(<Provider store={store}><Harness onProceed={vi.fn()} modelId="openai:lab::m" /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
  });
});
