/* #4199: a plain `#/books/<id>/generate` URL (no `?chapter=`) hydrates the
   default chapter 3; a malformed or absent param must not change that. */

import { Suspense } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
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
vi.mock('../views/generation', () => ({ GenerationView: () => null }));
vi.mock('../store/exports-thunks', async (orig) => ({
  ...(await orig<object>()),
  hydrateBookExports: () => () => Promise.resolve(),
}));

import { ReadyRoute } from './index';

function renderAt(entry: string) {
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
  });
  const ctx = { priorRoster: [], pushToast: vi.fn(), openFixCharacterAudio: vi.fn() };
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[entry]}>
        <Suspense fallback={null}>
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

describe('ReadyRoute chapter fallback', () => {
  it.each([
    ['/books/chain-b2/generate', 3],
    ['/books/chain-b2/generate?chapter=abc', 3],
    ['/books/chain-b2/generate?chapter=8', 8],
  ])('%s hydrates currentChapterId %i', async (entry, expected) => {
    const store = renderAt(entry);
    await waitFor(() => {
      const stage = store.getState().ui.stage;
      expect(stage.kind).toBe('ready');
      expect(stage.kind === 'ready' && stage.currentChapterId).toBe(expected);
    });
  });
});
