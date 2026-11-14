/* R57 (PR #4103 pass 5b) — the server refuses an add-from-roster (it mints a new cast row)
   with 409 `book_busy` while an analysis runs (R55). A stale tab or a second device that
   still offers it takes the read-only path (`handleCastIdentityBusy`): the read-only toast
   and the era latched, not the generic "Couldn't add" toast. */

import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router';
import { uiSlice } from '../store/ui-slice';
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
import { notificationsSlice } from '../store/notifications-slice';
import { settingsSlice } from '../store/settings-slice';
import type { Character, LibraryBook } from '../lib/types';

const { addFromSeriesRosterMock } = vi.hoisted(() => ({ addFromSeriesRosterMock: vi.fn() }));

vi.mock('../lib/api', () => ({
  api: {
    getBookState: () => new Promise(() => {}),
    getBookBusy: () => Promise.resolve(['analysis']),
    putBookState: vi.fn().mockResolvedValue(undefined),
    matchVoices: () => new Promise(() => {}),
    listBookExports: () => Promise.resolve([]),
    addFromSeriesRoster: (...a: unknown[]) => addFromSeriesRosterMock(...a),
  },
  AnalysisError: class extends Error {
    code = 'unknown';
  },
}));
vi.mock('../views/manuscript', () => ({
  ManuscriptView: (p: { onAddFromSeriesRoster?: (e: unknown) => Promise<string> }) => (
    <button
      data-testid="stub-add-from-roster"
      onClick={() =>
        void p
          .onAddFromSeriesRoster?.({ id: 'linnet', name: 'Councillor Linnet', bookId: 'b-prior', bookTitle: 'Book One' })
          .catch(() => {})
      }
    />
  ),
}));

import { ReadyRoute } from './index';

describe('R57: ReadyRoute manuscript — an add-from-roster answered 409 book_busy', () => {
  it('takes the read-only path, not the generic error toast', async () => {
    addFromSeriesRosterMock.mockRejectedValueOnce(
      Object.assign(new Error('This book is busy (analysing).'), { code: 'book_busy' }),
    );
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
        notifications: notificationsSlice.reducer,
      },
      middleware: (gDM) => gDM({ serializableCheck: false, immutableCheck: false }),
      preloadedState: {
        cast: {
          characters: [{ id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' } as Character],
          renderedFallbackByCharacter: {},
        },
        manuscript: { ...manuscriptSlice.getInitialState(), bookId: 'b-r57' },
        library: {
          ...librarySlice.getInitialState(),
          books: [{ bookId: 'b-r57', title: 'b-r57' } as LibraryBook],
        },
      },
    });
    const pushToast = vi.fn();
    render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books/b-r57/manuscript']}>
          <Suspense fallback={<div data-testid="suspense" />}>
            <Routes>
              <Route element={<Outlet context={{ priorRoster: [], pushToast, openFixCharacterAudio: vi.fn() }} />}>
                <Route path="/books/:bookId/:view" element={<ReadyRoute />} />
              </Route>
            </Routes>
          </Suspense>
        </MemoryRouter>
      </Provider>,
    );
    fireEvent.click(await screen.findByTestId('stub-add-from-roster'));
    await waitFor(() =>
      expect(store.getState().notifications.toasts.map((t) => t.dedupeKey)).toContain('cast-read-only'),
    );
    expect(addFromSeriesRosterMock).toHaveBeenCalledWith({ bookId: 'b-r57', targetBookId: 'b-prior', targetCharacterId: 'linnet' });
    expect(pushToast).not.toHaveBeenCalled();
    expect(store.getState().cast.analysisEra?.['b-r57']).toBeDefined();
  });
});
