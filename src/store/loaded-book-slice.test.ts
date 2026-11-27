import { configureStore } from '@reduxjs/toolkit';
import { describe, expect, it } from 'vitest';
import {
  loadedBookSlice,
  selectLoadedBook,
  selectLoadedBookMatchesStage,
  selectEditsGated,
} from './loaded-book-slice';
import { manuscriptSlice, manuscriptActions } from './manuscript-slice';
import { castSlice, castActions } from './cast-slice';
import { uiSlice, uiActions } from './ui-slice';
import { store as appStore } from './index';
import type { AnalyseResponse, BookStateJson, UploadResponse } from '../lib/types';

/* #3519 — the one record of which book the cast, chapters and manuscript
   slices hold. It moves only on the manuscript slice's own identity actions. */

function makeStore() {
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      loadedBook: loadedBookSlice.reducer,
    },
  });
}

const hydrate = (bookId: string, manuscriptId: string) =>
  manuscriptActions.hydrateFromBookState({
    state: { bookId, manuscriptId, title: 'A title' } as BookStateJson,
    sentences: null,
  });

const analysis = (bookId?: string) =>
  manuscriptActions.hydrateFromAnalysis({ bookId, sentences: [] } as unknown as AnalyseResponse);

const upload = (manuscriptId: string) =>
  manuscriptActions.uploadComplete({
    manuscriptId,
    title: 'New upload',
    format: 'plaintext',
    wordCount: 10,
    sourceText: 'text',
  } as UploadResponse);

const pair = (store: ReturnType<typeof makeStore>) => selectLoadedBook(store.getState());

describe('loadedBook slice', () => {
  it('starts with no book', () => {
    expect(pair(makeStore())).toEqual({ loadedBookId: null, loadedManuscriptId: null });
  });

  it('is registered in the app root reducer', () => {
    expect(appStore.getState().loadedBook).toEqual({
      loadedBookId: null,
      loadedManuscriptId: null,
    });
  });

  it('hydrateFromBookState sets both ids', () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    expect(pair(store)).toEqual({ loadedBookId: 'b1', loadedManuscriptId: 'm1' });
    store.dispatch(hydrate('b2', 'm2'));
    expect(pair(store)).toEqual({ loadedBookId: 'b2', loadedManuscriptId: 'm2' });
  });

  it('hydrateFromAnalysis sets only the book id', () => {
    const store = makeStore();
    store.dispatch(upload('m1'));
    store.dispatch(analysis('b1'));
    expect(pair(store)).toEqual({ loadedBookId: 'b1', loadedManuscriptId: 'm1' });
  });

  it('hydrateFromAnalysis without a bookId leaves the pair alone', () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    store.dispatch(analysis(undefined));
    expect(pair(store)).toEqual({ loadedBookId: 'b1', loadedManuscriptId: 'm1' });
  });

  it('resetForBook stamps the book id and drops the manuscript id', () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    store.dispatch(manuscriptActions.resetForBook('b2'));
    expect(pair(store)).toEqual({ loadedBookId: 'b2', loadedManuscriptId: null });
  });

  it("uploadComplete clears the previous book id and takes the upload's manuscript id", () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    store.dispatch(upload('m2'));
    expect(pair(store)).toEqual({ loadedBookId: null, loadedManuscriptId: 'm2' });
  });

  it('reset clears both', () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    store.dispatch(manuscriptActions.reset());
    expect(pair(store)).toEqual({ loadedBookId: null, loadedManuscriptId: null });
  });

  /* The library's re-parse and manuscript-replace handlers (routes/index.tsx)
     dispatch this exact sequence for the held book. */
  it('the re-parse sequence clears both', () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    store.dispatch(castActions.hydrateCharacters([]));
    store.dispatch(manuscriptActions.reset());
    expect(pair(store)).toEqual({ loadedBookId: null, loadedManuscriptId: null });
  });
});

describe('selectLoadedBookMatchesStage', () => {
  const ready = (bookId: string) => uiActions.openBook({ id: bookId, status: 'complete' });

  it('true when the stage names the loaded book', () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    store.dispatch(ready('b1'));
    expect(selectLoadedBookMatchesStage(store.getState())).toBe(true);
  });

  it('false when the stage names another book', () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    store.dispatch(ready('b2'));
    expect(selectLoadedBookMatchesStage(store.getState())).toBe(false);
  });

  it('false when the stage names a book and nothing is loaded', () => {
    const store = makeStore();
    store.dispatch(ready('b1'));
    expect(selectLoadedBookMatchesStage(store.getState())).toBe(false);
  });

  it('null when the stage names no book, whatever is loaded', () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    store.dispatch(uiActions.goHome());
    expect(selectLoadedBookMatchesStage(store.getState())).toBeNull();
  });

  /* An analysing stage can name its book by manuscriptId alone. */
  it('matches an analysing stage on the manuscript id when there is no book id', () => {
    const analysing = (manuscriptId: string, loadedManuscriptId: string | null) => ({
      ui: { stage: { kind: 'analysing', manuscriptId } },
      loadedBook: { loadedBookId: null, loadedManuscriptId },
    });
    expect(selectLoadedBookMatchesStage(analysing('m1', 'm1'))).toBe(true);
    expect(selectLoadedBookMatchesStage(analysing('m2', 'm1'))).toBe(false);
    expect(selectLoadedBookMatchesStage(analysing('m1', null))).toBe(false);
  });
});

describe('selectEditsGated', () => {
  const loadedB1 = () => {
    const store = makeStore();
    store.dispatch(hydrate('b1', 'm1'));
    return store;
  };

  it.each(['complete', 'cast_pending'] as const)(
    'true on a mismatch (a %s book opens on ready or confirm)',
    (status) => {
      const store = loadedB1();
      store.dispatch(uiActions.openBook({ id: 'b2', status }));
      expect(store.getState().ui.stage.kind).toBe(status === 'complete' ? 'ready' : 'confirm');
      expect(selectEditsGated(store.getState())).toBe(true);
    },
  );

  it.each(['complete', 'cast_pending'] as const)('false when the %s book is the loaded one', (status) => {
    const store = loadedB1();
    store.dispatch(uiActions.openBook({ id: 'b1', status }));
    expect(selectEditsGated(store.getState())).toBe(false);
  });

  /* Analysing legitimately starts on empty slices and grows them. */
  it('false on the analysing stage, even on a mismatch', () => {
    const store = loadedB1();
    store.dispatch(uiActions.openBook({ id: 'b2', status: 'analysing', manuscriptId: 'm2' }));
    expect(store.getState().ui.stage.kind).toBe('analysing');
    expect(selectLoadedBookMatchesStage(store.getState())).toBe(false);
    expect(selectEditsGated(store.getState())).toBe(false);
  });

  it.each(['books', 'upload', 'account'])('false on the %s stage', (kind) => {
    const state = {
      ui: { stage: { kind } },
      loadedBook: { loadedBookId: 'b1', loadedManuscriptId: 'm1' },
    };
    expect(selectEditsGated(state)).toBe(false);
  });
});
