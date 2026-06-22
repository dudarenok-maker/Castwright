import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShareCardModal, slugifyFilename } from './share-card-modal';
import type { SeriesMemoryDetail } from '../../lib/types';

vi.mock('html-to-image', () => ({
  toPng: vi.fn().mockResolvedValue('data:image/png;base64,AAAA'),
}));

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
  it('renders the card and the zero-dep JSON download', () => {
    render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
    expect(screen.getByTestId('series-share-card')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download data \(\.json\)/i }),
    ).toBeInTheDocument();
  });

  it('renders the Download image (.png) button', () => {
    render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /download image \(\.png\)/i })).toBeInTheDocument();
  });

  it('captures the card and triggers a .png download on click', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /download image \(\.png\)/i }));
    const { toPng } = await import('html-to-image');
    await waitFor(() => expect(toPng).toHaveBeenCalled());
    await waitFor(() => expect(click).toHaveBeenCalled());
  });

  it('surfaces an alert when capture fails', async () => {
    const { toPng } = await import('html-to-image');
    (toPng as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error('boom'));
    render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /download image \(\.png\)/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't render/i);
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

  it('shows the personalized footer when owner is provided', () => {
    render(<ShareCardModal detail={detail} seriesName="X" owner="Alex" onClose={() => {}} />);
    expect(screen.getByText("Alex's cast · kept true")).toBeInTheDocument();
  });

  it('shows the fallback footer when owner is omitted', () => {
    render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
    expect(screen.getByText("Your cast · kept true")).toBeInTheDocument();
  });

  it('shows the fallback footer when owner is an empty string', () => {
    render(<ShareCardModal detail={detail} seriesName="X" owner="" onClose={() => {}} />);
    expect(screen.getByText("Your cast · kept true")).toBeInTheDocument();
  });
});

describe('slugifyFilename', () => {
  it('replaces filename-illegal characters with a single dash', () => {
    expect(slugifyFilename('Marin Vale: North/Coast')).toBe('Marin Vale- North-Coast');
    expect(slugifyFilename('A::B')).toBe('A-B');
    expect(slugifyFilename('')).toBe('series');
  });
});
