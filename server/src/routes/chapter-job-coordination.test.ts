import { afterEach, describe, expect, it } from 'vitest';
import { isSpliceOrRepairActive, registerSplice } from './chapter-job-coordination.js';

describe('isSpliceOrRepairActive (#4235)', () => {
  const cleanups: Array<() => void> = [];
  const reg = (bookId: string, chapterId: number): (() => void) => {
    const c = registerSplice(bookId, chapterId, new AbortController());
    cleanups.push(c);
    return c;
  };

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('is false with nothing registered', () => {
    expect(isSpliceOrRepairActive('b1')).toBe(false);
  });

  it('is true after a splice registers for the book', () => {
    reg('b1', 3);
    expect(isSpliceOrRepairActive('b1')).toBe(true);
  });

  it('stays true while another chapter is still registered', () => {
    const c3 = reg('b1', 3);
    reg('b1', 4);
    c3();
    expect(isSpliceOrRepairActive('b1')).toBe(true);
  });

  it('is false after the last cleanup runs', () => {
    const c3 = reg('b1', 3);
    const c4 = reg('b1', 4);
    c3();
    c4();
    expect(isSpliceOrRepairActive('b1')).toBe(false);
  });

  it('does not match a different book sharing an id prefix (book-1 vs book-10)', () => {
    reg('book-10', 1);
    expect(isSpliceOrRepairActive('book-1')).toBe(false);
    expect(isSpliceOrRepairActive('book-10')).toBe(true);
  });

  it('a displaced splice leaves it true until the second one cleans up', () => {
    const first = reg('b1', 3);
    const second = reg('b1', 3);
    first(); // displaced holder: cleanup is a no-op
    expect(isSpliceOrRepairActive('b1')).toBe(true);
    second();
    expect(isSpliceOrRepairActive('b1')).toBe(false);
  });
});
