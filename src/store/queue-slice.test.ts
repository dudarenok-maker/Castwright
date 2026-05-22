/* Unit tests for queue-slice (plan 102). */

import { describe, it, expect } from 'vitest';
import {
  queueActions,
  queueSlice,
  selectInFlightEntry,
  selectQueueByBook,
  selectQueueCount,
  selectQueueEntries,
  selectQueueEntryById,
  selectQueueLoaded,
  selectQueuePaused,
  type QueueEntry,
  type QueueState,
} from './queue-slice';

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

  it('selectInFlightEntry returns the in_progress entry or null', () => {
    expect(selectInFlightEntry(populated)?.id).toBe('a1');
    const empty: { queue: QueueState } = {
      queue: { entries: [sampleEntry()], paused: false, loaded: true },
    };
    expect(selectInFlightEntry(empty)).toBeNull();
  });
});
