/* Pairs with plan 89 C5 — verifies that the Suspense fallback only paints
   if the wrapped boundary hasn't resolved within the delay window. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import { DelayedSpinner } from './delayed-spinner';

describe('DelayedSpinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT render before the delay elapses (warm-cache navigation contract)', () => {
    render(<DelayedSpinner delayMs={150} />);
    expect(screen.queryByTestId('route-suspense-fallback')).toBeNull();
    /* Even at one tick before the threshold the fallback stays hidden. */
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(screen.queryByTestId('route-suspense-fallback')).toBeNull();
  });

  it('renders the spinner after delayMs elapses', () => {
    render(<DelayedSpinner delayMs={150} />);
    act(() => {
      vi.advanceTimersByTime(151);
    });
    expect(screen.getByTestId('route-suspense-fallback')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the configurable label after the delay (a11y / readability)', () => {
    render(<DelayedSpinner delayMs={50} label="Loading view…" />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByText('Loading view…')).toBeInTheDocument();
  });

  it('cleans up the timer on unmount (no late-fire after Suspense resolves)', () => {
    const { unmount } = render(<DelayedSpinner delayMs={150} />);
    /* Unmount before the timer fires — simulates Suspense resolving the
       lazy chunk faster than the delay. */
    unmount();
    /* Advancing the clock past the threshold must NOT throw or warn
       (the timer must have been cleared on unmount). */
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }).not.toThrow();
  });
});
