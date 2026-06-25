import { describe, it, expect } from 'vitest';
import {
  renderedChaptersForCharacter,
  latestReassignAt,
  isChapterStaleFromReassign,
  isChapterReassignedSinceRender,
  textHashForStale,
  isChapterTextEditedSinceRender,
  isChapterInstructEditedSinceRender,
} from './stale-chapters';
import type { Chapter, ChangeLogEvent } from './types';

const ch = (id: number, state: string, characters: Record<string, unknown> | null): Chapter =>
  ({ id, title: `c${id}`, slug: `c${id}`, state, characters } as unknown as Chapter);

describe('renderedChaptersForCharacter', () => {
  it('returns ids of done chapters the character speaks in', () => {
    const chapters = [
      ch(1, 'done', { wren: 10, marlow: 4 }),
      ch(2, 'done', { marlow: 2 }), // wren absent
      ch(3, 'queued', { wren: 5 }), // not done
      ch(4, 'done', { wren: 1 }),
    ];
    expect(renderedChaptersForCharacter('wren', chapters)).toEqual([1, 4]);
  });

  it('returns [] when the character speaks in no done chapter', () => {
    expect(renderedChaptersForCharacter('ghost', [ch(1, 'done', { wren: 1 })])).toEqual([]);
    expect(renderedChaptersForCharacter('wren', [ch(1, 'queued', { wren: 1 })])).toEqual([]);
    expect(renderedChaptersForCharacter('wren', [ch(1, 'done', null)])).toEqual([]);
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

describe('isChapterReassignedSinceRender (#650 precise diff)', () => {
  const rendered = { 1: 'narrator', 2: 'wren', 3: 'marlow' };

  it('not reassigned when the live mapping matches the render-time mapping', () => {
    const current = [
      { id: 1, characterId: 'narrator' },
      { id: 2, characterId: 'wren' },
      { id: 3, characterId: 'marlow' },
    ];
    expect(isChapterReassignedSinceRender(rendered, current)).toBe(false);
  });

  it('reassigned when a rendered sentence now has a different speaker', () => {
    const current = [
      { id: 1, characterId: 'narrator' },
      { id: 2, characterId: 'marlow' }, // was wren
      { id: 3, characterId: 'marlow' },
    ];
    expect(isChapterReassignedSinceRender(rendered, current)).toBe(true);
  });

  it('reassigned when a rendered sentence is gone (split/merge/delete)', () => {
    const current = [
      { id: 1, characterId: 'narrator' },
      { id: 3, characterId: 'marlow' }, // id 2 removed
    ];
    expect(isChapterReassignedSinceRender(rendered, current)).toBe(true);
  });

  it('NO false positive on reassign-then-undo (the whole point vs the time-based heuristic)', () => {
    /* Same mapping as render after an undo → not stale, even though the
       time-based heuristic would still read stale from the logged edits. */
    const current = [
      { id: 1, characterId: 'narrator' },
      { id: 2, characterId: 'wren' },
      { id: 3, characterId: 'marlow' },
    ];
    expect(isChapterReassignedSinceRender(rendered, current)).toBe(false);
  });

  it('does not false-positive on a current sentence that was never in the render map', () => {
    /* A structural/empty line absent from segments isn't a rendered key, so an
       extra current sentence can't trip staleness on its own. */
    const current = [
      { id: 1, characterId: 'narrator' },
      { id: 2, characterId: 'wren' },
      { id: 3, characterId: 'marlow' },
      { id: 99, characterId: 'narrator' }, // never rendered
    ];
    expect(isChapterReassignedSinceRender(rendered, current)).toBe(false);
  });

  it('returns false when there is no render map for the chapter (fall back to heuristic)', () => {
    expect(isChapterReassignedSinceRender(undefined, [{ id: 1, characterId: 'x' }])).toBe(false);
    expect(isChapterReassignedSinceRender({}, [{ id: 1, characterId: 'x' }])).toBe(false);
  });
});

describe('textHashForStale (#1105)', () => {
  it('is deterministic and differs on a text change', () => {
    expect(textHashForStale('Hello there.')).toBe(textHashForStale('Hello there.'));
    expect(textHashForStale('Hello there.')).not.toBe(textHashForStale('Hello there!'));
  });

  it('matches the server djb2-base36 vector (cross-package contract)', () => {
    /* MUST equal server/src/audio/segments-io.ts textHashForStale for the same
       input — the staleness diff compares a server-stamped hash against this
       client-computed one. Pin a known vector so a drift on either side fails
       loudly here and in the server test. */
    expect(textHashForStale('"Stop," she said.')).toBe('2rq6ja');
  });
});

describe('isChapterTextEditedSinceRender (#1105 precise text diff)', () => {
  const h = textHashForStale;
  const rendered = { 1: h('The fire caught.'), 2: h('"Run," she said.'), 3: h('No one moved.') };

  it('not stale when every rendered sentence still has byte-identical text', () => {
    const current = [
      { id: 1, text: 'The fire caught.' },
      { id: 2, text: '"Run," she said.' },
      { id: 3, text: 'No one moved.' },
    ];
    expect(isChapterTextEditedSinceRender(rendered, current)).toBe(false);
  });

  it('stale when a rendered sentence text was edited', () => {
    const current = [
      { id: 1, text: 'The fire caught.' },
      { id: 2, text: '"Run!" she screamed.' }, // edited
      { id: 3, text: 'No one moved.' },
    ];
    expect(isChapterTextEditedSinceRender(rendered, current)).toBe(true);
  });

  it('stale when a rendered sentence is gone (split/merge/delete)', () => {
    const current = [
      { id: 1, text: 'The fire caught.' },
      { id: 3, text: 'No one moved.' }, // id 2 removed
    ];
    expect(isChapterTextEditedSinceRender(rendered, current)).toBe(true);
  });

  it('NO false positive on edit-then-revert (the derived-from-JSON win)', () => {
    const current = [
      { id: 1, text: 'The fire caught.' },
      { id: 2, text: '"Run," she said.' },
      { id: 3, text: 'No one moved.' },
    ];
    expect(isChapterTextEditedSinceRender(rendered, current)).toBe(false);
  });

  it('does not false-positive on a current sentence never in the render map', () => {
    const current = [
      { id: 1, text: 'The fire caught.' },
      { id: 2, text: '"Run," she said.' },
      { id: 3, text: 'No one moved.' },
      { id: 99, text: 'A new line.' },
    ];
    expect(isChapterTextEditedSinceRender(rendered, current)).toBe(false);
  });

  it('returns false when there is no render text map (pre-1105 render → fall back)', () => {
    expect(isChapterTextEditedSinceRender(undefined, [{ id: 1, text: 'x' }])).toBe(false);
    expect(isChapterTextEditedSinceRender({}, [{ id: 1, text: 'x' }])).toBe(false);
  });
});

describe('isChapterInstructEditedSinceRender (fs-58 precise instruct diff)', () => {
  const rendered = { 1: textHashForStale('a tired sigh') } as Record<number, string>;
  it('not stale when the live instruct matches the stamp', () => {
    expect(isChapterInstructEditedSinceRender(rendered, [{ id: 1, instruct: 'a tired sigh' }])).toBe(
      false,
    );
  });
  it('stale when the instruct was edited', () => {
    expect(isChapterInstructEditedSinceRender(rendered, [{ id: 1, instruct: 'shouting' }])).toBe(
      true,
    );
  });
  it('stale when the instruct was cleared', () => {
    expect(isChapterInstructEditedSinceRender(rendered, [{ id: 1 }])).toBe(true);
  });
  it('not stale when no stamps exist (non-liveInstruct render)', () => {
    expect(isChapterInstructEditedSinceRender(undefined, [{ id: 1, instruct: 'x' }])).toBe(false);
    expect(isChapterInstructEditedSinceRender({}, [{ id: 1, instruct: 'x' }])).toBe(false);
  });
  // §6.5 trim invariant: the server stamps the TRIMMED instruct (setSentenceInstruct trims
  // on write); a live value differing only in surrounding whitespace must read NOT stale.
  it('not stale when the live instruct differs only by surrounding whitespace', () => {
    expect(
      isChapterInstructEditedSinceRender(rendered, [{ id: 1, instruct: '  a tired sigh  ' }]),
    ).toBe(false);
  });
});
