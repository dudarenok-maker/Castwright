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
    expect(revisionsSlice.getInitialState()).toEqual({
      pending: [],
      drift: [],
      dismissed: [],
      acceptedSelections: {},
      loaded: false,
    });
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

describe('revisionsSlice — acceptRevision / rejectRevision (per-item)', () => {
  it('acceptRevision removes only the named revision from pending', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1'), rev('r2'), rev('r3')], drift: [],
    }));
    const next = revisionsSlice.reducer(start,
      revisionsActions.acceptRevision({ revisionId: 'r2', selection: { 7: 'B', 8: 'A' } }));
    expect(next.pending.map(r => r.id)).toEqual(['r1', 'r3']);
  });

  it('acceptRevision records the per-segment selection map keyed by revision id', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1')], drift: [],
    }));
    const selection = { 12: 'B' as const, 13: 'A' as const };
    const next = revisionsSlice.reducer(start,
      revisionsActions.acceptRevision({ revisionId: 'r1', selection }));
    expect(next.acceptedSelections).toEqual({ r1: selection });
  });

  it('rejectRevision removes only the named revision from pending and records no selection', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1'), rev('r2')], drift: [],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.rejectRevision('r1'));
    expect(next.pending.map(r => r.id)).toEqual(['r2']);
    /* Reject is wholesale "throw this away" — no selection to remember. */
    expect(next.acceptedSelections).toEqual({});
  });

  it('acceptRevision is a no-op on pending when the id is unknown but still records the selection', () => {
    /* If the user's last poll didn't carry r-stale but they're acting on an
       in-memory copy they had before, the reducer should leave pending alone
       and still record the selection (so a future PUT carries it). Belt-and-
       braces — happens in practice if the modal stays open across a poll. */
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1')], drift: [],
    }));
    const next = revisionsSlice.reducer(start,
      revisionsActions.acceptRevision({ revisionId: 'r-stale', selection: { 1: 'A' } }));
    expect(next.pending.map(r => r.id)).toEqual(['r1']);
    expect(next.acceptedSelections).toEqual({ 'r-stale': { 1: 'A' } });
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
  it('loads pending, drift, dismissed, and acceptedSelections from disk', () => {
    const next = revisionsSlice.reducer(undefined, revisionsActions.hydrateFromBookState({
      pending: [rev('r1')],
      drift: [drift('d1')],
      dismissed: ['old-id'],
      acceptedSelections: { 'r-prev': { 4: 'B', 5: 'A' } },
    }));
    expect(next.pending.map(r => r.id)).toEqual(['r1']);
    expect(next.drift.map(d => d.id)).toEqual(['d1']);
    expect(next.dismissed).toEqual(['old-id']);
    expect(next.acceptedSelections).toEqual({ 'r-prev': { 4: 'B', 5: 'A' } });
    expect(next.loaded).toBe(true);
  });

  it('a null payload flips loaded but leaves slice fields empty', () => {
    const next = revisionsSlice.reducer(undefined, revisionsActions.hydrateFromBookState(null));
    expect(next.pending).toEqual([]);
    expect(next.drift).toEqual([]);
    expect(next.dismissed).toEqual([]);
    expect(next.acceptedSelections).toEqual({});
    expect(next.loaded).toBe(true);
  });

  it('absent dismissed and acceptedSelections default to empty', () => {
    const next = revisionsSlice.reducer(undefined, revisionsActions.hydrateFromBookState({
      pending: [], drift: [],
    }));
    expect(next.dismissed).toEqual([]);
    expect(next.acceptedSelections).toEqual({});
  });
});

describe('revisionsSlice — enqueuePending', () => {
  it('appends a new pending revision', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({ pending: [rev('r1')], drift: [] }));
    const next = revisionsSlice.reducer(start, revisionsActions.enqueuePending(
      rev('r2', { playable: false, hasPreviousAudio: true })),
    );
    expect(next.pending.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(next.pending[1].playable).toBe(false);
    expect(next.pending[1].hasPreviousAudio).toBe(true);
  });

  it('replaces (dedupes) when the same id is enqueued again', () => {
    /* Regen restart for the same character + chapter rebuilds the stub
       with a fresh playable=false. The dedupe is by id, so the slice
       carries exactly one entry per (chapterId, characterId) tuple as
       long as the id encodes both. */
    const start = revisionsSlice.reducer(undefined, revisionsActions.enqueuePending(
      rev('r1', { playable: true })),
    );
    const next = revisionsSlice.reducer(start, revisionsActions.enqueuePending(
      rev('r1', { playable: false })),
    );
    expect(next.pending).toHaveLength(1);
    expect(next.pending[0].playable).toBe(false);
  });
});

describe('revisionsSlice — markRevisionPlayable', () => {
  it('flips playable=true for matching chapterId', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [
        rev('r1', { chapterId: 1, playable: false }),
        rev('r2', { chapterId: 2, playable: false }),
      ],
      drift: [],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.markRevisionPlayable({ chapterId: 1 }));
    expect(next.pending.find(r => r.id === 'r1')?.playable).toBe(true);
    expect(next.pending.find(r => r.id === 'r2')?.playable).toBe(false);
  });

  it('flips all pending revisions targeting the same chapter (parallel regens)', () => {
    /* Two characters regenerated in the same chapter → two pending
       revisions with the same chapterId. chapter_complete fires once
       per chapter; both should flip. */
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [
        rev('r1', { chapterId: 3, characterId: 'a', playable: false }),
        rev('r2', { chapterId: 3, characterId: 'b', playable: false }),
      ],
      drift: [],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.markRevisionPlayable({ chapterId: 3 }));
    expect(next.pending.every(r => r.playable === true)).toBe(true);
  });

  it('is a no-op when no revision targets the chapter', () => {
    const start = revisionsSlice.reducer(undefined, revisionsActions.applyPoll({
      pending: [rev('r1', { chapterId: 1, playable: false })],
      drift: [],
    }));
    const next = revisionsSlice.reducer(start, revisionsActions.markRevisionPlayable({ chapterId: 99 }));
    expect(next.pending).toEqual(start.pending);
  });
});
