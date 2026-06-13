import { describe, it, expect } from 'vitest';
import { completionPct, isFinished, buildLibraryStats, buildContinueListening } from './listen-stats-aggregate.js';

const ch = [{ id: 1, duration: '10:00' }, { id: 2, duration: '10:00' }];

describe('completionPct', () => {
  it('is consumed / total listenable', () => {
    expect(completionPct(ch, { chapterId: 2, currentSec: 300, updatedAt: 'x' })).toBeCloseTo((600 + 300) / 1200);
  });
  it('guards divide-by-zero', () => {
    expect(completionPct([{ id: 1 }], { chapterId: 1, currentSec: 0, updatedAt: 'x' })).toBe(0);
  });
});

describe('isFinished', () => {
  it('true when in the final listenable chapter near its end', () => {
    expect(isFinished(ch, { chapterId: 2, currentSec: 600, updatedAt: 'x' })).toBe(true);
    expect(isFinished(ch, { chapterId: 2, currentSec: 595, updatedAt: 'x' })).toBe(true);
  });
  it('false mid-final-chapter and false when not in final chapter', () => {
    expect(isFinished(ch, { chapterId: 2, currentSec: 120, updatedAt: 'x' })).toBe(false);
    expect(isFinished(ch, { chapterId: 1, currentSec: 600, updatedAt: 'x' })).toBe(false);
  });
});

describe('buildLibraryStats', () => {
  it('aggregates totals, finished count, per-series, and byDay; empty = zeros not NaN', () => {
    const out = buildLibraryStats([]);
    expect(out).toEqual({ totalListenedSec: 0, booksFinished: 0, perBook: [], perSeries: [], byDay: [] });
  });
});

describe('buildContinueListening', () => {
  it('excludes finished + <=5s, sorts by updatedAt desc', () => {
    const books = [
      { bookId: 'a', title: 'A', series: null, isStandalone: true, chapters: ch,
        resume: { chapterId: 1, currentSec: 120, updatedAt: '2026-06-10T00:00:00Z' }, statsFile: null },
      { bookId: 'b', title: 'B', series: null, isStandalone: true, chapters: ch,
        resume: { chapterId: 1, currentSec: 300, updatedAt: '2026-06-13T00:00:00Z' }, statsFile: null },
      { bookId: 'c', title: 'C', series: null, isStandalone: true, chapters: ch,
        resume: { chapterId: 2, currentSec: 600, updatedAt: '2026-06-12T00:00:00Z' }, statsFile: null },
      { bookId: 'd', title: 'D', series: null, isStandalone: true, chapters: ch,
        resume: { chapterId: 1, currentSec: 3, updatedAt: '2026-06-13T00:00:00Z' }, statsFile: null },
    ];
    const out = buildContinueListening(books);
    expect(out.map((x) => x.bookId)).toEqual(['b', 'a']);
  });
});
