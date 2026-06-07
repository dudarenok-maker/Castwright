/* Pairs with docs/features/NNN-design-full-cast.md.

   The cast-design slice is a narrow out-of-band snapshot for the third
   top-bar status pill ("Designing"), driven by the server-owned bulk-design
   job via `cast-design-stream-middleware`. Tests cover the reducer surface,
   the cross-book guard (a tick for another book must not move this snapshot),
   and that per-character failures accumulate without bumping `done`. */

import { describe, it, expect } from 'vitest';
import { castDesignSlice, castDesignActions } from './cast-design-slice';

const begin = castDesignActions.begin({
  bookId: 'b1',
  total: 3,
  currentName: 'Sophie',
  lastTickAt: 1000,
});

describe('castDesignSlice — active snapshot reducers', () => {
  it('starts with active: null', () => {
    const state = castDesignSlice.reducer(undefined, { type: 'noop' });
    expect(state.active).toBeNull();
  });

  it('begin opens a running snapshot with zeroed counters', () => {
    const s = castDesignSlice.reducer(undefined, begin);
    expect(s.active).toEqual({
      bookId: 'b1',
      total: 3,
      done: 0,
      skipped: 0,
      currentName: 'Sophie',
      state: 'running',
      lastTickAt: 1000,
      failures: [],
    });
  });

  it('charDone bumps done; charSkipped bumps skipped; both refresh lastTickAt', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(s, castDesignActions.charDone({ bookId: 'b1', lastTickAt: 1100 }));
    s = castDesignSlice.reducer(s, castDesignActions.charSkipped({ bookId: 'b1', lastTickAt: 1200 }));
    expect(s.active).toMatchObject({ done: 1, skipped: 1, lastTickAt: 1200 });
  });

  it('charFailed records the failure WITHOUT bumping done', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(
      s,
      castDesignActions.charFailed({
        bookId: 'b1',
        characterId: 'c2',
        name: 'Keefe',
        error: 'GEMINI_API_KEY is required',
        lastTickAt: 1300,
      }),
    );
    expect(s.active?.done).toBe(0);
    expect(s.active?.failures).toEqual([
      { characterId: 'c2', name: 'Keefe', error: 'GEMINI_API_KEY is required' },
    ]);
  });

  it('tick advances currentName; heartbeat only refreshes lastTickAt', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(
      s,
      castDesignActions.tick({ bookId: 'b1', currentName: 'Keefe', lastTickAt: 1400 }),
    );
    expect(s.active).toMatchObject({ currentName: 'Keefe', lastTickAt: 1400 });
    s = castDesignSlice.reducer(s, castDesignActions.heartbeat({ bookId: 'b1', lastTickAt: 1500 }));
    expect(s.active).toMatchObject({ currentName: 'Keefe', lastTickAt: 1500 });
  });

  it('settle flips to done + nulls currentName; clear tears down', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(s, castDesignActions.settle({ bookId: 'b1', lastTickAt: 1600 }));
    expect(s.active).toMatchObject({ state: 'done', currentName: null });
    s = castDesignSlice.reducer(s, castDesignActions.clear());
    expect(s.active).toBeNull();
  });

  it('halt flips to halted (catastrophic abort)', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(s, castDesignActions.halt({ bookId: 'b1', lastTickAt: 1700 }));
    expect(s.active).toMatchObject({ state: 'halted', currentName: null });
  });

  it('cross-book guard: a tick for another book is ignored', () => {
    let s = castDesignSlice.reducer(undefined, begin);
    s = castDesignSlice.reducer(s, castDesignActions.charDone({ bookId: 'OTHER', lastTickAt: 9999 }));
    s = castDesignSlice.reducer(
      s,
      castDesignActions.charFailed({
        bookId: 'OTHER',
        characterId: 'x',
        name: 'X',
        error: 'e',
        lastTickAt: 9999,
      }),
    );
    s = castDesignSlice.reducer(s, castDesignActions.settle({ bookId: 'OTHER', lastTickAt: 9999 }));
    expect(s.active).toMatchObject({ done: 0, state: 'running', lastTickAt: 1000 });
    expect(s.active?.failures).toEqual([]);
  });

  it('designAllRequested + resubscribe are no-op reducers (side effects in middleware)', () => {
    const s0 = castDesignSlice.reducer(undefined, begin);
    const s1 = castDesignSlice.reducer(
      s0,
      castDesignActions.designAllRequested({ bookId: 'b1', characterIds: ['c1'], modelKey: 'k' }),
    );
    expect(s1.active).toEqual(s0.active);
    const s2 = castDesignSlice.reducer(s1, castDesignActions.resubscribe({ bookId: 'b1' }));
    expect(s2.active).toEqual(s0.active);
  });
});
