import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

const { apiMock } = vi.hoisted(() => ({ apiMock: { restorePreviousUnrecorded: vi.fn() } }));
vi.mock('../lib/api', () => ({ api: apiMock }));

import { uiSlice, uiActions, type PreviewRegenCtx } from './ui-slice';
import { castSlice } from './cast-slice';
import { changeLogSlice } from './change-log-slice';
import { manuscriptSlice } from './manuscript-slice';
import { queueSlice } from './queue-slice';
import { analysisSlice } from './analysis-slice';
import { chaptersSlice } from './chapters-slice';
import { notificationsSlice } from './notifications-slice';
import { RevisionOpFailure } from '../lib/revision-op-failure';
import { startPreviewRegen, approvePreviewSideEffects, restoreUnrecordedPreview } from './preview-thunks';

let fetchMock: ReturnType<typeof vi.fn>;
const enqueueBodies = () => fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/queue/enqueue')).map((c) => JSON.parse(c[1].body).entries);
beforeEach(() => {
  apiMock.restorePreviousUnrecorded.mockReset();
  fetchMock = vi.fn(async (_u: string, init?: { body?: string }) => ({ ok: true, status: 200, json: async () => ({ entries: init?.body ? JSON.parse(init.body).entries : [], paused: false }) }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/* Test store typed with a loose dispatch so dispatch(thunk) typechecks the
   same way queue-thunks.test.ts's makeStore does (RTK's inferred Dispatch
   type does not surface the thunk overload on this store shape). */
type TestDispatch = (action: unknown) => Promise<unknown>;
function makeStore(active = 'A'): {
  getState: () => {
    ui: ReturnType<typeof uiSlice.reducer>;
    cast: ReturnType<typeof castSlice.reducer>;
    changeLog: ReturnType<typeof changeLogSlice.reducer>;
    queue: ReturnType<typeof queueSlice.reducer>;
    analysis: ReturnType<typeof analysisSlice.reducer>;
    manuscript: ReturnType<typeof manuscriptSlice.reducer>;
    chapters: ReturnType<typeof chaptersSlice.reducer>;
    notifications: ReturnType<typeof notificationsSlice.reducer>;
  };
  dispatch: TestDispatch;
} {
  const store = configureStore({ reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, changeLog: changeLogSlice.reducer, queue: queueSlice.reducer, analysis: analysisSlice.reducer, chapters: chaptersSlice.reducer, manuscript: manuscriptSlice.reducer, notifications: notificationsSlice.reducer } });
  const typed = store as unknown as {
    getState: typeof store.getState;
    dispatch: TestDispatch;
  };
  typed.dispatch(uiActions.openBook({ id: active, status: 'complete' } as never));
  typed.dispatch(manuscriptSlice.actions.hydrateFromBookState({ state: { bookId: active, manuscriptId: `m-${active}`, title: active } as never, sentences: null }));
  typed.dispatch(castSlice.actions.hydrateCharacters([{ id: 'eliza', name: 'Eliza Carrick', role: '', color: 'narrator' } as never]));
  return typed;
}
const PREVIEW = (over: Partial<PreviewRegenCtx> = {}): PreviewRegenCtx => ({ bookId: 'A', characterId: 'eliza', previewChapterId: 1, remainingChapterIds: [2, 3], reason: 'voice', note: '', ...over });
const stub = (hasPreviousAudio: boolean) => ({ id: 'revision:1:eliza', chapterId: 1, characterId: 'eliza', segments: [], playable: true, hasPreviousAudio });
const toasts = (s: ReturnType<typeof makeStore>) => s.getState().notifications.toasts.map((t) => t.message);

describe('startPreviewRegen (plan 286)', () => {
  it('stores the preview with its bookId and enqueues the first chapter carrying review', async () => {
    const store = makeStore();
    await store.dispatch(startPreviewRegen({ bookId: 'A', characterId: 'eliza', characterName: 'Eliza Carrick', chapterIds: [1, 2, 3], reason: 'voice', note: '' }));
    expect(store.getState().ui.previewRegen).toMatchObject({ bookId: 'A', previewChapterId: 1, remainingChapterIds: [2, 3] });
    const [entries] = enqueueBodies();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ bookId: 'A', chapterId: 1, review: { characterId: 'eliza', triggeredBy: 'Eliza Carrick voice change' } });
  });
});

describe('approvePreviewSideEffects (plan 286)', () => {
  it('clears the preview, logs the regenerate, and fans the rest out under preview.bookId', async () => {
    const store = makeStore('A');
    store.dispatch(uiActions.setPreviewRegen(PREVIEW()));
    await store.dispatch(approvePreviewSideEffects(PREVIEW()));
    expect(store.getState().ui.previewRegen).toBeNull();
    expect(store.getState().changeLog.events.some((e) => e.type === 'regenerate')).toBe(true);
    const [entries] = enqueueBodies();
    expect(entries.map((e: { bookId: string; chapterId: number }) => [e.bookId, e.chapterId])).toEqual([['A', 2], ['A', 3]]);
  });
  it('a preview for another book fans out to THAT book and does not switch the view', async () => {
    const store = makeStore('B');
    const viewBefore = (store.getState().ui.stage as { view?: string }).view;
    await store.dispatch(approvePreviewSideEffects(PREVIEW({ bookId: 'A' })));
    const [entries] = enqueueBodies();
    expect(entries.every((e: { bookId: string }) => e.bookId === 'A')).toBe(true);
    expect((store.getState().ui.stage as { view?: string }).view).toBe(viewBefore);
  });
  it('no remaining chapters → no enqueue', async () => {
    const store = makeStore('A');
    await store.dispatch(approvePreviewSideEffects(PREVIEW({ remainingChapterIds: [] })));
    expect(enqueueBodies()).toEqual([]);
  });
});

describe('restoreUnrecordedPreview (plan 286, spec §4 stub table)', () => {
  function open(store: ReturnType<typeof makeStore>, hasPrev: boolean) {
    store.dispatch(uiActions.setPreviewRegen(PREVIEW({ stub: stub(hasPrev) })));
    store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
    return store.getState().ui.previewRegen!;
  }
  it('hasPreviousAudio false → drops the preview with no request', async () => {
    const store = makeStore();
    await store.dispatch(restoreUnrecordedPreview(open(store, false)));
    expect(apiMock.restorePreviousUnrecorded).not.toHaveBeenCalled();
    expect(store.getState().ui.previewRegen).toBeNull();
    expect(store.getState().ui.openRevision).toBeNull();
  });
  it.each([['restored'], ['none']])('%s → drops the preview', async (outcome) => {
    apiMock.restorePreviousUnrecorded.mockResolvedValueOnce(outcome);
    const store = makeStore();
    await store.dispatch(restoreUnrecordedPreview(open(store, true)));
    expect(apiMock.restorePreviousUnrecorded).toHaveBeenCalledWith({ bookId: 'A', chapterId: 1 });
    expect(store.getState().ui.previewRegen).toBeNull();
    expect(store.getState().ui.openRevision).toBeNull();
  });
  it('#3400: A\'s restore settling after the user opened an entry on book B leaves B\'s player open', async () => {
    let release!: (v: unknown) => void;
    apiMock.restorePreviousUnrecorded.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore('A');
    const p = store.dispatch(restoreUnrecordedPreview(open(store, true)));
    store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'b1', chapterId: 3 }));
    release('restored'); await p;
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'b1', chapterId: 3 });
  });
  it('#3400: A\'s restore settling after the user opened another entry on the same book leaves it open', async () => {
    let release!: (v: unknown) => void;
    apiMock.restorePreviousUnrecorded.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore('A');
    const p = store.dispatch(restoreUnrecordedPreview(open(store, true)));
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r2', chapterId: 3 }));
    release('restored'); await p;
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r2', chapterId: 3 });
  });
  it('#3400: a restore settling for a preview that was since replaced leaves the newer preview alone', async () => {
    let release!: (v: unknown) => void;
    apiMock.restorePreviousUnrecorded.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore('A');
    const p = store.dispatch(restoreUnrecordedPreview(open(store, true)));
    store.dispatch(uiActions.setPreviewRegen(PREVIEW({ previewChapterId: 9, stub: stub(true) })));
    release('restored'); await p;
    expect(store.getState().ui.previewRegen?.previewChapterId).toBe(9);
    expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
  });
  it.each([
    ['has_revision', 409, "This chapter has an older pending review — resolve it from the chapter's review first"],
    ['chapter_busy', 409, 'This chapter is busy — try again when it finishes'],
    ['restore_failed', 500, "Couldn't restore the earlier take — try Reject again"],
  ])('%s → keeps the preview open with its toast', async (code, status, msg) => {
    apiMock.restorePreviousUnrecorded.mockRejectedValueOnce(new RevisionOpFailure('x', status, code as never));
    const store = makeStore();
    await store.dispatch(restoreUnrecordedPreview(open(store, true)));
    expect(store.getState().ui.previewRegen).not.toBeNull();
    expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
    expect(store.getState().ui.revisionOpInFlight).toBe(false);
    expect(toasts(store)).toEqual([msg]);
  });
});
