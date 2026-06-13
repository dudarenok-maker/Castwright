import { describe, it, expect } from 'vitest';
import {
  parseDurationToSec, bookListenableSeconds, secondsBeforeChapter, finalListenableChapter,
} from './chapter-durations.js';

const chapters = [
  { id: 1, duration: '10:00' },
  { id: 2, duration: '5:00' },
  { id: 3, duration: '20:00' },
  { id: 4, duration: '1:00', excluded: true },
];

describe('parseDurationToSec', () => {
  it('parses mm:ss and h:mm:ss', () => {
    expect(parseDurationToSec('12:34')).toBe(754);
    expect(parseDurationToSec('1:02:03')).toBe(3723);
  });
  it('returns 0 for missing/garbage', () => {
    expect(parseDurationToSec(undefined)).toBe(0);
    expect(parseDurationToSec('--')).toBe(0);
  });
});

describe('bookListenableSeconds', () => {
  it('sums durations of non-excluded, non-held, audio-bearing chapters', () => {
    expect(bookListenableSeconds(chapters)).toBe((10 + 5 + 20) * 60);
  });
});

describe('secondsBeforeChapter', () => {
  it('sums listenable durations before the resume chapter id', () => {
    expect(secondsBeforeChapter(chapters, 3)).toBe((10 + 5) * 60);
    expect(secondsBeforeChapter(chapters, 1)).toBe(0);
  });
});

describe('finalListenableChapter', () => {
  it('returns the last non-excluded/held chapter with audio', () => {
    expect(finalListenableChapter(chapters)?.id).toBe(3);
  });
  it('returns null when none are listenable', () => {
    expect(finalListenableChapter([{ id: 1 }])).toBeNull();
  });
});
