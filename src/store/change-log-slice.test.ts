/* Slice unit tests — pairs with the per-book hydration in
   src/components/layout.tsx and the persistence rule in
   src/store/persistence-middleware.ts. */

import { describe, expect, it } from 'vitest';
import { changeLogSlice, changeLogActions, type ChangeLogState } from './change-log-slice';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
import type { ChangeLogEvent } from '../lib/types';

const seed: ChangeLogState = { events: CHANGE_LOG_EVENTS, workspaceEvents: [] };

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
    const start: ChangeLogState = { events: [makeEvent(2)], workspaceEvents: [] };
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
    const start: ChangeLogState = { events: [makeEvent(1), makeEvent(2)], workspaceEvents: [makeEvent(3)] };
    const next = changeLogSlice.reducer(start, changeLogActions.reset());
    expect(next.events).toEqual([]);
    expect(next.workspaceEvents).toEqual([]);
  });

  describe('bumpBoundaryMove', () => {
    it('appends a fresh boundary_move when the head is not one', () => {
      const start: ChangeLogState = {
        events: [makeEvent(1, { type: 'regenerate', chapterId: 1 })],
        workspaceEvents: [],
      };
      const next = changeLogSlice.reducer(start, changeLogActions.bumpBoundaryMove({ chapterId: 3, count: 2 }));
      expect(next.events).toHaveLength(2);
      expect(next.events[0].type).toBe('boundary_move');
      expect(next.events[0].chapterId).toBe(3);
      expect(next.events[0].note).toContain('2 sentences reassigned');
    });

    it('rewrites the head in place when consecutive edits hit the same chapter', () => {
      const start: ChangeLogState = { events: [], workspaceEvents: [] };
      const after1 = changeLogSlice.reducer(start, changeLogActions.bumpBoundaryMove({ chapterId: 3, count: 1 }));
      const after2 = changeLogSlice.reducer(after1, changeLogActions.bumpBoundaryMove({ chapterId: 3, count: 4 }));
      expect(after2.events).toHaveLength(1);
      expect(after2.events[0].note).toContain('5 sentences reassigned');
    });

    it('starts a new entry when the chapter switches', () => {
      const start: ChangeLogState = { events: [], workspaceEvents: [] };
      const after1 = changeLogSlice.reducer(start, changeLogActions.bumpBoundaryMove({ chapterId: 3, count: 1 }));
      const after2 = changeLogSlice.reducer(after1, changeLogActions.bumpBoundaryMove({ chapterId: 4, count: 1 }));
      expect(after2.events).toHaveLength(2);
      expect(after2.events[0].chapterId).toBe(4);
      expect(after2.events[1].chapterId).toBe(3);
    });
  });

  describe('wipeBookShapeEvents', () => {
    it('drops events that carry a chapterId — those reference now-stale chapter ids after a reparse', () => {
      const start: ChangeLogState = {
        events: [
          makeEvent(1, { type: 'regenerate', chapterId: 3 }),
          makeEvent(2, { type: 'voice_tune', chapterId: undefined }),
          makeEvent(3, { type: 'chapter_complete', chapterId: 4 }),
          makeEvent(4, { type: 'cast_confirm', chapterId: undefined }),
          makeEvent(5, { type: 'boundary_move', chapterId: 2 }),
        ],
        workspaceEvents: [],
      };
      const next = changeLogSlice.reducer(start, changeLogActions.wipeBookShapeEvents());
      expect(next.events.map(e => e.type)).toEqual(['voice_tune', 'cast_confirm']);
    });
  });

  describe('hydrateWorkspaceEvents', () => {
    it('replaces the workspace cache without touching per-book events', () => {
      const start: ChangeLogState = { events: [makeEvent(1)], workspaceEvents: [] };
      const next = changeLogSlice.reducer(start, changeLogActions.hydrateWorkspaceEvents([
        makeEvent(10, { bookId: 'sb', bookTitle: 'Solway Bay' }),
      ]));
      expect(next.events).toHaveLength(1);
      expect(next.workspaceEvents).toHaveLength(1);
      expect(next.workspaceEvents[0].bookTitle).toBe('Solway Bay');
    });
  });
});
