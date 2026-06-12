/* Unit tests for the generation-stream runner (queue-sole concurrency).
 *
 * The runner owns the SSE handles — one per CHAPTER, keyed
 * `${bookId}::${chapterId}` — and self-drives each stream's per-tick
 * side-effects via the onTick it passes to api.streamGeneration. These tests
 * open streams, capture each onTick, feed ticks, and assert: per-stream
 * snapshot, idle teardown (per chapter), the run rollup, multi-handle
 * concurrency (including two same-book chapters), the per-CHAPTER singleton,
 * excluded-chapter counting, close-by-key leaving a sibling intact, and the
 * dispatcher-facing query methods. */

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

/* The onTick the runner passed for a given (book, chapter) stream. Matches
   on the streamGeneration args' bookId + the single chapterId the dispatcher
   passes. */
function onTickFor(bookId: string, chapterId: number): (ev: GenerationTick) => void {
  const call = streamGenerationMock.mock.calls.find((c) => {
    const a = c[0] as { bookId?: string; chapterIds?: number[] };
    return a.bookId === bookId && (a.chapterIds ?? []).includes(chapterId);
  });
  if (!call) throw new Error(`no open stream for ${bookId}::${chapterId}`);
  return (call[0] as { onTick: (ev: GenerationTick) => void }).onTick;
}

function makeRunner(): { store: ReturnType<typeof makeStore>; runner: StreamRunner } {
  const store = makeStore();
  const runner = createStreamRunner(store);
  return { store, runner };
}

describe('generation-stream-runner (queue-sole concurrency)', () => {
  it('open() seeds the per-stream snapshot (keyed by composite key) from the viewed book’s rows', () => {
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
    runner.open('b1', 'kokoro-v1', { chapterIds: [2], force: true }, { chapterId: 2 });
    const snap = store.getState().chapters.activeStreams['b1::2'];
    expect(snap).toBeDefined();
    expect(snap.bookId).toBe('b1');
    expect(snap.chapterId).toBe(2);
    /* Excluded chapter 4 is not counted in total. */
    expect(snap.total).toBe(3);
    expect(snap.done).toBe(1);
    expect(snap.inProgress).toBe(1);
    expect(runner.hasOpenStreamForChapter('b1', 2)).toBe(true);
    expect(runner.hasOpenStreamForBook('b1')).toBe(true);
    expect(runner.openChapterIds()).toEqual([2]);
  });

  it('is a per-CHAPTER singleton — re-opening the SAME chapter is a no-op, but a sibling chapter opens', () => {
    const { runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    /* Two same-book chapters → two independent handles. */
    runner.open('b1', 'kokoro-v1', { chapterIds: [2], force: true }, { chapterId: 2 });
    expect(streamGenerationMock).toHaveBeenCalledTimes(2);
    expect(runner.openBookCount()).toBe(2);
    expect(runner.hasOpenStreamForChapter('b1', 1)).toBe(true);
    expect(runner.hasOpenStreamForChapter('b1', 2)).toBe(true);
    /* Re-opening chapter 1 is a no-op (singleton guards the chapter). */
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    expect(streamGenerationMock).toHaveBeenCalledTimes(2);
  });

  it('two same-book chapters open two handles; closing one leaves the sibling + its snapshot intact', () => {
    const { store, runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    runner.open('b1', 'kokoro-v1', { chapterIds: [2], force: true }, { chapterId: 2 });
    expect(Object.keys(store.getState().chapters.activeStreams).sort()).toEqual(['b1::1', 'b1::2']);

    /* Idle on chapter 1 closes ONLY its handle + snapshot; chapter 2 lives. */
    onTickFor('b1', 1)({ type: 'idle' } as GenerationTick);
    expect(runner.hasOpenStreamForChapter('b1', 1)).toBe(false);
    expect(runner.hasOpenStreamForChapter('b1', 2)).toBe(true);
    /* Book is still streaming (the sibling chapter). */
    expect(runner.hasOpenStreamForBook('b1')).toBe(true);
    expect(store.getState().chapters.activeStreams['b1::1']).toBeUndefined();
    expect(store.getState().chapters.activeStreams['b1::2']).toBeDefined();
  });

  it('runs independent concurrent streams for different books', () => {
    const { store, runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    runner.open('b2', 'kokoro-v1', { chapterIds: [5], force: true }, { chapterId: 5 });
    expect(runner.openBookCount()).toBe(2);
    expect(runner.openBookIds().sort()).toEqual(['b1', 'b2']);
    expect(Object.keys(store.getState().chapters.activeStreams).sort()).toEqual(['b1::1', 'b2::5']);

    /* Idle on b1 closes ONLY b1's stream; b2 keeps running. */
    onTickFor('b1', 1)({ type: 'idle' } as GenerationTick);
    expect(runner.hasOpenStreamForBook('b1')).toBe(false);
    expect(runner.hasOpenStreamForBook('b2')).toBe(true);
    expect(store.getState().chapters.activeStreams['b1::1']).toBeUndefined();
    expect(store.getState().chapters.activeStreams['b2::5']).toBeDefined();
  });

  it('flushes a single generation_run_complete rollup on idle close', () => {
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(
      chaptersSlice.actions.setChapters([ch(1, { state: 'in_progress', progress: 0.5 })]),
    );
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    const tick = onTickFor('b1', 1);
    tick({ type: 'chapter_complete', chapterId: 1 } as GenerationTick);
    /* No per-chapter complete events; rollup only on close. */
    const before = store
      .getState()
      .changeLog.events.filter((e) => e.type === 'generation_run_complete');
    expect(before).toHaveLength(0);
    tick({ type: 'idle' } as GenerationTick);
    const after = store
      .getState()
      .changeLog.events.filter((e) => e.type === 'generation_run_complete');
    expect(after).toHaveLength(1);
  });

  it('records a chapter_failed reason; takeChapterFailure returns it ONCE then null, surviving the idle close', () => {
    const { runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [2], force: true }, { chapterId: 2 });
    const tick = onTickFor('b1', 2);
    tick({ type: 'chapter_failed', chapterId: 2, errorReason: 'sidecar 500' } as GenerationTick);
    /* The stream then idles + closes, but the failure record outlives it — the
       dispatcher reads it on the post-close reconcile. */
    tick({ type: 'idle' } as GenerationTick);
    expect(runner.hasOpenStreamForChapter('b1', 2)).toBe(false);
    expect(runner.takeChapterFailure('b1', 2)).toBe('sidecar 500');
    /* One-shot — a re-run that succeeds can't read a stale failure. */
    expect(runner.takeChapterFailure('b1', 2)).toBeNull();
  });

  it('surfaces a chapter_failed tick carrying remediation + errorCode onto the failed row (fs-19)', () => {
    /* The runner dispatches applyGenerationTick for the VIEWED book, so the
       slice carries the structured failure class + the "what to do" copy onto
       the chapter row — the failed-state box renders it under the reason. */
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(
      chaptersSlice.actions.setChapters([ch(2, { state: 'in_progress', progress: 0.5 })]),
    );
    runner.open('b1', 'kokoro-v1', { chapterIds: [2], force: true }, { chapterId: 2 });
    onTickFor('b1', 2)({
      type: 'chapter_failed',
      chapterId: 2,
      errorReason: 'The workspace volume is out of disk space — the chapter audio could not be written.',
      errorCode: 'disk-full',
      remediation: 'Free up disk space on the workspace volume, then retry the chapter.',
    } as unknown as GenerationTick);
    const row = store.getState().chapters.chapters.find((c) => c.id === 2);
    expect(row?.state).toBe('failed');
    expect(row?.generationErrorCode).toBe('disk-full');
    expect(row?.generationRemediation).toMatch(/free up disk space/i);
  });

  it('records a CROSS-BOOK chapter_failed even when the slice is on another book', () => {
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('other-book'));
    runner.open('b1', 'kokoro-v1', { chapterIds: [3], force: true }, { chapterId: 3 });
    onTickFor('b1', 3)({ type: 'chapter_failed', chapterId: 3, errorReason: 'boom' } as GenerationTick);
    expect(runner.takeChapterFailure('b1', 3)).toBe('boom');
  });

  it('takeChapterFailure is null for a chapter that did not fail', () => {
    const { runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    expect(runner.takeChapterFailure('b1', 1)).toBeNull();
  });

  it('surfaces a `warning` tick as a toast (Qwen→Kokoro downgrade is never silent)', () => {
    /* Regression for the 2026-05-29 stale-build incident: the runner had no
       `warning` branch, so the server's downgrade advisory was dropped and a
       whole book rendered in the wrong voices unnoticed. */
    const { store, runner } = makeRunner();
    runner.open('b1', 'qwen3-tts-0.6b', { chapterIds: [1], force: true }, { chapterId: 1 });
    onTickFor('b1', 1)({
      type: 'warning',
      code: 'qwen_unavailable_kokoro_fallback',
      message: 'Qwen is unavailable, so every Qwen character will render in Kokoro …',
    } as unknown as GenerationTick);
    const toasts = store.getState().notifications.toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('warn');
    expect(toasts[0].message).toMatch(/Kokoro/);
    expect(toasts[0].dedupeKey).toBe('generation-warning:qwen_unavailable_kokoro_fallback');
  });

  it('dedupes identical `warning` ticks by code (per-chapter streams do not stack toasts)', () => {
    const { store, runner } = makeRunner();
    runner.open('b1', 'qwen3-tts-0.6b', { chapterIds: [1], force: true }, { chapterId: 1 });
    const warn = {
      type: 'warning',
      code: 'qwen_unavailable_kokoro_fallback',
      message: 'Qwen unavailable — falling back to Kokoro.',
    } as unknown as GenerationTick;
    onTickFor('b1', 1)(warn);
    onTickFor('b1', 1)(warn);
    expect(store.getState().notifications.toasts).toHaveLength(1);
  });

  it('surfaces a `chapter_awaiting_fallback_confirm` tick as a toast naming the chapter + characters', () => {
    const { store, runner } = makeRunner();
    runner.open('b1', 'qwen3-tts-0.6b', { chapterIds: [3], force: true }, { chapterId: 3 });
    onTickFor('b1', 3)({
      type: 'chapter_awaiting_fallback_confirm',
      chapterId: 3,
      queueEntryId: 'q3',
      fallbackCharacters: [
        { id: 'wren', name: 'Wren' },
        { id: 'nim', name: 'Nim' },
      ],
    } as unknown as GenerationTick);
    const toasts = store.getState().notifications.toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('warn');
    expect(toasts[0].message).toMatch(/Chapter 3/);
    expect(toasts[0].message).toMatch(/Wren, Nim/);
    expect(toasts[0].dedupeKey).toBe('fallback-confirm:q3');
  });

  it('refreshes the viewed book’s snapshot from rows on a progress tick', () => {
    const { store, runner } = makeRunner();
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(
      chaptersSlice.actions.setChapters([ch(1, { state: 'in_progress', progress: 0.1 }), ch(2)]),
    );
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    onTickFor(
      'b1',
      1,
    )({
      type: 'progress',
      chapterId: 1,
      progress: 0.5,
      characterId: 'narrator',
    } as GenerationTick);
    const snap = store.getState().chapters.activeStreams['b1::1'];
    expect(snap.lastTickAt).not.toBeNull();
  });

  it('cross-book stream updates its own snapshot from run aggregates without touching the viewed book’s rows', () => {
    const { store, runner } = makeRunner();
    /* Viewing b1; a stream is open for b2 (cross-book). */
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, { state: 'queued' })]));
    runner.open('b2', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    onTickFor(
      'b2',
      1,
    )({
      type: 'progress',
      chapterId: 1,
      progress: 0.5,
      runDone: 0,
      runTotal: 3,
      runInProgress: 1,
    } as unknown as GenerationTick);
    /* b2's snapshot picked up the run aggregates; b1's rows are untouched. */
    expect(store.getState().chapters.activeStreams['b2::1'].total).toBe(3);
    expect(store.getState().chapters.chapters[0].state).toBe('queued');
    expect(store.getState().chapters.chapters[0].progress).toBe(0);
  });

  it('closeAll tears down every stream', () => {
    const { runner } = makeRunner();
    runner.open('b1', 'kokoro-v1', { chapterIds: [1], force: true }, { chapterId: 1 });
    runner.open('b2', 'kokoro-v1', { chapterIds: [2], force: true }, { chapterId: 2 });
    runner.closeAll();
    expect(runner.openBookCount()).toBe(0);
    expect(cancelMock).toHaveBeenCalledTimes(2);
  });
});
