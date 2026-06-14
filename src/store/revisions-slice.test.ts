// Pairs with docs/features/archive/20-revisions-and-drift.md

import { describe, expect, it } from 'vitest';
import {
  revisionsSlice,
  revisionsActions,
  selectDriftByBook,
  selectDriftGroupsByBook,
  distinctDriftChapterCount,
} from './revisions-slice';
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
  bookId: 'book-A',
  chapterTitle: 'Chapter One',
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
      timeline: {},
      loaded: false,
    });
  });
});

describe('distinctDriftChapterCount — headline count dedupes to chapters', () => {
  it('counts a chapter once even when multiple cast members drift in it', () => {
    /* The real-world bug: chapter 5 has Halloran AND Marcus drifting. Raw
       event count = 2, but regenerating chapter 5 clears both → 1 chapter. */
    const events = [
      drift('d1', { chapterId: 5, characterId: 'halloran' }),
      drift('d2', { chapterId: 5, characterId: 'marcus' }),
    ];
    expect(distinctDriftChapterCount(events)).toBe(1);
  });

  it('counts a chapter once even when one character drifts on multiple factors', () => {
    const events = [
      drift('d1', { chapterId: 7, characterId: 'eliza', factor: 'register' }),
      drift('d2', { chapterId: 7, characterId: 'eliza', factor: 'pace' }),
    ];
    expect(distinctDriftChapterCount(events)).toBe(1);
  });

  it('keeps the same chapter number distinct across books', () => {
    const events = [
      drift('d1', { bookId: 'book-A', chapterId: 3 }),
      drift('d2', { bookId: 'book-B', chapterId: 3 }),
    ];
    expect(distinctDriftChapterCount(events)).toBe(2);
  });

  it('returns 0 for no events', () => {
    expect(distinctDriftChapterCount([])).toBe(0);
  });
});

describe('revisionsSlice — applyPoll', () => {
  it('hydrates pending + drift and flips loaded', () => {
    const next = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1'), rev('r2')],
        drift: [drift('d1')],
      }),
    );
    expect(next.pending.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(next.drift.map((d) => d.id)).toEqual(['d1']);
    expect(next.loaded).toBe(true);
  });

  it('falls back to empty arrays when payload omits pending or drift', () => {
    const next = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({} as RevisionsResponse),
    );
    expect(next.pending).toEqual([]);
    expect(next.drift).toEqual([]);
    expect(next.loaded).toBe(true);
  });

  it('replaces prior content on each poll', () => {
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1')],
        drift: [drift('d1')],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.applyPoll({
        pending: [rev('r2')],
        drift: [],
      }),
    );
    expect(s.pending.map((r) => r.id)).toEqual(['r2']);
    expect(s.drift).toEqual([]);
  });
});

describe('revisionsSlice — acceptRevision / rejectRevision (per-item)', () => {
  it('acceptRevision removes only the named revision from pending', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1'), rev('r2'), rev('r3')],
        drift: [],
      }),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.acceptRevision({ revisionId: 'r2', selection: { 7: 'B', 8: 'A' } }),
    );
    expect(next.pending.map((r) => r.id)).toEqual(['r1', 'r3']);
  });

  it('acceptRevision records the per-segment selection map keyed by revision id', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1')],
        drift: [],
      }),
    );
    const selection = { 12: 'B' as const, 13: 'A' as const };
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.acceptRevision({ revisionId: 'r1', selection }),
    );
    expect(next.acceptedSelections).toEqual({ r1: selection });
  });

  it('rejectRevision removes only the named revision from pending and records no selection', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1'), rev('r2')],
        drift: [],
      }),
    );
    const next = revisionsSlice.reducer(start, revisionsActions.rejectRevision('r1'));
    expect(next.pending.map((r) => r.id)).toEqual(['r2']);
    /* Reject is wholesale "throw this away" — no selection to remember. */
    expect(next.acceptedSelections).toEqual({});
  });

  it('acceptRevision is a no-op on pending when the id is unknown but still records the selection', () => {
    /* If the user's last poll didn't carry r-stale but they're acting on an
       in-memory copy they had before, the reducer should leave pending alone
       and still record the selection (so a future PUT carries it). Belt-and-
       braces — happens in practice if the modal stays open across a poll. */
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1')],
        drift: [],
      }),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.acceptRevision({ revisionId: 'r-stale', selection: { 1: 'A' } }),
    );
    expect(next.pending.map((r) => r.id)).toEqual(['r1']);
    expect(next.acceptedSelections).toEqual({ 'r-stale': { 1: 'A' } });
  });
});

describe('revisionsSlice — acceptAllPending / rejectAllPending', () => {
  it('acceptAllPending clears the pending queue', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1'), rev('r2')],
        drift: [drift('d1')],
      }),
    );
    const next = revisionsSlice.reducer(start, revisionsActions.acceptAllPending());
    expect(next.pending).toEqual([]);
    // drift untouched
    expect(next.drift).toEqual(start.drift);
  });

  it('rejectAllPending clears the pending queue', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1')],
        drift: [drift('d1')],
      }),
    );
    const next = revisionsSlice.reducer(start, revisionsActions.rejectAllPending());
    expect(next.pending).toEqual([]);
    expect(next.drift).toEqual(start.drift);
  });
});

describe('revisionsSlice — dismissDrift', () => {
  it('removes the matching drift event by id', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [drift('d1'), drift('d2'), drift('d3')],
      }),
    );
    const next = revisionsSlice.reducer(start, revisionsActions.dismissDrift('d2'));
    expect(next.drift.map((d) => d.id)).toEqual(['d1', 'd3']);
  });

  it('records the dismissed id so the persistence patch carries it through', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [drift('d1'), drift('d2')],
      }),
    );
    const next = revisionsSlice.reducer(start, revisionsActions.dismissDrift('d2'));
    expect(next.dismissed).toEqual(['d2']);
  });

  it('does not duplicate an id that is dismissed twice', () => {
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [drift('d1')],
      }),
    );
    s = revisionsSlice.reducer(s, revisionsActions.dismissDrift('d1'));
    s = revisionsSlice.reducer(s, revisionsActions.dismissDrift('d1'));
    expect(s.dismissed).toEqual(['d1']);
  });

  it('is a no-op for an unknown id (still records dismissal so persistence stays consistent)', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [drift('d1')],
      }),
    );
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
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.hydrateFromBookState({
        pending: [],
        drift: [drift('d1')],
        dismissed: ['d2', 'd3'],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.applyPoll({
        pending: [],
        drift: [drift('d4')],
      }),
    );
    expect(s.dismissed).toEqual(['d2', 'd3']);
    expect(s.drift.map((d) => d.id)).toEqual(['d4']);
  });
});

describe('revisionsSlice — hydrateFromBookState', () => {
  it('loads pending, drift, dismissed, and acceptedSelections from disk', () => {
    const next = revisionsSlice.reducer(
      undefined,
      revisionsActions.hydrateFromBookState({
        pending: [rev('r1')],
        drift: [drift('d1')],
        dismissed: ['old-id'],
        acceptedSelections: { 'r-prev': { 4: 'B', 5: 'A' } },
      }),
    );
    expect(next.pending.map((r) => r.id)).toEqual(['r1']);
    expect(next.drift.map((d) => d.id)).toEqual(['d1']);
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
    const next = revisionsSlice.reducer(
      undefined,
      revisionsActions.hydrateFromBookState({
        pending: [],
        drift: [],
      }),
    );
    expect(next.dismissed).toEqual([]);
    expect(next.acceptedSelections).toEqual({});
  });
});

describe('revisionsSlice — plan 55 timeline', () => {
  it('acceptRevision appends an `accepted` timeline entry keyed by chapterId', () => {
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1', { chapterId: 3, characterId: 'halloran' })],
        drift: [],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.acceptRevision({ revisionId: 'r1', selection: { 1: 'B' } }),
    );
    expect(s.timeline[3]).toHaveLength(1);
    expect(s.timeline[3][0]).toMatchObject({
      id: 'r1',
      chapterId: 3,
      characterId: 'halloran',
      eventKind: 'accepted',
      status: 'active',
    });
    expect(typeof s.timeline[3][0].timestamp).toBe('string');
  });

  it('rejectRevision appends a `rejected` timeline entry', () => {
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r2', { chapterId: 5, characterId: 'wren' })],
        drift: [],
      }),
    );
    s = revisionsSlice.reducer(s, revisionsActions.rejectRevision('r2'));
    expect(s.timeline[5]).toHaveLength(1);
    expect(s.timeline[5][0]).toMatchObject({
      id: 'r2',
      chapterId: 5,
      characterId: 'wren',
      eventKind: 'rejected',
      status: 'active',
    });
  });

  it('subsequent accept on the same chapter flips the prior reversible entry off', () => {
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [
          rev('r1', { chapterId: 3, characterId: 'a' }),
          rev('r2', { chapterId: 3, characterId: 'b' }),
        ],
        drift: [],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.acceptRevision({ revisionId: 'r1', selection: {} }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.acceptRevision({ revisionId: 'r2', selection: {} }),
    );
    expect(s.timeline[3]).toHaveLength(2);
    expect(s.timeline[3][0].reversible).toBe(false);
    expect(s.timeline[3][1].reversible).toBe(true);
  });

  it('accept on an unknown revisionId is a no-op for timeline (no pending to read chapter from)', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.acceptRevision({ revisionId: 'never-existed', selection: {} }),
    );
    expect(s.timeline).toEqual({});
  });

  it('rolledBack flips the targeted entry to `rolled-back-from` and appends a new `rolled-back` entry', () => {
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1', { chapterId: 2 })],
        drift: [],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.acceptRevision({ revisionId: 'r1', selection: {} }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.rolledBack({
        chapterId: 2,
        timelineEntryId: 'r1',
        rolledBackId: 'rb-1',
      }),
    );
    expect(s.timeline[2]).toHaveLength(2);
    expect(s.timeline[2][0].status).toBe('rolled-back-from');
    expect(s.timeline[2][1]).toMatchObject({
      id: 'rb-1',
      eventKind: 'rolled-back',
      status: 'active',
      reversible: false,
    });
  });

  it('hydrateFromBookState normalises string-keyed timeline (JSON serialisation)', () => {
    /* On-disk JSON keys are strings; the slice carries numeric chapterIds.
       Defensive normalisation preserves both shapes on hydrate. */
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.hydrateFromBookState({
        timeline: {
          '7': [
            {
              id: 'r99',
              chapterId: 7,
              eventKind: 'accepted',
              timestamp: '2026-05-19T10:00:00.000Z',
              status: 'active',
            },
          ],
        },
      }),
    );
    expect(s.timeline[7]).toHaveLength(1);
    expect(s.timeline[7][0].id).toBe('r99');
  });
});

describe('revisionsSlice — multi-book drift (plan: drift-report-fidelity)', () => {
  it('applyPoll with bookId replaces only that book\'s drift, preserving siblings', () => {
    /* Two concurrent books — Book A polled first, then Book B. Both books'
       drift events should coexist in the flat list. */
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        bookId: 'book-A',
        drift: [drift('d-A1', { bookId: 'book-A' })],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.applyPoll({
        bookId: 'book-B',
        drift: [drift('d-B1', { bookId: 'book-B' })],
      }),
    );
    expect(s.drift.map((d) => d.id).sort()).toEqual(['d-A1', 'd-B1']);
  });

  it('applyPoll with bookId stamps bookId on events that arrive without it', () => {
    /* Defensive: if the server omits bookId (older deploy), stamp it from
       the poll context so the slice's selectors stay coherent. */
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        bookId: 'book-A',
        drift: [{ ...drift('d-A1'), bookId: undefined as unknown as string }],
      }),
    );
    expect(s.drift[0].bookId).toBe('book-A');
  });

  it('re-polling Book A replaces only Book A\'s events', () => {
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        bookId: 'book-A',
        drift: [drift('d-A-old', { bookId: 'book-A' })],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.applyPoll({
        bookId: 'book-B',
        drift: [drift('d-B1', { bookId: 'book-B' })],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.applyPoll({
        bookId: 'book-A',
        drift: [drift('d-A-new', { bookId: 'book-A' })],
      }),
    );
    expect(s.drift.map((d) => d.id).sort()).toEqual(['d-A-new', 'd-B1']);
  });

  it('hydrateFromBookState with bookId merges into the flat drift list', () => {
    let s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        bookId: 'book-A',
        drift: [drift('d-A1', { bookId: 'book-A' })],
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.hydrateFromBookState({
        bookId: 'book-B',
        drift: [drift('d-B1', { bookId: 'book-B' })],
        dismissed: [],
      }),
    );
    expect(s.drift.map((d) => d.id).sort()).toEqual(['d-A1', 'd-B1']);
  });

  it('selectDriftByBook groups flat drift events by bookId', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d-A1', { bookId: 'book-A' }),
          drift('d-B1', { bookId: 'book-B' }),
          drift('d-A2', { bookId: 'book-A' }),
        ],
      }),
    );
    const grouped = selectDriftByBook({ revisions: s });
    /* First-appearance order is preserved so the modal doesn't reshuffle
       sections when a single book's events trickle in mid-render. */
    expect(grouped.map((g) => g.bookId)).toEqual(['book-A', 'book-B']);
    expect(grouped[0].events.map((d) => d.id)).toEqual(['d-A1', 'd-A2']);
    expect(grouped[1].events.map((d) => d.id)).toEqual(['d-B1']);
  });

  it('selectDriftByBook returns a stable reference when the drift array is unchanged', () => {
    /* Memoisation invariant — unrelated reducer dispatches must not
       force the modal's selector to walk the array again. */
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [drift('d-A1', { bookId: 'book-A' })],
      }),
    );
    const first = selectDriftByBook({ revisions: s });
    const second = selectDriftByBook({ revisions: s });
    expect(second).toBe(first);
  });
});

describe('selectDriftGroupsByBook — (book × character × snapshot) consolidation', () => {
  /* Sample snapshots — A and B differ on voiceId so they fingerprint
     apart; A and A' are deeply equal so they fingerprint together
     (mid-book cast edit edge case). */
  const snapA: DriftEvent['snapshot'] = {
    voiceId: 'old-voice',
    tone: { warmth: 40, pace: 50 },
    attributes: ['warm'],
  };
  const snapB: DriftEvent['snapshot'] = {
    voiceId: 'second-old-voice',
    tone: { warmth: 40, pace: 50 },
    attributes: ['warm'],
  };
  const cur: DriftEvent['current'] = {
    voiceId: 'new-voice',
    tone: { warmth: 60, pace: 50 },
    attributes: ['warm'],
  };

  it('collapses N events sharing one snapshot into a single group', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d1', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur }),
          drift('d2', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur }),
          drift('d3', { bookId: 'book-A', chapterId: 3, snapshot: snapA, current: cur }),
        ],
      }),
    );
    const result = selectDriftGroupsByBook({ revisions: s });
    expect(result).toHaveLength(1);
    expect(result[0].groups).toHaveLength(1);
    expect(result[0].groups[0].events.map((e) => e.id)).toEqual(['d1', 'd2', 'd3']);
  });

  it('splits a character with two snapshots (mid-book cast edit) into two groups', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d1', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur }),
          drift('d2', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur }),
          drift('d3', { bookId: 'book-A', chapterId: 3, snapshot: snapB, current: cur }),
        ],
      }),
    );
    const groups = selectDriftGroupsByBook({ revisions: s })[0].groups;
    expect(groups).toHaveLength(2);
    expect(groups[0].events.map((e) => e.id)).toEqual(['d1', 'd2']);
    expect(groups[1].events.map((e) => e.id)).toEqual(['d3']);
  });

  it('sorts events within a group by chapterId ascending', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d3', { bookId: 'book-A', chapterId: 9, snapshot: snapA, current: cur }),
          drift('d1', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur }),
          drift('d2', { bookId: 'book-A', chapterId: 5, snapshot: snapA, current: cur }),
        ],
      }),
    );
    const events = selectDriftGroupsByBook({ revisions: s })[0].groups[0].events;
    expect(events.map((e) => e.chapterId)).toEqual([2, 5, 9]);
  });

  it('aggregates severity counts and topSeverity per group', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d1', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur, severity: 'severe' }),
          drift('d2', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur, severity: 'moderate' }),
          drift('d3', { bookId: 'book-A', chapterId: 3, snapshot: snapA, current: cur, severity: 'mild' }),
        ],
      }),
    );
    const g = selectDriftGroupsByBook({ revisions: s })[0].groups[0];
    expect(g.topSeverity).toBe('severe');
    expect(g.severityCounts).toEqual({ severe: 1, moderate: 1, mild: 1 });
  });

  it('union of factors across events lands on the group', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d1', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur, factor: 'voice' }),
          drift('d2', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur, factor: 'warmth' }),
          drift('d3', { bookId: 'book-A', chapterId: 3, snapshot: snapA, current: cur, factor: 'voice' }),
        ],
      }),
    );
    const g = selectDriftGroupsByBook({ revisions: s })[0].groups[0];
    expect(g.factors.sort()).toEqual(['voice', 'warmth']);
  });

  it('allAutoQueueable is false when any event is not autoQueueable', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d1', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur, autoQueueable: true }),
          drift('d2', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur, autoQueueable: undefined }),
        ],
      }),
    );
    expect(selectDriftGroupsByBook({ revisions: s })[0].groups[0].allAutoQueueable).toBe(false);
  });

  it('returns a stable reference when the drift array is unchanged', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [drift('d1', { bookId: 'book-A', snapshot: snapA, current: cur })],
      }),
    );
    const first = selectDriftGroupsByBook({ revisions: s });
    const second = selectDriftGroupsByBook({ revisions: s });
    expect(second).toBe(first);
  });
});

describe('selectDriftGroupsByBook — per-chapter rollup (multi-factor dedup)', () => {
  /* Regression for the Voice Drift Detector "duplicated chapter rows"
     bug: the server emits one DriftEvent per drift factor (voice / tone
     metrics / attributes / …), and the modal's chapter strip must
     collapse those to one row per chapter. The slice's `chapters[]`
     derivation is where that collapse happens. */
  const snapA: DriftEvent['snapshot'] = {
    voiceId: 'old-voice',
    tone: { warmth: 40, pace: 50 },
    attributes: ['warm'],
  };
  const cur: DriftEvent['current'] = {
    voiceId: 'new-voice',
    tone: { warmth: 80, pace: 50 },
    attributes: ['warm', 'tense'],
  };

  it('collapses N factor-events on the same chapter into one chapters[] entry', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('drift:book-A:3:marlow:voice', {
            bookId: 'book-A',
            chapterId: 3,
            characterId: 'marlow',
            snapshot: snapA,
            current: cur,
            factor: 'voice',
            severity: 'severe',
          }),
          drift('drift:book-A:3:marlow:warmth', {
            bookId: 'book-A',
            chapterId: 3,
            characterId: 'marlow',
            snapshot: snapA,
            current: cur,
            factor: 'warmth',
            severity: 'moderate',
          }),
          drift('drift:book-A:3:marlow:attributes', {
            bookId: 'book-A',
            chapterId: 3,
            characterId: 'marlow',
            snapshot: snapA,
            current: cur,
            factor: 'attributes',
            severity: 'moderate',
          }),
        ],
      }),
    );
    const g = selectDriftGroupsByBook({ revisions: s })[0].groups[0];
    /* events[] keeps every factor-event (dismiss-all loops over them). */
    expect(g.events).toHaveLength(3);
    /* chapters[] dedupes to one row for the chapter. */
    expect(g.chapters).toHaveLength(1);
    const entry = g.chapters[0];
    expect(entry.chapterId).toBe(3);
    expect(entry.eventIds.sort()).toEqual([
      'drift:book-A:3:marlow:attributes',
      'drift:book-A:3:marlow:voice',
      'drift:book-A:3:marlow:warmth',
    ]);
    expect(entry.factors.sort()).toEqual(['attributes', 'voice', 'warmth']);
    /* Top severity of the chapter is the max across its events. */
    expect(entry.topSeverity).toBe('severe');
    /* Representative event is the top-severity one (drives the
       DriftListenWidget audio probe). */
    expect(entry.representativeEvent.id).toBe('drift:book-A:3:marlow:voice');
  });

  it('chapters[] sorts by chapterId ascending even when events arrive out of order', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d-c5', { bookId: 'book-A', chapterId: 5, snapshot: snapA, current: cur, factor: 'voice' }),
          drift('d-c2-v', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur, factor: 'voice' }),
          drift('d-c2-w', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur, factor: 'warmth' }),
          drift('d-c9', { bookId: 'book-A', chapterId: 9, snapshot: snapA, current: cur, factor: 'voice' }),
        ],
      }),
    );
    const g = selectDriftGroupsByBook({ revisions: s })[0].groups[0];
    expect(g.chapters.map((c) => c.chapterId)).toEqual([2, 5, 9]);
    /* Chapter 2 has two factors collapsed; 5 and 9 have one each. */
    expect(g.chapters[0].eventIds).toHaveLength(2);
    expect(g.chapters[1].eventIds).toHaveLength(1);
    expect(g.chapters[2].eventIds).toHaveLength(1);
  });

  it('per-chapter autoQueueable is the AND over its events; group.allAutoQueueable is the AND over chapters', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          /* CH 1: voice severe (auto) + warmth moderate (NOT auto) → chapter NOT auto. */
          drift('d1v', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur, factor: 'voice', autoQueueable: true }),
          drift('d1w', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur, factor: 'warmth', autoQueueable: false }),
          /* CH 2: voice severe (auto only) → chapter IS auto. */
          drift('d2v', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur, factor: 'voice', autoQueueable: true }),
        ],
      }),
    );
    const g = selectDriftGroupsByBook({ revisions: s })[0].groups[0];
    expect(g.chapters[0].autoQueueable).toBe(false);
    expect(g.chapters[1].autoQueueable).toBe(true);
    /* Group rolls up to false because CH 1 isn't all-auto. */
    expect(g.allAutoQueueable).toBe(false);
  });

  it('severityCounts counts CHAPTERS (top-severity per chapter), not raw events', () => {
    /* Pre-correction (plan 91 archive) severityCounts summed events,
       so a chapter that fired severe+moderate+mild contributed +1 to
       each bucket. Post-correction it contributes only to the chapter's
       top bucket ("severe"). */
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        drift: [
          drift('d1s', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur, factor: 'voice', severity: 'severe' }),
          drift('d1mod', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur, factor: 'warmth', severity: 'moderate' }),
          drift('d1mild', { bookId: 'book-A', chapterId: 1, snapshot: snapA, current: cur, factor: 'attributes', severity: 'mild' }),
          drift('d2mod', { bookId: 'book-A', chapterId: 2, snapshot: snapA, current: cur, factor: 'voice', severity: 'moderate' }),
        ],
      }),
    );
    const g = selectDriftGroupsByBook({ revisions: s })[0].groups[0];
    /* CH 1 top = severe; CH 2 top = moderate. */
    expect(g.severityCounts).toEqual({ severe: 1, moderate: 1, mild: 0 });
  });
});

describe('revisionsSlice — enqueuePending', () => {
  it('appends a new pending revision', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({ pending: [rev('r1')], drift: [] }),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.enqueuePending(rev('r2', { playable: false, hasPreviousAudio: true })),
    );
    expect(next.pending.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(next.pending[1].playable).toBe(false);
    expect(next.pending[1].hasPreviousAudio).toBe(true);
  });

  it('replaces (dedupes) when the same id is enqueued again', () => {
    /* Regen restart for the same character + chapter rebuilds the stub
       with a fresh playable=false. The dedupe is by id, so the slice
       carries exactly one entry per (chapterId, characterId) tuple as
       long as the id encodes both. */
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.enqueuePending(rev('r1', { playable: true })),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.enqueuePending(rev('r1', { playable: false })),
    );
    expect(next.pending).toHaveLength(1);
    expect(next.pending[0].playable).toBe(false);
  });
});

describe('revisionsSlice — markRevisionPlayable', () => {
  it('flips playable=true for matching chapterId', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [
          rev('r1', { chapterId: 1, playable: false }),
          rev('r2', { chapterId: 2, playable: false }),
        ],
        drift: [],
      }),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.markRevisionPlayable({ chapterId: 1 }),
    );
    expect(next.pending.find((r) => r.id === 'r1')?.playable).toBe(true);
    expect(next.pending.find((r) => r.id === 'r2')?.playable).toBe(false);
  });

  it('flips all pending revisions targeting the same chapter (parallel regens)', () => {
    /* Two characters regenerated in the same chapter → two pending
       revisions with the same chapterId. chapter_complete fires once
       per chapter; both should flip. */
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [
          rev('r1', { chapterId: 3, characterId: 'a', playable: false }),
          rev('r2', { chapterId: 3, characterId: 'b', playable: false }),
        ],
        drift: [],
      }),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.markRevisionPlayable({ chapterId: 3 }),
    );
    expect(next.pending.every((r) => r.playable === true)).toBe(true);
  });

  it('is a no-op when no revision targets the chapter', () => {
    const start = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        pending: [rev('r1', { chapterId: 1, playable: false })],
        drift: [],
      }),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.markRevisionPlayable({ chapterId: 99 }),
    );
    expect(next.pending).toEqual(start.pending);
  });
});
