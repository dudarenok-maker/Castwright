/* LibraryTable — series grouping, Standalones pseudo-section,
   per-row callbacks, collapse, and empty-state branches.

   Pairs with docs/features/archive/76-library-table-view.md. The card view
   (library-grid) carries its own coverage in book-library.test.tsx;
   these specs lock the table-specific seams. */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { librarySlice } from '../../store/library-slice';
import { accountSlice } from '../../store/account-slice';
import { LibraryTable } from './library-table';
import type { LibraryAuthor, LibraryBook, LibrarySeries } from '../../lib/types';

function makeBook(over: Partial<LibraryBook> & Pick<LibraryBook, 'bookId' | 'title'>): LibraryBook {
  const base: LibraryBook = {
    bookId: over.bookId,
    title: over.title,
    author: 'Test Author',
    series: 'Test Series',
    seriesPosition: 1,
    isStandalone: false,
    status: 'complete',
    chapterCount: 10,
    completedChapters: 10,
    characterCount: 5,
    voiceCount: 5,
    lastWorkedOn: 'today',
    coverGradient: ['#000', '#fff'],
    runtime: '5h 0m',
    tags: [],
  };
  return { ...base, ...over };
}

function renderTable(opts: {
  authors: LibraryAuthor[];
  isLibraryEmpty?: boolean;
  loaded?: boolean;
  activeBookId?: string | null;
  onOpenBook?: (b: LibraryBook) => void;
  onDeleteBook?: (b: LibraryBook) => void;
  onReparseBook?: (b: LibraryBook) => void;
  onReplaceManuscript?: (b: LibraryBook, file: File) => void;
  onEditBook?: (b: LibraryBook) => Promise<void>;
  onStartNew?: () => void;
  onOpenSeriesMemory?: (s: LibrarySeries) => void;
}) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer, library: librarySlice.reducer },
    preloadedState: {
      library: {
        loaded: opts.loaded ?? true,
        error: null,
        authors: opts.authors,
        books: opts.authors.flatMap((a) => a.series.flatMap((s) => s.books)),
        pausedSnapshots: {},
      },
    },
  });
  return render(
    <Provider store={store}>
      <LibraryTable
        loaded={opts.loaded ?? true}
        isLibraryEmpty={opts.isLibraryEmpty ?? opts.authors.length === 0}
        authors={opts.authors}
        activeBookId={opts.activeBookId ?? null}
        onOpenBook={opts.onOpenBook ?? vi.fn()}
        onDeleteBook={opts.onDeleteBook ?? vi.fn()}
        onReparseBook={opts.onReparseBook ?? vi.fn()}
        onReplaceManuscript={opts.onReplaceManuscript ?? vi.fn()}
        onEditBook={opts.onEditBook ?? vi.fn().mockResolvedValue(undefined)}
        onStartNew={opts.onStartNew ?? vi.fn()}
        onOpenSeriesMemory={opts.onOpenSeriesMemory}
      />
    </Provider>,
  );
}

describe('LibraryTable — empty / skeleton branches', () => {
  it('renders the skeleton when loaded is false', () => {
    renderTable({ authors: [], loaded: false, isLibraryEmpty: true });
    expect(screen.getByTestId('library-skeleton')).toBeInTheDocument();
  });

  it('renders the empty library state when there are zero authors', () => {
    renderTable({ authors: [], isLibraryEmpty: true });
    expect(screen.getByText(/your library is empty/i)).toBeInTheDocument();
  });

  it('renders the no-filter-match copy when library is non-empty but every group is empty', () => {
    /* Library has authors and was loaded, but the filter has stripped
       every series' books — same shape the orchestrator hands the
       grid when an active filter hides everything. */
    const author: LibraryAuthor = { name: 'Empty Author', series: [] };
    renderTable({ authors: [author], isLibraryEmpty: false });
    expect(screen.getByTestId('library-no-filter-match')).toBeInTheDocument();
  });
});

describe('LibraryTable — series grouping', () => {
  it('renders each series under its author + series header', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author One',
        series: [
          {
            name: 'Series Alpha',
            books: [makeBook({ bookId: 'a1', title: 'Alpha One', seriesPosition: 1 })],
          },
          {
            name: 'Series Beta',
            books: [makeBook({ bookId: 'b1', title: 'Beta One', seriesPosition: 1 })],
          },
        ],
      },
    ];
    renderTable({ authors });
    expect(screen.getByTestId('library-table-section-Author One::Series Alpha')).toBeInTheDocument();
    expect(screen.getByTestId('library-table-section-Author One::Series Beta')).toBeInTheDocument();
  });

  it('collects standalones from every author into a single "Standalones" group', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [
          {
            name: 'Series One',
            books: [
              makeBook({ bookId: 'sa1', title: 'A Standalone', isStandalone: true, seriesPosition: null }),
              makeBook({ bookId: 'a1', title: 'A One', seriesPosition: 1 }),
            ],
          },
        ],
      },
      {
        name: 'Author B',
        series: [
          {
            name: 'Series Two',
            books: [
              makeBook({ bookId: 'sb1', title: 'B Standalone', isStandalone: true, seriesPosition: null }),
            ],
          },
        ],
      },
    ];
    renderTable({ authors });
    const standalones = screen.getByTestId('library-table-section-__standalones__');
    expect(standalones).toBeInTheDocument();
    expect(within(standalones).getByText('A Standalone')).toBeInTheDocument();
    expect(within(standalones).getByText('B Standalone')).toBeInTheDocument();
    expect(within(standalones).getByText('Standalones')).toBeInTheDocument();
  });

  it('omits the Standalones group when no standalones survive the filter', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [
          { name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One' })] },
        ],
      },
    ];
    renderTable({ authors });
    expect(screen.queryByTestId('library-table-section-__standalones__')).not.toBeInTheDocument();
  });

  it('prefixes series-position into the title column for non-standalone rows', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [
          { name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One', seriesPosition: 4 })] },
        ],
      },
    ];
    renderTable({ authors });
    const row = screen.getByTestId('library-table-row-a1');
    expect(row).toHaveTextContent(/#4/);
    expect(row).toHaveTextContent('A One');
  });
});

describe('LibraryTable — interactions', () => {
  it('fires onOpenBook when a row is clicked', () => {
    const onOpenBook = vi.fn();
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [{ name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One' })] }],
      },
    ];
    renderTable({ authors, onOpenBook });
    fireEvent.click(screen.getByTestId('library-table-row-a1'));
    expect(onOpenBook).toHaveBeenCalledTimes(1);
    expect(onOpenBook.mock.calls[0][0].bookId).toBe('a1');
  });

  it('does NOT fire onOpenBook when the kebab menu is clicked', () => {
    const onOpenBook = vi.fn();
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [{ name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One' })] }],
      },
    ];
    renderTable({ authors, onOpenBook });
    fireEvent.click(screen.getByLabelText(/Actions for A One/));
    expect(onOpenBook).not.toHaveBeenCalled();
  });

  it('collapses and expands a series header on click', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [{ name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One' })] }],
      },
    ];
    renderTable({ authors });
    /* Initially expanded — row is in the DOM. */
    expect(screen.getByTestId('library-table-row-a1')).toBeInTheDocument();
    const section = screen.getByTestId('library-table-section-Author A::S');
    const header = within(section).getByRole('button', { name: /S/ });
    fireEvent.click(header);
    /* After collapse — row gone. */
    expect(screen.queryByTestId('library-table-row-a1')).not.toBeInTheDocument();
    /* Re-expand restores it. */
    fireEvent.click(header);
    expect(screen.getByTestId('library-table-row-a1')).toBeInTheDocument();
  });

  it('opens the Delete confirm dialog from the kebab menu and routes confirm → onDeleteBook', () => {
    const onDeleteBook = vi.fn();
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [{ name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One' })] }],
      },
    ];
    renderTable({ authors, onDeleteBook });
    fireEvent.click(screen.getByLabelText(/Actions for A One/));
    fireEvent.click(screen.getByRole('button', { name: /Delete book/i }));
    /* ConfirmDialog renders with the confirmLabel button. */
    const confirmButtons = screen.getAllByRole('button', { name: /Delete book/i });
    /* The dialog's confirm button is the LAST in the DOM (the menu's
       trigger has closed already). */
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    expect(onDeleteBook).toHaveBeenCalledTimes(1);
  });

  it('delete confirm dialog warns that listening history will be removed (fs-16/D14)', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [{ name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One' })] }],
      },
    ];
    renderTable({ authors });
    fireEvent.click(screen.getByLabelText(/Actions for A One/));
    fireEvent.click(screen.getByRole('button', { name: /Delete book/i }));
    expect(screen.getByText(/listening history/i)).toBeInTheDocument();
  });

  it('opens the Edit modal from the kebab menu', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [{ name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One' })] }],
      },
    ];
    renderTable({ authors });
    fireEvent.click(screen.getByLabelText(/Actions for A One/));
    fireEvent.click(screen.getByRole('button', { name: /^Edit details$/i }));
    /* EditBookMetaModal renders an "Edit details" eyebrow paragraph + a
       Close button. Both anchor that the modal mounted; the Close button
       is the more stable selector across modal-shell refactors. */
    expect(screen.getByRole('button', { name: /^Close$/i })).toBeInTheDocument();
  });

  it('renders the cover <img> overlay when book.coverImageUrl is set', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [
          {
            name: 'S',
            books: [
              makeBook({
                bookId: 'a1',
                title: 'A One',
                coverImageUrl: '/api/books/a1/cover',
              }),
            ],
          },
        ],
      },
    ];
    renderTable({ authors });
    const img = screen.getByTestId('book-table-cover-a1') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/books/a1/cover');
  });

  it('renders the "Open" pill on the row that matches activeBookId', () => {
    const authors: LibraryAuthor[] = [
      {
        name: 'Author A',
        series: [{ name: 'S', books: [makeBook({ bookId: 'a1', title: 'A One' })] }],
      },
    ];
    renderTable({ authors, activeBookId: 'a1' });
    const row = screen.getByTestId('library-table-row-a1');
    expect(within(row).getByText(/Open/i)).toBeInTheDocument();
  });

  it('Replace manuscript… menu item → file upload → confirm → calls onReplaceManuscript', () => {
    const onReplaceManuscript = vi.fn();
    const book = makeBook({ bookId: 'a1', title: 'A One' });
    const authors: LibraryAuthor[] = [
      { name: 'Author A', series: [{ name: 'S', books: [book] }] },
    ];
    renderTable({ authors, onReplaceManuscript });

    /* Open the kebab menu. */
    fireEvent.click(screen.getByLabelText(/Actions for A One/));
    /* Click "Replace manuscript…" — this triggers a hidden file input click. */
    fireEvent.click(screen.getByRole('button', { name: /Replace manuscript…/i }));

    /* Simulate a file being chosen via the hidden input. */
    const input = screen.getByTestId('replace-manuscript-input') as HTMLInputElement;
    const file = new File(['content'], 'new-manuscript.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    /* Click the confirm button in the ConfirmDialog. */
    const confirmBtns = screen.getAllByRole('button', { name: /Replace manuscript/i });
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);

    expect(onReplaceManuscript).toHaveBeenCalledTimes(1);
    expect(onReplaceManuscript.mock.calls[0][0]).toBe(book);
    expect(onReplaceManuscript.mock.calls[0][1]).toBe(file);
  });
});

const SUMMARY = {
  carriedCount: 8, bespokeCount: 5, designedCount: 5,
  confirmedBookCount: 3, spanBooks: 3, perBook: [],
};

describe('LibraryTable — series-memory chip (fe-41)', () => {
  const authorsWith = (seriesMemory: typeof SUMMARY | undefined): LibraryAuthor[] => [
    {
      name: 'Marin Vale',
      series: [
        {
          name: 'Northern Coast Trilogy',
          seriesMemory,
          books: [makeBook({ bookId: 'n1', title: 'North One', seriesPosition: 1 })],
        },
      ],
    },
  ];

  it('renders the compact chip (no books clause) for a series with seriesMemory', () => {
    renderTable({ authors: authorsWith(SUMMARY) });
    const chip = screen.getByTestId('series-memory-chip');
    expect(chip).toHaveTextContent('Your cast · 8 voices');
    expect(chip).not.toHaveTextContent('books');
  });

  it('renders no chip when the series has no seriesMemory', () => {
    renderTable({ authors: authorsWith(undefined) });
    expect(screen.queryByTestId('series-memory-chip')).toBeNull();
  });

  it('renders no chip in the Standalones section', () => {
    const authors: LibraryAuthor[] = [
      { name: 'A', series: [{ name: 'S', seriesMemory: SUMMARY,
        books: [makeBook({ bookId: 's1', title: 'Solo', isStandalone: true })] }] },
    ];
    renderTable({ authors });
    expect(screen.queryByTestId('series-memory-chip')).toBeNull();
  });

  it('clicking the chip fires onOpenSeriesMemory without toggling collapse', () => {
    const onOpenSeriesMemory = vi.fn();
    renderTable({ authors: authorsWith(SUMMARY), onOpenSeriesMemory });
    // chip scoped by testid (the section also has the collapse button) — R3-2
    fireEvent.click(screen.getByTestId('series-memory-chip'));
    expect(onOpenSeriesMemory).toHaveBeenCalledTimes(1);
    expect(onOpenSeriesMemory.mock.calls[0][0].name).toBe('Northern Coast Trilogy');
    // collapse did NOT fire: the book row is still present
    expect(screen.getByText('North One')).toBeInTheDocument();
  });
});
