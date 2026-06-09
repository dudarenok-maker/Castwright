// Pairs with docs/features/archive/04-analysing-view-progress.md

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import { castSlice } from '../../store/cast-slice';
import type { AnalysisPhase } from '../../lib/types';
import { PhaseCard } from './phase-card';

function mountStore() {
  return configureStore({
    reducer: { account: accountSlice.reducer, cast: castSlice.reducer },
  });
}

function renderPhase(phase: AnalysisPhase) {
  const store = mountStore();
  return render(
    <Provider store={store}>
      <PhaseCard
        phase={phase}
        activePhaseId={phase.id}
        phaseProgress={0.5}
        phaseLogs={[]}
        live={null}
        isLocalAnalyzer={false}
        analysisStarted={true}
        conn="streaming"
        bookId={null}
        droppedQuotesRefreshKey={0}
      />
    </Provider>,
  );
}

describe('PhaseCard layout', () => {
  /* The detail copy must span the full card width rather than the narrow
     column beneath the label. The model chip + swap dropdown share the
     label's flex row (`justify-between`); if the detail stays in that row it
     wraps into a cramped two- or three-line block — the bug this locks. */
  it('renders the detail outside the label/model-controls row so it spans full width', () => {
    const phase: AnalysisPhase = {
      id: 0,
      label: 'Detecting characters',
      detail: 'Named-entity extraction, dialogue attribution, speaker resolution.',
      duration: 1000,
    };
    renderPhase(phase);

    const label = screen.getByText(phase.label);
    const detail = screen.getByText(phase.detail);
    // The chip anchors the flex row that pairs the label with the model controls.
    const chip = screen.getByTestId('phase-model-chip-0');
    const controlsRow = chip.closest('[class*="justify-between"]');
    expect(controlsRow).not.toBeNull();

    // Label shares the row with the controls; detail does not.
    expect(controlsRow!.contains(label)).toBe(true);
    expect(controlsRow!.contains(detail)).toBe(false);
  });
});
