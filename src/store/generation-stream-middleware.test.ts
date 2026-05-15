// Pairs with docs/features/16-generation-stream.md
// Covers the SSE-handle owner that replaced the in-view useEffect, so that
// generation continues across view navigation, pauses cleanly, and — per
// the v3 sticky-generation contract — survives openBook to a different
// book, goHome, and TTS-model switches.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { chaptersSlice } from './chapters-slice';
import { manuscriptSlice } from './manuscript-slice';
import { uiSlice } from './ui-slice';
import { changeLogSlice } from './change-log-slice';
import { generationStreamMiddleware } from './generation-stream-middleware';
import type { Chapter, GenerationTick } from '../lib/types';

const streamGenerationMock = vi.fn();
const cancelMock = vi.fn();
const pauseGenerationMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return cancelMock;
    },
    pauseGeneration: (args: unknown) => {
      pauseGenerationMock(args);
      return Promise.resolve();
    },
  },
}));

function makeStore() {
  return configureStore({
    reducer: {
      ui:         uiSlice.reducer,
      chapters:   chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog:  changeLogSlice.reducer,
    },
    middleware: (gd) => gd().concat(generationStreamMiddleware),
  });
}

const ch = (id: number, overrides: Partial<Chapter> = {}): Chapter => ({
  id,
  title: `Chapter ${id}`,
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: { narrator: 'queued' },
  ...overrides,
});

/* Helper: simulate what Layout's per-book hydration effect does — set the
   slice's chapters and tell the middleware which book they're for. The
   middleware's auto-open is gated on `currentBookId === stageBookId`, so
   tests have to mirror the production handshake. Order matters: claim the
   book FIRST so the middleware's reconcile after the setChapters dispatch
   sees a consistent (currentBookId, chapters) pair; otherwise the stale
   currentBookId would let reconcile close a still-relevant stream the
   moment the slice swaps to a different book's rows. */
function seedBook(store: ReturnType<typeof makeStore>, bookId: string, chapters: Chapter[]) {
  store.dispatch(chaptersSlice.actions.setCurrentBookId(bookId));
  store.dispatch(chaptersSlice.actions.setChapters(chapters));
}

describe('generationStreamMiddleware', () => {
  beforeEach(() => {
    streamGenerationMock.mockClear();
    cancelMock.mockClear();
    pauseGenerationMock.mockClear();
  });

  it('opens the SSE when a regenerate spec lands and a book is in scope', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'done', progress: 1 }), ch(2)]);
    /* Setting chapters with a queued one already triggers an open (work in
       scope) — clear the spy so the assertion below counts only the
       regenerate-driven open. */
    streamGenerationMock.mockClear();
    cancelMock.mockClear();

    store.dispatch(chaptersSlice.actions.regenerateChapter({ chapterId: 1, scope: 'this' }));

    /* The previous handle was cancelled (chapter switched into in_progress
       via the reducer; pendingRegen was set; reconcile dropped the old
       handle and opened a fresh one with the spec). */
    expect(cancelMock).toHaveBeenCalled();
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const args = streamGenerationMock.mock.calls[0][0] as { chapterIds?: number[]; force?: boolean };
    expect(args.chapterIds).toEqual([1]);
    expect(args.force).toBe(true);
  });

  it('cancels the SSE on setPaused(true) and reopens on setPaused(false)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(chaptersSlice.actions.setPaused(true));
    expect(cancelMock).toHaveBeenCalledTimes(1);
    /* clearActiveStream fires on close, so the snapshot disappears. */
    expect(store.getState().chapters.activeStream).toBeNull();

    streamGenerationMock.mockClear();
    store.dispatch(chaptersSlice.actions.setPaused(false));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('reacts to ui/changeView without crashing or double-opening (auto-start trigger regression)', () => {
    /* changeView must be in TRIGGER_TYPES so the middleware re-evaluates
       when the user navigates to Generate. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(uiSlice.actions.changeView('cast'));
    expect(streamGenerationMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();

    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    streamGenerationMock.mockClear();
    cancelMock.mockClear();
    store.dispatch(uiSlice.actions.changeView('generate'));
    expect(streamGenerationMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('keeps the SSE alive across changeView (background generation while user navigates within the book)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(uiSlice.actions.changeView('cast'));
    expect(cancelMock).toHaveBeenCalledTimes(0);

    store.dispatch(uiSlice.actions.changeView('generate'));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  /* ── v3 sticky-generation contract ─────────────────────────────────── */

  it('keeps the SSE alive across goHome — generation runs in the background while user browses Books', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(uiSlice.actions.goHome());
    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(store.getState().chapters.activeStream?.bookId).toBe('b1');
  });

  it('keeps the SSE alive across startNewBook (Upload screen) — the canonical "I want to import while gen runs" path', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(uiSlice.actions.goHome());
    store.dispatch(uiSlice.actions.startNewBook());
    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(store.getState().chapters.activeStream?.bookId).toBe('b1');
  });

  it('keeps the SSE alive when the user opens a different book — and refuses to start a second stream for it', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(((streamGenerationMock.mock.calls[0][0]) as { bookId?: string }).bookId).toBe('b1');

    /* Opening a different book swaps the URL stage but the middleware's
       handle is pinned to b1. Layout would normally hydrate b2's chapters
       and dispatch setCurrentBookId('b2'); we simulate that here. */
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'generating' }));
    seedBook(store, 'b2', [ch(7, { state: 'queued' })]);

    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    /* activeStream still describes the original generating book. */
    expect(store.getState().chapters.activeStream?.bookId).toBe('b1');
  });

  it('keeps the SSE alive when the TTS model is switched mid-run (new model applies to the NEXT run)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const originalKey = ((streamGenerationMock.mock.calls[0][0]) as { modelKey?: string }).modelKey;

    store.dispatch(uiSlice.actions.setTtsModelKey('gemini-2.5-flash'));

    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    /* The live handle stays bound to the original model — the picker only
       affects the next generation start. */
    expect(originalKey).not.toBe('gemini-2.5-flash');
  });

  it('drops applyGenerationTick into the slice when the slice has drifted to a different book', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* User opens b2; Layout swaps the slice's chapters and currentBookId. */
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    seedBook(store, 'b2', [ch(7, { state: 'done', progress: 1, characters: { narrator: 'done' } })]);

    /* A tick arrives for the still-running b1 stream. The reducer's
       cross-book guard must refuse to mutate the b2 chapter. */
    store.dispatch(chaptersSlice.actions.applyGenerationTick(
      { type: 'progress', chapterId: 7, progress: 0.02, characterId: 'narrator' } as GenerationTick,
    ));
    const state = store.getState().chapters;
    expect(state.chapters[0].state).toBe('done');
    expect(state.chapters[0].progress).toBe(1);
  });

  it('cancels on idle once the queue drains and does not reopen for an idle tick', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.5 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* Complete the chapter, then deliver the idle tick. */
    store.dispatch(chaptersSlice.actions.applyGenerationTick({
      type: 'chapter_complete', chapterId: 1,
    } as GenerationTick));
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'idle' } as GenerationTick));

    expect(cancelMock).toHaveBeenCalled();
    expect(store.getState().chapters.activeStream).toBeNull();

    streamGenerationMock.mockClear();
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'idle' } as GenerationTick));
    expect(streamGenerationMock).not.toHaveBeenCalled();
  });

  it('emits chapter_complete and chapter_failed change-log events from ticks', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(3, { state: 'in_progress', progress: 0.5 })]);
    const beforeCount = store.getState().changeLog.events.length;

    store.dispatch(chaptersSlice.actions.applyGenerationTick({
      type: 'chapter_complete', chapterId: 3,
    } as GenerationTick));
    const events = store.getState().changeLog.events;
    expect(events.length).toBeGreaterThan(beforeCount);
    expect(events[0].type).toBe('chapter_complete');
    expect(events[0].chapterId).toBe(3);
    expect(events[0].actor).toBe('system');

    /* And the per-chapter failure case. */
    seedBook(store, 'b1', [ch(4, { state: 'in_progress', progress: 0.5 })]);
    store.dispatch(chaptersSlice.actions.applyGenerationTick({
      type: 'chapter_failed', chapterId: 4, errorReason: 'Voice not found',
    } as GenerationTick));
    const after = store.getState().changeLog.events;
    expect(after[0].type).toBe('chapter_failed');
    expect(after[0].chapterId).toBe(4);
    expect(after[0].note).toContain('Voice not found');
  });

  it('publishes an activeStream snapshot on open and clears it on close', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    expect(store.getState().chapters.activeStream).toBeNull();

    seedBook(store, 'b1', [
      ch(1, { state: 'done', progress: 1, characters: { narrator: 'done' } }),
      ch(2, { state: 'in_progress', progress: 0.5 }),
      ch(3, { state: 'queued' }),
    ]);
    const snap = store.getState().chapters.activeStream;
    expect(snap).not.toBeNull();
    expect(snap!.bookId).toBe('b1');
    expect(snap!.done).toBe(1);
    expect(snap!.total).toBe(3);
    expect(snap!.inProgress).toBe(1);

    /* Stop → snapshot cleared. */
    store.dispatch(chaptersSlice.actions.setPaused(true));
    expect(store.getState().chapters.activeStream).toBeNull();
  });
});
