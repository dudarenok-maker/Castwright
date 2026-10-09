// Pairs with docs/features/archive/20-revisions-and-drift.md

import { describe, expect, it } from 'vitest';
import {
  revisionsSlice,
  revisionsActions,
  selectDriftByBook,
  selectDriftForBook,
  selectDriftGroupsByBook,
  scopeDriftGroupsByBook,
  distinctDriftChapterCount,
} from './revisions-slice';
import type { Revision, DriftEvent } from '../lib/types';

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
      fileId: null,
      rev: 0,
      adoptSeq: 0,
      pending: [],
      drift: [],
      dismissed: [],
      acceptedSelections: {},
      timeline: {},
      loaded: false,
      bookId: null,
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

describe('applyPoll adopts server state (plan 286)', () => {
  const F = '000000000000001-a';
  const base = () =>
    revisionsSlice.reducer(
      undefined,
      revisionsActions.applyServerState({
        bookId: 'A',
        fileId: F,
        rev: 2,
        pending: [],
        dismissed: [],
        acceptedSelections: {},
        timeline: {},
      }),
    );
  it('adopts pending/dismissed by the ordered rule and merges drift', () => {
    const s = revisionsSlice.reducer(
      base(),
      revisionsActions.applyPoll({
        bookId: 'A',
        fileId: F,
        rev: 3,
        pending: [{ id: 'p', chapterId: 1, characterId: 'c', segments: [] }],
        dismissed: ['d'],
        drift: [{ id: 'x', bookId: 'A' } as never],
      }),
    );
    expect(s.pending.map((p) => p.id)).toEqual(['p']);
    expect(s.dismissed).toEqual(['d']);
    expect(s.drift.map((d) => d.id)).toEqual(['x']);
    expect(s.loaded).toBe(true);
  });
  it('a stale poll (lower rev) updates drift but not pending', () => {
    let s = revisionsSlice.reducer(
      base(),
      revisionsActions.applyServerState({
        bookId: 'A',
        fileId: F,
        rev: 5,
        pending: [{ id: 'keep', chapterId: 1, characterId: 'c', segments: [] }],
        dismissed: [],
        acceptedSelections: {},
        timeline: {},
      }),
    );
    s = revisionsSlice.reducer(
      s,
      revisionsActions.applyPoll({
        bookId: 'A',
        fileId: F,
        rev: 4,
        pending: [],
        drift: [{ id: 'new', bookId: 'A' } as never],
      }),
    );
    expect(s.pending.map((p) => p.id)).toEqual(['keep']);
    expect(s.drift.map((d) => d.id)).toEqual(['new']);
  });
});

describe('revisionsSlice — applyBackgroundPoll (#3376)', () => {
  const seed = (overrides: { pending?: Revision[]; drift?: DriftEvent[] } = {}) =>
    revisionsSlice.reducer(
      undefined,
      revisionsActions.applyServerState({
        bookId: 'book-A',
        fileId: null,
        rev: 0,
        pending: overrides.pending ?? [],
        dismissed: [],
        acceptedSelections: {},
        timeline: {},
      }),
    );

  it('leaves an existing pending list unchanged', () => {
    let start = seed({ pending: [rev('r1'), rev('r2')] });
    start = revisionsSlice.reducer(
      start,
      revisionsActions.applyBackgroundPoll({ bookId: 'book-A', drift: [drift('a1')] }),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.applyBackgroundPoll({ bookId: 'book-B', drift: [] }),
    );
    expect(next.pending.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('replaces only the polled bookId drift and keeps other books drift', () => {
    let start = seed({ pending: [rev('r1')] });
    start = revisionsSlice.reducer(
      start,
      revisionsActions.applyBackgroundPoll({
        bookId: 'book-A',
        drift: [drift('a1', { bookId: 'book-A' }), drift('b1', { bookId: 'book-B' })],
      }),
    );
    const next = revisionsSlice.reducer(
      start,
      revisionsActions.applyBackgroundPoll({
        bookId: 'book-B',
        drift: [drift('b2', { bookId: 'book-B' })],
      }),
    );
    expect(next.drift.map((d) => d.id)).toEqual(['a1', 'b2']);
    expect(next.pending.map((r) => r.id)).toEqual(['r1']);
  });

  it('leaves loaded unchanged — a background tick never flips it', () => {
    const next = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyBackgroundPoll({
        bookId: 'book-B',
        drift: [drift('b2', { bookId: 'book-B' })],
      }),
    );
    expect(next.loaded).toBe(false);
    expect(next.drift.map((d) => d.id)).toEqual(['b2']);
    /* And it never clears it either: once loaded by the active poll or a
       hydrate, a background tick leaves the flag alone. */
    const loaded = revisionsSlice.reducer(
      next,
      revisionsActions.applyBackgroundPoll({ bookId: 'book-C', drift: [] }),
    );
    expect(loaded.loaded).toBe(false);
    const afterPoll = revisionsSlice.reducer(
      next,
      revisionsActions.applyPoll({ bookId: 'book-D', pending: [], drift: [] }),
    );
    expect(revisionsSlice.reducer(afterPoll, revisionsActions.applyBackgroundPoll({ bookId: 'book-D', drift: [] })).loaded).toBe(true);
  });
});

describe('revisionsSlice — timeline (plan 55, server-owned as of plan 286)', () => {
  it('applyServerState normalises string-keyed timeline (JSON serialisation)', () => {
    /* On-disk JSON keys are strings; the slice carries numeric chapterIds.
       Defensive normalisation preserves both shapes on adopt. */
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyServerState({
        bookId: 'book-A',
        fileId: null,
        rev: 1,
        pending: [],
        dismissed: [],
        acceptedSelections: {},
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

  it('selectDriftByBook groups flat drift events by bookId', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        bookId: 'book-A',
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
        bookId: 'book-A',
        drift: [drift('d-A1', { bookId: 'book-A' })],
      }),
    );
    const first = selectDriftByBook({ revisions: s });
    const second = selectDriftByBook({ revisions: s });
    expect(second).toBe(first);
  });

  it('selectDriftForBook filters to one book and returns a stable reference (#1285)', () => {
    const s = revisionsSlice.reducer(
      undefined,
      revisionsActions.applyPoll({
        bookId: 'book-A',
        drift: [
          drift('d-A1', { bookId: 'book-A' }),
          drift('d-B1', { bookId: 'book-B' }),
          drift('d-A2', { bookId: 'book-A' }),
        ],
      }),
    );
    const forA = selectDriftForBook({ revisions: s }, 'book-A');
    expect(forA.map((d) => d.id)).toEqual(['d-A1', 'd-A2']);
    /* Unmemoized, an inline `.filter()` allocates a fresh array on every
       call even for the identical (drift, bookId) pair — react-redux's
       dev-mode stability check flags exactly this as "returned a different
       result" and forces the calling component (ReadyViewSwitch, the direct
       parent of GenerationView) to re-render on every store dispatch. */
    expect(selectDriftForBook({ revisions: s }, 'book-A')).toBe(forA);
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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
        bookId: 'book-A',
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

/* Fixes the "375 chapters flagged across 10 books" Drift Report browser-hang
   report — `selectDriftGroupsByBook` buckets the whole workspace (the
   background cross-book poll fills it for every book), so the modal needs a
   render-time scope on top. */
describe('scopeDriftGroupsByBook', () => {
  const s = revisionsSlice.reducer(
    undefined,
    revisionsActions.applyPoll({
      bookId: 'book-A',
      drift: [
        drift('d-a', { bookId: 'book-A' }),
        drift('d-b', { bookId: 'book-B' }),
        drift('d-c', { bookId: 'book-C' }),
      ],
    }),
  );
  const groupsByBook = selectDriftGroupsByBook({ revisions: s });

  it('"book" scope keeps only the active book', () => {
    const result = scopeDriftGroupsByBook(groupsByBook, 'book', 'book-B', ['book-B']);
    expect(result.map((g) => g.bookId)).toEqual(['book-B']);
  });

  it('"series" scope keeps every book in the given series list', () => {
    const result = scopeDriftGroupsByBook(groupsByBook, 'series', 'book-A', ['book-A', 'book-B']);
    expect(result.map((g) => g.bookId).sort()).toEqual(['book-A', 'book-B']);
  });

  it('"series" scope with a single-book series behaves like "book" scope', () => {
    const result = scopeDriftGroupsByBook(groupsByBook, 'series', 'book-A', ['book-A']);
    expect(result.map((g) => g.bookId)).toEqual(['book-A']);
  });

  it('falls back to the unscoped list when there is no active book (defensive)', () => {
    const result = scopeDriftGroupsByBook(groupsByBook, 'book', null, []);
    expect(result).toBe(groupsByBook);
  });
});
