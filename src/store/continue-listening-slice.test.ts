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

const empty = (): ContinueListeningState => ({ items: [] });

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

describe('selectContinueListening', () => {
  it('returns items when slice is present', () => {
    const items = [item()];
    expect(selectContinueListening({ continueListening: { items } })).toEqual(items);
  });

  it('returns [] when slice is absent (older test stores)', () => {
    expect(selectContinueListening({})).toEqual([]);
  });
});
