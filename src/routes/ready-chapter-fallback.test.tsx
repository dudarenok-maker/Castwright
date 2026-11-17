/* #4199: a plain `#/books/<id>/generate` URL (no `?chapter=`) hydrates the
   default chapter 3; a malformed or absent param must not change that. */

import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { configureStore, type Middleware } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Routes, Route, Outlet, useNavigate } from 'react-router';
import { uiSlice, uiActions } from '../store/ui-slice';
import { store as singleton } from '../store';
import { stageToHash } from '../lib/router';
import type { Stage } from '../lib/types';
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

const nav: { go: (to: string) => void } = { go: () => {} };
function NavCapture() {
  const navigate = useNavigate();
  nav.go = (to) => navigate(to);
  return null;
}

function renderAt(entry: string) {
  const hydrations: Stage[] = [];
  const recorder = () => (next: (a: unknown) => unknown) => (action: unknown) => {
    const a = action as { type?: string; payload?: Stage };
    if (a.type === uiActions.hydrateFromUrl.type && a.payload) hydrations.push(a.payload);
    return next(action);
  };
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
      gDM({ serializableCheck: false, immutableCheck: false }).concat(persistenceMiddleware, recorder as unknown as Middleware),
  });
  const ctx = { priorRoster: [], pushToast: vi.fn(), openFixCharacterAudio: vi.fn() };
  render(
    <Provider store={store}>
      <MemoryRouter initialEntries={[entry]}>
        <NavCapture />
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
  return Object.assign(store, { hydrations });
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

  /* #4212: chapterExplicit follows the URL and round-trips through stageToHash. */
  it.each([
    ['/books/chain-b2/generate?chapter=3', 3, true, '?chapter=3'],
    ['/books/chain-b2/generate', 3, false, ''],
    ['/books/chain-b2/generate?chapter=abc', 3, false, ''],
    ['/books/chain-b2/generate?chapter=8', 8, true, '?chapter=8'],
  ])('%s hydrates chapterExplicit and round-trips', async (entry, id, explicit, query) => {
    const store = renderAt(entry);
    await waitFor(() => {
      const stage = store.getState().ui.stage;
      expect(stage.kind === 'ready' && stage.currentChapterId).toBe(id);
      expect(stage.kind === 'ready' && stage.chapterExplicit).toBe(explicit);
    });
    expect(stageToHash(store.getState().ui.stage)).toBe(`#/books/chain-b2/generate${query}`);
  });

  describe('stale persisted stage in the singleton store', () => {
    const seed = (extra: { chapterExplicit?: boolean }) =>
      singleton.dispatch(
        uiActions.hydrateFromUrl({
          kind: 'ready',
          bookId: 'chain-b2',
          view: 'generate',
          currentChapterId: 3,
          openProfileId: null,
          ...extra,
        }),
      );
    afterEach(() => singleton.dispatch(uiActions.hydrateFromUrl({ kind: 'books' })));

    it('explicit persisted stage + plain URL hydrates chapterExplicit false', async () => {
      seed({ chapterExplicit: true });
      const store = renderAt('/books/chain-b2/generate');
      await waitFor(() => expect(store.hydrations).toHaveLength(1));
      const stage = store.getState().ui.stage;
      expect(stage.kind === 'ready' && stage.chapterExplicit).toBe(false);
    });

    it('pre-#4212 persisted stage (no key) + ?chapter=3 hydrates chapterExplicit true', async () => {
      seed({});
      const store = renderAt('/books/chain-b2/generate?chapter=3');
      await waitFor(() => expect(store.hydrations).toHaveLength(1));
      const stage = store.getState().ui.stage;
      expect(stage.kind === 'ready' && stage.chapterExplicit).toBe(true);
    });
  });

  it('re-render in place between plain and ?chapter=3 (same id) makes the flag follow', async () => {
    const store = renderAt('/books/chain-b2/generate');
    const flag = () => {
      const stage = store.getState().ui.stage;
      return stage.kind === 'ready' ? stage.chapterExplicit : undefined;
    };
    await waitFor(() => expect(flag()).toBe(false));
    act(() => nav.go('/books/chain-b2/generate?chapter=3'));
    await waitFor(() => expect(flag()).toBe(true));
    act(() => nav.go('/books/chain-b2/generate'));
    await waitFor(() => expect(flag()).toBe(false));
  });
});
