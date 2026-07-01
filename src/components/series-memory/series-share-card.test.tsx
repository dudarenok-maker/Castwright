// src/components/series-memory/series-share-card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { SeriesShareCard } from './series-share-card';
import type { SeriesMemoryDetail } from '../../lib/types';

const detail: SeriesMemoryDetail = {
  series: { confirmedBookCount: 12, spanBooks: 12, books: [] },
  carried: { count: 56, bespokeCount: 41, designedCount: 39,
    characters: Array.from({ length: 56 }, (_, i) => ({
      character: `Name${i}`, aliases: [], voiceId: `v${i}`, voiceLabel: 'Designed voice',
      engine: 'qwen', voiceKind: i < 39 ? 'designed' : 'preset', firstBookId: 'b1', lastBookId: 'b12',
      bookIndices: [1], carriedFullSpan: true, totalLines: 56 - i,
    })) as SeriesMemoryDetail['carried']['characters'] },
};

describe('SeriesShareCard', () => {
  it('leads on the designed figure, the claim line, and mandatory branding', () => {
    render(<SeriesShareCard detail={detail} seriesName="The Ninth House" owner="Alex" />);
    const card = screen.getByTestId('series-share-card');
    expect(within(card).getByTestId('card-hero-number')).toHaveTextContent('39 designed voices'); // not the wall's "Name39"
    expect(within(card).getByText(/kept true across all 12 books/)).toBeInTheDocument();
    expect(within(card).getByText('12 books. The same cast.')).toBeInTheDocument(); // locked claim line
    expect(within(card).getByText('castwright.ai')).toBeInTheDocument();            // non-removable branding
    expect(within(card).getByText(/Alex's cast · kept true/)).toBeInTheDocument();
    expect(within(card).queryByText('✦')).toBeNull();                              // no stock sparkle separator
  });
  it('uses spanBooks (not series length) so the claim cannot overclaim', () => {
    const turnover = { ...detail, series: { ...detail.series, confirmedBookCount: 12, spanBooks: 10 } };
    render(<SeriesShareCard detail={turnover} seriesName="X" />);
    expect(screen.getByText(/kept true across all 10 books/)).toBeInTheDocument();
    expect(screen.getByText('10 books. The same cast.')).toBeInTheDocument();
  });
  it('falls back to "Your cast · kept true" when no owner is set (never "undefined")', () => {
    render(<SeriesShareCard detail={detail} seriesName="X" />);
    expect(screen.getByText(/Your cast · kept true/)).toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });
  it('caps the wall past 45 names', () => {
    render(<SeriesShareCard detail={detail} seriesName="X" />);
    expect(screen.getByText(/and \d+ more of your cast/)).toBeInTheDocument();
  });
});
