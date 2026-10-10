/* Plan 286 / #3400 review — approving a preview for book A while book B is
   open must not write A's change-log event into B's change log. Drives the
   thunk through a store with the real persistence middleware (which saves the
   change log to the CURRENTLY OPEN book) and checks every putBookState call. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { PutStateRequest } from '../lib/types';

const { putBookState } = vi.hoisted(() => ({
  putBookState: vi.fn(async (_bookId: string, _req: PutStateRequest) => {}),
}));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), api: { putBookState } }));

import { persistenceMiddleware, flushBookPersistence } from './persistence-middleware';
import { uiSlice, uiActions, type PreviewRegenCtx } from './ui-slice';
import { castSlice } from './cast-slice';
import { changeLogSlice } from './change-log-slice';
import { manuscriptSlice } from './manuscript-slice';
import { queueSlice } from './queue-slice';
import { analysisSlice } from './analysis-slice';
import { chaptersSlice } from './chapters-slice';
import { notificationsSlice } from './notifications-slice';
import { approvePreviewSideEffects } from './preview-thunks';

type TestDispatch = (action: unknown) => Promise<unknown>;
const PREVIEW: PreviewRegenCtx = { bookId: 'A', characterId: 'eliza', previewChapterId: 1, remainingChapterIds: [2], reason: 'voice', note: '' };

beforeEach(() => {
  putBookState.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: { body?: string }) => ({ ok: true, status: 200, json: async () => ({ entries: init?.body ? JSON.parse(init.body).entries : [], paused: false }) })));
});
afterEach(() => vi.unstubAllGlobals());

/* `active` is the stage's open book; `slicesHold` is the book the loaded slices
   belong to (manuscript.bookId) — they differ in the window between a book
   switch and the new book's state read landing. */
function storeWithBookOpen(active: string, slicesHold: string = active) {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, changeLog: changeLogSlice.reducer, queue: queueSlice.reducer, analysis: analysisSlice.reducer, chapters: chaptersSlice.reducer, manuscript: manuscriptSlice.reducer, notifications: notificationsSlice.reducer },
    middleware: (g) => g().concat(persistenceMiddleware),
  });
  const dispatch = store.dispatch as unknown as TestDispatch;
  void dispatch(uiActions.openBook({ id: active, status: 'complete' } as never));
  void dispatch(castSlice.actions.hydrateCharacters([{ id: 'eliza', name: 'Eliza Carrick', role: '', color: 'narrator' } as never]));
  void dispatch(manuscriptSlice.actions.hydrateFromBookState({ state: { bookId: slicesHold, manuscriptId: `m-${slicesHold}`, title: slicesHold } as never, sentences: null }));
  return { store, dispatch };
}
const changeLogPuts = (bookId: string) => putBookState.mock.calls.filter((c) => c[0] === bookId && (c[1] as { slice: string }).slice === 'changeLog');

describe('approvePreviewSideEffects across books (#3400 review)', () => {
  it('never persists A\'s regenerate event into the open book B', async () => {
    const { store, dispatch } = storeWithBookOpen('B');
    await dispatch(approvePreviewSideEffects(PREVIEW));
    await dispatch(flushBookPersistence('B'));
    expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(false);
    expect(changeLogPuts('B')).toEqual([]);
  });
  it('still logs the regenerate when the preview\'s book is the open one', async () => {
    const { store, dispatch } = storeWithBookOpen('A');
    await dispatch(approvePreviewSideEffects(PREVIEW));
    await dispatch(flushBookPersistence('A'));
    expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(true);
    expect(changeLogPuts('A')).toHaveLength(1);
  });
  it('does not log or persist when the stage moved to A but the slices still hold B (#3400 review 2)', async () => {
    const { store, dispatch } = storeWithBookOpen('A', 'B');
    void dispatch(changeLogSlice.actions.hydrateFromBookState([{ id: 'b-only-1', type: 'edit' }] as never));
    await dispatch(approvePreviewSideEffects(PREVIEW));
    await dispatch(flushBookPersistence('A'));
    expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(false);
    expect(changeLogPuts('A')).toEqual([]);
  });
});
