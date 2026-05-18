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
  computeBodySplitIndex,
  type RestructureSentence,
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
