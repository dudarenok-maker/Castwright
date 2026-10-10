import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { acceptRevision: vi.fn(), rejectRevision: vi.fn(), dismissDrift: vi.fn(), pollRevisions: vi.fn(), restorePreviousUnrecorded: vi.fn() },
}));
vi.mock('../lib/api', () => ({ api: apiMock }));

import { uiSlice, uiActions } from './ui-slice';
import { revisionsSlice, revisionsActions } from './revisions-slice';
import { notificationsSlice } from './notifications-slice';
import { RevisionOpFailure } from '../lib/revision-op-failure';
import { acceptRevisionOp, rejectRevisionOp, dismissDriftOp, refetchActiveRevisions } from './revisions-thunks';
import { restoreUnrecordedPreview } from './preview-thunks';

const F = '000000000000001-a';
const S = (bookId: string, rev: number, ids: string[] = [], fileId = F) => ({ bookId, fileId, rev, pending: ids.map((id) => ({ id, chapterId: 3, characterId: 'c', segments: [] })), dismissed: [], acceptedSelections: {}, timeline: {} });
const PREVIEW = (chapter: number) => ({ bookId: 'A', characterId: 'c', previewChapterId: chapter, remainingChapterIds: [4], reason: '', note: '' });

/* Test store typed with a loose dispatch so dispatch(thunk) typechecks the
   same way queue-thunks.test.ts's makeStore does (RTK's inferred Dispatch
   type does not surface the thunk overload on this store shape). */
type TestDispatch = (action: unknown) => Promise<unknown>;
function makeStore(activeBook = 'A'): {
  getState: () => {
    ui: ReturnType<typeof uiSlice.reducer>;
    revisions: ReturnType<typeof revisionsSlice.reducer>;
    notifications: ReturnType<typeof notificationsSlice.reducer>;
  };
  dispatch: TestDispatch;
} {
  const store = configureStore({ reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer, notifications: notificationsSlice.reducer } });
  const typed = store as unknown as {
    getState: typeof store.getState;
    dispatch: TestDispatch;
  };
  typed.dispatch(uiActions.openBook({ id: activeBook, status: 'complete' } as never));
  typed.dispatch(revisionsActions.applyServerState(S(activeBook, 1, ['r1'])));
  typed.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
  return typed;
}
const toasts = (s: ReturnType<typeof makeStore>) => s.getState().notifications.toasts.map((t) => t.message);
beforeEach(() => { for (const f of Object.values(apiMock)) f.mockReset(); });

describe('revisions thunks (plan 286)', () => {
  it('success applies the returned state, closes the player, no toast, in-flight cleared', async () => {
    apiMock.acceptRevision.mockResolvedValueOnce(S('A', 2));
    const store = makeStore();
    const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(out).toEqual({ ok: true });
    expect(store.getState().revisions.pending).toEqual([]);
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.revisionOpInFlight).toBe(false);
    expect(toasts(store)).toEqual([]);
  });
  it('sets revisionOpInFlight while the op runs', async () => {
    let release!: (v: unknown) => void;
    apiMock.rejectRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore();
    const p = store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(store.getState().ui.revisionOpInFlight).toBe(true);
    release(S('A', 2)); await p;
    expect(store.getState().ui.revisionOpInFlight).toBe(false);
  });
  it('a response for a book the user has left is not applied', async () => {
    let release!: (v: unknown) => void;
    apiMock.acceptRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore('A');
    const p = store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
    release(S('A', 2)); await p;
    expect(store.getState().revisions.rev).toBe(1);
  });
  it('#3400: an op settling for book A leaves a player the user opened on book B open', async () => {
    let release!: (v: unknown) => void;
    apiMock.acceptRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore('A');
    const p = store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
    store.dispatch(revisionsActions.applyServerState(S('B', 1, ['b1'])));
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'b1', chapterId: 3 }));
    release(S('A', 2)); await p;
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'b1', chapterId: 3 });
  });
  it('#3400: an op settling for entry r1 leaves a player the user opened on another entry of the SAME book open', async () => {
    let release!: (v: unknown) => void;
    apiMock.acceptRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore('A');
    store.dispatch(revisionsActions.applyServerState(S('A', 1, ['r1', 'r2'])));
    const p = store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r2', chapterId: 3 }));
    release(S('A', 2, ['r2'])); await p;
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r2', chapterId: 3 });
  });
  it('#3400: a settle for book A does not clear the in-flight flag while book B\'s op still runs', async () => {
    let releaseA!: (v: unknown) => void;
    let releaseB!: (v: unknown) => void;
    apiMock.acceptRevision.mockReturnValueOnce(new Promise((r) => (releaseA = r)));
    apiMock.rejectRevision.mockReturnValueOnce(new Promise((r) => (releaseB = r)));
    const store = makeStore('A');
    const pA = store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
    store.dispatch(revisionsActions.applyServerState(S('B', 1, ['b1'])));
    const pB = store.dispatch(rejectRevisionOp({ bookId: 'B', revisionId: 'b1', chapterId: 3 }));
    releaseA(S('A', 2)); await pA;
    expect(store.getState().ui.revisionOpInFlight).toBe(true);
    releaseB(S('B', 2)); await pB;
    expect(store.getState().ui.revisionOpInFlight).toBe(false);
  });
  it('revision_gone with a preview on THAT chapter: applies state, closes, clears the preview, one toast', async () => {
    apiMock.acceptRevision.mockRejectedValueOnce(new RevisionOpFailure('gone', 409, 'revision_gone', S('A', 3)));
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen(PREVIEW(3)));
    const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(out).toEqual({ ok: false, code: 'revision_gone' });
    expect(store.getState().revisions.rev).toBe(3);
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen).toBeNull();
    expect(toasts(store)).toEqual(['This take was replaced by a newer render']);
  });
  it('revision_gone leaves an UNRELATED preview (another chapter) alone', async () => {
    apiMock.acceptRevision.mockRejectedValueOnce(new RevisionOpFailure('gone', 409, 'revision_gone', S('A', 3)));
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen(PREVIEW(7)));
    await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(store.getState().ui.previewRegen?.previewChapterId).toBe(7);
  });
  it('revision_not_found without a state refetches the active book', async () => {
    apiMock.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('nf', 404, 'revision_not_found'));
    apiMock.pollRevisions.mockResolvedValueOnce({ ...S('A', 4), drift: [] });
    const store = makeStore();
    await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(apiMock.pollRevisions).toHaveBeenCalledWith({ bookId: 'A' });
    expect(store.getState().revisions.rev).toBe(4);
  });
  it.each([
    ['chapter_busy', 'This chapter is busy — try again when it finishes'],
    ['no_previous_audio', 'Original audio not preserved'],
    ['live_audio_missing', "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it"],
  ])('%s keeps the player open with its toast and clears in-flight', async (code, msg) => {
    apiMock.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('x', 409, code as never, S('A', 1, ['r1'])));
    const store = makeStore();
    await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(store.getState().ui.openRevision).not.toBeNull();
    expect(store.getState().ui.revisionOpInFlight).toBe(false);
    expect(toasts(store)).toEqual([msg]);
  });
  it('restore_failed toasts, refetches and keeps the entry', async () => {
    apiMock.rejectRevision.mockRejectedValueOnce(new RevisionOpFailure('x', 500, 'restore_failed'));
    apiMock.pollRevisions.mockResolvedValueOnce({ ...S('A', 1, ['r1']), drift: [] });
    const store = makeStore();
    await store.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(toasts(store)).toEqual(["Couldn't restore the earlier take — try Reject again"]);
    expect(apiMock.pollRevisions).toHaveBeenCalledWith({ bookId: 'A' });
    expect(store.getState().revisions.pending.map((p) => p.id)).toEqual(['r1']);
  });
  it('an unexpected failure shows a fixed sentence (never the error text) and leaves the cache alone', async () => {
    apiMock.acceptRevision.mockRejectedValueOnce(new Error("EPERM: operation not permitted, unlink 'C:\\SECRET\\a.mp3'"));
    const store = makeStore();
    const before = store.getState().revisions;
    const out = await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(out).toEqual({ ok: false, code: 'network' });
    expect(store.getState().revisions).toBe(before);
    expect(toasts(store)).toEqual(["Couldn't update the revision — try again"]);
  });
  it('a legacy id (revision:<ch>:<char>) is sent as-is to the server op', async () => {
    apiMock.acceptRevision.mockResolvedValueOnce(S('A', 2));
    const store = makeStore();
    await store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'revision:3:eliza', chapterId: 3 }));
    expect(apiMock.acceptRevision).toHaveBeenCalledWith({ bookId: 'A', revisionId: 'revision:3:eliza' });
  });
  it("dismissDriftOp posts to the event's own book; a foreign dismiss leaves the active rev alone", async () => {
    const store = makeStore('A');
    store.dispatch(revisionsActions.applyBackgroundPoll({ bookId: 'B', drift: [{ id: 'dB', bookId: 'B' } as never] }));
    apiMock.dismissDrift.mockResolvedValueOnce(S('B', 7, [], '000000000000009-z'));
    await store.dispatch(dismissDriftOp('dB'));
    expect(apiMock.dismissDrift).toHaveBeenCalledWith({ bookId: 'B', driftId: 'dB' });
    expect(store.getState().revisions.drift).toEqual([]);
    expect(store.getState().revisions.rev).toBe(1);
  });
  it('dismissDriftOp failure keeps the event and toasts', async () => {
    const store = makeStore('A');
    store.dispatch(revisionsActions.applyBackgroundPoll({ bookId: 'A', drift: [{ id: 'dA', bookId: 'A' } as never] }));
    apiMock.dismissDrift.mockRejectedValueOnce(new Error('x'));
    await store.dispatch(dismissDriftOp('dA'));
    expect(store.getState().revisions.drift.map((d) => d.id)).toEqual(['dA']);
    expect(toasts(store)).toEqual(["Couldn't dismiss the drift event — try again"]);
  });
  it('refetchActiveRevisions skips a non-active book and reports a failure', async () => {
    const store = makeStore('A');
    expect(await store.dispatch(refetchActiveRevisions('B'))).toBe('skipped');
    expect(apiMock.pollRevisions).not.toHaveBeenCalled();
    apiMock.pollRevisions.mockRejectedValueOnce(new Error('x'));
    expect(await store.dispatch(refetchActiveRevisions('A'))).toBe('failed');
  });
  it('#3400: a refetch for book A that resolves after the user switched to B does not touch B\'s cache', async () => {
    let release!: (v: unknown) => void;
    apiMock.pollRevisions.mockReturnValueOnce(new Promise((r) => (release = r)));
    const store = makeStore('A');
    const p = store.dispatch(refetchActiveRevisions('A'));
    store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
    store.dispatch(revisionsActions.applyServerState(S('B', 1, ['b1'])));
    release(S('A', 5, ['a1']));
    expect(await p).toBe('ok');
    expect(store.getState().revisions.rev).toBe(1);
    expect(store.getState().revisions.pending.map((r) => r.id)).toEqual(['b1']);
  });
});

describe('in-flight count lives in the store (#3400)', () => {
  it('a restore-unrecorded settling mid-op leaves the flag true until the op settles', async () => {
    let release!: (v: unknown) => void;
    apiMock.acceptRevision.mockReturnValueOnce(new Promise((r) => (release = r)));
    apiMock.restorePreviousUnrecorded.mockResolvedValueOnce('restored');
    const store = makeStore('A');
    const p = store.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    await store.dispatch(restoreUnrecordedPreview({ ...PREVIEW(3), stub: { hasPreviousAudio: true } } as never));
    expect(store.getState().ui.revisionOpInFlight).toBe(true);
    release(S('A', 2)); await p;
    expect(store.getState().ui.revisionOpInFlight).toBe(false);
  });
  it('two stores do not share the count', async () => {
    apiMock.acceptRevision.mockReturnValueOnce(new Promise(() => {}));
    apiMock.rejectRevision.mockResolvedValueOnce(S('A', 2));
    const one = makeStore('A');
    void one.dispatch(acceptRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    const two = makeStore('A');
    await two.dispatch(rejectRevisionOp({ bookId: 'A', revisionId: 'r1', chapterId: 3 }));
    expect(two.getState().ui.revisionOpInFlight).toBe(false);
    expect(one.getState().ui.revisionOpInFlight).toBe(true);
  });
});
