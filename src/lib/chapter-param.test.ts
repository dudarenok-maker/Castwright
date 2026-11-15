import { describe, expect, it } from 'vitest';
import { parseChapterParam } from './chapter-param';

describe('parseChapterParam', () => {
  it.each<[string | null, number | null]>([
    [null, null],
    ['', null],
    ['abc', null],
    ['3', 3],
    ['08', 8],
    ['5abc', 5],
    ['-1', -1],
    ['0', 0],
    ['-0', -0],
  ])('%j -> %j', (raw, expected) => {
    expect(parseChapterParam(raw)).toEqual(expected);
  });
});
