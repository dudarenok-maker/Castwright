import { describe, it, expect } from 'vitest';
import {
  completionPct,
  isFinished,
  buildLibraryStats,
  buildContinueListening,
  type BookStatsInput,
} from './listen-stats-aggregate.js';

const ch = [{ id: 1, duration: '10:00' }, { id: 2, duration: '10:00' }];

type Ch = BookStatsInput['chapters'][number];

/* fs-15 shelf controls — helper for the auto-hide / finished / hidden cases. */
function book(over: Partial<BookStatsInput> = {}): BookStatsInput {
  return {
    bookId: 'b1',
    title: 'Test Book',
    series: null,
    isStandalone: true,
    chapters: [
      { id: 1, duration: '00:30:00' },
      { id: 2, duration: '00:30:00' },
    ],
    resume: null,
    statsFile: null,
    ...over,
  };
}

const at = '2026-06-14T00:00:00.000Z';
const railIds = (items: { bookId: string }[]) => items.map((i) => i.bookId);

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

describe('buildContinueListening — auto-hide completed (fs-15 shelf controls)', () => {
  it('keeps a genuinely in-progress book on the rail', () => {
    const b = book({ resume: { chapterId: 1, currentSec: 60, updatedAt: at } });
    expect(railIds(buildContinueListening([b]))).toContain('b1');
  });

  it('drops a book consumed to the end whose resume bookmark is in a non-listenable final chapter (the "0:00 left" leak)', () => {
    // ch2 has no duration (credits / audio not generated) → not listenable.
    // The bookmark points at it; everything listenable (ch1) is consumed.
    const chapters: Ch[] = [{ id: 1, duration: '00:30:00' }, { id: 2 }];
    const b = book({ chapters, resume: { chapterId: 2, currentSec: 10, updatedAt: at } });
    expect(railIds(buildContinueListening([b]))).not.toContain('b1');
  });

  it('drops a book with no listenable audio at all (no durations)', () => {
    const chapters: Ch[] = [{ id: 1 }, { id: 2 }];
    const b = book({ chapters, resume: { chapterId: 1, currentSec: 10, updatedAt: at } });
    expect(buildContinueListening([b])).toHaveLength(0);
  });

  it('excludes an explicitly-finished book even with plenty of time remaining', () => {
    const b = book({ resume: { chapterId: 1, currentSec: 60, updatedAt: at }, finished: true });
    expect(buildContinueListening([b])).toHaveLength(0);
  });

  it('excludes a hidden book', () => {
    const b = book({ resume: { chapterId: 1, currentSec: 60, updatedAt: at }, hidden: true });
    expect(buildContinueListening([b])).toHaveLength(0);
  });
});

describe('buildLibraryStats — finished accounting (fs-15 shelf controls)', () => {
  it('counts an explicitly-finished book as finished', () => {
    const b = book({ resume: { chapterId: 1, currentSec: 60, updatedAt: at }, finished: true });
    const stats = buildLibraryStats([b]);
    expect(stats.booksFinished).toBe(1);
    expect(stats.perBook.find((p) => p.bookId === 'b1')?.finished).toBe(true);
  });

  it('does NOT count a merely-hidden book as finished', () => {
    const b = book({ resume: { chapterId: 1, currentSec: 60, updatedAt: at }, hidden: true });
    const stats = buildLibraryStats([b]);
    expect(stats.booksFinished).toBe(0);
    expect(stats.perBook.find((p) => p.bookId === 'b1')?.finished).toBe(false);
  });

  it('counts an effectively-complete book as finished without an explicit flag', () => {
    const chapters: Ch[] = [{ id: 1, duration: '00:30:00' }, { id: 2 }];
    const b = book({ chapters, resume: { chapterId: 2, currentSec: 10, updatedAt: at } });
    expect(buildLibraryStats([b]).booksFinished).toBe(1);
  });

  it('does NOT count a no-audio book as finished', () => {
    const chapters: Ch[] = [{ id: 1 }, { id: 2 }];
    const b = book({ chapters, resume: { chapterId: 1, currentSec: 10, updatedAt: at } });
    expect(buildLibraryStats([b]).booksFinished).toBe(0);
  });
});

describe('isFinished — explicit flag (fs-15 shelf controls)', () => {
  it('short-circuits true for an explicitly-finished book regardless of position', () => {
    expect(isFinished([{ id: 1, duration: '00:30:00' }], { chapterId: 1, currentSec: 5, updatedAt: at }, true)).toBe(true);
  });

  it('stays false for a no-audio book that is not explicitly finished', () => {
    expect(isFinished([{ id: 1 }], { chapterId: 1, currentSec: 10, updatedAt: at })).toBe(false);
  });
});
