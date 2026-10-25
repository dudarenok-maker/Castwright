/* Pure-transform coverage for chapter restructure (plan 51).
 *
 * Pins the four downstream layers each transform produces — state.chapters,
 * ChapterHint[], sentences, audioOps — for every op shape:
 * - mergeChapters: contiguity guard, body concat, sentence renumber, slug
 *   regen, audio deletes for the merged chapter + renames for tail.
 * - splitChapter: locator-match path + paragraph-bisection fallback,
 *   sentence partition at the boundary, audio delete for the split source.
 * - reorderChapters: permutation validation, no-op slugs, rotate without
 *   collision-risk in audio op emission.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyMerge,
  applySplit,
  applyReorder,
  applyRename,
  applyExclude,
  applyRefreshTitles,
  backfillTitleSynthesized,
  computeBodySplitIndex,
  touchedChapterIds,
  carryMergedAwayKeys,
  type RefreshTitlesOptions,
  type RestructureSentence,
  type AudioOp,
} from './restructure.js';
import type { BookStateJson } from './scan.js';
import type { ChapterHint } from '../store/manuscripts.js';

function makeState(
  chapters: Array<{
    id: number;
    title: string;
    duration?: string;
    excluded?: boolean;
    audioModelKey?: string;
    audioRenderedAt?: string;
    uuid?: string;
    titleSynthesized?: boolean;
  }>,
): BookStateJson {
  return {
    bookId: 'test-book',
    manuscriptId: 'mid-1',
    title: 'Test',
    author: 'Tester',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: chapters.map((c) => ({
      id: c.id,
      title: c.title,
      slug: `${String(c.id).padStart(2, '0')}-${c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      ...(c.duration ? { duration: c.duration } : {}),
      ...(c.excluded ? { excluded: true } : {}),
      ...(c.audioModelKey ? { audioModelKey: c.audioModelKey } : {}),
      ...(c.audioRenderedAt ? { audioRenderedAt: c.audioRenderedAt } : {}),
      ...(c.uuid ? { uuid: c.uuid } : {}),
      ...(c.titleSynthesized ? { titleSynthesized: true } : {}),
    })),
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeHints(
  data: Array<{ id: number; title: string; body: string; excluded?: boolean }>,
): ChapterHint[] {
  return data.map((d) => ({ ...d }));
}

function s(
  id: number,
  chapterId: number,
  characterId: string,
  text: string,
): RestructureSentence {
  return { id, chapterId, characterId, text };
}

/* -- merge ---------------------------------------------------------- */

describe('applyMerge', () => {
  it('rejects single-id merge', () => {
    const state = makeState([{ id: 1, title: 'A' }]);
    const hints = makeHints([{ id: 1, title: 'A', body: 'one' }]);
    expect(() =>
      applyMerge(state, hints, [], { chapterIds: [1] }),
    ).toThrow(/at least 2/);
  });

  it('rejects non-contiguous merge', () => {
    const state = makeState([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
      { id: 3, title: 'C' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
      { id: 3, title: 'C', body: 'c' },
    ]);
    expect(() =>
      applyMerge(state, hints, [], { chapterIds: [1, 3] }),
    ).toThrow(/contiguous/);
  });

  it('merges 2 contiguous chapters: body concat, sentences renumber, audio delete + tail rename', () => {
    const state = makeState([
      { id: 1, title: 'A', audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, title: 'B', audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' },
      { id: 3, title: 'C', audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' },
      { id: 4, title: 'D', audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'A body' },
      { id: 2, title: 'B', body: 'B body' },
      { id: 3, title: 'C', body: 'C body' },
      { id: 4, title: 'D', body: 'D body' },
    ]);
    const sentences = [
      s(1, 1, 'narrator', 'A1'),
      s(2, 1, 'narrator', 'A2'),
      s(1, 2, 'narrator', 'B1'),
      s(2, 2, 'sam', 'B2'),
      s(1, 3, 'narrator', 'C1'),
      s(1, 4, 'narrator', 'D1'),
    ];

    const result = applyMerge(state, hints, sentences, { chapterIds: [2, 3] });

    // Chapter count drops by 1
    expect(result.state.chapters).toHaveLength(3);
    expect(result.hints).toHaveLength(3);
    // New ids 1..3
    expect(result.state.chapters.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(result.hints.map((h) => h.id)).toEqual([1, 2, 3]);
    // Chapter 1 untouched; chapter 2 = merged B+C; chapter 3 = old D
    expect(result.hints[0].body).toBe('A body');
    expect(result.hints[1].title).toBe('B'); // inherits first merged member's title
    expect(result.hints[1].body).toBe('B body\n\nC body');
    expect(result.hints[2].body).toBe('D body');

    // State chapters: merged chapter loses audio metadata (content changed);
    // tail (new id 3, old id 4) keeps it (renumbered-only).
    expect(result.state.chapters[0].audioModelKey).toBe('kokoro-v1');
    expect(result.state.chapters[0].audioRenderedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.state.chapters[1].audioModelKey).toBeUndefined();
    expect(result.state.chapters[1].audioRenderedAt).toBeUndefined();
    expect(result.state.chapters[2].audioModelKey).toBe('kokoro-v1');

    // Slugs regenerated from new id + title
    expect(result.state.chapters[0].slug).toBe('01-a');
    expect(result.state.chapters[1].slug).toBe('02-b');
    expect(result.state.chapters[2].slug).toBe('03-d');

    // Sentences: B sentences kept (chapter id rewritten to 2); C sentences appended with continuing ids
    const newSentences = result.sentences;
    // Old chapter 1's sentences → new chapter 1, ids unchanged
    expect(newSentences.filter((s) => s.chapterId === 1)).toEqual([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'A1' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'A2' },
    ]);
    // Merged chapter 2: B1,B2 then C1 with ids 1,2,3
    expect(newSentences.filter((s) => s.chapterId === 2)).toEqual([
      { id: 1, chapterId: 2, characterId: 'narrator', text: 'B1' },
      { id: 2, chapterId: 2, characterId: 'sam', text: 'B2' },
      { id: 3, chapterId: 2, characterId: 'narrator', text: 'C1' },
    ]);
    // Old chapter 4 → new chapter 3, sentence ids unchanged
    expect(newSentences.filter((s) => s.chapterId === 3)).toEqual([
      { id: 1, chapterId: 3, characterId: 'narrator', text: 'D1' },
    ]);

    // Remap table
    expect(result.remap.find((r) => r.oldChapterId === 2 && r.oldSentenceId === 1)).toEqual({
      oldChapterId: 2,
      oldSentenceId: 1,
      newChapterId: 2,
      newSentenceId: 1,
    });
    expect(result.remap.find((r) => r.oldChapterId === 3 && r.oldSentenceId === 1)).toEqual({
      oldChapterId: 3,
      oldSentenceId: 1,
      newChapterId: 2,
      newSentenceId: 3,
    });
    expect(result.remap.find((r) => r.oldChapterId === 4 && r.oldSentenceId === 1)).toEqual({
      oldChapterId: 4,
      oldSentenceId: 1,
      newChapterId: 3,
      newSentenceId: 1,
    });

    // Audio ops: delete old 2 + old 3 (merged into content-changed chapter);
    // rename old 4 to new slug 03-d
    const deletes = result.audioOps.filter((op) => op.kind === 'delete');
    const renames = result.audioOps.filter((op) => op.kind === 'rename');
    expect(deletes.map((op) => op.from).sort()).toEqual(['02-b', '03-c']);
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({ from: '04-d', to: '03-d', newChapterId: 3 });
  });

  it('inherits excluded flag only when ALL merged chapters were excluded', () => {
    const state = makeState([
      { id: 1, title: 'A', excluded: true },
      { id: 2, title: 'B', excluded: true },
      { id: 3, title: 'C', excluded: false },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a', excluded: true },
      { id: 2, title: 'B', body: 'b', excluded: true },
      { id: 3, title: 'C', body: 'c' },
    ]);
    const allExcl = applyMerge(state, hints, [], { chapterIds: [1, 2] });
    expect(allExcl.hints[0].excluded).toBe(true);
    expect(allExcl.state.chapters[0].excluded).toBe(true);

    const mixed = applyMerge(state, hints, [], { chapterIds: [2, 3] });
    expect(mixed.hints[1].excluded).toBeUndefined();
    expect(mixed.state.chapters[1].excluded).toBeUndefined();
  });

  it('uses mergedTitle override when provided', () => {
    const state = makeState([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
    ]);
    const result = applyMerge(state, hints, [], {
      chapterIds: [1, 2],
      mergedTitle: 'Combined Adventure',
    });
    expect(result.hints[0].title).toBe('Combined Adventure');
    expect(result.state.chapters[0].slug).toBe('01-combined-adventure');
  });
});

/* -- split ---------------------------------------------------------- */

describe('applySplit', () => {
  it('splits a chapter cleanly when sentence text matches body verbatim', () => {
    const state = makeState([
      { id: 1, title: 'Before' },
      {
        id: 2,
        title: 'Long',
        audioModelKey: 'kokoro-v1',
        audioRenderedAt: '2026-01-01T00:00:00.000Z',
      },
      { id: 3, title: 'After', audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const longBody =
      'Alpha first sentence. Beta second sentence.\n\nGamma third sentence. Delta fourth sentence.';
    const hints = makeHints([
      { id: 1, title: 'Before', body: 'before body' },
      { id: 2, title: 'Long', body: longBody },
      { id: 3, title: 'After', body: 'after body' },
    ]);
    const sentences = [
      s(1, 2, 'narr', 'Alpha first sentence.'),
      s(2, 2, 'narr', 'Beta second sentence.'),
      s(3, 2, 'narr', 'Gamma third sentence.'),
      s(4, 2, 'narr', 'Delta fourth sentence.'),
      s(1, 3, 'narr', 'After.'),
    ];

    const result = applySplit(state, hints, sentences, {
      chapterId: 2,
      afterSentenceId: 2,
    });

    // 4 chapters now
    expect(result.hints).toHaveLength(4);
    expect(result.state.chapters.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    // First half keeps title, second half gets "(cont.)"
    expect(result.hints[1].title).toBe('Long');
    expect(result.hints[2].title).toBe('Long (cont.)');
    // Body split at paragraph boundary (\n\n)
    expect(result.hints[1].body).toContain('Beta second sentence.');
    expect(result.hints[1].body).not.toContain('Gamma');
    expect(result.hints[2].body).toContain('Gamma third sentence.');
    expect(result.hints[2].body).not.toContain('Alpha');

    // Sentences split between halves; ids renumbered per chapter
    expect(result.sentences.filter((s) => s.chapterId === 2)).toEqual([
      { id: 1, chapterId: 2, characterId: 'narr', text: 'Alpha first sentence.' },
      { id: 2, chapterId: 2, characterId: 'narr', text: 'Beta second sentence.' },
    ]);
    expect(result.sentences.filter((s) => s.chapterId === 3)).toEqual([
      { id: 1, chapterId: 3, characterId: 'narr', text: 'Gamma third sentence.' },
      { id: 2, chapterId: 3, characterId: 'narr', text: 'Delta fourth sentence.' },
    ]);
    // Trailing chapter pushed to id 4
    expect(result.sentences.filter((s) => s.chapterId === 4)).toEqual([
      { id: 1, chapterId: 4, characterId: 'narr', text: 'After.' },
    ]);

    // Audio: old 2 (split source) → delete; old 3 → rename to new id 4
    const deletes = result.audioOps.filter((op) => op.kind === 'delete');
    const renames = result.audioOps.filter((op) => op.kind === 'rename');
    expect(deletes.map((op) => op.from)).toEqual(['02-long']);
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({ from: '03-after', to: '04-after' });
  });

  it('rejects split after last sentence (second half would be empty)', () => {
    const state = makeState([{ id: 1, title: 'A' }]);
    const hints = makeHints([{ id: 1, title: 'A', body: 'X. Y.' }]);
    const sentences = [s(1, 1, 'narr', 'X.'), s(2, 1, 'narr', 'Y.')];
    expect(() =>
      applySplit(state, hints, sentences, {
        chapterId: 1,
        afterSentenceId: 2,
      }),
    ).toThrow(/last sentence/);
  });

  it('rejects split when sentence id not in chapter', () => {
    const state = makeState([{ id: 1, title: 'A' }]);
    const hints = makeHints([{ id: 1, title: 'A', body: 'X.' }]);
    const sentences = [s(1, 1, 'narr', 'X.')];
    expect(() =>
      applySplit(state, hints, sentences, {
        chapterId: 1,
        afterSentenceId: 99,
      }),
    ).toThrow(/not in chapter/);
  });

  it('uses newTitle override when provided', () => {
    const state = makeState([
      { id: 1, title: 'Long' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'Long', body: 'X.\n\nY.' },
    ]);
    const sentences = [s(1, 1, 'n', 'X.'), s(2, 1, 'n', 'Y.')];
    const result = applySplit(state, hints, sentences, {
      chapterId: 1,
      afterSentenceId: 1,
      newTitle: 'Part Two',
    });
    expect(result.hints[1].title).toBe('Part Two');
  });
});

describe('computeBodySplitIndex', () => {
  it('finds the unique locator and advances to the next paragraph break', () => {
    const body = 'First sentence here.\n\nSecond paragraph here.';
    const prefix = [s(1, 1, 'n', 'First sentence here.')];
    const idx = computeBodySplitIndex(body, prefix, 2);
    expect(body.slice(0, idx)).toBe('First sentence here.');
    expect(body.slice(idx).startsWith('\n\n')).toBe(true);
  });

  it('falls back to paragraph-count bisection when locator does not match', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body =
      'Para1 stuff.\n\nPara2 stuff.\n\nPara3 stuff.\n\nPara4 stuff.';
    // Sentence text deliberately doesn't appear in body verbatim
    const prefix = [
      s(1, 1, 'n', 'No-match alpha'),
      s(2, 1, 'n', 'No-match beta'),
    ];
    const idx = computeBodySplitIndex(body, prefix, 4);
    expect(warnSpy).toHaveBeenCalled();
    // 2/4 ratio → split at paragraph 2 (after 'Para2 stuff.')
    expect(body.slice(0, idx)).toBe('Para1 stuff.\n\nPara2 stuff.');
    warnSpy.mockRestore();
  });
});

/* -- reorder -------------------------------------------------------- */

describe('applyReorder', () => {
  it('rejects order with wrong length', () => {
    const state = makeState([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
    ]);
    expect(() => applyReorder(state, hints, [], { order: [1] })).toThrow(
      /order length/,
    );
  });

  it('rejects order with duplicates', () => {
    const state = makeState([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
    ]);
    expect(() => applyReorder(state, hints, [], { order: [1, 1] })).toThrow(
      /duplicates/,
    );
  });

  it('rejects order missing a current chapter', () => {
    const state = makeState([
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
    ]);
    expect(() => applyReorder(state, hints, [], { order: [1, 9] })).toThrow(
      /missing chapter 2/,
    );
  });

  it('rotates 3 chapters with two-pass-safe rename ops + preserves audio metadata', () => {
    const state = makeState([
      { id: 1, title: 'A', audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' },
      { id: 2, title: 'B', audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' },
      { id: 3, title: 'C', audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
      { id: 3, title: 'C', body: 'c' },
    ]);
    const sentences = [
      s(1, 1, 'narr', 'A1'),
      s(1, 2, 'narr', 'B1'),
      s(2, 2, 'sam', 'B2'),
      s(1, 3, 'narr', 'C1'),
    ];

    // Rotate: 3,1,2 → new ids 1,2,3
    const result = applyReorder(state, hints, sentences, {
      order: [3, 1, 2],
    });

    // New chapters: id 1 = old C, id 2 = old A, id 3 = old B
    expect(result.hints.map((h) => h.title)).toEqual(['C', 'A', 'B']);
    expect(result.state.chapters.map((c) => ({ id: c.id, slug: c.slug }))).toEqual([
      { id: 1, slug: '01-c' },
      { id: 2, slug: '02-a' },
      { id: 3, slug: '03-b' },
    ]);

    // Audio metadata preserved on ALL reordered chapters
    for (const ch of result.state.chapters) {
      expect(ch.audioModelKey).toBe('kokoro-v1');
      expect(ch.audioRenderedAt).toBe('2026-01-01T00:00:00.000Z');
    }

    // Audio ops are all renames (no deletes); each old slug → its new slug
    expect(result.audioOps.every((op) => op.kind === 'rename')).toBe(true);
    const renamesByFrom = new Map(
      result.audioOps
        .filter((op) => op.kind === 'rename')
        .map((op) => [op.from, op]),
    );
    expect(renamesByFrom.get('01-a')).toMatchObject({ from: '01-a', to: '02-a', newChapterId: 2 });
    expect(renamesByFrom.get('02-b')).toMatchObject({ from: '02-b', to: '03-b', newChapterId: 3 });
    expect(renamesByFrom.get('03-c')).toMatchObject({ from: '03-c', to: '01-c', newChapterId: 1 });

    // Sentences remapped: old (2, 1) → new (3, 1) because old chapter 2 is now new chapter 3
    expect(result.sentences.find((sentence) => sentence.text === 'B1')).toEqual({
      id: 1,
      chapterId: 3,
      characterId: 'narr',
      text: 'B1',
    });
    expect(result.sentences.find((sentence) => sentence.text === 'C1')).toEqual({
      id: 1,
      chapterId: 1,
      characterId: 'narr',
      text: 'C1',
    });
  });

  it('skips audio ops for chapters without rendered audio', () => {
    const state = makeState([
      { id: 1, title: 'A' }, // no audioRenderedAt
      { id: 2, title: 'B', audioModelKey: 'kokoro-v1', audioRenderedAt: 'x' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
    ]);
    const result = applyReorder(state, hints, [], { order: [2, 1] });
    // Only chapter that had audio gets a rename op
    expect(result.audioOps).toHaveLength(1);
    expect(result.audioOps[0]).toMatchObject({ from: '02-b', to: '01-b' });
  });
});

/* srv-35 (plan 190) — the immutable per-chapter uuid is identity, not
   position, so a restructure must carry it by the chapter it belongs to,
   never re-issue it like the positional id. */
describe('uuid preservation across restructure (srv-35)', () => {
  it('reorder carries each chapter uuid with the chapter, not the position', () => {
    const state = makeState([
      { id: 1, title: 'A', uuid: 'u-a' },
      { id: 2, title: 'B', uuid: 'u-b' },
      { id: 3, title: 'C', uuid: 'u-c' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
      { id: 3, title: 'C', body: 'c' },
    ]);

    // Rotate: old 3,1,2 → new ids 1,2,3
    const result = applyReorder(state, hints, [], { order: [3, 1, 2] });

    const byNewId = new Map(result.state.chapters.map((c) => [c.id, c.uuid]));
    expect(byNewId.get(1)).toBe('u-c'); // old C is now id 1
    expect(byNewId.get(2)).toBe('u-a'); // old A is now id 2
    expect(byNewId.get(3)).toBe('u-b'); // old B is now id 3
  });

  it('merge keeps the survivor (first member) uuid and preserves the tail uuid', () => {
    const state = makeState([
      { id: 1, title: 'A', uuid: 'u-a' },
      { id: 2, title: 'B', uuid: 'u-b' },
      { id: 3, title: 'C', uuid: 'u-c' },
      { id: 4, title: 'D', uuid: 'u-d' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'A body' },
      { id: 2, title: 'B', body: 'B body' },
      { id: 3, title: 'C', body: 'C body' },
      { id: 4, title: 'D', body: 'D body' },
    ]);

    // Merge old 2+3 → new id 2 ; old 4 becomes new id 3
    const result = applyMerge(state, hints, [], { chapterIds: [2, 3] });

    const byNewId = new Map(result.state.chapters.map((c) => [c.id, c.uuid]));
    expect(byNewId.get(1)).toBe('u-a'); // untouched
    expect(byNewId.get(2)).toBe('u-b'); // merged B+C keeps B's (survivor) uuid
    expect(byNewId.get(3)).toBe('u-d'); // tail D renumbered, uuid preserved
  });

  it('split keeps the original uuid on the first half and mints a fresh one for the second', () => {
    const state = makeState([{ id: 1, title: 'A', uuid: 'u-a' }]);
    const hints = makeHints([{ id: 1, title: 'A', body: 'A1\n\nA2' }]);
    const sentences = [s(1, 1, 'narr', 'A1'), s(2, 1, 'narr', 'A2')];

    // Split chapter 1 after sentence 1 → two chapters
    const result = applySplit(state, hints, sentences, {
      chapterId: 1,
      afterSentenceId: 1,
    });

    expect(result.state.chapters).toHaveLength(2);
    expect(result.state.chapters[0].uuid).toBe('u-a'); // first half keeps it
    expect(result.state.chapters[1].uuid).toBeDefined();
    expect(result.state.chapters[1].uuid).not.toBe('u-a'); // second half is new
  });

  it('rename preserves the uuid', () => {
    const state = makeState([{ id: 1, title: 'A', uuid: 'u-a' }]);
    const hints = makeHints([{ id: 1, title: 'A', body: 'a' }]);

    const result = applyRename(state, hints, [], { chapterId: 1, title: 'New Title' });

    expect(result.state.chapters[0].uuid).toBe('u-a');
  });

  it('exclude preserves the uuid', () => {
    const state = makeState([
      { id: 1, title: 'A', uuid: 'u-a' },
      { id: 2, title: 'B', uuid: 'u-b' },
    ]);
    const hints = makeHints([
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
    ]);

    const result = applyExclude(state, hints, [], { chapterIds: [2], excluded: true });

    expect(result.state.chapters[0].uuid).toBe('u-a');
    expect(result.state.chapters[1].uuid).toBe('u-b');
    expect(result.state.chapters[1].excluded).toBe(true);
  });
});

/* -- touchedChapterIds (plan 286) ------------------------------------ */

describe('touchedChapterIds', () => {
  const ch = (id: number, slug: string) => ({ id, title: slug, slug });

  it('plan 286 — touchedChapterIds covers content change (same id), id change, and slug-only rename; leaves untouched chapters', () => {
    const old = [ch(1, '01-a'), ch(2, '02-b'), ch(3, '03-c'), ch(4, '04-d'), ch(5, '05-e')];
    const neu = [ch(1, '01-a'), ch(2, '02-b'), ch(3, '03-c-renamed'), ch(4, '04-merged')];
    const ops: AudioOp[] = [{ kind: 'delete', from: '02-b' }, { kind: 'rename', from: '03-c', to: '03-c-renamed', newChapterId: 3, newChapterTitle: 'C' }];
    // 2: content changed, same id+slug (delete op) · 3: slug-only rename · 4: same id, new slug · 5: gone · 1: untouched
    expect(touchedChapterIds(old as never, neu as never, ops)).toEqual([2, 3, 4, 5]);
  });
});

describe('post-process passes move audio with the slug (#3400)', () => {
  const T = '2026-01-01T00:00:00.000Z';
  // Only app-made ("Chapter N", flagged titleSynthesized) titles are renumbered (#3628).
  const rendered = (id: number, title: string) => ({
    id,
    title,
    ...(/^Chapter \d+$/.test(title) ? { titleSynthesized: true } : {}),
    audioModelKey: 'kokoro-v1',
    audioRenderedAt: T,
  });
  const slugs = (ops: AudioOp[], kind: AudioOp['kind']) =>
    ops
      .filter((o) => o.kind === kind)
      .map((o) => (o.kind === 'rename' ? `${o.from}>${o.to}` : o.from))
      .sort();

  it('exclude: chapters retitled only by the generic-title pass get a rename from their original slug', () => {
    const state = makeState([
      rendered(1, 'Prologue'),
      rendered(2, 'Chapter 1'),
      rendered(3, 'Chapter 2'),
      rendered(4, 'Chapter 3'),
    ]);
    const hints = makeHints(state.chapters.map((c) => ({ id: c.id, title: c.title, body: 'b' })));
    const r = applyExclude(state, hints, [], { chapterIds: [4], excluded: true });
    expect(r.state.chapters.map((c) => c.slug)).toEqual([
      '01-prologue',
      '02-chapter-2',
      '03-chapter-3',
      '04-chapter-4',
    ]);
    expect(slugs(r.audioOps, 'rename')).toEqual([
      '02-chapter-1>02-chapter-2',
      '03-chapter-2>03-chapter-3',
      '04-chapter-3>04-chapter-4',
    ]);
    expect(slugs(r.audioOps, 'delete')).toEqual([]);
  });

  it('merge [3,4]: the chapter shifted only by a retitle keeps its audio', () => {
    const state = makeState([
      rendered(1, 'Prologue'),
      rendered(2, 'Chapter 1'),
      rendered(3, 'Chapter 2'),
      rendered(4, 'Chapter 3'),
    ]);
    const hints = makeHints(state.chapters.map((c) => ({ id: c.id, title: c.title, body: 'b' })));
    const r = applyMerge(state, hints, [], { chapterIds: [3, 4] });
    expect(slugs(r.audioOps, 'rename')).toContain('02-chapter-1>02-chapter-2');
    expect(slugs(r.audioOps, 'delete')).toEqual(['03-chapter-2', '04-chapter-3']);
  });

  it('prune: a survivor renumbered into a pruned chapter\'s slot is renamed, the pruned audio deleted from its own slug', () => {
    const state = makeState([
      rendered(1, 'Chapter 1'),
      rendered(2, 'Chapter 2'),
      rendered(3, 'Chapter 3'),
    ]);
    const hints = makeHints(
      state.chapters.map((c) => ({ id: c.id, title: c.title, body: c.id === 2 ? '' : 'b' })),
    );
    // chapter 2 has no sentences AND an empty body (#3783) → pruned; chapter 3 becomes id 2
    const sentences: RestructureSentence[] = [
      { id: 1, chapterId: 1, characterId: 'n', text: 'a' },
      { id: 1, chapterId: 3, characterId: 'n', text: 'c' },
    ];
    const r = applyExclude(state, hints, sentences, { chapterIds: [1], excluded: false });
    expect(slugs(r.audioOps, 'delete')).toEqual(['02-chapter-2']);
    expect(slugs(r.audioOps, 'rename')).toEqual(['03-chapter-3>02-chapter-2']);
  });

  it('#3774 include: a never-analysed (zero-sentence) chapter the op just included survives the prune — no delete/rename ops, numbering stable', () => {
    const state = makeState([
      rendered(1, 'Chapter 1'),
      { ...rendered(2, 'Chapter 2'), excluded: true },
      rendered(3, 'Chapter 3'),
    ]);
    const hints = makeHints([
      { id: 1, title: 'Chapter 1', body: 'b' },
      { id: 2, title: 'Chapter 2', body: 'b', excluded: true },
      { id: 3, title: 'Chapter 3', body: 'b' },
    ]);
    // chapter 2 (excluded) has no sentences; chapters 1 and 3 do.
    const sentences: RestructureSentence[] = [
      { id: 1, chapterId: 1, characterId: 'n', text: 'a' },
      { id: 1, chapterId: 3, characterId: 'n', text: 'c' },
    ];
    const r = applyExclude(state, hints, sentences, { chapterIds: [2], excluded: false });
    expect(r.state.chapters.map((c) => [c.id, c.slug, c.excluded])).toEqual([
      [1, '01-chapter-1', undefined],
      [2, '02-chapter-2', undefined],
      [3, '03-chapter-3', undefined],
    ]);
    expect(r.hints.map((h) => h.id)).toEqual([1, 2, 3]);
    expect(r.audioOps).toEqual([]);
  });
});

/* -- #3783: prune ONLY a chapter with no manuscript text ------------ */

describe('prune only a chapter with no manuscript text (#3783)', () => {
  const four = () => {
    const state = makeState([
      { id: 1, title: 'Chapter 1', titleSynthesized: true },
      { id: 2, title: 'Chapter 2', titleSynthesized: true, excluded: true },
      { id: 3, title: 'Chapter 3', titleSynthesized: true, excluded: true },
      { id: 4, title: 'Chapter 4', titleSynthesized: true },
    ]);
    const hints = makeHints(
      state.chapters.map((c) => ({ id: c.id, title: c.title, body: `body ${c.id}`, excluded: c.excluded })),
    );
    // chapters 2 and 3 were never analysed: zero sentences.
    const sentences = [s(1, 1, 'n', 'a'), s(1, 4, 'n', 'd')];
    return { state, hints, sentences };
  };

  it('including chapter A then (a separate op) chapter B keeps A', () => {
    const { state, hints, sentences } = four();
    const afterA = applyExclude(state, hints, sentences, { chapterIds: [2], excluded: false });
    const afterB = applyExclude(afterA.state, afterA.hints, afterA.sentences, {
      chapterIds: [3],
      excluded: false,
    });
    expect(afterB.state.chapters.map((c) => [c.id, c.excluded])).toEqual([
      [1, undefined],
      [2, undefined],
      [3, undefined],
      [4, undefined],
    ]);
    expect(afterB.hints.map((h) => h.body)).toEqual(['body 1', 'body 2', 'body 3', 'body 4']);
    expect(afterB.audioOps).toEqual([]);
  });

  it('a merge of unrelated chapters leaves a zero-sentence included chapter intact', () => {
    const { state, hints, sentences } = four();
    const included = applyExclude(state, hints, sentences, { chapterIds: [2, 3], excluded: false });
    const merged = applyMerge(included.state, included.hints, included.sentences, { chapterIds: [3, 4] });
    expect(merged.state.chapters.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(merged.hints.find((h) => h.id === 2)?.body).toBe('body 2');
  });

  it('a reorder leaves a zero-sentence included chapter intact', () => {
    const { state, hints, sentences } = four();
    const included = applyExclude(state, hints, sentences, { chapterIds: [2, 3], excluded: false });
    const reordered = applyReorder(included.state, included.hints, included.sentences, {
      order: [4, 3, 2, 1],
    });
    expect(reordered.state.chapters.map((c) => c.id)).toEqual([1, 2, 3, 4]);
    expect(reordered.hints.map((h) => h.body)).toEqual(['body 4', 'body 3', 'body 2', 'body 1']);
  });

  // Included (not excluded) chapters 2 and 3 with zero sentences; `bodies` sets
  // each hint's text (omit an id for no hint entry).
  const withBody = (bodies: Record<number, string | undefined>) => {
    const { state: base, sentences } = four();
    const state = {
      ...base,
      chapters: base.chapters.map(({ excluded: _e, ...c }) => c),
    };
    const hints = state.chapters
      .filter((c) => bodies[c.id] !== undefined)
      .map((c) => ({ id: c.id, title: c.title, body: bodies[c.id]! }));
    return { state, hints, sentences };
  };

  it.each([
    ['whitespace-only', '  \n\n \t'],
    ['heading-only', '# Chapter 2\n'],
    ['empty', ''],
  ])('a merge prunes a zero-sentence chapter whose body is %s', (_n, body) => {
    const { state, hints, sentences } = withBody({ 1: 'b1', 2: body, 3: 'b3', 4: 'b4' });
    const merged = applyMerge(state, hints, sentences, { chapterIds: [3, 4] });
    // chapter 2 pruned: chapter 1 + (old 3+4 merged) remain
    expect(merged.state.chapters.map((c) => c.id)).toEqual([1, 2]);
  });

  it('a reorder prunes a zero-sentence chapter whose body is empty', () => {
    const { state, hints, sentences } = withBody({ 1: 'b1', 2: '', 3: 'b3', 4: 'b4' });
    const reordered = applyReorder(state, hints, sentences, { order: [4, 3, 2, 1] });
    expect(reordered.state.chapters.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(reordered.hints.map((h) => h.body)).toEqual(['b4', 'b3', 'b1']);
  });

  it('a chapter that has sentences is kept even if its hint body is empty', () => {
    const { state, hints, sentences } = withBody({ 1: '', 2: 'b2', 3: 'b3', 4: 'b4' });
    const r = applyExclude(state, hints, sentences, { chapterIds: [4], excluded: true });
    expect(r.state.chapters.map((c) => c.id)).toEqual([1, 2, 3, 4]);
  });

  it('a zero-sentence chapter with no hint entry is kept (text cannot be judged)', () => {
    // exclude keeps state.chapters as-is, so a chapter can lack a hint entry
    const { state, hints, sentences } = withBody({ 1: 'b1', 3: 'b3', 4: 'b4' });
    const r = applyExclude(state, hints, sentences, { chapterIds: [4], excluded: true });
    expect(r.state.chapters.map((c) => c.id)).toEqual([1, 2, 3, 4]);
  });

  it('including an excluded zero-sentence chapter whose body is empty prunes it and renumbers later audio', () => {
    const rendered = { audioModelKey: 'kokoro-v1', audioRenderedAt: '2026-01-01T00:00:00.000Z' };
    const state = makeState([
      { id: 1, title: 'Alpha' },
      { id: 2, title: 'Beta', excluded: true },
      { id: 3, title: 'Gamma', ...rendered },
      { id: 4, title: 'Delta', ...rendered },
    ]);
    const hints = makeHints([
      { id: 1, title: 'Alpha', body: 'b1' },
      { id: 2, title: 'Beta', body: '', excluded: true },
      { id: 3, title: 'Gamma', body: 'b3' },
      { id: 4, title: 'Delta', body: 'b4' },
    ]);
    const sentences = [s(1, 1, 'n', 'a'), s(1, 3, 'n', 'c'), s(1, 4, 'n', 'd')];
    const r = applyExclude(state, hints, sentences, { chapterIds: [2], excluded: false });
    expect(r.state.chapters.map((c) => [c.id, c.title])).toEqual([
      [1, 'Alpha'],
      [2, 'Gamma'],
      [3, 'Delta'],
    ]);
    expect(r.audioOps.map((o) => [o.kind, o.from, o.kind === 'rename' ? o.to : undefined])).toEqual([
      ['rename', '03-gamma', '02-gamma'],
      ['rename', '04-delta', '03-delta'],
    ]);
    expect(r.warnings.some((w) => /Beta/.test(w))).toBe(true);
  });
});

describe('carryMergedAwayKeys (#3400)', () => {
  const r = (oc: number, os: number, nc: number, ns: number) => ({
    oldChapterId: oc, oldSentenceId: os, newChapterId: nc, newSentenceId: ns,
  });

  it('re-keys a chapter whose ids are unchanged and drops the rest', () => {
    expect(carryMergedAwayKeys(['1:3', '2:3', '9:1'], [r(1, 1, 2, 1), r(2, 1, 1, 1)])).toEqual([
      '2:3',
      '1:3',
    ]);
  });

  it('drops a chapter spread over two new chapters even at unchanged ids', () => {
    expect(carryMergedAwayKeys(['1:3'], [r(1, 1, 1, 1), r(1, 2, 2, 2)])).toEqual([]);
  });

  it('drops a chapter that shares its new chapter with another (merge)', () => {
    expect(carryMergedAwayKeys(['1:3', '2:3'], [r(1, 1, 1, 1), r(2, 1, 1, 2)])).toEqual([]);
  });
});

/* -- title source (#3628): only app-made titles are renumbered ------ */

describe('renumbering honours titleSynthesized (#3628)', () => {
  const titles = ['Prologue', 'Chapter 1', 'Chapter 2', 'Chapter 3'];
  const book = (synth: boolean) =>
    makeState(
      titles.map((title, i) => ({
        id: i + 1,
        title,
        ...(synth && i > 0 ? { titleSynthesized: true } : {}),
      })),
    );
  const bookHints = () =>
    makeHints(titles.map((title, i) => ({ id: i + 1, title, body: `b${i + 1}` })));
  const bookSentences = () => titles.map((_, i) => s(1, i + 1, 'narr', `One ${i + 1}.`));

  it('(A) leaves manuscript headings without the flag untouched', () => {
    const result = applyExclude(book(false), bookHints(), bookSentences(), {
      chapterIds: [4],
      excluded: true,
    });
    expect(result.state.chapters.map((c) => c.title)).toEqual(titles);
  });

  it('(B) renumbers chapters flagged titleSynthesized', () => {
    const result = applyExclude(book(true), bookHints(), bookSentences(), {
      chapterIds: [4],
      excluded: true,
    });
    expect(result.state.chapters.map((c) => c.title)).toEqual([
      'Prologue',
      'Chapter 2',
      'Chapter 3',
      'Chapter 4',
    ]);
  });

  it('(B2) keeps hint titles in step with renumbered state titles', () => {
    const result = applyExclude(book(true), bookHints(), bookSentences(), {
      chapterIds: [4],
      excluded: true,
    });
    const stateTitles = result.state.chapters.map((c) => c.title);
    expect(stateTitles).not.toEqual(titles); // renumbering really happened
    for (const c of result.state.chapters) {
      expect(result.hints.find((h) => h.id === c.id)?.title).toBe(c.title);
    }
  });

  it('(C) reorder and title-less merge carry the flag to the new chapter', () => {
    const reordered = applyReorder(book(true), bookHints(), bookSentences(), {
      order: [1, 3, 2, 4],
    });
    expect(reordered.state.chapters.map((c) => c.titleSynthesized)).toEqual([
      undefined,
      true,
      true,
      true,
    ]);

    // Merge 2+3: no explicit title → first member's title and flag.
    const merged = applyMerge(book(true), bookHints(), bookSentences(), {
      chapterIds: [2, 3],
    });
    expect(merged.state.chapters[1].titleSynthesized).toBe(true);
    // A merge led by an unflagged member stays unflagged.
    const mergedHeading = applyMerge(book(true), bookHints(), bookSentences(), {
      chapterIds: [1, 2],
    });
    expect(mergedHeading.state.chapters[0].titleSynthesized).toBeUndefined();
  });

  it('(D) rename and merge mergedTitle drop the flag for good', () => {
    const renamed = applyRename(book(true), bookHints(), bookSentences(), {
      chapterId: 3,
      title: 'Chapter 9',
    });
    const mergedExplicit = applyMerge(book(true), bookHints(), bookSentences(), {
      chapterIds: [2, 3],
      mergedTitle: 'Chapter 9',
    });

    const cases: Array<[string, ReturnType<typeof applyRename>, number]> = [
      ['rename', renamed, 3],
      ['merge', mergedExplicit, 2],
    ];
    for (const [label, result, id] of cases) {
      const ch = result.state.chapters.find((c) => c.id === id)!;
      expect(ch.title, label).toBe('Chapter 9');
      expect('titleSynthesized' in ch, label).toBe(false);
      // A later restructure must not renumber the explicit title.
      const later = applyExclude(result.state, result.hints, result.sentences, {
        chapterIds: [1],
        excluded: true,
      });
      expect(later.state.chapters.find((c) => c.id === id)!.title, label).toBe('Chapter 9');
    }
  });

  it('(E) split keeps the flag on the first half and never gives it to the second', () => {
    const split = applySplit(
      makeState([
        { id: 1, title: 'Prologue' },
        { id: 2, title: 'Chapter 1', titleSynthesized: true },
      ]),
      makeHints([
        { id: 1, title: 'Prologue', body: 'p' },
        { id: 2, title: 'Chapter 1', body: 'Alpha one. Beta two.' },
      ]),
      [s(1, 1, 'narr', 'P.'), s(1, 2, 'narr', 'Alpha one.'), s(2, 2, 'narr', 'Beta two.')],
      { chapterId: 2, afterSentenceId: 1, newTitle: 'Chapter 9' },
    );
    expect(split.state.chapters[1].titleSynthesized).toBe(true);
    expect('titleSynthesized' in split.state.chapters[2]).toBe(false);
  });
});
/* -- title source (#3628): the title-refresh passes honour the flag -- */

describe('applyRefreshTitles honours titleSynthesized (#3628)', () => {
  const opts = (over: Partial<RefreshTitlesOptions> = {}): RefreshTitlesOptions => ({
    parsedTitles: [],
    useFirstLine: false,
    looksLikeTitle: () => true,
    maxLen: 80,
    ...over,
  });
  const oneChapter = (synth: boolean) => ({
    state: makeState([{ id: 1, title: 'Chapter 1', ...(synth ? { titleSynthesized: true } : {}) }]),
    hints: makeHints([{ id: 1, title: 'Chapter 1', body: 'The Long Road Home' }]),
    sentences: [s(1, 1, 'narr', 'The Long Road Home')],
  });

  it('first-line promotion leaves an unflagged "Chapter 1" heading alone', () => {
    const { state, hints, sentences } = oneChapter(false);
    const result = applyRefreshTitles(state, hints, sentences, opts({ useFirstLine: true }));
    expect(result.state.chapters[0].title).toBe('Chapter 1');
  });

  it('first-line promotion replaces a flagged title and drops the flag', () => {
    const { state, hints, sentences } = oneChapter(true);
    const result = applyRefreshTitles(state, hints, sentences, opts({ useFirstLine: true }));
    const ch = result.state.chapters[0];
    expect(ch.title).toBe('The Long Road Home');
    expect('titleSynthesized' in ch).toBe(false);
  });

  it('parser-aligned pass does not replace an unflagged generic title', () => {
    const { state, hints, sentences } = oneChapter(false);
    const result = applyRefreshTitles(
      state,
      hints,
      sentences,
      opts({ parsedTitles: ['Opening'], parsedTitleSynthesized: [false] }),
    );
    expect(result.state.chapters[0].title).toBe('Chapter 1');
  });

  it('parser-aligned pass replaces a flagged title; the flag follows the parsed title', () => {
    const synthesizedParse = oneChapter(true);
    const kept = applyRefreshTitles(
      synthesizedParse.state,
      synthesizedParse.hints,
      synthesizedParse.sentences,
      opts({ parsedTitles: ['Chapter 7'], parsedTitleSynthesized: [true] }),
    );
    expect(kept.state.chapters[0].title).toBe('Chapter 7');
    expect(kept.state.chapters[0].titleSynthesized).toBe(true);

    const headingParse = oneChapter(true);
    const cleared = applyRefreshTitles(
      headingParse.state,
      headingParse.hints,
      headingParse.sentences,
      opts({ parsedTitles: ['Opening'], parsedTitleSynthesized: [false] }),
    );
    expect(cleared.state.chapters[0].title).toBe('Opening');
    expect('titleSynthesized' in cleared.state.chapters[0]).toBe(false);
  });
});

/* -- title source (#3628): backfilling the flag on legacy chapters --- */

describe('backfillTitleSynthesized (#3628)', () => {
  const parsedTitles = ['Chapter 1', 'Prologue', 'Chapter 3'];
  const parsedSynth = [true, false, true];

  it('flags a keyless chapter whose title matches an app-made parse position', () => {
    const out = backfillTitleSynthesized(
      makeState([
        { id: 1, title: 'Chapter 1' },
        { id: 2, title: 'Prologue' },
        { id: 3, title: 'Chapter 3' },
      ]),
      parsedTitles,
      parsedSynth,
    );
    expect(out.chapters.map((c) => c.titleSynthesized)).toEqual([true, undefined, true]);
  });

  it('does not backfill an edited title, a titleOverridden chapter, or a position the parse took from a heading', () => {
    const state = makeState([
      { id: 1, title: 'Chapter 1 — Mine' },
      { id: 2, title: 'Prologue' },
      { id: 3, title: 'Chapter 3' },
    ]);
    state.chapters[2].titleOverridden = true;
    const out = backfillTitleSynthesized(state, parsedTitles, parsedSynth);
    expect(out.chapters.some((c) => 'titleSynthesized' in c)).toBe(false);
  });

  it('does nothing when the chapter counts differ', () => {
    const state = makeState([{ id: 1, title: 'Chapter 1' }]);
    expect(backfillTitleSynthesized(state, parsedTitles, parsedSynth)).toBe(state);
  });

  it('never touches a chapter that already has the key, including false', () => {
    const state = makeState([
      { id: 1, title: 'Chapter 1' },
      { id: 2, title: 'Prologue' },
      { id: 3, title: 'Chapter 3' },
    ]);
    state.chapters[0].titleSynthesized = false; // makeState only writes the key when true
    const out = backfillTitleSynthesized(state, parsedTitles, parsedSynth);
    expect(out.chapters[0].titleSynthesized).toBe(false);
    expect(out.chapters[2].titleSynthesized).toBe(true);
  });
});
