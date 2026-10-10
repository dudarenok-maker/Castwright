import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { uiSlice, uiActions } from './ui-slice';
import { revisionsSlice, revisionsActions } from './revisions-slice';
import { notificationsSlice } from './notifications-slice';
import { revisionPlayerMiddleware } from './revision-player-middleware';

const F = '000000000000001-a';
const state = (rev: number, entries: Array<[string, number]>) => ({ bookId: 'A', fileId: F, rev, pending: entries.map(([id, ch]) => ({ id, chapterId: ch, characterId: 'c', segments: [] })), dismissed: [], acceptedSelections: {}, timeline: {} });
function makeStore() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer, revisions: revisionsSlice.reducer, notifications: notificationsSlice.reducer }, middleware: (g) => g().concat(revisionPlayerMiddleware) });
  store.dispatch(uiActions.openBook({ id: 'A', status: 'complete' } as never));
  store.dispatch(revisionsActions.applyServerState(state(1, [['r1', 3], ['r2', 5]])));
  return store;
}
const preview = (ch: number) => ({ bookId: 'A', characterId: 'c', previewChapterId: ch, remainingChapterIds: [], reason: '', note: '' });
/* Chapter 7 has no cache entry in makeStore, so rule 1 stays quiet until a test adds one. */
const stubPreview = (completed?: { reviewOutcome?: 'recorded' | 'none' | 'failed'; stubFallback: boolean }) => ({
  ...preview(7), stub: { id: 'revision:7:c', chapterId: 7, characterId: 'c', segments: [] }, ...(completed ? { completed } : {}),
});
const toastMessages = (s: ReturnType<typeof makeStore>) => s.getState().notifications.toasts.map((t) => t.message);

describe('revisionPlayerMiddleware (plan 286)', () => {
  it('a server entry vanishing (another tab) closes the player and clears a preview tied to it, with one toast', () => {
    const store = makeStore();
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
    store.dispatch(uiActions.setPreviewRegen(preview(3)));
    store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r2', 5]]), drift: [] }));
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen).toBeNull();
    expect(toastMessages(store)).toEqual(['This preview was resolved elsewhere']);
  });
  it("does not fire during the user's own op (revisionOpInFlight)", () => {
    const store = makeStore();
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
    store.dispatch(uiActions.setPreviewRegen(preview(3)));
    store.dispatch(uiActions.beginRevisionOp());
    store.dispatch(revisionsActions.applyServerState(state(2, [['r2', 5]])));
    expect(store.getState().ui.openRevision).not.toBeNull();
    expect(store.getState().ui.previewRegen).not.toBeNull();
    expect(toastMessages(store)).toEqual([]);
  });
  it('a vanishing entry unrelated to the preview closes the player but keeps the preview', () => {
    const store = makeStore();
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r2', chapterId: 5 }));
    store.dispatch(uiActions.setPreviewRegen(preview(3)));
    store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r1', 3]]), drift: [] }));
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen?.previewChapterId).toBe(3);
    expect(toastMessages(store)).toEqual([]);
  });
  it('a vanishing entry with no preview closes silently (OD16)', () => {
    const store = makeStore();
    store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: 'r1', chapterId: 3 }));
    store.dispatch(revisionsActions.applyPoll({ ...state(2, []), drift: [] }));
    expect(store.getState().ui.openRevision).toBeNull();
    expect(toastMessages(store)).toEqual([]);
  });
  it("a poll on the stub's own book never closes it (the stub is never in the cache)", () => {
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen(stubPreview()));
    store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
    store.dispatch(revisionsActions.applyPoll({ ...state(2, []), drift: [] }));
    expect(store.getState().ui.openRevision).toEqual({ kind: 'preview-stub' });
    expect(store.getState().ui.previewRegen?.stub?.id).toBe('revision:7:c');
  });
  it('OD28 — navigating to another book hides an open stub player but keeps the preview', () => {
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen(stubPreview({ reviewOutcome: 'none', stubFallback: true })));
    store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
    store.dispatch(uiActions.openBook({ id: 'B', status: 'complete' } as never));
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen?.stub?.id).toBe('revision:7:c');
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'none', stubFallback: true });
    expect(toastMessages(store)).toEqual([]);
  });
  it('#11 — a cache entry for the preview chapter supersedes an open stub: the player switches to it', () => {
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen(stubPreview({ reviewOutcome: 'recorded', stubFallback: true })));
    store.dispatch(uiActions.setOpenRevision({ kind: 'preview-stub' }));
    store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r1', 3], ['r2', 5], ['r9', 7]]), drift: [] }));
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r9', chapterId: 7 });
    expect(store.getState().ui.previewRegen?.previewChapterId).toBe(7); // the preview survives: Approve still fans out
    expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'recorded', stubFallback: false });
    expect(toastMessages(store)).toEqual([]);
  });
  it('#11 — with the player closed, the entry still replaces the stub marker', () => {
    const store = makeStore();
    store.dispatch(uiActions.setPreviewRegen(stubPreview({ reviewOutcome: 'recorded', stubFallback: true })));
    store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r1', 3], ['r2', 5], ['r9', 7]]), drift: [] }));
    expect(store.getState().ui.openRevision).toBeNull();
    expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
    expect(store.getState().ui.previewRegen?.completed).toEqual({ reviewOutcome: 'recorded', stubFallback: false });
  });
  it('OD30 — a stub opened while the cache already holds an entry for its chapter opens that entry instead, in the same dispatch', () => {
    const store = makeStore();
    store.dispatch(revisionsActions.applyPoll({ ...state(2, [['r1', 3], ['r2', 5], ['r9', 7]]), drift: [] }));
    store.dispatch(uiActions.setPreviewRegen(preview(7)));
    store.dispatch(uiActions.openPreviewStub({ id: 'revision:7:c', chapterId: 7, characterId: 'c', segments: [] }));
    expect(store.getState().ui.openRevision).toEqual({ kind: 'server', revisionId: 'r9', chapterId: 7 });
    expect(store.getState().ui.previewRegen?.previewChapterId).toBe(7); // preview mode: Approve still fans out (Task 22)
    expect(store.getState().ui.previewRegen?.stub).toBeUndefined();
    expect(toastMessages(store)).toEqual([]);
  });
});
