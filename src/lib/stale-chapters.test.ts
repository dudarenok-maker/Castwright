import { describe, it, expect } from 'vitest';
import {
  renderedChaptersForCharacter,
  latestReassignAt,
  isChapterStaleFromReassign,
} from './stale-chapters';
import type { Chapter, ChangeLogEvent } from './types';

const ch = (id: number, state: string, characters: Record<string, unknown> | null): Chapter =>
  ({ id, title: `c${id}`, slug: `c${id}`, state, characters } as unknown as Chapter);

describe('renderedChaptersForCharacter', () => {
  it('returns ids of done chapters the character speaks in', () => {
    const chapters = [
      ch(1, 'done', { sophie: 10, keefe: 4 }),
      ch(2, 'done', { keefe: 2 }), // sophie absent
      ch(3, 'queued', { sophie: 5 }), // not done
      ch(4, 'done', { sophie: 1 }),
    ];
    expect(renderedChaptersForCharacter('sophie', chapters)).toEqual([1, 4]);
  });

  it('returns [] when the character speaks in no done chapter', () => {
    expect(renderedChaptersForCharacter('ghost', [ch(1, 'done', { sophie: 1 })])).toEqual([]);
    expect(renderedChaptersForCharacter('sophie', [ch(1, 'queued', { sophie: 1 })])).toEqual([]);
    expect(renderedChaptersForCharacter('sophie', [ch(1, 'done', null)])).toEqual([]);
  });
});

const ev = (over: Partial<ChangeLogEvent>): ChangeLogEvent =>
  ({
    id: 1,
    ts: 'now',
    date: 'today',
    type: 'boundary_move',
    title: '',
    note: '',
    actor: 'you',
    ...over,
  } as ChangeLogEvent);

const doneCh = (id: number, renderedAt: string | undefined): Chapter =>
  ({ id, title: `c${id}`, slug: `c${id}`, state: 'done', audioRenderedAt: renderedAt } as unknown as Chapter);

describe('latestReassignAt (Bug 2)', () => {
  it('returns the newest boundary_move time for the chapter (events are newest-first)', () => {
    const events = [
      ev({ chapterId: 2, at: '2026-06-08T10:00:00Z' }),
      ev({ chapterId: 1, at: '2026-06-08T09:00:00Z' }),
      ev({ chapterId: 1, at: '2026-06-08T08:00:00Z' }),
    ];
    expect(latestReassignAt(1, events)).toBe('2026-06-08T09:00:00Z');
    expect(latestReassignAt(2, events)).toBe('2026-06-08T10:00:00Z');
  });

  it('ignores non-boundary_move events and returns undefined when none match', () => {
    const events = [
      ev({ chapterId: 1, type: 'chapter_complete', at: '2026-06-08T10:00:00Z' }),
      ev({ chapterId: 3, type: 'boundary_move', at: '2026-06-08T09:00:00Z' }),
    ];
    expect(latestReassignAt(1, events)).toBeUndefined();
  });
});

describe('isChapterStaleFromReassign (Bug 2)', () => {
  it('is stale when a done chapter was reassigned AFTER it was rendered', () => {
    const events = [ev({ chapterId: 1, at: '2026-06-08T12:00:00Z' })];
    expect(isChapterStaleFromReassign(doneCh(1, '2026-06-08T10:00:00Z'), events)).toBe(true);
  });

  it('is NOT stale when the reassignment predates the render', () => {
    const events = [ev({ chapterId: 1, at: '2026-06-08T09:00:00Z' })];
    expect(isChapterStaleFromReassign(doneCh(1, '2026-06-08T10:00:00Z'), events)).toBe(false);
  });

  it('is NOT stale for a non-done chapter or one with no audioRenderedAt', () => {
    const events = [ev({ chapterId: 1, at: '2026-06-08T12:00:00Z' })];
    const queued = { id: 1, title: 'c1', slug: 'c1', state: 'queued' } as unknown as Chapter;
    expect(isChapterStaleFromReassign(queued, events)).toBe(false);
    expect(isChapterStaleFromReassign(doneCh(1, undefined), events)).toBe(false);
  });

  it('is NOT stale when the chapter has no reassignment at all', () => {
    expect(isChapterStaleFromReassign(doneCh(1, '2026-06-08T10:00:00Z'), [])).toBe(false);
  });
});
