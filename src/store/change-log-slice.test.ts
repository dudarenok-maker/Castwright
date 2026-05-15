/* Slice unit tests — pairs with the per-book hydration in
   src/components/layout.tsx and the persistence rule in
   src/store/persistence-middleware.ts. */

import { describe, expect, it } from 'vitest';
import { changeLogSlice, changeLogActions, type ChangeLogState } from './change-log-slice';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
import type { ChangeLogEvent } from '../lib/types';

const emptyCounts = { voice: 0, generation: 0, manuscript: 0, cast: 0 };

const seed: ChangeLogState = {
  events: CHANGE_LOG_EVENTS,
  workspaceEvents: [],
  workspaceNextCursor: null,
  workspaceTotalCount: 0,
  workspaceCategoryCounts: { ...emptyCounts },
};

function makeState(overrides: Partial<ChangeLogState> = {}): ChangeLogState {
  return {
    events: [],
    workspaceEvents: [],
    workspaceNextCursor: null,
    workspaceTotalCount: 0,
    workspaceCategoryCounts: { ...emptyCounts },
    ...overrides,
  };
}

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
  it('starts empty — the workspace Activity view hydrates from disk, not from a demo fixture', () => {
    expect(changeLogSlice.getInitialState().events).toBe(CHANGE_LOG_EVENTS);
    expect(changeLogSlice.getInitialState().events).toEqual([]);
  });

  it('appendLogEvent unshifts (newest first)', () => {
    const start = makeState({ events: [makeEvent(2)] });
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
    const start = makeState({
      events: [makeEvent(1), makeEvent(2)],
      workspaceEvents: [makeEvent(3)],
      workspaceNextCursor: '2026-05-13T15:00:00.000Z',
      workspaceTotalCount: 7,
      workspaceCategoryCounts: { voice: 1, generation: 2, manuscript: 3, cast: 1 },
    });
    const next = changeLogSlice.reducer(start, changeLogActions.reset());
    expect(next.events).toEqual([]);
    expect(next.workspaceEvents).toEqual([]);
    expect(next.workspaceNextCursor).toBeNull();
    expect(next.workspaceTotalCount).toBe(0);
    expect(next.workspaceCategoryCounts).toEqual(emptyCounts);
  });

  describe('bumpBoundaryMove', () => {
    it('appends a fresh boundary_move when the head is not one', () => {
      const start = makeState({ events: [makeEvent(1, { type: 'regenerate', chapterId: 1 })] });
      const next = changeLogSlice.reducer(start, changeLogActions.bumpBoundaryMove({ chapterId: 3, count: 2 }));
      expect(next.events).toHaveLength(2);
      expect(next.events[0].type).toBe('boundary_move');
      expect(next.events[0].chapterId).toBe(3);
      expect(next.events[0].note).toContain('2 sentences reassigned');
    });

    it('rewrites the head in place when consecutive edits hit the same chapter', () => {
      const start = makeState();
      const after1 = changeLogSlice.reducer(start, changeLogActions.bumpBoundaryMove({ chapterId: 3, count: 1 }));
      const after2 = changeLogSlice.reducer(after1, changeLogActions.bumpBoundaryMove({ chapterId: 3, count: 4 }));
      expect(after2.events).toHaveLength(1);
      expect(after2.events[0].note).toContain('5 sentences reassigned');
    });

    it('starts a new entry when the chapter switches', () => {
      const start = makeState();
      const after1 = changeLogSlice.reducer(start, changeLogActions.bumpBoundaryMove({ chapterId: 3, count: 1 }));
      const after2 = changeLogSlice.reducer(after1, changeLogActions.bumpBoundaryMove({ chapterId: 4, count: 1 }));
      expect(after2.events).toHaveLength(2);
      expect(after2.events[0].chapterId).toBe(4);
      expect(after2.events[1].chapterId).toBe(3);
    });
  });

  describe('wipeBookShapeEvents', () => {
    it('drops events that carry a chapterId — those reference now-stale chapter ids after a reparse', () => {
      const start = makeState({
        events: [
          makeEvent(1, { type: 'regenerate', chapterId: 3 }),
          makeEvent(2, { type: 'voice_tune', chapterId: undefined }),
          makeEvent(3, { type: 'chapter_complete', chapterId: 4 }),
          makeEvent(4, { type: 'cast_confirm', chapterId: undefined }),
          makeEvent(5, { type: 'boundary_move', chapterId: 2 }),
        ],
      });
      const next = changeLogSlice.reducer(start, changeLogActions.wipeBookShapeEvents());
      expect(next.events.map(e => e.type)).toEqual(['voice_tune', 'cast_confirm']);
    });
  });

  describe('hydrateWorkspaceEvents', () => {
    it('replaces the workspace cache without touching per-book events', () => {
      const start = makeState({ events: [makeEvent(1)] });
      const next = changeLogSlice.reducer(start, changeLogActions.hydrateWorkspaceEvents([
        makeEvent(10, { bookId: 'sb', bookTitle: 'Solway Bay' }),
      ]));
      expect(next.events).toHaveLength(1);
      expect(next.workspaceEvents).toHaveLength(1);
      expect(next.workspaceEvents[0].bookTitle).toBe('Solway Bay');
    });
  });

  describe('hydrateWorkspaceFirstPage', () => {
    it('replaces events + sets cursor/totals atomically so a stale total never coexists with new events', () => {
      const start = makeState({
        workspaceEvents: [makeEvent(99, { bookId: 'old' })],
        workspaceNextCursor: '2026-04-01T00:00:00.000Z',
        workspaceTotalCount: 5,
        workspaceCategoryCounts: { voice: 1, generation: 1, manuscript: 1, cast: 2 },
      });
      const next = changeLogSlice.reducer(start, changeLogActions.hydrateWorkspaceFirstPage({
        events: [makeEvent(10, { bookId: 'sb' })],
        nextCursor: '2026-05-10T00:00:00.000Z',
        totalCount: 200,
        categoryCounts: { voice: 3, generation: 195, manuscript: 1, cast: 1 },
      }));
      expect(next.workspaceEvents).toHaveLength(1);
      expect(next.workspaceEvents[0].bookId).toBe('sb');
      expect(next.workspaceNextCursor).toBe('2026-05-10T00:00:00.000Z');
      expect(next.workspaceTotalCount).toBe(200);
      expect(next.workspaceCategoryCounts.generation).toBe(195);
    });
  });

  describe('appendWorkspacePage', () => {
    it('appends to the tail and advances the cursor without disturbing already-loaded events', () => {
      const start = makeState({
        workspaceEvents: [makeEvent(10), makeEvent(9)],
        workspaceNextCursor: '2026-05-08T00:00:00.000Z',
        workspaceTotalCount: 4,
        workspaceCategoryCounts: { voice: 0, generation: 4, manuscript: 0, cast: 0 },
      });
      const next = changeLogSlice.reducer(start, changeLogActions.appendWorkspacePage({
        events: [makeEvent(8), makeEvent(7)],
        nextCursor: null,
        totalCount: 4,
        categoryCounts: { voice: 0, generation: 4, manuscript: 0, cast: 0 },
      }));
      expect(next.workspaceEvents.map(e => e.id)).toEqual([10, 9, 8, 7]);
      expect(next.workspaceNextCursor).toBeNull();
      expect(next.workspaceTotalCount).toBe(4);
    });

    it('re-syncs totals from the server payload so a write between pages is reflected', () => {
      /* If a generation_run_complete lands while the user is mid-scroll,
         the server's totals will have bumped by 1. The slice trusts the
         server, not its own stale snapshot. */
      const start = makeState({
        workspaceEvents: [makeEvent(10)],
        workspaceNextCursor: '2026-05-09T00:00:00.000Z',
        workspaceTotalCount: 50,
        workspaceCategoryCounts: { voice: 1, generation: 48, manuscript: 1, cast: 0 },
      });
      const next = changeLogSlice.reducer(start, changeLogActions.appendWorkspacePage({
        events: [makeEvent(9)],
        nextCursor: null,
        totalCount: 51,
        categoryCounts: { voice: 1, generation: 49, manuscript: 1, cast: 0 },
      }));
      expect(next.workspaceTotalCount).toBe(51);
      expect(next.workspaceCategoryCounts.generation).toBe(49);
    });
  });
});
