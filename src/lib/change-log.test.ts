/* Helpers that compose log entries from the three regenerate confirm
   shapes plus the display-time formatter used by ChangeLogView. */

import { describe, expect, it } from 'vitest';
import {
  buildChapterRegenEvent,
  buildCharacterRegenEvent,
  buildGenerationStartedEvent,
  buildChapterCompleteEvent,
  buildChapterFailedEvent,
  buildCastConfirmEvent,
  buildVoiceTuneEvent,
  buildVoiceLockEvent,
  buildNameChangeEvent,
  buildBoundaryMoveEvent,
  bucketDate,
  relativeTime,
  withRecomputedDisplay,
} from './change-log';
import type { Chapter, ChangeLogEvent, Character } from './types';

const NOW = new Date('2026-05-13T15:00:00Z');

const makeChapter = (id: number, overrides: Partial<Chapter> = {}): Chapter => ({
  id,
  title: `Chapter ${id}`,
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: {},
  ...overrides,
});

const makeChar = (id: string, name = id, overrides: Partial<Character> = {}): Character => ({
  id,
  name,
  role: 'role',
  color: 'narrator',
  voiceState: 'generated',
  ...overrides,
});

describe('buildChapterRegenEvent', () => {
  it('produces a regenerate entry with reason label and chapter id', () => {
    const ev = buildChapterRegenEvent({
      chapter: makeChapter(3),
      scope: 'this',
      reason: 'voice',
      note: '',
      affectedChapterCount: 1,
      now: NOW,
    });
    expect(ev.type).toBe('regenerate');
    expect(ev.actor).toBe('you');
    expect(ev.chapterId).toBe(3);
    expect(ev.title).toBe('Regenerated Chapter 3');
    expect(ev.note).toContain('voice tuning updated');
    expect(ev.at).toBe(NOW.toISOString());
    expect(ev.revertible).toBe(true);
  });

  it('adds propagation copy when scope is "forward"', () => {
    const ev = buildChapterRegenEvent({
      chapter: makeChapter(3),
      scope: 'forward',
      reason: 'voice',
      note: '',
      affectedChapterCount: 4,
      now: NOW,
    });
    expect(ev.note).toContain('Propagated forward through 4 chapters');
  });

  it('appends the custom note for "other" reason', () => {
    const ev = buildChapterRegenEvent({
      chapter: makeChapter(2),
      scope: 'this',
      reason: 'other',
      note: 'Wrong character emphasised.',
      affectedChapterCount: 1,
      now: NOW,
    });
    expect(ev.note).toContain('other reason');
    expect(ev.note).toContain('Wrong character emphasised.');
  });
});

describe('buildCharacterRegenEvent', () => {
  it('mentions the character name and the chapter scope', () => {
    const ev = buildCharacterRegenEvent({
      character: makeChar('eliza', 'Eliza Gray'),
      chapterIds: [3, 4, 5],
      reason: 'quality',
      note: '',
      now: NOW,
    });
    expect(ev.title).toBe("Regenerated Eliza Gray's lines");
    expect(ev.note).toContain('across 3 chapters');
    expect(ev.chapterId).toBeUndefined();
  });

  it('binds chapterId on single-chapter regens for the timeline UI', () => {
    const ev = buildCharacterRegenEvent({
      character: makeChar('halloran', 'Captain Halloran'),
      chapterIds: [3],
      reason: 'manuscript',
      note: '',
      now: NOW,
    });
    expect(ev.chapterId).toBe(3);
    expect(ev.note).toContain('in Chapter 3');
  });
});

describe('buildGenerationStartedEvent', () => {
  it('produces a system event with the targeted chapters in the note', () => {
    const ev = buildGenerationStartedEvent({ chapterIds: [3, 4, 5], now: NOW });
    expect(ev.type).toBe('generation_started');
    expect(ev.actor).toBe('system');
    expect(ev.title).toContain('3 chapters');
    expect(ev.note).toContain('3, 4, 5');
  });

  it('falls back to a generic "resuming" note when no chapterIds are passed', () => {
    const ev = buildGenerationStartedEvent({ chapterIds: [], now: NOW });
    expect(ev.title).toBe('Generation started');
    expect(ev.note).toContain('Resuming');
  });
});

describe('buildChapterCompleteEvent', () => {
  it('attributes the event to the system and names the chapter', () => {
    const ev = buildChapterCompleteEvent({
      chapter: makeChapter(7, { title: 'The Long Way Down' }),
      now: NOW,
    });
    expect(ev.type).toBe('chapter_complete');
    expect(ev.actor).toBe('system');
    expect(ev.chapterId).toBe(7);
    expect(ev.note).toContain('The Long Way Down');
  });
});

describe('buildChapterFailedEvent', () => {
  it('carries the error reason verbatim so the feed and the row stay in sync', () => {
    const ev = buildChapterFailedEvent({
      chapter: makeChapter(2),
      errorReason: 'Voice not found in library',
      now: NOW,
    });
    expect(ev.type).toBe('chapter_failed');
    expect(ev.actor).toBe('system');
    expect(ev.chapterId).toBe(2);
    expect(ev.note).toBe('Voice not found in library');
  });
});

describe('buildCastConfirmEvent', () => {
  it('records the character count and quotes the book title when given', () => {
    const ev = buildCastConfirmEvent({ characterCount: 7, bookTitle: 'Solway Bay', now: NOW });
    expect(ev.type).toBe('cast_confirm');
    expect(ev.actor).toBe('you');
    expect(ev.chapterId).toBeUndefined();
    expect(ev.note).toContain('7 characters');
    expect(ev.note).toContain('Solway Bay');
  });

  it('handles singular and missing-title cases', () => {
    const ev = buildCastConfirmEvent({ characterCount: 1, now: NOW });
    expect(ev.note).toContain('1 character ');
    expect(ev.note).not.toContain('"');
  });
});

describe('buildVoiceTuneEvent', () => {
  it('names the character and notes a clean tune', () => {
    const ev = buildVoiceTuneEvent({ character: makeChar('eliza', 'Eliza Gray'), now: NOW });
    expect(ev.type).toBe('voice_tune');
    expect(ev.title).toBe("Tuned Eliza Gray's voice");
    expect(ev.note).toContain('Voice tone updated');
  });

  it('surfaces the conflict-reset note when the library match was dropped', () => {
    const ev = buildVoiceTuneEvent({
      character: makeChar('halloran', 'Captain Halloran'),
      hadConflict: true,
      now: NOW,
    });
    expect(ev.note).toContain('Identity edit reset the library match');
  });
});

describe('buildVoiceLockEvent', () => {
  it('records the lock action against the character', () => {
    const ev = buildVoiceLockEvent({
      character: makeChar('halloran', 'Captain Halloran'),
      now: NOW,
    });
    expect(ev.type).toBe('voice_lock');
    expect(ev.title).toBe("Locked Captain Halloran's voice");
    expect(ev.actor).toBe('you');
  });
});

describe('buildNameChangeEvent', () => {
  it('records the old name in the title and the new name in the note', () => {
    const ev = buildNameChangeEvent({
      oldName: 'Dame Linnet',
      newName: 'Councilor Linnet',
      now: NOW,
    });
    expect(ev.type).toBe('name_change');
    expect(ev.actor).toBe('you');
    expect(ev.title).toBe('Renamed Dame Linnet');
    expect(ev.note).toContain('Councilor Linnet');
    /* Frames the rename as non-destructive — the old name is kept as an alias. */
    expect(ev.note).toContain('alias');
  });
});

describe('buildBoundaryMoveEvent', () => {
  it('binds the chapterId and stamps the count for the aggregator', () => {
    const ev = buildBoundaryMoveEvent({ chapterId: 3, count: 4, now: NOW });
    expect(ev.type).toBe('boundary_move');
    expect(ev.chapterId).toBe(3);
    expect(ev.title).toContain('Chapter 3');
    expect(ev.note).toContain('4 sentences reassigned');
  });

  it('uses singular phrasing for a single reassigned sentence', () => {
    const ev = buildBoundaryMoveEvent({ chapterId: 1, count: 1, now: NOW });
    expect(ev.note).toContain('1 sentence reassigned');
  });
});

describe('display-time formatters', () => {
  it('buckets `at` into today / yesterday / earlier relative to the given clock', () => {
    expect(bucketDate(NOW.toISOString(), NOW)).toBe('today');
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    expect(bucketDate(yesterday.toISOString(), NOW)).toBe('yesterday');
    const lastWeek = new Date(NOW.getTime() - 7 * 86_400_000);
    expect(bucketDate(lastWeek.toISOString(), NOW)).toBe('earlier');
  });

  it('relativeTime returns "Just now" inside the first minute', () => {
    expect(relativeTime(new Date(NOW.getTime() - 5_000).toISOString(), NOW)).toBe('Just now');
  });

  it('relativeTime returns minutes within the first hour', () => {
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago');
  });

  it('withRecomputedDisplay recomputes ts/date for entries with `at` and leaves fixture entries untouched', () => {
    const fixture: ChangeLogEvent = {
      id: 1,
      ts: 'Last week',
      date: 'earlier',
      type: 'import',
      title: 't',
      note: 'n',
      actor: 'you',
    };
    const real: ChangeLogEvent = {
      id: 2,
      at: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
      ts: 'Just now',
      date: 'today',
      type: 'regenerate',
      title: 'Regenerated CH 3',
      note: 'n',
      actor: 'you',
    };
    const out = withRecomputedDisplay([fixture, real], NOW);
    expect(out[0]).toEqual(fixture); // unchanged
    expect(out[1].ts).toBe('2 min ago');
    expect(out[1].date).toBe('today');
  });
});
