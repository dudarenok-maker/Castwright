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

describe('LibraryGrid Add-book tile', () => {
  it('Add-book tile mirrors hover with group-active, no resting peach (fe-39, caveat a)', () => {
    renderGrid(authorsWith(undefined));
    const addBtn = document.querySelector('[data-tour-id="new-book-btn"]') as HTMLElement;
    expect(addBtn).not.toBeNull();
    const circle = addBtn.querySelector('span.rounded-full') as HTMLElement;
    expect(circle).not.toBeNull();
    // mirrors present
    expect(circle.className).toContain('group-active:bg-peach');
    expect(circle.className).toContain('group-active:border-peach');
    expect(circle.className).toContain('group-active:text-white');
    // resting appearance intact
    expect(circle.className).toContain('bg-white');
    expect(circle.className).toContain('border-ink/10');
    // caveat (a): peach only ever appears as a variant, never bare
    // (regex requires start-or-whitespace before the token, so `group-hover:bg-peach`
    //  and `group-active:bg-peach` — preceded by ':' — do NOT match)
    expect(circle.className).not.toMatch(/(^|\s)bg-peach(\s|$)/);
    expect(circle.className).not.toMatch(/(^|\s)border-peach(\s|$)/);
    expect(circle.className).not.toMatch(/(^|\s)text-white(\s|$)/);
  });
});
