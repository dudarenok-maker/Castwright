import { describe, expect, it } from 'vitest';
import { stripChapterPrefix } from './format-chapter-title';

describe('stripChapterPrefix', () => {
  it('strips "Chapter N — " prefix produced by the parser subtitle merge', () => {
    expect(stripChapterPrefix('Chapter 3 — The Beginning')).toBe('The Beginning');
  });

  it('strips Roman-numeral prefixes', () => {
    expect(stripChapterPrefix('Chapter IV — The Long Tide')).toBe('The Long Tide');
  });

  it('strips word-form numbered prefixes ("Chapter Twenty-One")', () => {
    expect(stripChapterPrefix('Chapter Twenty-One — Riptide')).toBe('Riptide');
  });

  it('strips colon-separated prefixes ("Chapter 3: The Beginning")', () => {
    expect(stripChapterPrefix('Chapter 3: The Beginning')).toBe('The Beginning');
  });

  it('strips hyphen-separated prefixes', () => {
    expect(stripChapterPrefix('Chapter 3 - The Beginning')).toBe('The Beginning');
  });

  it('strips en-dash separators', () => {
    expect(stripChapterPrefix('Chapter 3 – The Beginning')).toBe('The Beginning');
  });

  it('is case-insensitive', () => {
    expect(stripChapterPrefix('CHAPTER 3 — THE BEGINNING')).toBe('THE BEGINNING');
  });

  it('returns plain titles unchanged ("The Berth at Liverpool")', () => {
    expect(stripChapterPrefix('The Berth at Liverpool')).toBe('The Berth at Liverpool');
  });

  it('returns bare "Chapter 3" unchanged (no separator → keep so the user sees something)', () => {
    expect(stripChapterPrefix('Chapter 3')).toBe('Chapter 3');
  });

  it('returns empty input verbatim', () => {
    expect(stripChapterPrefix('')).toBe('');
  });

  it('keeps the original when stripping would leave nothing (defensive)', () => {
    /* "Chapter 3 — " (trailing whitespace after dash, no title) shouldn't
       collapse to empty string. */
    expect(stripChapterPrefix('Chapter 3 — ')).toBe('Chapter 3 — ');
  });

  it('does not strip "Chapter X" appearing mid-title', () => {
    expect(stripChapterPrefix('Prologue: Chapter 3 in retrospect')).toBe('Prologue: Chapter 3 in retrospect');
  });
});
