import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../store/account-slice';
import { uiSlice } from '../store/ui-slice';
import { AnalyzerModelOverrideBadge } from './analyzer-model-override-badge';

function mountStore(selectedModel: string, selectedModelExplicit: boolean, defaultAnalysisModel: string) {
  return configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        defaultAnalysisModel,
      } as ReturnType<typeof accountSlice.getInitialState>,
      ui: {
        ...uiSlice.getInitialState(),
        selectedModel,
        selectedModelExplicit,
      } as ReturnType<typeof uiSlice.getInitialState>,
    },
  });
}

describe('AnalyzerModelOverrideBadge', () => {
  it('renders nothing when no explicit override is active', () => {
    render(
      <Provider store={mountStore('gemini-3.1-flash-lite', false, 'gemini-3.1-flash-lite')}>
        <AnalyzerModelOverrideBadge />
      </Provider>,
    );
    expect(screen.queryByTestId('analyzer-model-override-badge')).toBeNull();
  });

  it('renders nothing when the explicit pick equals the saved default', () => {
    render(
      <Provider store={mountStore('gemini-3.1-flash-lite', true, 'gemini-3.1-flash-lite')}>
        <AnalyzerModelOverrideBadge />
      </Provider>,
    );
    expect(screen.queryByTestId('analyzer-model-override-badge')).toBeNull();
  });

  it('surfaces the override with both model labels when it differs from the saved default', () => {
    render(
      <Provider store={mountStore('qwen3.5:4b', true, 'gemini-3.1-flash-lite')}>
        <AnalyzerModelOverrideBadge />
      </Provider>,
    );
    const badge = screen.getByTestId('analyzer-model-override-badge');
    expect(badge).toHaveTextContent('Qwen3.5 4B (local)'); // the override in use
    expect(badge).toHaveTextContent('Gemini 3.1 Flash Lite'); // the saved default
  });

  it('Reset to default clears the override (explicit → false, value → saved default)', async () => {
    const store = mountStore('qwen3.5:4b', true, 'gemini-3.1-flash-lite');
    render(
      <Provider store={store}>
        <AnalyzerModelOverrideBadge />
      </Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(store.getState().ui.selectedModel).toBe('gemini-3.1-flash-lite');
    expect(store.getState().ui.selectedModelExplicit).toBe(false);
    // And the badge disappears once the override is cleared.
    expect(screen.queryByTestId('analyzer-model-override-badge')).toBeNull();
  });
});
