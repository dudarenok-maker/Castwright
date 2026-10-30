import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { combineReducers, configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import type { Stage } from '../../lib/types';
import { AnalyzerRequestControls } from './analyzer-request-controls';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: { getAnalyzerModels: vi.fn(), putUserSettings: vi.fn() },
}));
const mockModels = vi.mocked(api.getAnalyzerModels);
const mockPut = vi.mocked(api.putUserSettings);

const CATALOG = {
  groups: [
    {
      kind: 'ollama',
      id: 'ollama',
      label: 'Local Ollama',
      status: 'ok',
      models: [
        { id: 'q:4b', label: 'Qwen 4B', offeredReasoningLevels: ['model-default', 'off', 'on', 'low'] },
        { id: 'q:9b', label: 'Qwen 9B', offeredReasoningLevels: ['model-default', 'off', 'on'] },
      ],
    },
    {
      kind: 'gemini',
      id: 'gemini',
      label: 'Gemini API',
      status: 'ok',
      models: [
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', offeredReasoningLevels: ['model-default', 'low', 'medium', 'high'] },
        { id: 'gemma-4-31b-it', label: 'Gemma 4 31B', offeredReasoningLevels: ['model-default', 'off', 'on'] },
        { id: 'gemini-9-ultra', label: 'Gemini 9 Ultra', offeredReasoningLevels: ['model-default'] },
      ],
    },
  ],
};

/* `stage` defaults to a plain 'advanced' stage (no reasoningFocus) so every existing 5.6 case renders
   exactly as before; Task 5.6b's cases pass a stage carrying `reasoningFocus` through the same
   helper, so both share one store-construction path (review pass 2, item 4 — do not add a second
   `makeStore`-shaped helper elsewhere in this file). */
function renderControls(account: Record<string, unknown> = {}, stage: Stage = { kind: 'advanced' }) {
  const store = configureStore({
    reducer: combineReducers({ account: accountSlice.reducer, ui: uiSlice.reducer }),
    preloadedState: {
      account: { ...accountSlice.reducer(undefined, { type: '@@INIT' }), hydrated: true, ...account },
      ui: { ...uiSlice.reducer(undefined, { type: '@@INIT' }), stage },
    } as never,
  });
  render(<Provider store={store}><AnalyzerRequestControls /></Provider>);
  return store;
}
const optionValues = (testId: string) =>
  within(screen.getByTestId(testId)).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);

beforeEach(() => {
  mockModels.mockReset().mockResolvedValue(CATALOG as never);
  mockPut.mockReset();
});

describe('AnalyzerRequestControls — reasoning', () => {
  it('offers each model only its own levels, the current analysis model first (P18)', async () => {
    renderControls({ defaultAnalysisModel: 'q:9b' });
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash')).toBeInTheDocument());
    expect(screen.getAllByTestId(/^analyzer-reasoning-ollama-/).map((el) => el.getAttribute('data-model-id'))).toEqual(['q:9b', 'q:4b']);
    expect(optionValues('analyzer-reasoning-ollama-q:4b')).toEqual(['model-default', 'off', 'on', 'low']);
    expect(optionValues('analyzer-reasoning-ollama-q:9b')).toEqual(['model-default', 'off', 'on']); // low was accepted for q:4b only
    expect(optionValues('analyzer-reasoning-gemini-gemini-3.8-flash')).toEqual(['model-default', 'low', 'medium', 'high']);
    expect(optionValues('analyzer-reasoning-gemini-gemma-4-31b-it')).toEqual(['model-default', 'off', 'on']);
    expect(screen.queryByTestId('analyzer-reasoning-gemini-gemini-9-ultra')).toBeNull();
    expect((screen.getByTestId('analyzer-reasoning-ollama-q:9b') as HTMLSelectElement).value).toBe('off');
    expect(screen.getByText(/A server may accept a level and still ignore it/)).toBeInTheDocument();
  });

  it('saves non-default Ollama and Gemini levels per model only', async () => {
    mockPut.mockResolvedValue({} as never);
    renderControls({ analyzerReasoningByEngine: { ollama: { 'q:9b': 'on' } } });
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:4b'), { target: { value: 'low' } });
    fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:9b'), { target: { value: 'off' } });
    fireEvent.change(screen.getByTestId('analyzer-reasoning-gemini-gemini-3.8-flash'), { target: { value: 'low' } });
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    /* Per model (P18). `off` is the Ollama default, so q:9b, set back to off, is not saved. */
    expect(mockPut.mock.calls[0][0]).toEqual({
      analyzerReasoningByEngine: { ollama: { 'q:4b': 'low' }, gemini: { 'gemini-3.8-flash': 'low' } },
      analyzerExtraParamsByEngine: {},
    });
  });

  it('keeps a saved Gemini level the model no longer offers selected, and Model default clears it on save', async () => {
    mockPut.mockResolvedValue({} as never);
    renderControls({ analyzerReasoningByEngine: { gemini: { 'gemini-3.8-flash': 'minimal' } } });
    const select = (await screen.findByTestId('analyzer-reasoning-gemini-gemini-3.8-flash')) as HTMLSelectElement;
    expect(optionValues('analyzer-reasoning-gemini-gemini-3.8-flash')).toEqual(['model-default', 'low', 'medium', 'high', 'minimal']);
    expect(select.value).toBe('minimal');
    fireEvent.change(select, { target: { value: 'model-default' } });
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0][0]).toEqual({ analyzerReasoningByEngine: { ollama: {}, gemini: {} }, analyzerExtraParamsByEngine: {} });
  });

  it('renders a Gemini row for a saved key even when the model offers one level or is not in the catalog', async () => {
    renderControls({ analyzerReasoningByEngine: { gemini: { 'gemini-9-ultra': 'high', 'gemini-gone': 'low' } } });
    const ultra = (await screen.findByTestId('analyzer-reasoning-gemini-gemini-9-ultra')) as HTMLSelectElement;
    expect(ultra.value).toBe('high');
    expect(optionValues('analyzer-reasoning-gemini-gemini-9-ultra')).toEqual(['model-default', 'high']);
    expect((screen.getByTestId('analyzer-reasoning-gemini-gemini-gone') as HTMLSelectElement).value).toBe('low');
  });

  it('shows the server validation messages when the save is refused', async () => {
    mockPut.mockRejectedValue(
      new Error('User settings save failed (400): {"error":"Invalid user settings.","issues":[{"message":"Gemini reasoning \\"minimal\\" is not available for gemini-3.8-flash (offered: model-default, low, medium, high)."}]}'),
    );
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-ollama-q:4b')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    expect(await screen.findByTestId('analyzer-request-controls-errors')).toHaveTextContent(
      'Gemini reasoning "minimal" is not available for gemini-3.8-flash (offered: model-default, low, medium, high).',
    );
  });

  it('blocks the save while the settings file is unreadable (#3625)', async () => {
    renderControls({ settingsFileUnreadable: true });
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-ollama-q:4b')).toBeInTheDocument());
    expect(screen.getByTestId('analyzer-request-controls-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    expect(mockPut).not.toHaveBeenCalled();
    expect(screen.getByTestId('analyzer-request-controls-unreadable')).toBeInTheDocument();
  });

  it('blocks the save before account settings have hydrated, so default rows cannot wipe saved levels', async () => {
    renderControls({ hydrated: false });
    await waitFor(() => expect(screen.getByTestId('analyzer-reasoning-ollama-q:4b')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:4b'), { target: { value: 'low' } });
    expect(screen.getByTestId('analyzer-request-controls-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    expect(mockPut).not.toHaveBeenCalled();
    expect(screen.getByTestId('analyzer-request-controls-unreadable')).toHaveTextContent(/haven.t loaded yet/);
  });
});

describe('AnalyzerRequestControls — custom payload', () => {
  it('saves both engine payloads with the reasoning levels in one patch', async () => {
    mockPut.mockResolvedValue({} as never);
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-extra-params-ollama')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-extra-params-ollama'), { target: { value: '{"options":{"min_p":0.05}}' } });
    fireEvent.change(screen.getByTestId('analyzer-extra-params-gemini'), { target: { value: '{"config":{"topK":40}}' } });
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0][0]).toEqual({
      analyzerReasoningByEngine: { ollama: {}, gemini: {} },
      analyzerExtraParamsByEngine: { ollama: { options: { min_p: 0.05 } }, gemini: { config: { topK: 40 } } },
    });
  });
  it('blocks the save on invalid JSON and says why', async () => {
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-extra-params-ollama')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-extra-params-ollama'), { target: { value: '{oops' } });
    expect(screen.getByTestId('analyzer-extra-params-ollama-error')).toHaveTextContent('Not valid JSON.');
    fireEvent.click(screen.getByTestId('analyzer-request-controls-save'));
    expect(mockPut).not.toHaveBeenCalled();
  });
  it('notes when the payload takes over the output cap', async () => {
    renderControls();
    await waitFor(() => expect(screen.getByTestId('analyzer-extra-params-gemini')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('analyzer-extra-params-gemini'), { target: { value: '{"config":{"maxOutputTokens":2048}}' } });
    expect(screen.getByTestId('analyzer-extra-params-gemini-cap-note')).toHaveTextContent('Gemini max output tokens is not used for Gemini');
    fireEvent.change(screen.getByTestId('analyzer-extra-params-ollama'), { target: { value: '{"options":{"num_predict":512}}' } });
    expect(screen.getByTestId('analyzer-extra-params-ollama-cap-note')).toHaveTextContent('Ollama num_predict is not used for Ollama');
    /* P29 — both payload editors say a payload is not a place for credentials. */
    expect(screen.getAllByText(/Not a place for credentials/)).toHaveLength(2);
  });
  it('renders both payload editors with the touch target, the Gemini one with no Gemini model listed (5b-D7)', async () => {
    /* The file's CATALOG lists three Gemini models; this case must render with none, or it cannot fail. */
    mockModels.mockResolvedValue({ groups: [CATALOG.groups[0]] } as never);
    renderControls();
    await screen.findByTestId('analyzer-reasoning-ollama-q:4b'); // the catalog has loaded
    expect(screen.queryAllByTestId(/^analyzer-reasoning-gemini-/)).toHaveLength(0);
    for (const engine of ['ollama', 'gemini']) {
      expect(screen.getByTestId(`analyzer-extra-params-${engine}`)).toHaveClass('min-h-[44px]', 'fine-pointer:min-h-0');
    }
  });
});

describe('AnalyzerRequestControls — deep-linked reasoning row (5.6b)', () => {
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it('scrolls to and highlights the deep-linked Gemini row once its data arrives', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mockModels.mockResolvedValue({
      groups: [{ kind: 'gemini', id: 'gemini', label: 'Gemini API', status: 'ok', models: [{ id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', offeredReasoningLevels: ['model-default', 'minimal', 'low'] }] }],
    } as never);
    renderControls({}, { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.6-flash' } });
    await screen.findByTestId('analyzer-reasoning-gemini-gemini-3.6-flash');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.getElementById('analyzer-reasoning-gemini-gemini-3.6-flash')?.className).toMatch(/(^| )ring-magenta\/60( |$)/);
  });

  it('matches an Ollama row by its normalised tag, not the raw URL value', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mockModels.mockResolvedValue({
      groups: [{ kind: 'ollama', id: 'ollama', label: 'Local Ollama', status: 'ok', models: [{ id: 'qwen3.5:4b', label: 'qwen3.5:4b', offeredReasoningLevels: ['model-default', 'off', 'on'] }] }],
    } as never);
    renderControls({}, { kind: 'advanced', reasoningFocus: { engine: 'ollama', model: 'qwen3.5:4b:latest' } });
    await screen.findByTestId('analyzer-reasoning-ollama-qwen3.5:4b');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });

  it('does nothing when the deep-linked row is not in the current lists', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mockModels.mockResolvedValue({ groups: [] } as never);
    renderControls({}, { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-9-ultra' } });
    await waitFor(() => expect(mockModels).toHaveBeenCalled());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('does not re-scroll on an unrelated edit while the same deep-link stage persists', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    mockModels.mockResolvedValue(CATALOG as never);
    renderControls({ defaultAnalysisModel: 'q:9b' }, { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.8-flash' } });
    await screen.findByTestId('analyzer-reasoning-gemini-gemini-3.8-flash');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:9b'), { target: { value: 'on' } });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('still removes the highlight after an unrelated edit within the highlight window (review pass 3, item 7)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      mockModels.mockResolvedValue(CATALOG as never);
      renderControls({ defaultAnalysisModel: 'q:9b' }, { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.8-flash' } });
      await screen.findByTestId('analyzer-reasoning-gemini-gemini-3.8-flash');
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(document.getElementById('analyzer-reasoning-gemini-gemini-3.8-flash')?.className).toMatch(/(^| )ring-magenta\/60( |$)/);
      // An unrelated edit re-runs the highlight effect (ollamaRows/geminiModels change identity)
      // while the removal timer is still pending.
      act(() => {
        fireEvent.change(screen.getByTestId('analyzer-reasoning-ollama-q:9b'), { target: { value: 'on' } });
      });
      act(() => {
        vi.advanceTimersByTime(2400);
      });
      expect(document.getElementById('analyzer-reasoning-gemini-gemini-3.8-flash')?.className).not.toMatch(/(^| )ring-magenta\/60( |$)/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the first row highlight when a second deep link lands inside the window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      Element.prototype.scrollIntoView = vi.fn();
      mockModels.mockResolvedValue(CATALOG as never);
      const focusA: Stage = { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemini-3.8-flash' } };
      const focusB: Stage = { kind: 'advanced', reasoningFocus: { engine: 'gemini', model: 'gemma-4-31b-it' } };
      // The slice has no action that sets reasoningFocus, so a test-only action swaps the stage.
      const store = configureStore({
        reducer: combineReducers({
          account: accountSlice.reducer,
          ui: (state: ReturnType<typeof uiSlice.reducer> | undefined, action: { type: string; stage?: Stage }) =>
            action.type === 'test/setStage' ? { ...uiSlice.reducer(state, action), stage: action.stage as Stage } : uiSlice.reducer(state, action),
        }),
        preloadedState: {
          account: accountSlice.reducer(undefined, { type: '@@INIT' }),
          ui: { ...uiSlice.reducer(undefined, { type: '@@INIT' }), stage: focusA },
        } as never,
      });
      render(<Provider store={store}><AnalyzerRequestControls /></Provider>);
      await screen.findByTestId('analyzer-reasoning-gemini-gemini-3.8-flash');
      // Look rows up by id: the highlight lands on the id'd element, not the select carrying the test id.
      const rowA = document.getElementById('analyzer-reasoning-gemini-gemini-3.8-flash') as HTMLElement;
      await waitFor(() => expect(rowA.className).toMatch(/(^| )ring-2( |$)/));
      act(() => {
        store.dispatch({ type: 'test/setStage', stage: focusB });
      });
      const rowB = document.getElementById('analyzer-reasoning-gemini-gemma-4-31b-it') as HTMLElement;
      await waitFor(() => expect(rowB.className).toMatch(/(^| )ring-2( |$)/));
      expect(rowA.className).not.toMatch(/(^| )ring-2( |$)/);
    } finally {
      vi.useRealTimers();
    }
  });
});
