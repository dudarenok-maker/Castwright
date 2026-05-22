// Pairs with docs/features/archive/95-analysing-multi-model-ui.md

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice, PHASE0_MODEL_DEFAULT, PHASE1_MODEL_DEFAULT } from '../../store/account-slice';
import { PhaseModelChip } from './phase-model-chip';

function mountStore(overrides: Partial<{
  analyzerPhase0Model: string | null;
  analyzerPhase1Model: string | null;
  analyzerPhase1MinLagChapters: number | null;
}>) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        ...overrides,
      } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}

function renderChip(opts: Parameters<typeof mountStore>[0], chipProps: React.ComponentProps<typeof PhaseModelChip>) {
  return render(
    <Provider store={mountStore(opts)}>
      <PhaseModelChip {...chipProps} />
    </Provider>,
  );
}

describe('PhaseModelChip', () => {
  it('renders the phase-0 user-settings model label when set', () => {
    renderChip({ analyzerPhase0Model: 'gemma-4-31b-it' }, { phaseId: 0, state: 'streaming' });
    const chip = screen.getByTestId('phase-model-chip-0');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('Gemma 4 31B');
    expect(chip.textContent).toContain('streaming');
    expect(chip.getAttribute('data-phase-state')).toBe('streaming');
  });

  it('falls back to the documented Phase 0 default when user-settings is null', () => {
    renderChip({ analyzerPhase0Model: null }, { phaseId: 0, state: 'pending' });
    /* The default label is the MODEL_OPTIONS label for PHASE0_MODEL_DEFAULT
       (gemma-4-31b-it → "Gemma 4 31B"). */
    expect(PHASE0_MODEL_DEFAULT).toBe('gemma-4-31b-it');
    expect(screen.getByTestId('phase-model-chip-0').textContent).toContain('Gemma 4 31B');
  });

  it('renders the phase-1 default (Gemini 3.1 Flash Lite) when nothing is set', () => {
    renderChip({ analyzerPhase1Model: null }, { phaseId: 1, state: 'warming' });
    expect(PHASE1_MODEL_DEFAULT).toBe('gemini-3.1-flash-lite');
    const chip = screen.getByTestId('phase-model-chip-1');
    expect(chip.textContent).toContain('Gemini 3.1 Flash Lite');
    /* warming state surfaces the "warms up after chapter N" hint. Default
       lag is 10. */
    expect(chip.textContent).toContain('warms up after ch. 10');
    expect(chip.getAttribute('title')).toContain('Warms up after chapter 10');
  });

  it('honours a custom phase-1 min-lag in the warming hint', () => {
    renderChip(
      { analyzerPhase1Model: 'gemini-3.1-flash-lite', analyzerPhase1MinLagChapters: 15 },
      { phaseId: 1, state: 'warming' },
    );
    expect(screen.getByTestId('phase-model-chip-1').textContent).toContain('warms up after ch. 15');
  });

  it('renders nothing for phase 2 (no model selection)', () => {
    const { container } = renderChip({}, { phaseId: 2, state: 'pending' });
    /* The chip returns null for phase 2 — render output should be empty. */
    expect(container.querySelector('[data-testid^="phase-model-chip"]')).toBeNull();
  });
});
