import { describe, expect, it } from 'vitest';
import {
  continueListeningSlice,
  continueListeningActions,
  selectContinueListening,
  type ContinueItem,
  type ContinueListeningState,
} from './continue-listening-slice';

const item = (over: Partial<ContinueItem> = {}): ContinueItem => ({
  bookId: 'b1',
  title: 'The Coalfall Commission',
  chapterId: 3,
  currentSec: 120,
  remainingSec: 3600,
  completionPct: 0.25,
  updatedAt: '2026-06-13T10:00:00.000Z',
  ...over,
});

const empty = (): ContinueListeningState => ({ items: [], dismissedIds: [] });

describe('continueListeningSlice — hydrate', () => {
  it('stores the supplied items', () => {
    const items = [item(), item({ bookId: 'b2', title: 'Another Book' })];
    const next = continueListeningSlice.reducer(empty(), continueListeningActions.hydrate(items));
    expect(next.items).toEqual(items);
  });

  it('replaces a previously-hydrated list', () => {
    const start = continueListeningSlice.reducer(
      empty(),
      continueListeningActions.hydrate([item()]),
    );
    const replacement = [item({ bookId: 'b2', title: 'Book Two' })];
    const next = continueListeningSlice.reducer(
      start,
      continueListeningActions.hydrate(replacement),
    );
    expect(next.items).toEqual(replacement);
  });

  it('accepts an empty array (clears the shelf)', () => {
    const start = continueListeningSlice.reducer(
      empty(),
      continueListeningActions.hydrate([item()]),
    );
    const next = continueListeningSlice.reducer(start, continueListeningActions.hydrate([]));
    expect(next.items).toHaveLength(0);
  });
});

describe('continueListeningSlice — dismiss', () => {
  it('removes the matching book and leaves the rest', () => {
    const start = continueListeningSlice.reducer(
      empty(),
      continueListeningActions.hydrate([item({ bookId: 'b1' }), item({ bookId: 'b2' })]),
    );
    const next = continueListeningSlice.reducer(start, continueListeningActions.dismiss('b1'));
    expect(next.items.map((i) => i.bookId)).toEqual(['b2']);
  });

  it('is a no-op when the bookId is not on the shelf', () => {
    const start = continueListeningSlice.reducer(
      empty(),
      continueListeningActions.hydrate([item({ bookId: 'b1' })]),
    );
    const next = continueListeningSlice.reducer(start, continueListeningActions.dismiss('nope'));
    expect(next.items.map((i) => i.bookId)).toEqual(['b1']);
  });
});

describe('selectContinueListening', () => {
  it('returns items when slice is present', () => {
    const items = [item()];
    expect(selectContinueListening({ continueListening: { items, dismissedIds: [] } })).toEqual(items);
  });

  it('returns [] when slice is absent (older test stores)', () => {
    expect(selectContinueListening({})).toEqual([]);
  });
});

const reducer = continueListeningSlice.reducer;
const actions = continueListeningActions;

describe('continueListeningSlice — dismissedIds flicker guard', () => {
  it('hydrate keeps a dismissed book out until the server confirms it gone', () => {
    let s = reducer(undefined, actions.hydrate([item({ bookId: 'a' }), item({ bookId: 'b' })]));
    s = reducer(s, actions.dismiss('a'));
    s = reducer(s, actions.hydrate([item({ bookId: 'a' }), item({ bookId: 'b' })])); // server still returns 'a'
    expect(s.items.map((i) => i.bookId)).toEqual(['b']);
    s = reducer(s, actions.hydrate([item({ bookId: 'b' })])); // server now omits 'a'
    expect(s.dismissedIds).not.toContain('a');
    s = reducer(s, actions.hydrate([item({ bookId: 'a' }), item({ bookId: 'b' })])); // 'a' reappears
    expect(s.items.map((i) => i.bookId)).toEqual(['a', 'b']);
  });

  it('undismiss restores a card (fs-15 failed-POST recovery)', () => {
    let s = reducer(undefined, actions.hydrate([item({ bookId: 'a' })]));
    s = reducer(s, actions.dismiss('a'));
    s = reducer(s, actions.undismiss('a'));
    s = reducer(s, actions.hydrate([item({ bookId: 'a' })]));
    expect(s.items.map((i) => i.bookId)).toEqual(['a']);
  });

  it('dismiss deduplicates ids', () => {
    let s = reducer(undefined, actions.hydrate([item({ bookId: 'a' })]));
    s = reducer(s, actions.dismiss('a'));
    s = reducer(s, actions.dismiss('a'));
    expect(s.dismissedIds).toEqual(['a']);
  });
});
