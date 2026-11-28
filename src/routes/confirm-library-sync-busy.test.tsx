/* #4564 (PR #4862 review pass 2) — the 409 `book_busy` backstop toast, driven through the REAL
   ConfirmCastView inside ConfirmRoute (a real click on Confirm cast). The book on screen starts
   analysing server-side only: this client has no era, no snapshot and no busy cache for it, so
   the view offers the sync and sends it. The server refuses naming the busy book; the toast must
   name that book, not the library book the row is matched to. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route } from 'react-router';
import { uiSlice, uiActions } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { queueSlice } from '../store/queue-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { voicesSlice } from '../store/voices-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { persistenceMiddleware } from '../store/persistence-middleware';
import { settingsSlice } from '../store/settings-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { analysisSlice } from '../store/analysis-slice';
import { bookBusySlice } from '../store/book-busy-slice';
import { castGateMiddleware } from '../store/cast-gate';
import type { Character } from '../lib/types';

const BOOK_ID = 'castwright__standalones__book-two';
const LIBRARY_BOOK_ID = 'castwright__standalones__book-one';

const { getBookStateMock, getBookBusyMock, overrideLibraryCastMock } = vi.hoisted(() => ({
  getBookStateMock: vi.fn(),
  getBookBusyMock: vi.fn(),
  overrideLibraryCastMock: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: {
    getBookBusy: (...args: unknown[]) => getBookBusyMock(...args),
    overrideLibraryCast: (...args: unknown[]) => overrideLibraryCastMock(...args),
    getBookState: (bookId: string, signal?: AbortSignal) => getBookStateMock(bookId, signal),
    putBookState: vi.fn().mockResolvedValue(undefined),
    matchVoices: () => new Promise(() => {}),
  },
  AnalysisError: class extends Error {
    code = 'unknown';
  },
}));

vi.mock('../hooks/use-local-analyzer-guard', () => ({
  useLocalAnalyzerGuard: () => ({ guard: (fn: () => void) => fn(), modal: null }),
}));

import { ConfirmRoute } from './index';

const SERVER_SENTENCE = 'This book is busy (analysing). Its cast is read-only until the analysis finishes.';
const WREN = {
  id: 'wren',
  name: 'Wren',
  role: 'protagonist',
  color: 'wren',
  voiceState: 'reused',
  matchedFrom: { bookTitle: 'Book One', bookId: LIBRARY_BOOK_ID, characterId: 'wren_lib', confidence: 0.5 },
} as unknown as Character;

function makeStore() {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      chapters: chaptersSlice.reducer,
      revisions: revisionsSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      library: librarySlice.reducer,
      voices: voicesSlice.reducer,
      changeLog: changeLogSlice.reducer,
      account: accountSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      queue: queueSlice.reducer,
      settings: settingsSlice.reducer,
      analysis: analysisSlice.reducer,
      bookBusy: bookBusySlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (gDM) => gDM().concat(persistenceMiddleware, castGateMiddleware),
    preloadedState: { cast: { characters: [WREN], renderedFallbackByCharacter: {} } as never },
  });
  store.dispatch(uiActions.openBook({ id: BOOK_ID, status: 'cast_pending' }));
  store.dispatch(
    manuscriptSlice.actions.hydrateFromBookState({
      state: { bookId: BOOK_ID, manuscriptId: 'm2', title: 'Book Two' } as never,
      sentences: null,
    }),
  );
  return store;
}

beforeEach(() => {
  getBookStateMock.mockReset();
  getBookBusyMock.mockReset();
  overrideLibraryCastMock.mockReset();
  getBookBusyMock.mockResolvedValue([]);
  getBookStateMock.mockResolvedValue({
    state: { bookId: BOOK_ID, chapters: [] },
    cast: { characters: [WREN] },
  });
});

async function confirmWithSync(store: ReturnType<typeof makeStore>) {
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/books/${BOOK_ID}/confirm`]}>
        <Routes>
          <Route path="/books/:bookId/confirm" element={<ConfirmRoute />} />
        </Routes>
      </MemoryRouter>
    </Provider>,
  );
  await waitFor(() => expect(getBookStateMock).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole('checkbox', { name: /Sync profile with Book One/ }));
  fireEvent.click(screen.getByRole('button', { name: /Confirm cast and design voices/ }));
  await waitFor(() => expect(overrideLibraryCastMock).toHaveBeenCalledTimes(1));
}

const syncToasts = (store: ReturnType<typeof makeStore>) =>
  store.getState().notifications.toasts.filter((t) => /Profile sync not applied/.test(t.message));

describe('Confirm cast — library sync refused 409 book_busy (real view)', () => {
  it('names the book on screen when the server says it is the busy one', async () => {
    overrideLibraryCastMock.mockRejectedValue(
      Object.assign(new Error(SERVER_SENTENCE), { code: 'book_busy', bookId: BOOK_ID }),
    );
    const store = makeStore();
    await confirmWithSync(store);
    await waitFor(() => expect(syncToasts(store)).toHaveLength(1));
    expect(syncToasts(store)[0].message).toContain('"Book Two" is re-analysing');
    expect(syncToasts(store)[0].message).not.toContain('Book One');
  });

  it('names the library book when the server says that one is busy', async () => {
    overrideLibraryCastMock.mockRejectedValue(
      Object.assign(new Error(SERVER_SENTENCE), { code: 'book_busy', bookId: LIBRARY_BOOK_ID }),
    );
    const store = makeStore();
    await confirmWithSync(store);
    await waitFor(() => expect(syncToasts(store)).toHaveLength(1));
    expect(syncToasts(store)[0].message).toContain('"Book One" is re-analysing');
    expect(syncToasts(store)[0].message).not.toContain('Book Two');
  });
});
