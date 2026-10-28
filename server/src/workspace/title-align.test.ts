import { describe, it, expect } from 'vitest';
import { parseIndexByBody } from './title-align.js';

describe('parseIndexByBody (#3828)', () => {
  it('pairs a body with the parse chapter that holds it, wherever that sits', () => {
    expect(parseIndexByBody(['B', 'A'], ['A', 'B'])).toEqual([1, 0]);
  });

  it('is null for a body no parse chapter holds (a merge or split result)', () => {
    expect(parseIndexByBody(['A\n\nB', 'C'], ['A', 'B', 'C'])).toEqual([null, 2]);
  });

  it('is null when several parse chapters hold the same body', () => {
    expect(parseIndexByBody(['X', 'A'], ['X', 'A', 'X'])).toEqual([null, 1]);
  });

  it('is null for a chapter with no body, and compares exactly (no trimming)', () => {
    expect(parseIndexByBody([undefined, 'A '], ['A'])).toEqual([null, null]);
  });
});
