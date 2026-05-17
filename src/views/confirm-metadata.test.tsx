/* ConfirmMetadataView — Book # input behaviour and Submit gating.
   Pairs with docs/features/03-import-confirm-metadata.md. */

import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { manuscriptSlice } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { uiSlice } from '../store/ui-slice';
import { ConfirmMetadataView } from './confirm-metadata';
import type { ImportCandidate, LibraryBook } from '../lib/types';

const candidate: ImportCandidate = {
  tempId: 'imp_test',
  format: 'epub',
  title: 'Keeper of the Lost Cities',
  author: 'Shannon Messenger',
  series: 'Keeper of the Lost Cities',
  seriesPosition: null /* Mirrors the screenshot: parser left position blank. */,
  sourceText: 'body',
  wordCount: 103102,
  byteSize: 500_000,
  chapters: Array.from({ length: 59 }, (_, i) => ({ id: i + 1, title: `Chapter ${i + 1}` })),
};

const libraryBook = (
  overrides: Partial<LibraryBook> & Pick<LibraryBook, 'bookId'>,
): LibraryBook => ({
  title: overrides.bookId,
  author: 'Shannon Messenger',
  series: 'Keeper of the Lost Cities',
  seriesPosition: null,
  isStandalone: false,
  status: 'complete',
  chapterCount: 30,
  completedChapters: 30,
  characterCount: 20,
  voiceCount: 20,
  lastWorkedOn: 'last week',
  coverGradient: ['#000', '#fff'],
  ...overrides,
});

function renderView(libraryBooks: LibraryBook[] = []) {
  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      library: librarySlice.reducer,
      ui: uiSlice.reducer,
    },
    preloadedState: {
      manuscript: { ...manuscriptSlice.getInitialState(), importCandidate: candidate },
      library: { loaded: true, authors: [], books: libraryBooks, pausedSnapshots: {} },
    },
  });
  return {
    store,
    ...render(
      <Provider store={store}>
        <ConfirmMetadataView />
      </Provider>,
    ),
  };
}

describe('ConfirmMetadataView — Book # input', () => {
  it('disables Submit when Book # is blank (so the click does not silently no-op)', () => {
    renderView();
    const submit = screen.getByRole('button', { name: /save book and start analysis/i });
    expect(submit).toBeDisabled();
  });

  it('preserves a decimal Book # like 1.5 and enables Submit', async () => {
    const user = userEvent.setup();
    renderView();
    const bookNum = screen.getByPlaceholderText('1') as HTMLInputElement;
    await user.type(bookNum, '1.5');
    expect(bookNum.value).toBe('1.5'); /* dot must not be stripped */
    const submit = screen.getByRole('button', { name: /save book and start analysis/i });
    expect(submit).not.toBeDisabled();
  });

  it('strips letters but keeps digits and a single dot', async () => {
    const user = userEvent.setup();
    renderView();
    const bookNum = screen.getByPlaceholderText('1') as HTMLInputElement;
    await user.type(bookNum, '1.5.7abc');
    /* second dot dropped; letters dropped; first dot retained. */
    expect(bookNum.value).toBe('1.57');
  });
});

describe('ConfirmMetadataView — duplicate position warning', () => {
  it('flags the conflict when another book in the same series already owns this number', async () => {
    const user = userEvent.setup();
    renderView([
      libraryBook({
        bookId: 'shannon-messenger__keeper__exile',
        title: 'Exile',
        seriesPosition: 2,
      }),
    ]);
    const bookNum = screen.getByPlaceholderText('1');
    await user.type(bookNum, '2');
    expect(screen.getByText(/heads-up/i)).toBeInTheDocument();
    expect(screen.getByText(/Exile/)).toBeInTheDocument();
  });

  it('does not warn when the same number exists in a different series', async () => {
    const user = userEvent.setup();
    renderView([
      libraryBook({ bookId: 'foreign-series', series: 'Some Other Series', seriesPosition: 2 }),
    ]);
    const bookNum = screen.getByPlaceholderText('1');
    await user.type(bookNum, '2');
    expect(screen.queryByText(/heads-up/i)).not.toBeInTheDocument();
  });

  it('matches series case-insensitively (so "keeper of the lost cities" and "Keeper…" collide)', async () => {
    const user = userEvent.setup();
    renderView([
      libraryBook({
        bookId: 'lower-case-series',
        title: 'Everblaze',
        series: 'keeper of the lost cities',
        seriesPosition: 3,
      }),
    ]);
    const bookNum = screen.getByPlaceholderText('1');
    await user.type(bookNum, '3');
    expect(screen.getByText(/Everblaze/)).toBeInTheDocument();
  });
});
