/* Unit tests for queue-slice (plan 102). */

import { describe, it, expect } from 'vitest';
import {
  queueActions,
  queueSlice,
  selectActiveGenerationView,
  selectGenerationActivityCount,
  selectInFlightEntry,
  selectInFlightEntryIds,
  selectQueueByBook,
  selectQueueCount,
  selectQueueEntries,
  selectQueueEntryById,
  selectQueueLoaded,
  selectQueuePaused,
  type QueueEntry,
  type QueueState,
} from './queue-slice';
import type { ActiveStreamSnapshot, ChaptersState } from './chapters-slice';

const sampleEntry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'e1',
  bookId: 'book-A',
  chapterId: 1,
  scope: 'this',
  addedAt: '2026-05-23T00:00:00.000Z',
  status: 'queued',
  order: 0,
  ...overrides,
});

const initial: QueueState = queueSlice.getInitialState();

describe('queueSlice.setSnapshot', () => {
  it('replaces entries + paused + flips loaded=true', () => {
    const next = queueSlice.reducer(
      initial,
      queueActions.setSnapshot({
        entries: [sampleEntry({ id: 'e1', order: 0 }), sampleEntry({ id: 'e2', order: 1 })],
        paused: true,
      }),
    );
    expect(next.entries).toHaveLength(2);
    expect(next.paused).toBe(true);
    expect(next.loaded).toBe(true);
  });

  it('round-trips the Wave-3 requiredEngines + multiTts fields into state', () => {
    const next = queueSlice.reducer(
      initial,
      queueActions.setSnapshot({
        entries: [
          sampleEntry({ id: 'single', requiredEngines: ['kokoro'], multiTts: false }),
          sampleEntry({ id: 'multi', requiredEngines: ['kokoro', 'qwen'], multiTts: true }),
          sampleEntry({ id: 'legacy' }),
        ],
        paused: false,
      }),
    );
    expect(next.entries[0].requiredEngines).toEqual(['kokoro']);
    expect(next.entries[0].multiTts).toBe(false);
    expect(next.entries[1].requiredEngines).toEqual(['kokoro', 'qwen']);
    expect(next.entries[1].multiTts).toBe(true);
    /* Legacy entry: fields absent, treated as single-engine / unknown. */
    expect(next.entries[2].requiredEngines).toBeUndefined();
    expect(next.entries[2].multiTts).toBeUndefined();
  });

  it('overwrites prior entries (server-authoritative)', () => {
    let s = queueSlice.reducer(
      initial,
      queueActions.setSnapshot({ entries: [sampleEntry({ id: 'old' })], paused: false }),
    );
    s = queueSlice.reducer(
      s,
      queueActions.setSnapshot({
        entries: [sampleEntry({ id: 'new', chapterId: 2, order: 0 })],
        paused: false,
      }),
    );
    expect(s.entries.map((e) => e.id)).toEqual(['new']);
  });

  it('setSnapshot ingests recycling (and defaults to false when omitted)', () => {
    const withRecycling = queueSlice.reducer(
      initial,
      queueActions.setSnapshot({ entries: [], paused: false, recycling: true }),
    );
    expect(withRecycling.recycling).toBe(true);

    const withoutRecycling = queueSlice.reducer(
      initial,
      queueActions.setSnapshot({ entries: [], paused: false }),
    );
    expect(withoutRecycling.recycling).toBe(false);
  });
});

describe('queueSlice.reset', () => {
  it('flips back to initial state', () => {
    const populated = queueSlice.reducer(
      initial,
      queueActions.setSnapshot({ entries: [sampleEntry()], paused: true }),
    );
    expect(queueSlice.reducer(populated, queueActions.reset())).toEqual(initial);
  });
});

describe('selectors', () => {
  const populated: { queue: QueueState } = {
    queue: {
      entries: [
        sampleEntry({ id: 'a1', bookId: 'book-A', chapterId: 1, order: 0, status: 'in_progress' }),
        sampleEntry({ id: 'b1', bookId: 'book-B', chapterId: 5, order: 1 }),
        sampleEntry({ id: 'a2', bookId: 'book-A', chapterId: 2, order: 2 }),
      ],
      paused: false,
      recycling: false,
      loaded: true,
    },
  };

  it('selectQueueEntries returns the array', () => {
    expect(selectQueueEntries(populated)).toHaveLength(3);
  });

  it('selectQueuePaused returns the flag', () => {
    expect(selectQueuePaused(populated)).toBe(false);
  });

  it('selectQueueLoaded returns the load flag', () => {
    expect(selectQueueLoaded(populated)).toBe(true);
  });

  it('selectQueueCount returns the length', () => {
    expect(selectQueueCount(populated)).toBe(3);
  });

  it('selectQueueEntryById finds an entry by id', () => {
    expect(selectQueueEntryById('b1')(populated)?.chapterId).toBe(5);
    expect(selectQueueEntryById('missing')(populated)).toBeUndefined();
  });

  it('selectQueueByBook groups by bookId in arrival order', () => {
    const grouped = selectQueueByBook(populated);
    expect(grouped.map((g) => g.bookId)).toEqual(['book-A', 'book-B']);
    expect(grouped[0].entries.map((e) => e.id)).toEqual(['a1', 'a2']);
    expect(grouped[1].entries.map((e) => e.id)).toEqual(['b1']);
  });

  it('selectInFlightEntry returns the FIRST in_progress entry or null', () => {
    expect(selectInFlightEntry(populated)?.id).toBe('a1');
    const empty: { queue: QueueState } = {
      queue: { entries: [sampleEntry()], paused: false, recycling: false, loaded: true },
    };
    expect(selectInFlightEntry(empty)).toBeNull();
  });

  it('selectInFlightEntryIds returns EVERY in_progress entry id (multiple concurrent)', () => {
    /* Queue-sole concurrency runs one chapter per worker, so several entries
       can be in_progress at once — the set must hold all of them. */
    const multi: { queue: QueueState } = {
      queue: {
        entries: [
          sampleEntry({ id: 'a1', bookId: 'book-A', chapterId: 1, status: 'in_progress' }),
          sampleEntry({ id: 'a2', bookId: 'book-A', chapterId: 2, status: 'in_progress' }),
          sampleEntry({ id: 'b1', bookId: 'book-B', chapterId: 5, status: 'queued' }),
          sampleEntry({ id: 'b2', bookId: 'book-B', chapterId: 6, status: 'failed' }),
        ],
        paused: false,
        recycling: false,
        loaded: true,
      },
    };
    const ids = selectInFlightEntryIds(multi);
    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual(['a1', 'a2']);
    expect(ids.has('b1')).toBe(false);
    expect(ids.has('b2')).toBe(false);
  });

  it('selectInFlightEntryIds is empty when nothing is in flight', () => {
    const none: { queue: QueueState } = {
      queue: { entries: [sampleEntry()], paused: false, recycling: false, loaded: true },
    };
    expect(selectInFlightEntryIds(none).size).toBe(0);
  });
});

/* Read-side honesty selectors — surface the live generation run (driven by the
   reconcile path, which writes no queue entry) when the workspace queue is empty
   so the modal / chip don't read "Empty"/0 mid-generation. */
describe('active-generation selectors', () => {
  const stream = (overrides: Partial<ActiveStreamSnapshot> = {}): ActiveStreamSnapshot =>
    ({
      bookId: 'book-A',
      modelKey: 'kokoro-v1',
      done: 2,
      total: 5,
      inProgress: 1,
      lastTickAt: null,
      halted: false,
      ...overrides,
    }) as ActiveStreamSnapshot;

  const chaptersState = (opts: {
    activeStream: ActiveStreamSnapshot | null;
    currentBookId: string | null;
    chapters?: Array<{ id: number; state: string; excluded?: boolean }>;
  }): ChaptersState =>
    ({
      chapters: (opts.chapters ?? []) as ChaptersState['chapters'],
      lastError: null,
      generationStartedAt: null,
      lastTickAt: null,
      currentBookId: opts.currentBookId,
      activeStreams: opts.activeStream ? { [opts.activeStream.bookId]: opts.activeStream } : {},
    }) as ChaptersState;

  const emptyQueue: QueueState = { entries: [], paused: false, recycling: false, loaded: true };

  it('returns null and the real count when there ARE real queue entries (real queue wins)', () => {
    const s = {
      queue: {
        entries: [sampleEntry({ id: 'r1' }), sampleEntry({ id: 'r2' })],
        paused: false,
        recycling: false,
        loaded: true,
      },
      chapters: chaptersState({ activeStream: stream(), currentBookId: 'book-A' }),
    };
    expect(selectActiveGenerationView(s)).toBeNull();
    expect(selectGenerationActivityCount(s)).toBe(2);
  });

  it('same-book stream: lists in_progress + queued rows (excluded filtered out)', () => {
    const s = {
      queue: emptyQueue,
      chapters: chaptersState({
        activeStream: stream({ done: 2, total: 5, inProgress: 1 }),
        currentBookId: 'book-A',
        chapters: [
          { id: 1, state: 'done' },
          { id: 2, state: 'in_progress' },
          { id: 3, state: 'queued' },
          { id: 4, state: 'queued', excluded: true },
          { id: 5, state: 'failed' },
        ],
      }),
    };
    const view = selectActiveGenerationView(s);
    expect(view).not.toBeNull();
    expect(view!.bookId).toBe('book-A');
    expect(view!.done).toBe(2);
    expect(view!.total).toBe(5);
    expect(view!.chapters).toEqual([
      { id: 2, state: 'in_progress' },
      { id: 3, state: 'queued' },
    ]);
    /* Count tracks the listed rows, not done/failed/excluded. */
    expect(selectGenerationActivityCount(s)).toBe(2);
  });

  it('cross-book stream: no per-chapter rows, count derived from the summary', () => {
    const s = {
      queue: emptyQueue,
      chapters: chaptersState({
        activeStream: stream({ bookId: 'book-B', done: 3, total: 10, inProgress: 2 }),
        currentBookId: 'book-A', // slice holds a DIFFERENT book
        chapters: [{ id: 1, state: 'done' }],
      }),
    };
    const view = selectActiveGenerationView(s);
    expect(view!.bookId).toBe('book-B');
    expect(view!.chapters).toBeNull();
    /* max(total-done, inProgress, 1) = max(7, 2, 1) = 7. */
    expect(selectGenerationActivityCount(s)).toBe(7);
  });

  it('empty queue with no live stream → null / 0', () => {
    const s = {
      queue: emptyQueue,
      chapters: chaptersState({ activeStream: null, currentBookId: 'book-A' }),
    };
    expect(selectActiveGenerationView(s)).toBeNull();
    expect(selectGenerationActivityCount(s)).toBe(0);
  });

  it('store without a chapters slice → null / 0 (defensive optional read)', () => {
    const s = { queue: emptyQueue };
    expect(selectActiveGenerationView(s)).toBeNull();
    expect(selectGenerationActivityCount(s)).toBe(0);
  });
});
