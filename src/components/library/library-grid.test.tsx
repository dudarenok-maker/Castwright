import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen } from '@testing-library/react';
import { librarySlice } from '../../store/library-slice';
import { accountSlice } from '../../store/account-slice';
import { LibraryGrid } from './library-grid';
import type { LibraryAuthor, LibraryBook } from '../../lib/types';

const makeBook = (bookId: string, title: string): LibraryBook => ({
  bookId, title, author: 'A. Kell', series: 'The Ninth House', seriesPosition: 1,
  isStandalone: false, status: 'complete', chapterCount: 10, completedChapters: 10,
  characterCount: 8, voiceCount: 8, lastWorkedOn: 'today', coverGradient: ['#000', '#fff'], tags: [],
});

function renderGrid(authors: LibraryAuthor[]) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer, library: librarySlice.reducer },
    preloadedState: {
      library: {
        loaded: true,
        error: null,
        authors,
        books: authors.flatMap((a) => a.series.flatMap((s) => s.books)),
        pausedSnapshots: {},
      },
    },
  });
  return render(
    <Provider store={store}>
      <LibraryGrid
        loaded
        isLibraryEmpty={false}
        authors={authors}
        activeBookId={null}
        onOpenBook={vi.fn()}
        onDeleteBook={vi.fn()}
        onReparseBook={vi.fn()}
        onReplaceManuscript={vi.fn()}
        onEditBook={vi.fn()}
        onStartNew={vi.fn()}
        onOpenSeriesMemory={vi.fn()}
      />
    </Provider>,
  );
}

const sm = {
  carriedCount: 5, bespokeCount: 4, designedCount: 4, confirmedBookCount: 3, spanBooks: 3,
  perBook: [
    { bookId: 'b1', index: 1, principalCount: 8, carriedPresent: 5 },
    { bookId: 'b2', index: 2, principalCount: 9, carriedPresent: 5 },
    { bookId: 'b3', index: 3, principalCount: 9, carriedPresent: 5 },
  ],
};

const authorsWith = (seriesMemory: typeof sm | undefined): LibraryAuthor[] => [{
  name: 'A. Kell',
  series: [{ name: 'The Ninth House', seriesMemory, books: [makeBook('b1', 'One')] }],
}];

describe('LibraryGrid series-memory', () => {
  it('renders the series-memory chip + sparkline when seriesMemory is present', () => {
    renderGrid(authorsWith(sm));
    expect(screen.getByTestId('series-memory-chip')).toBeInTheDocument();
    expect(screen.getByTestId('series-sparkline')).toBeInTheDocument();
  });

  it('renders neither when seriesMemory is absent', () => {
    renderGrid(authorsWith(undefined));
    expect(screen.queryByTestId('series-memory-chip')).toBeNull();
    expect(screen.queryByTestId('series-sparkline')).toBeNull();
  });
});
