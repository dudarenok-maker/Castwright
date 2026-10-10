import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import { chaptersSlice, type ActiveStreamSnapshot } from '../../store/chapters-slice';
import { librarySlice } from '../../store/library-slice';
import { AnalyzerModelLimits } from './analyzer-model-limits';
import { api } from '../../lib/api';
import type { AnalyzerCatalog, AnalyzerCatalogEntry } from '../../lib/types';

vi.mock('../../lib/api', () => ({
  api: { getAnalyzerModels: vi.fn(), putUserSettings: vi.fn(), testAnalyzerModel: vi.fn() },
}));
vi.mock('../../store/queue-thunks', () => ({ haltActiveGeneration: vi.fn(() => ({ type: 'test/halt' })) }));

const entry = (id: string, engine: AnalyzerCatalogEntry['engine'], model = id): AnalyzerCatalogEntry => ({
  id, label: model, engine, model, structuredOutput: { mode: 'schema', dropped: [], label: 'schema' },
  testPlan: { configured: 2, all: 3, attempts: engine === 'local' ? 1 : 3 },
});

const CATALOG: AnalyzerCatalog = {
  groups: [
    { kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [entry('qwen3.5:4b', 'local')] },
    { kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [entry('gemini-3.6-flash', 'gemini')] },
    { kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok', models: [entry('openai:lab::qwen3-30b', 'openai', 'qwen3-30b')] },
  ],
};

const stream: ActiveStreamSnapshot = {
  streamKey: 'b::1', bookId: 'b', chapterId: 1, modelKey: 'kokoro-v1', done: 0, total: 3, inProgress: 1, lastTickAt: Date.now(), halted: false,
};

function renderLimits(opts: { activeStream?: ActiveStreamSnapshot } = {}) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer, chapters: chaptersSlice.reducer, library: librarySlice.reducer },
  });
  if (opts.activeStream) store.dispatch(chaptersSlice.actions.setActiveStream(opts.activeStream));
  render(
    <Provider store={store}>
      <AnalyzerModelLimits />
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getAnalyzerModels).mockResolvedValue(CATALOG);
  vi.mocked(api.putUserSettings).mockImplementation(async (patch) => patch as never);
  vi.mocked(api.testAnalyzerModel).mockResolvedValue({
    serverUrl: 'gemini', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true }, structuredOutput: {}, reasoning: {},
  });
});

describe('AnalyzerModelLimits (#3084)', () => {
  it('lists every catalog model; Ollama rows offer Test but no rate inputs', async () => {
    renderLimits();
    const gemini = await screen.findByTestId('model-limits-row-gemini-3.6-flash');
    expect(within(gemini).getByLabelText('Gemini 3.6 Flash RPM')).toBeInTheDocument();
    expect(screen.getByTestId('model-limits-row-openai:lab::qwen3-30b')).toBeInTheDocument();
    const local = screen.getByTestId('model-limits-row-qwen3.5:4b');
    expect(within(local).queryByLabelText(/RPM/)).toBeNull();
    expect(within(local).getByTestId('model-test-qwen3.5:4b')).toBeInTheDocument();
  });

  it('Save writes the whole map, omitting blank fields and empty models', async () => {
    renderLimits();
    fireEvent.change(await screen.findByLabelText('Gemini 3.6 Flash RPM'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Lab server · qwen3-30b TPM'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Lab server · qwen3-30b TPM'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('model-limits-save'));
    await waitFor(() =>
      expect(api.putUserSettings).toHaveBeenCalledWith({ analyzerRateLimitsByModel: { 'gemini-3.6-flash': { rpm: 3 } } }),
    );
  });

  it('Test shows the request count and the maximum including retries, switches to the all-modes count, and sends the chosen scope', async () => {
    renderLimits();
    fireEvent.click(await screen.findByTestId('model-test-gemini-3.6-flash'));
    expect(screen.getByTestId('model-test-request-count')).toHaveTextContent('2');
    /* N6: the transport retries a 500/502/503/504 up to three times per request. */
    expect(screen.getByTestId('model-test-max-requests')).toHaveTextContent('6');
    expect(screen.getByText(/count against today's Gemini quota/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('model-test-scope-all'));
    // off-mode control + schema + json (the off check reuses the control)
    expect(screen.getByTestId('model-test-request-count')).toHaveTextContent('3');
    expect(screen.getByTestId('model-test-max-requests')).toHaveTextContent('9');
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await waitFor(() => expect(api.testAnalyzerModel).toHaveBeenCalledWith({ modelId: 'gemini-3.6-flash', scope: 'all' }));
  });

  it('an Ollama model states no maximum, because its transport does not retry (N6)', async () => {
    renderLimits();
    fireEvent.click(await screen.findByTestId('model-test-qwen3.5:4b'));
    expect(screen.getByTestId('model-test-request-count')).toHaveTextContent('2');
    expect(screen.queryByTestId('model-test-max-requests')).toBeNull();
  });

  it('testing a local model while TTS is generating opens the GPU guard before any request; Wait sends nothing', async () => {
    renderLimits({ activeStream: stream });
    fireEvent.click(await screen.findByTestId('model-test-qwen3.5:4b'));
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    expect(screen.getByText('Pause audio generation to analyse?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));
    expect(api.testAnalyzerModel).not.toHaveBeenCalled();
  });

  it('testing a Gemini model while TTS is generating never opens the GPU guard', async () => {
    renderLimits({ activeStream: stream });
    fireEvent.click(await screen.findByTestId('model-test-gemini-3.6-flash'));
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    expect(screen.queryByText('Pause audio generation to analyse?')).toBeNull();
    await waitFor(() => expect(api.testAnalyzerModel).toHaveBeenCalledTimes(1));
  });
});
