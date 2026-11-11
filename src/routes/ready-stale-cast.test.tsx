/* Review of #4082: the stale-rows invariant ("a failed or pending load for a
   different book must not show another book's rows") covers every route that
   renders the one-book cast slice, not only Confirm. */

import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
import { persistenceMiddleware } from '../store/persistence-middleware';
import { settingsSlice } from '../store/settings-slice';
import type { Character } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getBookState: () => Promise.reject(new Error('proxy down')),
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

function renderAt(view: string, sliceBookId: string | null) {
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
    },
  });
  const ctx = { priorRoster: [], pushToast: vi.fn(), openFixCharacterAudio: vi.fn() };
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[`/books/chain-b2/${view}`]}>
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
