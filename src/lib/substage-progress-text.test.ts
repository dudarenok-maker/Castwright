import { describe, it, expect } from 'vitest';
import { formatChapterCount, formatEtaClause, formatSubstageDetail } from './substage-progress-text';

describe('formatChapterCount', () => {
  it('formats a multi-chapter position', () => {
    expect(formatChapterCount(3, 12)).toBe('Chapter 3 of 12');
  });
  it('returns null for a single-chapter pass', () => {
    expect(formatChapterCount(1, 1)).toBeNull();
  });
  it('returns null when either field is missing', () => {
    expect(formatChapterCount(undefined, 12)).toBeNull();
    expect(formatChapterCount(3, undefined)).toBeNull();
  });
});

describe('formatEtaClause', () => {
  it('returns null when no estimate exists', () => {
    expect(formatEtaClause(undefined)).toBeNull();
  });
  it('renders under a minute as "less than a minute left"', () => {
    expect(formatEtaClause(0)).toBe('less than a minute left');
    expect(formatEtaClause(59_000)).toBe('less than a minute left');
  });
  it('renders minutes', () => {
    expect(formatEtaClause(60_000)).toBe('~1m left');
    expect(formatEtaClause(125_000)).toBe('~2m left');
  });
  it('renders hours and minutes', () => {
    expect(formatEtaClause(3_600_000)).toBe('~1h left');
    expect(formatEtaClause(3_900_000)).toBe('~1h 5m left');
  });
});

describe('formatSubstageDetail', () => {
  it('joins both clauses with a middle dot', () => {
    expect(formatSubstageDetail({ chapterIndex: 3, totalChapters: 12, estRemainingMs: 125_000 })).toBe(
      'Chapter 3 of 12 · ~2m left',
    );
  });
  it('omits the missing clause', () => {
    expect(formatSubstageDetail({ chapterIndex: 1, totalChapters: 12 })).toBe('Chapter 1 of 12');
    expect(formatSubstageDetail({ estRemainingMs: 30_000 })).toBe('less than a minute left');
  });
  it('returns null when nothing is available', () => {
    expect(formatSubstageDetail({})).toBeNull();
    expect(formatSubstageDetail({ chapterIndex: 1, totalChapters: 1 })).toBeNull();
  });
});
