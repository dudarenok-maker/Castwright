import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShareCardModal } from './share-card-modal';
import type { SeriesMemoryDetail } from '../../lib/types';

const detail: SeriesMemoryDetail = {
  series: { confirmedBookCount: 3, spanBooks: 3, books: [] },
  carried: {
    count: 3,
    bespokeCount: 3,
    designedCount: 3,
    characters: [
      {
        character: 'Marrow',
        aliases: [],
        voiceId: 'v1',
        voiceLabel: 'Designed voice',
        engine: 'qwen',
        voiceKind: 'designed',
        firstBookId: 'b1',
        lastBookId: 'b3',
        bookIndices: [1, 2, 3],
        carriedFullSpan: true,
      },
    ],
  },
};

describe('ShareCardModal', () => {
  it('renders the card and the zero-dep JSON download (no PNG dep in v1)', () => {
    render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
    expect(screen.getByTestId('series-share-card')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download data \(\.json\)/i }),
    ).toBeInTheDocument();
    // PNG download is a gated follow-up (requires html-to-image dep sign-off)
    expect(screen.queryByRole('button', { name: /download image/i })).toBeNull();
  });

  it('is a dialog with aria-modal', () => {
    render(<ShareCardModal detail={detail} seriesName="TestSeries" onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal');
  });

  it('has a close button', () => {
    render(<ShareCardModal detail={detail} seriesName="TestSeries" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('passes seriesName through to the card', () => {
    render(<ShareCardModal detail={detail} seriesName="The Coalfall Commission" onClose={() => {}} />);
    // The series-share-card renders "Series memory · <seriesName>" — getAllByText
    // because the name also appears in the sr-only aria label.
    const matches = screen.getAllByText(/the coalfall commission/i);
    expect(matches.length).toBeGreaterThan(0);
  });
});
