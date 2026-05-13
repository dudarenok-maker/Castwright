// Pairs with docs/features/12-revisions-pipeline.md

import { describe, expect, it } from 'vitest';
import { revisionsSlice, revisionsActions } from './revisions-slice';
import type { Revision, DriftEvent, RevisionsResponse } from '../lib/types';

const rev = (id: string, overrides: Partial<Revision> = {}): Revision => ({
  id,
  chapterId: 1,
  characterId: 'halloran',
  segments: [],
  ...overrides,
});

const drift = (id: string, overrides: Partial<DriftEvent> = {}): DriftEvent => ({
  id,
  characterId: 'halloran',
  chapterId: 1,
  severity: 'mild',
  factor: 'register',
  ...overrides,
});

describe('revisionsSlice — initial state', () => {
  it('starts empty and not loaded', () => {
    expect(revisionsSlice.getInitialState()).toEqual({ pending: [], drift: [], dismissed: [], loaded: false });
  });
});

describe('revisionsSlice — applyPoll', () => {
  it('hydrates pending + drift and flips loaded', () => {
    const next = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1'), rev('r2')],
      drift: [drift('d1')],
    }));
    expect(next.pending.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(next.drift.map(d => d.id)).toEqual(['d1']);
    expect(next.loaded).toBe(true);
  });

  it('falls back to empty arrays when payload omits pending or drift', () => {
    const next = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({} as RevisionsResponse));
    expect(next.pending).toEqual([]);
    expect(next.drift).toEqual([]);
    expect(next.loaded).toBe(true);
  });

  it('replaces prior content on each poll', () => {
    let s = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1')], drift: [drift('d1')],
    }));
    s = revisionsSlice.reducer(s, revisionsActions.applyPoll({
      pending: [rev('r2')], drift: [],
    }));
    expect(s.pending.map(r => r.id)).toEqual(['r2']);
    expect(s.drift).toEqual([]);
  });
});

describe('revisionsSlice — acceptAllPending / rejectAllPending', () => {
  it('acceptAllPending clears the pending queue', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1'), rev('r2')], drift: [drift('d1')],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.acceptAllPending());
    expect(next.pending).toEqual([]);
    // drift untouched
    expect(next.drift).toEqual(start.drift);
  });

  it('rejectAllPending clears the pending queue', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1')], drift: [drift('d1')],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.rejectAllPending());
    expect(next.pending).toEqual([]);
    expect(next.drift).toEqual(start.drift);
  });
});

describe('revisionsSlice — dismissDrift', () => {
  it('removes the matching drift event by id', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      drift: [drift('d1'), drift('d2'), drift('d3')],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.dismissDrift('d2'));
    expect(next.drift.map(d => d.id)).toEqual(['d1', 'd3']);
  });

  it('records the dismissed id so the persistence patch carries it through', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      drift: [drift('d1'), drift('d2')],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.dismissDrift('d2'));
    expect(next.dismissed).toEqual(['d2']);
  });

  it('does not duplicate an id that is dismissed twice', () => {
    let s = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      drift: [drift('d1')],
    }));
    s = revisionsSlice.reducer(s, revisionsActions.dismissDrift('d1'));
    s = revisionsSlice.reducer(s, revisionsActions.dismissDrift('d1'));
    expect(s.dismissed).toEqual(['d1']);
  });

  it('is a no-op for an unknown id (still records dismissal so persistence stays consistent)', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      drift: [drift('d1')],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.dismissDrift('not-real'));
    expect(next.drift).toEqual(start.drift);
    /* "not-real" still lands in dismissed — the reducer can't tell whether
       an unknown id is a typo or an event that already aged out of the poll.
       Persisting it is harmless: the backend's drift detector only emits ids
       it knows, so a stray entry can never resurrect a real drift. */
    expect(next.dismissed).toEqual(['not-real']);
  });
});

describe('revisionsSlice — applyPoll preserves dismissed', () => {
  it('a runtime poll does not overwrite the dismissed list', () => {
    let s = revisionsSlice.reducer(undefined, revisionsActions.hydrateFromBookState({
      pending: [], drift: [drift('d1')], dismissed: ['d2', 'd3'],
    }));
    s = revisionsSlice.reducer(s, revisionsActions.applyPoll({
      pending: [], drift: [drift('d4')],
    }));
    expect(s.dismissed).toEqual(['d2', 'd3']);
    expect(s.drift.map(d => d.id)).toEqual(['d4']);
  });
});

describe('revisionsSlice — hydrateFromBookState', () => {
  it('loads pending, drift, and dismissed from disk', () => {
    const next = revisionsSlice.reducer(undefined, revisionsActions.hydrateFromBookState({
      pending: [rev('r1')],
      drift: [drift('d1')],
      dismissed: ['old-id'],
    }));
    expect(next.pending.map(r => r.id)).toEqual(['r1']);
    expect(next.drift.map(d => d.id)).toEqual(['d1']);
    expect(next.dismissed).toEqual(['old-id']);
    expect(next.loaded).toBe(true);
  });

  it('a null payload flips loaded but leaves slice arrays empty', () => {
    const next = revisionsSlice.reducer(undefined, revisionsActions.hydrateFromBookState(null));
    expect(next.pending).toEqual([]);
    expect(next.drift).toEqual([]);
    expect(next.dismissed).toEqual([]);
    expect(next.loaded).toBe(true);
  });

  it('absent dismissed defaults to empty array', () => {
    const next = revisionsSlice.reducer(undefined, revisionsActions.hydrateFromBookState({
      pending: [], drift: [],
    }));
    expect(next.dismissed).toEqual([]);
  });
});
