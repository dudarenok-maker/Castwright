/* BulkDuplicateReviewModal — the foreign-cast read (#3967).

   A read that never settles used to hold the pair on "Loading both books' casts…"
   forever. It is now bounded (BOOK_READ_TIMEOUT_MS), retried on expiry, and aborted
   when the modal unmounts. The effect still does not abort on a dependency change
   (see the comment in the component). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { act, render, screen } from '@testing-library/react';
import { castSlice } from '../store/cast-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { BulkDuplicateReviewModal } from './bulk-duplicate-review';
import type { DuplicateCandidate } from '../lib/cross-book-duplicates';
import type { BookStateResponse, Character, Voice } from '../lib/types';

const getBookState = vi.fn<(bookId: string) => Promise<BookStateResponse | null>>();
const bookStateSignals: Array<AbortSignal | undefined> = [];

vi.mock('../lib/api', () => ({
  api: {
    getBookState: (bookId: string, signal?: AbortSignal) => {
      bookStateSignals.push(signal);
      return getBookState(bookId);
    },
    linkPriorCharacter: vi.fn(),
    notLinkedTo: vi.fn(),
  },
}));

function voice(id: string, character: string, bookId: string): Voice {
  return {
    id,
    character,
    bookTitle: bookId,
    bookId,
    attributes: [],
    usedIn: 1,
    source: 'current',
    gradient: ['#000', '#fff'],
    ttsVoice: { provider: 'gemini', name: 'Kore', description: '' },
  } as Voice;
}

const candidate: DuplicateCandidate = {
  voiceKey: 'gemini|Kore',
  seriesKey: 'a|s',
  a: { voice: voice('v1', 'Eliza Gray', 'b1'), character: null },
  b: { voice: voice('v2', 'Eliza', 'b2'), character: null },
};

const casts: Record<string, Character[]> = {
  b2: [{ id: 'v2', name: 'Eliza', role: 'character', color: 'unset', voiceId: 'v2' } as Character],
};

function bookState(chars: Character[]): BookStateResponse {
  return { cast: { characters: chars } } as unknown as BookStateResponse;
}

function renderBulk() {
  const store = configureStore({
    reducer: { cast: castSlice.reducer, notifications: notificationsSlice.reducer },
  });
  const mine: Character[] = [
    { id: 'v1', name: 'Eliza Gray', role: 'character', color: 'unset', voiceId: 'v1' } as Character,
  ];
  return render(
    <Provider store={store}>
      <BulkDuplicateReviewModal
        open
        candidates={[candidate]}
        seriesName="S"
        currentBookId="b1"
        characters={mine}
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />
    </Provider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  getBookState.mockReset();
  bookStateSignals.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('BulkDuplicateReviewModal — a foreign-cast read that never settles (#3967)', () => {
  it('is aborted at 15 s and retried; the retry lands the pair', async () => {
    getBookState.mockImplementationOnce(() => new Promise(() => {}));
    getBookState.mockResolvedValueOnce(bookState(casts.b2));
    renderBulk();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bookStateSignals).toHaveLength(1);
    expect(bookStateSignals[0]!.aborted).toBe(false);
    expect(screen.getByText(/Loading both books/)).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(bookStateSignals[0]!.aborted).toBe(true);
    /* The retry waits retryDelayMs(0) = 2 s. */
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getBookState).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Loading both books/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Same character — link them' })).toBeEnabled();
  });

  it('aborts the in-flight read when the modal unmounts, without reporting a failed load', async () => {
    getBookState.mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { unmount } = renderBulk();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(bookStateSignals).toHaveLength(1);
      unmount();
      expect(bookStateSignals[0]!.aborted).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(warn).not.toHaveBeenCalledWith('[bulk-duplicate] foreign cast hydrate failed', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('leaving while a retry is pending issues no further read and reports no failed load', async () => {
    getBookState.mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { unmount } = renderBulk();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15500);
      });
      expect(getBookState).toHaveBeenCalledTimes(1);
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300000);
      });
      expect(getBookState).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalledWith('[bulk-duplicate] foreign cast hydrate failed', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });
});
