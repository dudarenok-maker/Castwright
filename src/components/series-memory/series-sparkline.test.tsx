// src/components/series-memory/series-sparkline.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SeriesSparkline } from './series-sparkline';

const summary = {
  carriedCount: 9, bespokeCount: 7, designedCount: 6, confirmedBookCount: 3, spanBooks: 3,
  perBook: [
    { bookId: 'b1', index: 1, principalCount: 12, carriedPresent: 8 },
    { bookId: 'b2', index: 2, principalCount: 14, carriedPresent: 9 },
    { bookId: 'b3', index: 3, principalCount: 13, carriedPresent: 9 },
  ],
};

describe('SeriesSparkline', () => {
  it('renders one bar per book and the honest caption + aria', () => {
    render(<SeriesSparkline summary={summary} onOpen={() => {}} />);
    const strip = screen.getByTestId('series-sparkline');
    expect(strip).toHaveAttribute('aria-label', '9 of your cast carried across 3 books');
    expect(strip.querySelectorAll('[data-testid="sparkline-bar"]')).toHaveLength(3);
    expect(screen.getByText(/9 of your cast, kept true across the series\./)).toBeInTheDocument();
  });
  it('splits each bar into two buckets (carried + other principals)', () => {
    render(<SeriesSparkline summary={summary} onOpen={() => {}} />);
    const bar = screen.getAllByTestId('sparkline-bar')[0];
    expect(bar.children).toHaveLength(2); // gradient (carried) + faint (rest)
  });
  it('does not overflow when a carried character is below the principal floor (carriedPresent > principalCount)', () => {
    const odd = { ...summary, perBook: [{ bookId: 'b1', index: 1, principalCount: 2, carriedPresent: 5 }] };
    render(<SeriesSparkline summary={odd} onOpen={() => {}} />);
    const carried = screen.getByTestId('sparkline-bar').children[0] as HTMLElement;
    // base clamps to carriedPresent → carried fills 100%, never >100.
    expect(carried.style.height).toBe('100%');
  });
});
