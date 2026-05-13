// Pairs with docs/features/16-generation-stream.md
// Covers the SSE-handle owner that replaced the in-view useEffect, so that
// generation continues across view navigation and pauses cleanly.

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

vi.mock('../lib/api', () => ({
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return cancelMock;
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

describe('generationStreamMiddleware', () => {
  beforeEach(() => {
    streamGenerationMock.mockClear();
    cancelMock.mockClear();
  });

  it('opens the SSE when a regenerate spec lands and a book is in scope', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'done', progress: 1 }), ch(2)]));
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
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'in_progress', progress: 0.1 })]));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(chaptersSlice.actions.setPaused(true));
    expect(cancelMock).toHaveBeenCalledTimes(1);

    streamGenerationMock.mockClear();
    store.dispatch(chaptersSlice.actions.setPaused(false));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the SSE alive across changeView (background generation while user navigates)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'in_progress', progress: 0.1 })]));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* Navigating to Cast must NOT cancel the stream — that was the original
       complaint (generation died as soon as the user clicked away from the
       Generate tab). */
    store.dispatch(uiSlice.actions.changeView('cast'));
    expect(cancelMock).toHaveBeenCalledTimes(0);

    /* And navigating back doesn't double-open. */
    store.dispatch(uiSlice.actions.changeView('generate'));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('cancels and reopens against the new book when the active book changes', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'in_progress', progress: 0.1 })]));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const firstCallBookId = (streamGenerationMock.mock.calls[0][0] as { bookId?: string }).bookId;
    expect(firstCallBookId).toBe('b1');

    /* Switching books cancels the b1 stream and reopens against b2 (the
       reconcile after openBook re-evaluates: b2 in scope, work present in
       the slice's current chapters until hydrateFromBookState rewrites it,
       so the new stream targets b2). */
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'generating' }));
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(streamGenerationMock).toHaveBeenCalledTimes(2);
    const secondCallBookId = (streamGenerationMock.mock.calls[1][0] as { bookId?: string }).bookId;
    expect(secondCallBookId).toBe('b2');
  });

  it('cancels on idle once the queue drains and does not reopen for an idle tick', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'in_progress', progress: 0.5 })]));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* Complete the chapter, then deliver the idle tick. */
    store.dispatch(chaptersSlice.actions.applyGenerationTick({
      type: 'chapter_complete', chapterId: 1,
    } as GenerationTick));
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'idle' } as GenerationTick));

    expect(cancelMock).toHaveBeenCalled();

    streamGenerationMock.mockClear();
    /* A second idle tick from a still-attached server must not re-open. */
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'idle' } as GenerationTick));
    expect(streamGenerationMock).not.toHaveBeenCalled();
  });

  it('emits chapter_complete and chapter_failed change-log events from ticks', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setChapters([ch(3, { state: 'in_progress', progress: 0.5 })]));
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
    store.dispatch(chaptersSlice.actions.setChapters([ch(4, { state: 'in_progress', progress: 0.5 })]));
    store.dispatch(chaptersSlice.actions.applyGenerationTick({
      type: 'chapter_failed', chapterId: 4, errorReason: 'Voice not found',
    } as GenerationTick));
    const after = store.getState().changeLog.events;
    expect(after[0].type).toBe('chapter_failed');
    expect(after[0].chapterId).toBe(4);
    expect(after[0].note).toContain('Voice not found');
  });
});
