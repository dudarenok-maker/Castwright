/* ConfirmMetadataView — Book # input behaviour and Submit gating.
   Pairs with docs/features/archive/03-import-confirm-metadata.md. */

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
  title: 'The Hollow Tide',
  author: 'Della Renwick',
  series: 'The Hollow Tide',
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
  author: 'Della Renwick',
  series: 'The Hollow Tide',
  seriesPosition: null,
  isStandalone: false,
  status: 'complete',
  chapterCount: 30,
  completedChapters: 30,
  characterCount: 20,
  voiceCount: 20,
  lastWorkedOn: 'last week',
  coverGradient: ['#000', '#fff'],
  tags: [],
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

  it('matches series case-insensitively (so "the hollow tide" and "Keeper…" collide)', async () => {
    const user = userEvent.setup();
    renderView([
      libraryBook({
        bookId: 'lower-case-series',
        title: 'The Tidewatcher’s Oath',
        series: 'the hollow tide',
        seriesPosition: 3,
      }),
    ]);
    const bookNum = screen.getByPlaceholderText('1');
    await user.type(bookNum, '3');
    expect(screen.getByText(/The Tidewatcher’s Oath/)).toBeInTheDocument();
  });
});

describe('ConfirmMetadataView — seriesFromTitle chip (Bug B)', () => {
  /* The chip appears when the server marks the candidate's series as
     heuristically extracted from the title parenthetical. The user sees
     it next to the SERIES field as a heads-up that the value is a guess.
     Editing the SERIES or BOOK # field clears the flag (and the chip),
     because the user has explicitly verified or corrected the value. */
  function renderWithCandidate(c: Partial<ImportCandidate>) {
    const candidateOverride: ImportCandidate = { ...candidate, ...c };
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        library: librarySlice.reducer,
        ui: uiSlice.reducer,
      },
      preloadedState: {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          importCandidate: candidateOverride,
        },
        library: { loaded: true, authors: [], books: [], pausedSnapshots: {} },
      },
    });
    return render(
      <Provider store={store}>
        <ConfirmMetadataView />
      </Provider>,
    );
  }

  it('renders the chip next to SERIES when seriesFromTitle is true', () => {
    renderWithCandidate({
      seriesFromTitle: true,
      series: 'The Hollow Tide',
      seriesPosition: 3,
      title: 'The Tidewatcher’s Oath',
    });
    expect(screen.getByText(/auto-extracted from title/i)).toBeInTheDocument();
  });

  it('omits the chip when seriesFromTitle is false', () => {
    renderWithCandidate({
      seriesFromTitle: false,
      series: 'The Hollow Tide',
      seriesPosition: 3,
    });
    expect(screen.queryByText(/auto-extracted from title/i)).not.toBeInTheDocument();
  });

  it('omits the chip when seriesFromTitle is undefined (older server build)', () => {
    /* Forward-compat: if the server hasn't been upgraded to emit the
       flag yet, the field is absent — chip stays hidden, no crash. */
    renderWithCandidate({ series: 'The Hollow Tide', seriesPosition: 3 });
    expect(screen.queryByText(/auto-extracted from title/i)).not.toBeInTheDocument();
  });

  it('clears the chip when the user edits the SERIES field', async () => {
    const user = userEvent.setup();
    renderWithCandidate({
      seriesFromTitle: true,
      series: 'The Hollow Tide',
      seriesPosition: 3,
    });
    expect(screen.getByText(/auto-extracted from title/i)).toBeInTheDocument();

    const seriesInput = screen.getByPlaceholderText('e.g. Earthsea');
    await user.type(seriesInput, '!');
    expect(screen.queryByText(/auto-extracted from title/i)).not.toBeInTheDocument();
  });
});

describe('ConfirmMetadataView — fs-2 language selector', () => {
  function renderWithCandidate(c: Partial<ImportCandidate>) {
    const candidateOverride: ImportCandidate = { ...candidate, ...c };
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer,
        library: librarySlice.reducer,
        ui: uiSlice.reducer,
      },
      preloadedState: {
        manuscript: { ...manuscriptSlice.getInitialState(), importCandidate: candidateOverride },
        library: { loaded: true, authors: [], books: [], pausedSnapshots: {} },
      },
    });
    return render(
      <Provider store={store}>
        <ConfirmMetadataView />
      </Provider>,
    );
  }

  it('defaults the selector to English for a Latin manuscript (no chip)', () => {
    renderWithCandidate({ sourceText: 'The quick brown fox jumps over the lazy dog.' });
    const select = screen.getByTestId('confirm-language') as HTMLSelectElement;
    expect(select.value).toBe('en');
    expect(screen.queryByText(/auto-detected russian/i)).not.toBeInTheDocument();
  });

  it('auto-detects Russian from Cyrillic text and shows the chip + Qwen note', () => {
    renderWithCandidate({
      sourceText: 'Съешь же ещё этих мягких французских булок да выпей чаю. Это длинный текст.',
    });
    const select = screen.getByTestId('confirm-language') as HTMLSelectElement;
    expect(select.value).toBe('ru');
    expect(screen.getByText(/auto-detected russian/i)).toBeInTheDocument();
    expect(screen.getByText(/designed Qwen voices/i)).toBeInTheDocument();
  });

  it('clears the auto-detected chip once the user changes the selector', async () => {
    const user = userEvent.setup();
    renderWithCandidate({ sourceText: 'Привет мир, это русский текст для проверки определения.' });
    expect(screen.getByText(/auto-detected russian/i)).toBeInTheDocument();
    const select = screen.getByTestId('confirm-language');
    await user.selectOptions(select, 'en');
    expect(screen.queryByText(/auto-detected russian/i)).not.toBeInTheDocument();
  });
});

describe('ConfirmMetadataView — input theme classes', () => {
  /* Regression: in dark mode `--ink` flips near-white, so an input without
     an explicit `bg-white text-ink` pair gets a browser-default white
     background AND inherits white text — invisible. The codebase's canonical
     pattern (mirrored in src/modals/*, src/views/account.tsx, etc.) is
     `bg-white text-ink`; the styles.css dark-theme redirect flips both
     tokens correctly. */
  it('AUTHOR / SERIES / BOOK # / TITLE inputs carry bg-white + text-ink', () => {
    renderView();
    const author = screen.getByPlaceholderText('e.g. Ursula K. Le Guin');
    const series = screen.getByPlaceholderText('e.g. Earthsea');
    const bookNum = screen.getByPlaceholderText('1');
    const title = screen.getByPlaceholderText('e.g. A Wizard of Earthsea');
    for (const input of [author, series, bookNum, title]) {
      expect(input).toHaveClass('bg-white');
      expect(input).toHaveClass('text-ink');
    }
  });
});
