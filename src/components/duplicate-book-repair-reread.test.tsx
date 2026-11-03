import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import type { AppInfo } from '../lib/types';

const h = vi.hoisted(() => ({ info: null as unknown }));
vi.mock('../lib/use-app-info', () => ({
  useAppInfo: () => ({ info: h.info, error: null, refresh: vi.fn(async () => {}) }),
}));

import { DuplicateBookRepairReread } from './duplicate-book-repair-reread';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
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

/** `stage` is the view the tab is on; the slices hold `openBookId` either way (leaving a book keeps them). */
function makeStore(openBookId: string, manuscriptId: string | null, stage: 'ready' | 'books' = 'ready') {
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
      ui: {
        stage:
          stage === 'ready'
            ? { kind: 'ready', bookId: openBookId, view: 'cast', currentChapterId: 3, openProfileId: null }
            : { kind: 'books' },
      },
    } as never,
    middleware: (gDM) => gDM({ serializableCheck: false, immutableCheck: false }),
  });
  /* The tab loaded this book: its slices carry its identity. */
  store.dispatch(manuscriptActions.resetForBook(openBookId));
  store.dispatch(
    manuscriptActions.hydrateFromBookState({ state: { bookId: openBookId, manuscriptId, title: 'T', chapters: [] } as never } as never),
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

beforeEach(() => {
  vi.useFakeTimers();
  h.info = null;
});
afterEach(() => vi.useRealTimers());

describe('DuplicateBookRepairReread (#3713)', () => {
  it('a repair already in the first /api/info answer changes nothing (the tab loaded after the sweep)', () => {
    h.info = info([repair]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    h.info = info([repair]); // the next poll lists it again
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeUndefined();
  });

  it('a repair that appears later, for the open id: marks a full read of that id and stays on it', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_x');
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
    expect(root(store).ui.stage.bookId).toBe('a__s__t');
  });

  it('a tab that LEFT the book but still holds its slices is marked too (reopening must not trust them)', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_x', 'books');
    expect(root(store).ui.stage.bookId).toBeUndefined();
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
  });

  it('a tab proven to hold the re-minted twin moves to the new id and reads it', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', 'm_loser');
    const view = render(tree(store));
    h.info = info([{ ...repair, reassignedManuscriptId: 'm_loser' }]);
    view.rerender(tree(store));
    expect(root(store).ui.stage.bookId).toBe('a__s__t-2');
    expect(root(store).manuscript.bookId).toBe('a__s__t-2');
    expect(root(store).bookMeta.needsFullRead?.['a__s__t-2']).toBeGreaterThan(0);
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

  it('a tab with no manuscript loaded is not taken for the loser when the record names none', () => {
    h.info = info([]);
    const store = makeStore('a__s__t', null);
    const view = render(tree(store));
    expect(root(store).manuscript.manuscriptId).toBeNull();
    h.info = info([repair]); // reassignedManuscriptId: null
    view.rerender(tree(store));
    expect(root(store).ui.stage.bookId).toBe('a__s__t');
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeGreaterThan(0);
    expect(root(store).bookMeta.needsFullRead?.['a__s__t-2']).toBeUndefined();
  });

  it('a tab on another book is left alone', () => {
    h.info = info([]);
    const store = makeStore('other', 'm_o');
    const view = render(tree(store));
    h.info = info([repair]);
    view.rerender(tree(store));
    expect(root(store).bookMeta.needsFullRead?.['a__s__t']).toBeUndefined();
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
