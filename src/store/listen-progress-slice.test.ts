// Pairs with docs/features/archive/47-listen-progress.md

import { describe, expect, it } from 'vitest';
import {
  listenProgressSlice,
  listenProgressActions,
  selectListenProgress,
  type ListenProgressRecord,
  type ListenProgressState,
} from './listen-progress-slice';

const empty = (): ListenProgressState => ({ byBook: {} });

const sample: ListenProgressRecord = {
  chapterId: 3,
  currentSec: 83.5,
  updatedAt: '2026-05-18T01:30:00.000Z',
};

describe('listenProgressSlice — hydrate', () => {
  it('seeds byBook[bookId] from a non-null record', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.hydrate({ bookId: 'b1', progress: sample }),
    );
    expect(next.byBook).toEqual({ b1: sample });
  });

  it('null progress clears any existing entry for the book without touching others', () => {
    const start: ListenProgressState = {
      byBook: { b1: sample, b2: { ...sample, chapterId: 5 } },
    };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.hydrate({ bookId: 'b1', progress: null }),
    );
    expect(next.byBook.b1).toBeUndefined();
    expect(next.byBook.b2?.chapterId).toBe(5);
  });
});

describe('listenProgressSlice — update', () => {
  it('writes a fresh record for a book that had none', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.update({ bookId: 'b1', chapterId: 7, currentSec: 12 }),
    );
    expect(next.byBook.b1?.chapterId).toBe(7);
    expect(next.byBook.b1?.currentSec).toBe(12);
    expect(typeof next.byBook.b1?.updatedAt).toBe('string');
  });

  it('overwrites the prior chapterId / currentSec for the same book', () => {
    const start: ListenProgressState = { byBook: { b1: sample } };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.update({ bookId: 'b1', chapterId: 9, currentSec: 99 }),
    );
    expect(next.byBook.b1?.chapterId).toBe(9);
    expect(next.byBook.b1?.currentSec).toBe(99);
  });

  it('respects an explicit updatedAt payload (server echo path)', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.update({
        bookId: 'b1',
        chapterId: 2,
        currentSec: 4,
        updatedAt: '2026-05-18T02:00:00.000Z',
      }),
    );
    expect(next.byBook.b1?.updatedAt).toBe('2026-05-18T02:00:00.000Z');
  });

  it('leaves entries for other books intact', () => {
    const start: ListenProgressState = { byBook: { b1: sample } };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.update({ bookId: 'b2', chapterId: 1, currentSec: 2 }),
    );
    expect(next.byBook.b1).toEqual(sample);
    expect(next.byBook.b2?.chapterId).toBe(1);
  });
});

describe('listenProgressSlice — clear', () => {
  it('removes one book without touching others', () => {
    const start: ListenProgressState = {
      byBook: { b1: sample, b2: { ...sample, chapterId: 11 } },
    };
    const next = listenProgressSlice.reducer(start, listenProgressActions.clear({ bookId: 'b1' }));
    expect(next.byBook.b1).toBeUndefined();
    expect(next.byBook.b2?.chapterId).toBe(11);
  });
});

describe('selectListenProgress', () => {
  it('returns the record for the given book when present', () => {
    const state = { listenProgress: { byBook: { b1: sample } } };
    expect(selectListenProgress('b1')(state)).toEqual(sample);
  });

  it('returns null when the book has no entry', () => {
    const state = { listenProgress: { byBook: {} } };
    expect(selectListenProgress('b1')(state)).toBeNull();
  });

  it('returns null when bookId is null (pre-ready stages have no active book)', () => {
    const state = { listenProgress: { byBook: { b1: sample } } };
    expect(selectListenProgress(null)(state)).toBeNull();
  });

  it('returns null defensively when the slice is absent from the store', () => {
    const state: { listenProgress?: ListenProgressState } = {};
    expect(selectListenProgress('b1')(state)).toBeNull();
  });
});
