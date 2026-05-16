/* CoverPicker modal — opens on demand from the library card "..." menu
   and the Listen-view "Change cover" button. Assertions cover the four
   states (loading → ready / empty / error), the pick-success round-trip,
   and the Remove-cover destructive button. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CoverPicker } from './cover-picker';
import type { CoverCandidate } from '../lib/types';

/* Each test customises the mock return value before importing the
   component (which then resolves api.* via the module-level mock). */
const findCoverCandidates = vi.fn();
const setCover = vi.fn();
const removeCover = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    findCoverCandidates: (...args: unknown[]) => findCoverCandidates(...args),
    setCover: (...args: unknown[]) => setCover(...args),
    removeCover: (...args: unknown[]) => removeCover(...args),
  },
}));

const TWO_CANDIDATES: CoverCandidate[] = [
  { openLibraryId: 'cover-i:11', coverUrl: 'https://covers/11-L.jpg', edition: 'Alpha · 2020' },
  { openLibraryId: 'cover-i:22', coverUrl: 'https://covers/22-L.jpg', edition: 'Beta · 2021' },
];

beforeEach(() => {
  findCoverCandidates.mockReset();
  setCover.mockReset();
  removeCover.mockReset();
});

function renderPicker(overrides: Partial<React.ComponentProps<typeof CoverPicker>> = {}) {
  const onClose = vi.fn();
  const onPicked = vi.fn();
  const utils = render(
    <CoverPicker
      open
      bookId="bk_test"
      bookTitle="the Coalfall Commission"
      bookAuthor="Della Renwick"
      onClose={onClose}
      onPicked={onPicked}
      {...overrides}
    />,
  );
  return { onClose, onPicked, ...utils };
}

describe('CoverPicker — rendering states', () => {
  it('renders the candidate grid once the request resolves', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    renderPicker();

    /* Picker queries the book's id on mount. */
    expect(findCoverCandidates).toHaveBeenCalledWith('bk_test');

    await waitFor(() => expect(screen.getByTestId('cover-grid')).toBeInTheDocument());
    expect(screen.getByTestId('cover-candidate-cover-i:11')).toBeInTheDocument();
    expect(screen.getByTestId('cover-candidate-cover-i:22')).toBeInTheDocument();
  });

  it('renders the empty-state copy when OpenLibrary returns no candidates', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    renderPicker();
    await screen.findByText(/no covers found/i);
    expect(screen.queryByTestId('cover-grid')).not.toBeInTheDocument();
  });

  it('renders an error state with a retry button when the fetch fails', async () => {
    findCoverCandidates.mockRejectedValueOnce(new Error('upstream offline'));
    findCoverCandidates.mockResolvedValueOnce({ candidates: TWO_CANDIDATES });
    renderPicker();

    await screen.findByText(/upstream offline/i);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    /* The retry triggers a second call and renders the grid on success. */
    await screen.findByTestId('cover-grid');
    expect(findCoverCandidates).toHaveBeenCalledTimes(2);
  });
});

describe('CoverPicker — pick flow', () => {
  it('calls api.setCover with the chosen openLibraryId, fires onPicked, and closes', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    setCover.mockResolvedValue({ coverImageUrl: '/api/books/bk_test/cover' });

    const { onClose, onPicked } = renderPicker();
    const tile = await screen.findByTestId('cover-candidate-cover-i:22');
    fireEvent.click(tile);

    await waitFor(() => expect(setCover).toHaveBeenCalledWith('bk_test', 'cover-i:22'));
    expect(onPicked).toHaveBeenCalledWith('/api/books/bk_test/cover');
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a save error without closing so the user can retry', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    setCover.mockRejectedValue(new Error('download blew up'));

    const { onClose, onPicked } = renderPicker();
    const tile = await screen.findByTestId('cover-candidate-cover-i:11');
    fireEvent.click(tile);

    await screen.findByText(/download blew up/i);
    expect(onPicked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CoverPicker — remove flow', () => {
  it('renders the Remove cover button only when currentCoverUrl is set', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    const { rerender } = renderPicker();
    await screen.findByTestId('cover-grid');
    expect(screen.queryByRole('button', { name: /remove cover/i })).not.toBeInTheDocument();

    rerender(
      <CoverPicker
        open
        bookId="bk_test"
        bookTitle="the Coalfall Commission"
        bookAuthor="Della Renwick"
        currentCoverUrl="/api/books/bk_test/cover"
        onClose={() => {}}
        onPicked={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /remove cover/i })).toBeInTheDocument();
  });

  it('calls api.removeCover and emits an empty string via onPicked when Remove is clicked', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    removeCover.mockResolvedValue(undefined);

    const { onClose, onPicked } = renderPicker({ currentCoverUrl: '/api/books/bk_test/cover' });
    await screen.findByTestId('cover-grid');
    fireEvent.click(screen.getByRole('button', { name: /remove cover/i }));

    await waitFor(() => expect(removeCover).toHaveBeenCalledWith('bk_test'));
    expect(onPicked).toHaveBeenCalledWith('');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CoverPicker — closed state', () => {
  it('renders nothing when open=false and never calls the API', () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    render(
      <CoverPicker
        open={false}
        bookId="bk_test"
        bookTitle="the Coalfall Commission"
        bookAuthor="Della Renwick"
        onClose={() => {}}
        onPicked={() => {}}
      />,
    );
    expect(screen.queryByTestId('cover-picker')).not.toBeInTheDocument();
    expect(findCoverCandidates).not.toHaveBeenCalled();
  });
});
