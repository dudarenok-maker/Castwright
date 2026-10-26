import { describe, it, expect, vi, beforeEach } from 'vitest';
import { combineReducers, configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
      account: { ...accountSlice.reducer(undefined, { type: '@@INIT' }), ...account },
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
    expect(mockPut.mock.calls[0][0]).toEqual({ analyzerReasoningByEngine: { ollama: { 'q:4b': 'low' }, gemini: { 'gemini-3.8-flash': 'low' } } });
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
});
