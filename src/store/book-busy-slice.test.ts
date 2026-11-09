/* Plan 291 (#4031) — the store-level busy cache and its single-flight,
   backed-off poll. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

const api = vi.hoisted(() => ({ getBookBusy: vi.fn() }));
vi.mock('../lib/api', () => ({ api }));

import { bookBusySlice, bookBusyActions, pollBookBusy } from './book-busy-slice';
import { castSlice, castActions } from './cast-slice';
import { manuscriptSlice } from './manuscript-slice';
import { uiSlice, uiActions } from './ui-slice';
import { analysisSlice } from './analysis-slice';

function makeStore(open: string) {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      analysis: analysisSlice.reducer,
      bookBusy: bookBusySlice.reducer,
    },
  });
  store.dispatch(uiActions.openBook({ id: open, status: 'voices_pending' }));
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
  api.getBookBusy.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bookBusySlice', () => {
  it('records a reply per book, and a latch of the era drops that book\'s entry only', () => {
    let s = bookBusySlice.reducer(undefined, bookBusyActions.setBusy({ bookId: 'A', kinds: ['analysis'] }));
    s = bookBusySlice.reducer(s, bookBusyActions.setBusy({ bookId: 'B', kinds: [] }));
    s = bookBusySlice.reducer(s, castActions.latchAnalysisEra({ bookId: 'A' }));
    expect(s.busyByBook).toEqual({ B: [] });
  });
});

describe('pollBookBusy', () => {
  it('the busy poll is single-flight per book and backs off', async () => {
    api.getBookBusy.mockResolvedValue(['analysis']);
    const store = makeStore('A');
    const p1 = store.dispatch(pollBookBusy('A'));
    const p2 = store.dispatch(pollBookBusy('A'));
    expect(p2).toBe(p1);
    await vi.advanceTimersByTimeAsync(0);
    const calls = () => api.getBookBusy.mock.calls.filter(([id]) => id === 'A').length;
    expect(calls()).toBe(1);
    /* A reply listing `analysis` latches the era and is cached. */
    expect(store.getState().cast.analysisEra?.A).toBeDefined();
    expect(store.getState().bookBusy.busyByBook.A).toEqual(['analysis']);
    /* 1 s, 3 s, 9 s, 27 s, then every 30 s. */
    for (const [gap, total] of [[1000, 2], [3000, 3], [9000, 4], [27000, 5], [30000, 6], [30000, 7]] as const) {
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(calls()).toBe(total - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls()).toBe(total);
    }
    /* Leaving the book ends the loop with its last reply. */
    store.dispatch(uiActions.openBook({ id: 'B', status: 'voices_pending' }));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls()).toBe(7);
    await expect(p1).resolves.toEqual(['analysis']);
    /* The next poll is a fresh flight. */
    expect(store.dispatch(pollBookBusy('A'))).not.toBe(p1);
  });

  it('a reply issued before the era moved is not cached; the poll asks again', async () => {
    let answer!: (k: string[]) => void;
    api.getBookBusy.mockImplementationOnce(() => new Promise((r) => (answer = r))).mockResolvedValue([]);
    const store = makeStore('A');
    store.dispatch(castActions.latchAnalysisEra({ bookId: 'A' }));
    const p = store.dispatch(pollBookBusy('A'));
    await vi.advanceTimersByTimeAsync(0);
    store.dispatch(castActions.latchAnalysisEra({ bookId: 'A' }));
    answer([]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toEqual([]);
    expect(api.getBookBusy).toHaveBeenCalledTimes(2);
    expect(store.getState().bookBusy.busyByBook.A).toEqual([]);
  });
});
