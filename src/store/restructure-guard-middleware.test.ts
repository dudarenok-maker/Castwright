// #3400 pass 6 — while a book's chapter restructure is in flight nothing but the
// restructure (and its remap) may change that book's manuscript.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { configureStore, Tuple } from '@reduxjs/toolkit';

const { putBookState } = vi.hoisted(() => ({
  putBookState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/api', () => ({ api: { putBookState } }));

import { persistenceMiddleware } from './persistence-middleware';
import { restructureGuardMiddleware, REFUSED_WHILE_RESTRUCTURING } from './restructure-guard-middleware';
import { manuscriptSlice, manuscriptActions } from './manuscript-slice';
import { uiSlice, uiActions } from './ui-slice';
import { notificationsSlice } from './notifications-slice';

const sentences = [
  { id: 1, chapterId: 1, characterId: 'wren', text: 'One.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: 'Two.' },
] as never[];

function makeStore() {
  return configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      ui: uiSlice.reducer,
      notifications: notificationsSlice.reducer,
      cast: (s = { characters: [] as unknown[] }) => s,
      changeLog: (s = { events: [] as unknown[] }) => s,
      bookMeta: (s = { draft: null, saved: {} }) => s,
    },
    middleware: () => new Tuple(restructureGuardMiddleware, persistenceMiddleware),
    preloadedState: {
      manuscript: { ...manuscriptSlice.getInitialState(), bookId: 'b1', sentences },
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId: 'b1', view: 'manuscript', currentChapterId: 1 } as never,
      },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  putBookState.mockClear();
});
afterEach(() => vi.useRealTimers());

const edit = () =>
  manuscriptActions.setSentenceCharacter({ chapterId: 1, sentenceId: 1, characterId: 'halloran' });

describe('restructureGuardMiddleware', () => {
  it('refuses a manuscript edit for a book mid-restructure: no state change, no save', async () => {
    const store = makeStore();
    store.dispatch(uiActions.setRestructuringBook('b1'));
    store.dispatch(edit());
    expect(store.getState().manuscript.sentences[0].characterId).toBe('wren');
    await vi.advanceTimersByTimeAsync(2000);
    expect(putBookState).not.toHaveBeenCalled();
  });

  it('applies the same edit once the restructure has ended (control)', async () => {
    const store = makeStore();
    store.dispatch(uiActions.setRestructuringBook('b1'));
    store.dispatch(uiActions.clearRestructuringBook('b1'));
    store.dispatch(edit());
    expect(store.getState().manuscript.sentences[0].characterId).toBe('halloran');
    await vi.advanceTimersByTimeAsync(2000);
    expect(putBookState).toHaveBeenCalledTimes(1);
  });

  it("another book's restructure does not refuse this book's edits (control)", () => {
    const store = makeStore();
    store.dispatch(uiActions.setRestructuringBook('other'));
    store.dispatch(edit());
    expect(store.getState().manuscript.sentences[0].characterId).toBe('halloran');
  });

  it('an edit refused mid-restructure leaves no old-keyed save even if the user then leaves the book', async () => {
    const store = makeStore();
    store.dispatch(uiActions.setRestructuringBook('b1'));
    store.dispatch(edit());
    store.dispatch(uiActions.openBook({ id: 'b2', status: 'voices_pending' }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(putBookState).not.toHaveBeenCalled();
  });

  it('lets the restructure remap and the hydrate actions through while the flag is up', () => {
    const store = makeStore();
    store.dispatch(uiActions.setRestructuringBook('b1'));
    store.dispatch(manuscriptActions.applyChapterRestructure({ sentenceRemap: [] }));
    expect(store.getState().manuscript.sentences).toEqual([]);
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId: 'b1', manuscriptId: 'm1', title: 'T' } as never,
        sentences: sentences as never,
      }),
    );
    expect(store.getState().manuscript.sentences).toHaveLength(2);
  });

  it('every manuscript action is either refused mid-restructure or deliberately let through', () => {
    const LET_THROUGH = [
      'uploadComplete',
      'setImportCandidate',
      'hydrateFromAnalysis',
      'hydrateFromBookState',
      'reset',
      'resetForBook',
      'previewReuploadDiff',
      'discardReupload',
      'applyChapterRestructure',
    ];
    const refused = Object.keys(manuscriptActions)
      .filter((k) => REFUSED_WHILE_RESTRUCTURING.has(`manuscript/${k}`))
      .sort();
    const rest = Object.keys(manuscriptActions)
      .filter((k) => !REFUSED_WHILE_RESTRUCTURING.has(`manuscript/${k}`))
      .sort();
    expect(rest).toEqual([...LET_THROUGH].sort());
    expect(refused.length).toBeGreaterThan(10);
  });
});

describe('the app store wires the guard', () => {
  it('refuses a manuscript edit for a restructuring book through the real store', async () => {
    const { store } = await import('./index');
    store.dispatch(
      manuscriptActions.hydrateFromBookState({
        state: { bookId: 'wired', manuscriptId: 'm1', title: 'T' } as never,
        sentences: sentences as never,
      }),
    );
    store.dispatch(uiActions.setRestructuringBook('wired'));
    store.dispatch(edit());
    expect(store.getState().manuscript.sentences[0].characterId).toBe('wren');
    store.dispatch(uiActions.clearRestructuringBook('wired'));
  });
});
