import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { SeriesMemoryReveal } from './series-memory-reveal';
import type { SeriesMemoryDetail } from '../../lib/types';

const detail: SeriesMemoryDetail = {
  series: {
    confirmedBookCount: 3,
    spanBooks: 3,
    books: [
      { bookId: 'b1', title: 'One', index: 1, principalCount: 8 },
      { bookId: 'b2', title: 'Two', index: 2, principalCount: 9 },
      { bookId: 'b3', title: 'Three', index: 3, principalCount: 9 },
    ],
  },
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
      {
        character: 'Sela',
        aliases: [],
        voiceId: 'v2',
        voiceLabel: 'Designed voice',
        engine: 'qwen',
        voiceKind: 'designed',
        firstBookId: 'b2',
        lastBookId: 'b3',
        bookIndices: [2, 3],
        carriedFullSpan: false,
      },
      {
        character: 'Narrator',
        aliases: [],
        voiceId: 'v3',
        voiceLabel: 'Deep · Female · UK',
        engine: 'kokoro',
        voiceKind: 'preset',
        firstBookId: 'b1',
        lastBookId: 'b3',
        bookIndices: [1, 2, 3],
        carriedFullSpan: true,
      },
    ],
  },
};

describe('SeriesMemoryReveal', () => {
  it('renders headline, subtitle and a row per carried character', async () => {
    render(
      <SeriesMemoryReveal
        author="Kell"
        series="Ninth House"
        bookCount={3}
        onClose={() => {}}
        onShare={() => {}}
        fetcher={async () => detail}
      />,
    );
    await waitFor(() => screen.getByText(/not a voice has changed/));
    expect(
      screen.getByText(/Three books in, and not a voice has changed\./),
    ).toBeInTheDocument();
    expect(screen.getByText('Marrow')).toBeInTheDocument();
    expect(screen.getByText(/from Bk 2/)).toBeInTheDocument(); // Sela late joiner
    expect(screen.queryByText(/Kokoro|Qwen/)).toBeNull(); // no engine names
    expect(screen.queryByText(/bf_|am_|af_/)).toBeNull(); // no catalogue slugs (P2-3)
    expect(screen.getByLabelText(/in books 2.3/)).toBeInTheDocument(); // Sela's range-collapsed aria, unique (regex dodges the en-dash U+2013 codepoint trap; P0-5)
  });

  it('uses numerals (not spelled words) in the headline above twenty', async () => {
    render(
      <SeriesMemoryReveal
        author="Kell"
        series="Ninth House"
        bookCount={25}
        onClose={() => {}}
        onShare={() => {}}
        fetcher={async () => detail}
      />,
    );
    await waitFor(() => screen.getByText(/books in/));
    expect(screen.getByText(/^25 books in,/)).toBeInTheDocument(); // not "Twenty-five"
  });

  it('fires onShare with the detail', async () => {
    const onShare = vi.fn();
    render(
      <SeriesMemoryReveal
        author="Kell"
        series="Ninth House"
        bookCount={3}
        onClose={() => {}}
        onShare={onShare}
        fetcher={async () => detail}
      />,
    );
    await waitFor(() => screen.getByText('Share this cast'));
    fireEvent.click(screen.getByText('Share this cast'));
    expect(onShare).toHaveBeenCalledWith(detail);
  });

  it('dialog has an accessible name matching the heading once loaded', async () => {
    render(
      <SeriesMemoryReveal
        author="Kell"
        series="Ninth House"
        bookCount={3}
        onClose={() => {}}
        onShare={() => {}}
        fetcher={async () => detail}
      />,
    );
    await waitFor(() => screen.getByText(/not a voice has changed/));
    expect(screen.getByRole('dialog')).toHaveAccessibleName(/not a voice has changed/);
  });

  it('close button calls onClose', async () => {
    const onClose = vi.fn();
    render(
      <SeriesMemoryReveal
        author="Kell"
        series="Ninth House"
        bookCount={3}
        onClose={onClose}
        onShare={() => {}}
        fetcher={async () => detail}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape key calls onClose', async () => {
    const onClose = vi.fn();
    render(
      <SeriesMemoryReveal
        author="Kell"
        series="Ninth House"
        bookCount={3}
        onClose={onClose}
        onShare={() => {}}
        fetcher={async () => detail}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('caps panel height and scrolls internally so a large carried cast stays on-screen', async () => {
    // Regression: the panel used to be `min-h-screen sm:min-h-0 overflow-auto`
    // with NO max-height, so a long carried list grew past the viewport and
    // pushed the footer (Share / Export) off-screen. jsdom can't measure
    // layout, so assert the bounded-height + vertical-scroll classes structurally.
    render(
      <SeriesMemoryReveal
        author="Kell"
        series="Ninth House"
        bookCount={3}
        onClose={() => {}}
        onShare={() => {}}
        fetcher={async () => detail}
      />,
    );
    await waitFor(() => screen.getByText('Marrow'));
    const panel = screen.getByRole('dialog').firstElementChild as HTMLElement;
    expect(panel.className).toContain('overflow-y-auto');
    expect(panel.className).toContain('sm:max-h-[90vh]');
    expect(panel.className).not.toContain('min-h-screen'); // old unbounded height
  });

  it('shows error message when fetcher rejects', async () => {
    render(
      <SeriesMemoryReveal
        author="Kell"
        series="Ninth House"
        bookCount={3}
        onClose={() => {}}
        onShare={() => {}}
        fetcher={async () => { throw new Error('network'); }}
      />,
    );
    await waitFor(() => screen.getByText(/Couldn't load/));
    expect(screen.getByText(/Couldn't load/)).toBeInTheDocument();
  });
});
