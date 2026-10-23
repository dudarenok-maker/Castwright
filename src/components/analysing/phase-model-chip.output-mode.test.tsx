import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen } from '@testing-library/react';
import { accountSlice, fetchAnalyzerCatalog } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import { PhaseModelChip } from './phase-model-chip';
import type { AnalyzerCatalog } from '../../lib/types';

const CATALOG: AnalyzerCatalog = {
  groups: [
    {
      kind: 'endpoint', id: 'lab', label: 'Lab server', status: 'ok',
      models: [{ id: 'openai:lab::qwen3-30b', label: 'qwen3-30b', engine: 'openai', model: 'qwen3-30b', structuredOutput: { mode: 'schema', dropped: [], label: 'schema (not enforced)' }, testPlan: { configured: 2, all: 3, attempts: 3 } }],
    },
  ],
};

function renderChip(withCatalog: boolean) {
  const store = configureStore({ reducer: { account: accountSlice.reducer, ui: uiSlice.reducer } });
  if (withCatalog) store.dispatch(fetchAnalyzerCatalog.fulfilled(CATALOG, '', undefined));
  render(
    <Provider store={store}>
      <PhaseModelChip phaseId={0} state="streaming" serverModel="openai:lab::qwen3-30b" />
    </Provider>,
  );
}

describe('PhaseModelChip structured-output suffix (#3084)', () => {
  it('shows the endpoint label and the recorded mode', () => {
    renderChip(true);
    expect(screen.getByTestId('phase-model-chip-0')).toHaveTextContent('Lab server · qwen3-30b · schema (not enforced)');
  });
  it('without a catalog shows only the model label', () => {
    renderChip(false);
    const chip = screen.getByTestId('phase-model-chip-0');
    expect(chip).toHaveTextContent('lab · qwen3-30b');
    expect(chip).not.toHaveTextContent('schema');
  });
});
