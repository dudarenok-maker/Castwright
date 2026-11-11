/* Review of #4082: the stale-rows invariant ("a failed or pending load for a
   different book must not show another book's rows") covers every route that
   renders the one-book cast slice, not only Confirm. */

import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route, Outlet, useNavigate } from 'react-router';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { librarySlice } from '../store/library-slice';
import { queueSlice } from '../store/queue-slice';
import { revisionsSlice } from '../store/revisions-slice';
import { voicesSlice } from '../store/voices-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { accountSlice } from '../store/account-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { persistenceMiddleware } from '../store/persistence-middleware';
import { settingsSlice } from '../store/settings-slice';
import type { Character, LibraryBook } from '../lib/types';

const { getBookStateMock } = vi.hoisted(() => ({ getBookStateMock: vi.fn() }));

vi.mock('../lib/api', () => ({
  api: {
    getBookState: (...a: unknown[]) => getBookStateMock(...a),
    putBookState: vi.fn().mockResolvedValue(undefined),
    matchVoices: () => new Promise(() => {}),
    listBookExports: () => Promise.resolve([]),
  },
  AnalysisError: class extends Error {
    code = 'unknown';
  },
}));
const rows = ({ characters }: { characters: Character[] }) => (
  <ul>
    {characters.map((c) => (
      <li key={c.id}>{c.name}</li>
    ))}
  </ul>
);
vi.mock('../views/cast', () => ({ CastView: (p: { characters: Character[] }) => rows(p) }));
vi.mock('../views/listen', () => ({ ListenView: (p: { characters: Character[] }) => rows(p) }));
vi.mock('../store/exports-thunks', async (orig) => ({
  ...(await orig<object>()),
  hydrateBookExports: () => () => Promise.resolve(),
}));

import { ReadyRoute } from './index';

let navigateTo: (to: string) => void = () => {};
function NavProbe() {
  navigateTo = useNavigate();
  return null;
}

function renderAt(view: string, sliceBookId: string | null, reply?: unknown, listedIds: string[] = []) {
  getBookStateMock.mockReset();
  if (reply === undefined) getBookStateMock.mockRejectedValue(new Error('proxy down'));
  else getBookStateMock.mockResolvedValue(reply);
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
    },
    middleware: (gDM) =>
      gDM({ serializableCheck: false, immutableCheck: false }).concat(persistenceMiddleware),
    preloadedState: {
      cast: {
        characters: [
          { id: 'm', name: 'Maerin from Legacy Book 1', voiceState: 'generated' } as Character,
        ],
        renderedFallbackByCharacter: {},
      },
      manuscript: { ...manuscriptSlice.getInitialState(), bookId: sliceBookId },
      library: {
        ...librarySlice.getInitialState(),
        books: listedIds.map((bookId) => ({ bookId, title: bookId }) as LibraryBook),
      },
    },
  });
  const ctx = { priorRoster: [], pushToast: vi.fn(), openFixCharacterAudio: vi.fn() };
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/books/chain-b2/${view}`]}>
        <NavProbe />
        <Suspense fallback={<div data-testid="suspense" />}>
          <Routes>
            <Route element={<Outlet context={ctx} />}>
              <Route path="/books/:bookId/:view" element={<ReadyRoute />} />
            </Route>
          </Routes>
        </Suspense>
      </MemoryRouter>
    </Provider>,
  );
  return store;
}

describe.each(['cast', 'listen'])("ReadyRoute %s — never shows another book's cast", (view) => {
  it('shows a loading state while the slice names a different book', async () => {
    renderAt(view, 'legacy-b1');
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByText('Maerin from Legacy Book 1')).toBeNull();
  });

  it('renders the rows once the slice names this book', async () => {
    renderAt(view, 'chain-b2');
    expect(await screen.findByText('Maerin from Legacy Book 1')).toBeTruthy();
  });
});

describe.each(['cast', 'listen', 'generate'])('ReadyRoute %s — a book the server does not have', (view) => {
  it('shows a not-found message with a way back instead of loading forever', async () => {
    renderAt(view, null, null);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /library/i })).toBeTruthy();
  });
});

describe('ReadyRoute — not-found edge cases', () => {
  it('does not report a rejected read (server down) as a missing book', async () => {
    renderAt('cast', 'legacy-b1');
    await waitFor(() => expect(getBookStateMock).toHaveBeenCalled());
    /* let the rejection travel through readWithRetry and the hook's catch */
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it("does not carry book A's not-found flag over to book B", async () => {
    renderAt('cast', 'legacy-b1', null);
    expect(await screen.findByRole('alert')).toBeTruthy();
    getBookStateMock.mockReset();
    getBookStateMock.mockRejectedValue(new Error('proxy down'));
    act(() => navigateTo('/books/other-b/cast'));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says it could not be opened, not renamed or deleted, for a book the library lists', async () => {
    renderAt('cast', 'legacy-b1', null, ['chain-b2']);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/couldn't open this book/i)).toBeTruthy();
    expect(screen.queryByText(/renamed or deleted/i)).toBeNull();
  });

  it('keeps the renamed-or-deleted wording for a book the library does not list', async () => {
    renderAt('cast', 'legacy-b1', null);
    expect(await screen.findByText(/renamed or deleted/i)).toBeTruthy();
  });

  it("keeps the alert when Layout's null branch then stamps the book's identity on the slices", async () => {
    const store = renderAt('cast', 'legacy-b1', null);
    expect(await screen.findByRole('alert')).toBeTruthy();
    /* what Layout's resetBookSlices does on a null read */
    act(() => {
      store.dispatch(manuscriptActions.resetForBook('chain-b2'));
    });
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
