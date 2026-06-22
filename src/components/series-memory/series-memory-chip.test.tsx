import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SeriesMemoryChip } from './series-memory-chip';

const summary = { carriedCount: 9, bespokeCount: 7, designedCount: 6, confirmedBookCount: 12, spanBooks: 12, perBook: [] };

describe('SeriesMemoryChip', () => {
  it('renders the warm carried-character label and book count', () => {
    render(<SeriesMemoryChip summary={summary} bookCount={12} onOpen={() => {}} />);
    expect(screen.getByTestId('series-memory-chip')).toHaveTextContent('Your cast · 9 voices, 12 books');
  });
  it('calls onOpen when clicked', () => {
    const onOpen = vi.fn();
    render(<SeriesMemoryChip summary={summary} bookCount={12} onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('series-memory-chip'));
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it('omits the books clause when showBooks is false', () => {
    const testSummary = {
      carriedCount: 8, bespokeCount: 5, designedCount: 5,
      confirmedBookCount: 3, spanBooks: 3, perBook: [],
    };
    render(<SeriesMemoryChip summary={testSummary} bookCount={3} showBooks={false} onOpen={() => {}} />);
    const chip = screen.getByTestId('series-memory-chip');
    expect(chip).toHaveTextContent('Your cast · 8 voices');
    expect(chip).not.toHaveTextContent('books');
  });
  it('keeps the books clause by default', () => {
    const testSummary = {
      carriedCount: 8, bespokeCount: 5, designedCount: 5,
      confirmedBookCount: 3, spanBooks: 3, perBook: [],
    };
    render(<SeriesMemoryChip summary={testSummary} bookCount={3} onOpen={() => {}} />);
    expect(screen.getByTestId('series-memory-chip')).toHaveTextContent('Your cast · 8 voices, 3 books');
  });
});
