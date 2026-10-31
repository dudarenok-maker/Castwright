import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import type { AppInfo, Character } from '../lib/types';

const h = vi.hoisted(() => ({ info: null as unknown, putBookState: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: vi.fn(async () => {}) }),
}));
vi.mock('../lib/api', () => ({ api: { putBookState: h.putBookState } }));

import { DuplicateBookRepairReread } from './duplicate-book-repair-reread';
import { persistenceMiddleware, beginFullRead, learnSliceRevisions } from '../store/persistence-middleware';
import { uiSlice } from '../store/ui-slice';
import { castSlice, castActions } from '../store/cast-slice';
import { manuscriptSlice, manuscriptActions } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { bookMetaSlice } from '../store/book-meta-slice';
import { notificationsSlice } from '../store/notifications-slice';

const repair = {
  previousBookId: 'a__s__t',
  newBookId: 'a__s__t-2',
  keptFolder: 'A/S/T2',
  reassignedFolder: 'A/S/T',
  reassignedManuscriptId: null as string | null,
};
const info = (repairs: (typeof repair)[]): AppInfo =>
  ({
    appVersion: '1.8.0',
    sidecarVersion: null,
    schemas: {},
    lastSeenAppVersion: null,
    showWhatsNew: false,
    releaseNotes: '',
    duplicateBookIdRepairs: repairs,
  }) as AppInfo;

const eliza = (name: string) => ({ id: 'c1', name, role: '', color: 'narrator' }) as Character;

function makeStore(openBookId: string, manuscriptId: string | null) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      chapters: chaptersSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
      notifications: notificationsSlice.reducer,
    } as never,
    preloadedState: {
      ui: { stage: { kind: 'ready', bookId: openBookId, view: 'cast', currentChapterId: 3, openProfileId: null } },
    } as never,
    middleware: (gDM) => gDM({ serializableCheck: false, immutableCheck: false }).concat(persistenceMiddleware),
  });
  /* The tab loaded this book: its slices carry its identity. */
  store.dispatch(manuscriptActions.resetForBook(openBookId));
  store.dispatch(
    manuscriptActions.hydrateFromBookState({ state: { manuscriptId, title: 'T', chapters: [] } as never } as never),
  );
  return store;
}
type S = ReturnType<typeof makeStore>;
const root = (store: S) =>
  store.getState() as unknown as {
    ui: { stage: { bookId?: string } };
    bookMeta: { needsFullRead?: Record<string, number> };
    manuscript: { manuscriptId: string | null; bookId: string | null };
  };

const tree = (store: S) => (
  <Provider store={store as never}>
    <DuplicateBookRepairReread />
  </Provider>
);
const castPuts = () => h.putBookState.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'cast');
const setCast = (store: S, name: string) => act(() => void store.dispatch(castActions.setCharacters([eliza(name)])));

beforeEach(() => {
  vi.useFakeTimers();
  h.putBookState.mockClear();
  h.info = null;
});
afterEach(() => vi.useRealTimers());

describe('DuplicateBookRepairReread (#3713)', () => {
  it('a repair already in the first /api/info answer changes nothing (the tab loaded after the sweep)', async () => {
    h.info = info([repair]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    h.info = info([repair]); // the next poll lists it again
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeUndefined();
    setCast(store, 'Eliza');
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(castPuts()).toHaveLength(1);
  });

  it('a repair that appears later, for the open id: marks a full read and sends no stale cast save', async () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    /* A cast edit already queued in its debounce when the repair is learned. */
    setCast(store, 'Stale');
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
    expect(root(store).ui.stage.bookId).toBe('a__s__t'); // cannot tell which twin: stays on the id
    setCast(store, 'Stale again');
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(castPuts()).toHaveLength(0);
  });

  it('saves resume once the re-read lands (a full read begun after the hold)', async () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    const seq = store.dispatch(beginFullRead('a__s__t') as never) as unknown as number;
    store.dispatch(learnSliceRevisions('a__s__t', undefined, seq) as never);
    setCast(store, 'Fresh');
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(castPuts()).toHaveLength(1);
  });

  it('a tab proven to hold the re-minted twin moves to the new id and sends nothing stale', async () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_loser');
    const view = render(tree(store));
    setCast(store, 'Stale');
    h.info = info([{ ...repair, reassignedManuscriptId: 'm_loser' }]);
    view.rerender(tree(store));
    expect(root(store).ui.stage.bookId).toBe('a__s__t-2');
    expect(root(store).manuscript.bookId).toBe('a__s__t-2');
    expect(root(store).bookMeta.needsFullRead?.['a__s__t-2']).toBeGreaterThan(0);
    setCast(store, 'Stale again');
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(h.putBookState).not.toHaveBeenCalled();
  });

  it("a tab whose manuscriptId is not the loser's (the kept twin) re-reads the same id", () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_winner');
    const view = render(tree(store));
    h.info = info([{ ...repair, reassignedManuscriptId: 'm_loser' }]);
    view.rerender(tree(store));
    expect(root(store).ui.stage.bookId).toBe('a__s__t');
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
  });

  it('a tab open on another book is left alone', async () => {
    h.info = info([]);
    const store = makeStore('other', 'm_o');
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeUndefined();
    setCast(store, 'Eliza');
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(castPuts()).toHaveLength(1);
  });

  it('acts once per repair: a later poll that lists it again does nothing more', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    const mark = root(store).bookMeta.needsFullRead?.['a__s__t'];
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBe(mark);
  });
});
