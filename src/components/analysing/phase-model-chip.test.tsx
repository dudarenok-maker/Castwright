// Pairs with docs/features/archive/118-analyzer-per-phase-wiring-fix.md
// (originally docs/features/archive/95-analysing-multi-model-ui.md)

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import { PhaseModelChip } from './phase-model-chip';

function mountStore(
  account: Partial<{
    analyzerPhase0Model: string | null;
    analyzerPhase1Model: string | null;
    analyzerPhase1MinLagChapters: number | null;
    defaultAnalysisModel: string;
  }>,
  ui?: Partial<{ selectedModel: string; selectedModelExplicit: boolean }>,
) {
  return configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        ...account,
      } as ReturnType<typeof accountSlice.getInitialState>,
      ui: {
        ...uiSlice.getInitialState(),
        ...ui,
      } as ReturnType<typeof uiSlice.getInitialState>,
    },
  });
}

function renderChip(
  account: Parameters<typeof mountStore>[0],
  chipProps: React.ComponentProps<typeof PhaseModelChip>,
  ui?: Parameters<typeof mountStore>[1],
) {
  return render(
    <Provider store={mountStore(account, ui)}>
      <PhaseModelChip {...chipProps} />
    </Provider>,
  );
}

describe('PhaseModelChip', () => {
  describe('split OFF (no per-phase models) — both phases show the single effective model', () => {
    it('shows ui.selectedModel for phase 0, not a fabricated per-phase default', () => {
      /* Regression for plan 118: the chip used to fabricate "Gemma 4 31B"
         for phase 0 even though cast detection ran on the single default. */
      renderChip(
        { analyzerPhase0Model: null, analyzerPhase1Model: null },
        { phaseId: 0, state: 'streaming' },
        { selectedModel: 'gemini-2.5-flash' },
      );
      const chip = screen.getByTestId('phase-model-chip-0');
      expect(chip.textContent).toContain('Gemini 2.5 Flash');
      expect(chip.textContent).not.toContain('Gemma');
      expect(chip.textContent).toContain('streaming');
    });

    it('shows the same single model for phase 1 (not the old Flash-Lite default)', () => {
      renderChip(
        { analyzerPhase0Model: null, analyzerPhase1Model: null },
        { phaseId: 1, state: 'streaming' },
        { selectedModel: 'gemini-2.5-flash' },
      );
      expect(screen.getByTestId('phase-model-chip-1').textContent).toContain('Gemini 2.5 Flash');
    });

    it('falls back to account.defaultAnalysisModel when ui has no selected model', () => {
      renderChip({ analyzerPhase0Model: null }, { phaseId: 0, state: 'pending' }, { selectedModel: '' });
      /* account initial defaultAnalysisModel is gemini-3.1-flash-lite. */
      expect(screen.getByTestId('phase-model-chip-0').textContent).toContain('Gemini 3.1 Flash Lite');
    });

    it('does NOT show the warm-up hint for phase 1 even in the warming state', () => {
      /* With the split off there is no handoff — the chip must not promise one
         (plan 118). PhaseCard also gates this, but the chip self-guards. */
      renderChip(
        { analyzerPhase0Model: null, analyzerPhase1Model: null },
        { phaseId: 1, state: 'warming' },
      );
      const chip = screen.getByTestId('phase-model-chip-1');
      expect(chip.textContent).not.toContain('warms up');
      expect(chip.getAttribute('title')).toBeNull();
    });
  });

  describe('split ON (per-phase models set)', () => {
    it('shows each phase its own saved model', () => {
      renderChip(
        { analyzerPhase0Model: 'gemma-4-31b-it', analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { phaseId: 0, state: 'streaming' },
      );
      expect(screen.getByTestId('phase-model-chip-0').textContent).toContain('Gemma 4 31B');
    });

    it('shows the phase-1 model + warm-up hint while phase 0 is warming', () => {
      renderChip(
        { analyzerPhase0Model: 'gemma-4-31b-it', analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { phaseId: 1, state: 'warming' },
      );
      const chip = screen.getByTestId('phase-model-chip-1');
      expect(chip.textContent).toContain('Gemini 3.1 Flash Lite');
      expect(chip.textContent).toContain('warms up after ch. 10');
      expect(chip.getAttribute('title')).toContain('Warms up after chapter 10');
    });

    it('honours a custom phase-1 min-lag in the warming hint', () => {
      renderChip(
        {
          analyzerPhase0Model: 'gemma-4-31b-it',
          analyzerPhase1Model: 'gemini-3.1-flash-lite',
          analyzerPhase1MinLagChapters: 15,
        },
        { phaseId: 1, state: 'warming' },
      );
      expect(screen.getByTestId('phase-model-chip-1').textContent).toContain('warms up after ch. 15');
    });

    it('shows an honest "Server default" when a phase is left blank but the split is active', () => {
      /* Phase 0 set, Phase 1 null → the server falls through to its own
         default for Phase 1, which the client can't see. Don't fabricate. */
      renderChip(
        { analyzerPhase0Model: 'gemma-4-31b-it', analyzerPhase1Model: null },
        { phaseId: 1, state: 'streaming' },
      );
      expect(screen.getByTestId('phase-model-chip-1').textContent).toContain('Server default');
    });
  });

  describe('per-run override active (selectedModelExplicit) — collapses the split', () => {
    /* Regression for the 2026-06-14 report: with a per-phase split saved
       (Gemini for both phases), picking a per-run override (qwen3.5:4b) on
       the analysis-failed card made the run execute on Qwen (server log:
       "via Ollama (qwen3.5:4b)") but the chip kept showing the saved phase
       model. The server collapses both phases to a per-run override
       (analysis.ts precedence priority 2), so the chip must mirror that. */
    it('shows the override model for phase 0 even when the split is on', () => {
      renderChip(
        { analyzerPhase0Model: 'gemma-4-31b-it', analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { phaseId: 0, state: 'streaming' },
        { selectedModel: 'qwen3.5:4b', selectedModelExplicit: true },
      );
      const chip = screen.getByTestId('phase-model-chip-0');
      expect(chip.textContent).toContain('Qwen3.5 4B');
      expect(chip.textContent).not.toContain('Gemma');
    });

    it('shows the override model for phase 1 even when the split is on', () => {
      renderChip(
        { analyzerPhase0Model: 'gemma-4-31b-it', analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { phaseId: 1, state: 'streaming' },
        { selectedModel: 'qwen3.5:4b', selectedModelExplicit: true },
      );
      const chip = screen.getByTestId('phase-model-chip-1');
      expect(chip.textContent).toContain('Qwen3.5 4B');
      expect(chip.textContent).not.toContain('Flash Lite');
    });

    it('does NOT promise a warm-up handoff while an override is collapsing the split', () => {
      renderChip(
        { analyzerPhase0Model: 'gemma-4-31b-it', analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { phaseId: 1, state: 'warming' },
        { selectedModel: 'qwen3.5:4b', selectedModelExplicit: true },
      );
      const chip = screen.getByTestId('phase-model-chip-1');
      expect(chip.textContent).not.toContain('warms up');
    });

    it('ignores the override when it is not explicit (split still wins)', () => {
      /* selectedModelExplicit false = the value is just the seeded default,
         not a real per-run pick, so the saved phase model still governs. */
      renderChip(
        { analyzerPhase0Model: 'gemma-4-31b-it', analyzerPhase1Model: 'gemini-3.1-flash-lite' },
        { phaseId: 0, state: 'streaming' },
        { selectedModel: 'qwen3.5:4b', selectedModelExplicit: false },
      );
      expect(screen.getByTestId('phase-model-chip-0').textContent).toContain('Gemma 4 31B');
    });
  });

  it('renders nothing for phase 2 (no model selection)', () => {
    const { container } = renderChip({}, { phaseId: 2, state: 'pending' });
    expect(container.querySelector('[data-testid^="phase-model-chip"]')).toBeNull();
  });

  describe('serverModel prop — mirrors the server-resolved model id', () => {
    it('PREFERS serverModel over the Redux selection when present', () => {
      /* Regression for Task 2: chip must show the server-reported model id
         ("qwen3.5:9b") even when Redux has a different selection ("qwen3.5:4b").
         This is the core truthfulness requirement: if the server actually ran
         on a different model than the UI's default, the chip must say so. */
      renderChip(
        { analyzerPhase0Model: null, analyzerPhase1Model: null },
        { phaseId: 0, state: 'streaming', serverModel: 'qwen3.5:9b' },
        { selectedModel: 'qwen3.5:4b' },
      );
      const chip = screen.getByTestId('phase-model-chip-0');
      expect(chip.textContent).toContain('Qwen3.5 9B (local)');
      expect(chip.textContent).not.toContain('Qwen3.5 4B');
    });

    it('falls back to Redux selection when serverModel is absent (pre-stream)', () => {
      /* Pre-stream: no server events have arrived yet, so serverModel is
         undefined. The existing Redux-derived behaviour must be preserved. */
      renderChip(
        { analyzerPhase0Model: null, analyzerPhase1Model: null },
        { phaseId: 0, state: 'pending' },
        { selectedModel: 'qwen3.5:4b' },
      );
      const chip = screen.getByTestId('phase-model-chip-0');
      expect(chip.textContent).toContain('Qwen3.5 4B (local)');
    });

    it('resolves an unknown serverModel id to the raw id (graceful fallback)', () => {
      /* A future model the frontend doesn't know about yet should still
         render its id rather than crashing or hiding it. */
      renderChip(
        { analyzerPhase0Model: null },
        { phaseId: 0, state: 'streaming', serverModel: 'unknown-future-model:70b' },
      );
      const chip = screen.getByTestId('phase-model-chip-0');
      expect(chip.textContent).toContain('unknown-future-model:70b');
    });
  });
});
