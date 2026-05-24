/* Unit tests for the generation-stream runner (plan 111 worker pool).
 *
 * The runner owns the SSE handles — one per book — and self-drives each
 * stream's per-tick side-effects via the onTick it passes to
 * api.streamGeneration. These tests open streams, capture each onTick, feed
 * ticks, and assert: per-book snapshot, idle teardown (per book), the run
 * rollup, multi-handle concurrency, the per-book singleton, excluded-chapter
 * counting, and the dispatcher-facing query methods. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { chaptersSlice } from './chapters-slice';
import { changeLogSlice } from './change-log-slice';
import { revisionsSlice } from './revisions-slice';
import { notificationsSlice } from './notifications-slice';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';
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

beforeEach(() => {
  streamGenerationMock.mockClear();
  cancelMock.mockClear();
});

function makeStore() {
  return configureStore({
    reducer: {
      chapters: chaptersSlice.reducer,
      changeLog: changeLogSlice.reducer,
      revisions: revisionsSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
  });
}

const ch = (id: number, overrides: Partial<Chapter> = {}): Chapter =>
  ({
    id,
    title: `Chapter ${id}`,
    duration: '00:00',
    state: 'queued',
    progress: 0,
    characters: { narrator: 'queued' },
    ...overrides,
  }) as Chapter;

/* The onTick the runner passed for a given book's stream. */
function onTickFor(bookId: string): (ev: GenerationTick) => void {
  const call = streamGenerationMock.mock.calls.find(
    (c) => (c[0] as { bookId?: string }).bookId === bookId,
  );
  if (!call) throw new Error(`no open stream for ${bookId}`);
  return (call[0] as { onTick: (ev: GenerationTick) => void }).onTick;
}

function makeRunner(): { store: ReturnType<typeof makeStore>; runner: StreamRunner } {
  const store = makeStore();
  const runner = createStreamRunner(store);
  return { store, runner };
}

describe('generation-stream-runner (worker pool)', () => {
  it('open() seeds the per-book snapshot from the viewed book’s rows', () => {
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        ch(1, { state: 'done', progress: 1 }),
        ch(2, { state: 'in_progress', progress: 0.4 }),
        ch(3, { state: 'queued' }),
        ch(4, { state: 'queued', excluded: true }),
      ]),
    );
    runner.open('b1', 'kokoro-v1', { chapterIds: [2, 3], force: true });
    const snap = store.getState().chapters.activeStreams['b1'];
    expect(snap).toBeDefined();
    /* Excluded chapter 4 is not counted in total. */
    expect(snap.total).toBe(3);
    expect(snap.done).toBe(1);
    expect(snap.inProgress).toBe(1);
    expect(runner.hasOpenStreamForBook('b1')).toBe(true);
    expect(runner.openChapterIds().sort()).toEqual([2, 3]);
  });

  it('is a per-book singleton — opening the same book twice opens one stream', () => {
    const { runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true });
    runner.open('b1', 'kokoro-v1', { chapterIds: [2], force: true });
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(runner.openBookCount()).toBe(1);
  });

  it('runs independent concurrent streams for different books', () => {
    const { store, runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true });
    runner.open('b2', 'kokoro-v1', { chapterIds: [5], force: true });
    expect(runner.openBookCount()).toBe(2);
    expect(runner.openBookIds().sort()).toEqual(['b1', 'b2']);
    expect(Object.keys(store.getState().chapters.activeStreams).sort()).toEqual(['b1', 'b2']);

    /* Idle on b1 closes ONLY b1's stream; b2 keeps running. */
    onTickFor('b1')({ type: 'idle' } as GenerationTick);
    expect(runner.hasOpenStreamForBook('b1')).toBe(false);
    expect(runner.hasOpenStreamForBook('b2')).toBe(true);
    expect(store.getState().chapters.activeStreams['b1']).toBeUndefined();
    expect(store.getState().chapters.activeStreams['b2']).toBeDefined();
  });

  it('flushes a single generation_run_complete rollup on idle close', () => {
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(
      chaptersSlice.actions.setChapters([
        ch(1, { state: 'in_progress', progress: 0.5 }),
        ch(2, { state: 'queued' }),
      ]),
    );
    runner.open('b1', 'kokoro-v1', { chapterIds: [1, 2], force: true });
    const tick = onTickFor('b1');
    tick({ type: 'chapter_complete', chapterId: 1 } as GenerationTick);
    tick({ type: 'chapter_complete', chapterId: 2 } as GenerationTick);
    /* No per-chapter complete events; rollup only on close. */
    const before = store.getState().changeLog.events.filter((e) => e.type === 'generation_run_complete');
    expect(before).toHaveLength(0);
    tick({ type: 'idle' } as GenerationTick);
    const after = store.getState().changeLog.events.filter((e) => e.type === 'generation_run_complete');
    expect(after).toHaveLength(1);
  });

  it('refreshes the viewed book’s snapshot from rows on a progress tick', () => {
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(
      chaptersSlice.actions.setChapters([ch(1, { state: 'in_progress', progress: 0.1 }), ch(2)]),
    );
    runner.open('b1', 'kokoro-v1', { chapterIds: [1, 2], force: true });
    onTickFor('b1')({
      type: 'progress',
      chapterId: 1,
      progress: 0.5,
      characterId: 'narrator',
    } as GenerationTick);
    const snap = store.getState().chapters.activeStreams['b1'];
    expect(snap.lastTickAt).not.toBeNull();
  });

  it('cross-book stream updates its own snapshot from run aggregates without touching the viewed book’s rows', () => {
    const { store, runner } = makeRunner();
    /* Viewing b1; a stream is open for b2 (cross-book). */
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'queued' })]));
    runner.open('b2', 'kokoro-v1', { chapterIds: [1], force: true });
    onTickFor('b2')({
      type: 'progress',
      chapterId: 1,
      progress: 0.5,
      runDone: 0,
      runTotal: 3,
      runInProgress: 1,
    } as unknown as GenerationTick);
    /* b2's snapshot picked up the run aggregates; b1's rows are untouched. */
    expect(store.getState().chapters.activeStreams['b2'].total).toBe(3);
    expect(store.getState().chapters.chapters[0].state).toBe('queued');
    expect(store.getState().chapters.chapters[0].progress).toBe(0);
  });

  it('closeAll tears down every stream', () => {
    const { runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true });
    runner.open('b2', 'kokoro-v1', { chapterIds: [2], force: true });
    runner.closeAll();
    expect(runner.openBookCount()).toBe(0);
    expect(cancelMock).toHaveBeenCalledTimes(2);
  });
});
