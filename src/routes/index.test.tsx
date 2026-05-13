// Pairs with docs/features/00-stage-machine.md and 21-book-library.md
//
// Regression for the "No manuscript loaded" banner that appeared on the
// Analysing screen after a page refresh / deep link / confirm→reanalyse:
// AnalysingRoute used to read manuscriptId only from ui.stage, which gets
// clobbered to null by useHydrateStage. The fix is to fall back to the
// manuscript slice (populated by Layout's book-state hydration) and the
// library entry.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { uiSlice, uiActions } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { librarySlice, libraryActions } from '../store/library-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { voicesSlice } from '../store/voices-slice';
import { AnalysingRoute } from './index';
import type { LibraryBook } from '../lib/types';

const analyseMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    analyseManuscript: (manuscriptId: string, opts: unknown) => {
      analyseMock(manuscriptId, opts);
      /* Never resolves — keeps the AnalysingView effect parked in its
         loading state without flushing a setState after the test asserts. */
      return new Promise(() => {});
    },
  },
  AnalysisError: class extends Error {
    code = 'unknown';
    detail?: string;
  },
}));

function makeStore() {
  return configureStore({
    reducer: {
      ui:         uiSlice.reducer,
      cast:       castSlice.reducer,
      chapters:   chaptersSlice.reducer,
      revisions:  revisionsSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      library:    librarySlice.reducer,
      voices:     voicesSlice.reducer,
    },
  });
}

function makeBook(over: Partial<LibraryBook> = {}): LibraryBook {
  return {
    bookId: 'b1',
    title: 'Bonus Keefe Story',
    author: 'Shannon Messenger',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    status: 'analysing',
    manuscriptId: 'mns-from-library',
    chapterCount: 4,
    completedChapters: 0,
    characterCount: 0,
    voiceCount: 0,
    progress: 0,
    lastWorkedOn: 'just now',
    coverGradient: ['#3C194F', '#0F0E0D'],
    ...over,
  } as LibraryBook;
}

function renderAtAnalysing(store: ReturnType<typeof makeStore>) {
  return render(
    <Provider store={store}>
      <MemoryRouter initialEntries={['/books/b1/analysing']}>
        <Routes>
          <Route path="/books/:bookId/analysing" element={<AnalysingRoute/>}/>
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
}

beforeEach(() => {
  analyseMock.mockClear();
});

describe('AnalysingRoute manuscriptId derivation', () => {
  it('uses manuscript.manuscriptId when stage.manuscriptId is null (page-refresh path)', () => {
    /* Simulates: user refreshes /books/b1/analysing. useHydrateStage
       resets stage.manuscriptId to null; Layout's book-state hydration
       later seeds the manuscript slice from state.json. */
    const store = makeStore();
    store.dispatch(manuscriptActions.hydrateFromBookState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: { bookId: 'b1', manuscriptId: 'mns-real', title: 'Bonus Keefe Story' } as any,
      sentences: null,
      wordCount: 2440,
      format: 'plaintext',
    }));

    renderAtAnalysing(store);

    expect(screen.queryByText(/No manuscript loaded/i)).toBeNull();
    expect(analyseMock).toHaveBeenCalledTimes(1);
    expect(analyseMock).toHaveBeenCalledWith('mns-real', expect.any(Object));
  });

  it('falls back to library.book.manuscriptId before the manuscript slice has hydrated', () => {
    /* Simulates: user clicks an analysing book from the library, but the
       per-book hydration GET hasn't landed yet. library.books[i].manuscriptId
       is the only id in flight; AnalysingRoute should still feed it through. */
    const store = makeStore();
    store.dispatch(libraryActions.hydrate({
      authors: [{
        name: 'Shannon Messenger',
        series: [{ name: 'Standalones', books: [makeBook({ manuscriptId: 'mns-from-library' })] }],
      }],
    }));

    renderAtAnalysing(store);

    expect(screen.queryByText(/No manuscript loaded/i)).toBeNull();
    expect(analyseMock).toHaveBeenCalledWith('mns-from-library', expect.any(Object));
  });

  it('prefers stage.manuscriptId when it is set (post-upload path)', () => {
    /* Simulates: user just finished upload → manuscriptUploaded set
       stage.manuscriptId. The manuscript slice may also carry the same id
       from uploadComplete, but stage takes precedence. */
    const store = makeStore();
    store.dispatch(uiActions.startNewBook());
    store.dispatch(uiActions.manuscriptUploaded({ bookId: 'b1', manuscriptId: 'mns-from-upload' }));
    store.dispatch(manuscriptActions.hydrateFromBookState({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: { bookId: 'b1', manuscriptId: 'mns-real', title: 'Bonus Keefe Story' } as any,
      sentences: null,
      wordCount: 2440,
      format: 'plaintext',
    }));

    renderAtAnalysing(store);

    expect(screen.queryByText(/No manuscript loaded/i)).toBeNull();
    expect(analyseMock).toHaveBeenCalledWith('mns-from-upload', expect.any(Object));
  });

  it('still surfaces the "No manuscript loaded" banner when every source is empty', () => {
    /* Sanity check: with no library entry and no hydrated manuscript slice,
       the user really does need to start over. Banner must still appear so
       they have a recoverable action. */
    const store = makeStore();
    renderAtAnalysing(store);

    expect(screen.getByText(/No manuscript loaded/i)).toBeInTheDocument();
    expect(analyseMock).not.toHaveBeenCalled();
  });
});
