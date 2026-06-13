import { describe, it, expect } from 'vitest';
import { currentStreak, longestStreak, last7Days } from './listen-stats-math';

const byDay = (entries: [string, number][]) => entries.map(([date, seconds]) => ({ date, seconds }));

describe('currentStreak (grace = today or yesterday)', () => {
  it('counts consecutive days ending today', () => {
    expect(currentStreak(byDay([['2026-06-11', 60], ['2026-06-12', 60], ['2026-06-13', 60]]), '2026-06-13')).toBe(3);
  });
  it('still alive if last listen was yesterday', () => {
    expect(currentStreak(byDay([['2026-06-12', 60]]), '2026-06-13')).toBe(1);
  });
  it('zero if last listen was 2+ days ago', () => {
    expect(currentStreak(byDay([['2026-06-10', 60]]), '2026-06-13')).toBe(0);
  });
  it('ignores zero-second days', () => {
    expect(currentStreak(byDay([['2026-06-12', 0], ['2026-06-13', 60]]), '2026-06-13')).toBe(1);
  });
  it('returns 0 for empty', () => {
    expect(currentStreak([], '2026-06-13')).toBe(0);
  });
});

describe('longestStreak', () => {
  it('finds the longest run with gaps', () => {
    expect(longestStreak(byDay([['2026-06-01', 1], ['2026-06-02', 1], ['2026-06-05', 1], ['2026-06-06', 1], ['2026-06-07', 1]]))).toBe(3);
  });
  it('returns 0 for empty, 1 for a single day', () => {
    expect(longestStreak([])).toBe(0);
    expect(longestStreak(byDay([['2026-06-01', 5]]))).toBe(1);
  });
});

describe('last7Days', () => {
  it('returns 7 entries ending today, zero-filled', () => {
    const out = last7Days(byDay([['2026-06-13', 300]]), '2026-06-13');
    expect(out).toHaveLength(7);
    expect(out[6]).toEqual({ date: '2026-06-13', seconds: 300 });
    expect(out[0].seconds).toBe(0);
    expect(out[0].date).toBe('2026-06-07');
  });
});
