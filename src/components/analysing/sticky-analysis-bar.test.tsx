// Pairs with docs/features/94-analysing-multi-model-ui.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import { StickyAnalysisBar } from './sticky-analysis-bar';

function mount(props: React.ComponentProps<typeof StickyAnalysisBar>) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer },
  });
  return render(
    <Provider store={store}>
      <StickyAnalysisBar {...props} />
    </Provider>,
  );
}

describe('StickyAnalysisBar', () => {
  it('renders the phase-0 chip + label + active-model chip + Pause button while streaming', () => {
    const onPauseOrResume = vi.fn();
    mount({
      activePhaseId: 0,
      conn: 'streaming',
      isRunning: true,
      hasStartedOnce: true,
      isAnalyzerReady: true,
      onPauseOrResume,
    });
    const phaseChip = screen.getByTestId('sticky-phase-chip');
    expect(phaseChip.textContent).toContain('Phase 0');
    expect(phaseChip.textContent).toContain('Detecting characters');

    /* The phase-0 model chip mounts inside the bar with the streaming state. */
    expect(screen.getByTestId('phase-model-chip-0').getAttribute('data-phase-state')).toBe(
      'streaming',
    );

    const button = screen.getByTestId('sticky-pause-button');
    expect(button.textContent).toBe('Pause analysis');
    fireEvent.click(button);
    expect(onPauseOrResume).toHaveBeenCalledOnce();
  });

  it('switches the chip + button when Phase 1 is active', () => {
    mount({
      activePhaseId: 1,
      conn: 'streaming',
      isRunning: true,
      hasStartedOnce: true,
      isAnalyzerReady: true,
      onPauseOrResume: vi.fn(),
    });
    const phaseChip = screen.getByTestId('sticky-phase-chip');
    expect(phaseChip.textContent).toContain('Phase 1');
    expect(phaseChip.textContent).toContain('Parsing and attribution');
    expect(screen.getByTestId('phase-model-chip-1')).toBeTruthy();
    /* Phase-0 chip must no longer mount once the active phase advances. */
    expect(screen.queryByTestId('phase-model-chip-0')).toBeNull();
  });

  it('labels the button "Resume analysis" when started-once and currently idle', () => {
    mount({
      activePhaseId: 0,
      conn: 'idle',
      isRunning: false,
      hasStartedOnce: true,
      isAnalyzerReady: true,
      onPauseOrResume: vi.fn(),
    });
    expect(screen.getByTestId('sticky-pause-button').textContent).toBe('Resume analysis');
  });

  it('labels the button "Start analysis" before the first click and "Waiting…" when analyzer not ready', () => {
    const { rerender } = mount({
      activePhaseId: 0,
      conn: 'idle',
      isRunning: false,
      hasStartedOnce: false,
      isAnalyzerReady: true,
      onPauseOrResume: vi.fn(),
    });
    expect(screen.getByTestId('sticky-pause-button').textContent).toBe('Start analysis');

    rerender(
      <Provider store={configureStore({ reducer: { account: accountSlice.reducer } })}>
        <StickyAnalysisBar
          activePhaseId={0}
          conn="idle"
          isRunning={false}
          hasStartedOnce={false}
          isAnalyzerReady={false}
          onPauseOrResume={vi.fn()}
        />
      </Provider>,
    );
    const btn = screen.getByTestId('sticky-pause-button');
    expect(btn.textContent).toBe('Waiting for analyzer…');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('uses `position: sticky` with top-16 so the browser handles the pin without JS', () => {
    mount({
      activePhaseId: 0,
      conn: 'streaming',
      isRunning: true,
      hasStartedOnce: true,
      isAnalyzerReady: true,
      onPauseOrResume: vi.fn(),
    });
    const bar = screen.getByTestId('sticky-analysis-bar');
    /* Class-list assertion: the implementation MUST stay CSS-only. If a
       future refactor swaps to an IntersectionObserver, this assertion
       fails fast and points the reviewer at the regression plan. */
    expect(bar.className).toContain('sticky');
    expect(bar.className).toContain('top-16');
  });
});
