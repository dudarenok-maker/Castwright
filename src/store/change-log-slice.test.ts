/* Slice unit tests — pairs with the per-book hydration in
   src/components/layout.tsx and the persistence rule in
   src/store/persistence-middleware.ts. */

import { describe, expect, it } from 'vitest';
import { changeLogSlice, changeLogActions, type ChangeLogState } from './change-log-slice';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
import type { ChangeLogEvent } from '../lib/types';

const seed: ChangeLogState = { events: CHANGE_LOG_EVENTS };

const makeEvent = (id: number, overrides: Partial<ChangeLogEvent> = {}): ChangeLogEvent => ({
  id,
  at: new Date(id).toISOString(),
  ts: 'Just now',
  date: 'today',
  type: 'regenerate',
  title: `Event ${id}`,
  note: 'note',
  actor: 'you',
  ...overrides,
});

describe('changeLogSlice', () => {
  it('seeds with the demo fixture so the workspace Activity view is non-empty on first run', () => {
    expect(changeLogSlice.getInitialState().events).toBe(CHANGE_LOG_EVENTS);
  });

  it('appendLogEvent unshifts (newest first)', () => {
    const start: ChangeLogState = { events: [makeEvent(2)] };
    const next = changeLogSlice.reducer(start, changeLogActions.appendLogEvent(makeEvent(3)));
    expect(next.events.map(e => e.id)).toEqual([3, 2]);
  });

  it('hydrateFromBookState replaces the seed with disk events', () => {
    const next = changeLogSlice.reducer(seed, changeLogActions.hydrateFromBookState([
      makeEvent(100, { title: 'On-disk entry' }),
    ]));
    expect(next.events).toHaveLength(1);
    expect(next.events[0].title).toBe('On-disk entry');
  });

  it('hydrateFromBookState falls back to an empty list when the book has no on-disk log', () => {
    /* The seed must not leak into a book that has never had a regenerate
       action — otherwise opening a fresh book would replay a previous
       book's demo entries in its own Activity view. */
    const next = changeLogSlice.reducer(seed, changeLogActions.hydrateFromBookState(null));
    expect(next.events).toEqual([]);
  });

  it('reset clears the slice', () => {
    const start: ChangeLogState = { events: [makeEvent(1), makeEvent(2)] };
    const next = changeLogSlice.reducer(start, changeLogActions.reset());
    expect(next.events).toEqual([]);
  });
});
