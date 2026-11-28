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
import { selectEditsLocked } from './restructure-lock';
import { loadedBookSlice } from './loaded-book-slice';
import { loadedPair } from './loaded-book-slice.test-helpers';

const sentences = [
  { id: 1, chapterId: 1, characterId: 'wren', text: 'One.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: 'Two.' },
] as never[];

function makeStore({
  pairBookId = null as string | null,
  sliceBookId = 'b1',
  stageBookId = 'b1' as string | null,
} = {}) {
  return configureStore({
    reducer: {
      loadedBook: loadedBookSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      ui: uiSlice.reducer,
      notifications: notificationsSlice.reducer,
      cast: (s = { characters: [] as unknown[] }) => s,
      changeLog: (s = { events: [] as unknown[] }) => s,
      bookMeta: (s = { draft: null, saved: {} }) => s,
    },
    middleware: () => new Tuple(restructureGuardMiddleware, persistenceMiddleware),
    preloadedState: {
      loadedBook: loadedPair({ bookId: pairBookId }),
      manuscript: { ...manuscriptSlice.getInitialState(), bookId: sliceBookId, sentences },
      ui: {
        ...uiSlice.getInitialState(),
        stage: (stageBookId
          ? { kind: 'ready', bookId: stageBookId, view: 'manuscript', currentChapterId: 1 }
          : { kind: 'books' }) as never,
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

/* #3519 — the stage names no book here, so only the held one can lock. */
describe('which book the restructure lock asks about (#3519)', () => {
  it.each([
    { name: 'the pair names the restructuring book, the manuscript slice another', pair: 'b1', slice: 'other', locked: true },
    { name: 'the pair names another book, the manuscript slice the restructuring one', pair: 'other', slice: 'b1', locked: false },
    { name: 'a reload left the pair empty and restored the restructuring book', pair: null, slice: 'b1', locked: true },
  ])('selectEditsLocked: $name', ({ pair, slice, locked }) => {
    const store = makeStore({ pairBookId: pair, sliceBookId: slice, stageBookId: null });
    store.dispatch(uiActions.setRestructuringBook('b1'));
    expect(selectEditsLocked(store.getState() as never)).toBe(locked);
  });

  it.each([
    { name: 'the pair names the restructuring book, the manuscript slice another', pair: 'b1', slice: 'other', refused: true },
    { name: 'the pair names another book, the manuscript slice the restructuring one', pair: 'other', slice: 'b1', refused: false },
    { name: 'a reload left the pair empty and restored the restructuring book', pair: null, slice: 'b1', refused: true },
  ])('the guard: $name', ({ pair, slice, refused }) => {
    const store = makeStore({ pairBookId: pair, sliceBookId: slice, stageBookId: null });
    store.dispatch(uiActions.setRestructuringBook('b1'));
    store.dispatch(edit());
    expect(store.getState().manuscript.sentences[0].characterId).toBe(refused ? 'wren' : 'halloran');
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
