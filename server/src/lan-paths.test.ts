import { describe, it, expect } from 'vitest';
import { collapseHomePath, expandHomePath } from './lan-paths.js';

const w = (home: string) => ({ home, platform: 'win32' as const });
const l = (home: string) => ({ home, platform: 'linux' as const });

describe('collapseHomePath (#4446)', () => {
  it('exact home -> ~', () => {
    expect(collapseHomePath('C:\\Users\\ann', w('C:\\Users\\ann'))).toBe('~');
    expect(collapseHomePath('/home/ann', l('/home/ann'))).toBe('~');
  });
  it('child on win32 with backslash', () => {
    expect(collapseHomePath('C:\\Users\\ann\\books', w('C:\\Users\\ann'))).toBe('~\\books');
  });
  it('child with / on win32 keeps original separators', () => {
    expect(collapseHomePath('C:\\Users\\ann/books/x', w('C:\\Users\\ann'))).toBe('~/books/x');
  });
  it('case-insensitive on win32', () => {
    expect(collapseHomePath('c:\\users\\ANN\\books', w('C:\\Users\\ann'))).toBe('~\\books');
  });
  it('case-sensitive on linux', () => {
    expect(collapseHomePath('/home/Ann/books', l('/home/ann'))).toBe('/home/Ann/books');
  });
  it('ann/anna boundary', () => {
    expect(collapseHomePath('C:\\Users\\anna\\x', w('C:\\Users\\ann'))).toBe('C:\\Users\\anna\\x');
    expect(collapseHomePath('/home/anna/x', l('/home/ann'))).toBe('/home/anna/x');
  });
  it('trailing separator on home', () => {
    expect(collapseHomePath('C:\\Users\\ann\\x', w('C:\\Users\\ann\\'))).toBe('~\\x');
    expect(collapseHomePath('/home/ann/x', l('/home/ann/'))).toBe('~/x');
    expect(collapseHomePath('/home/ann', l('/home/ann/'))).toBe('~');
  });
  it('backslash is not a separator on linux', () => {
    expect(collapseHomePath('/home/ann\\x', l('/home/ann'))).toBe('/home/ann\\x');
  });
  it('not under home -> unchanged', () => {
    expect(collapseHomePath('D:\\books', w('C:\\Users\\ann'))).toBe('D:\\books');
    expect(collapseHomePath('/mnt/books', l('/home/ann'))).toBe('/mnt/books');
  });
  it('empty home -> unchanged', () => {
    expect(collapseHomePath('/x/y', l(''))).toBe('/x/y');
  });
});

describe('expandHomePath (#4446)', () => {
  it('~ alone -> home', () => {
    expect(expandHomePath('~', w('C:\\Users\\ann'))).toBe('C:\\Users\\ann');
    expect(expandHomePath('~', l('/home/ann'))).toBe('/home/ann');
  });
  it('~/x on both platforms', () => {
    expect(expandHomePath('~/x', l('/home/ann'))).toBe('/home/ann/x');
    expect(expandHomePath('~/x', w('C:\\Users\\ann'))).toBe('C:\\Users\\ann/x');
  });
  it('~\\x expands on win32 only', () => {
    expect(expandHomePath('~\\x', w('C:\\Users\\ann'))).toBe('C:\\Users\\ann\\x');
    expect(expandHomePath('~\\x', l('/home/ann'))).toBe('~\\x');
  });
  it('~user/x, a~b and absolute paths are unchanged', () => {
    expect(expandHomePath('~user/x', l('/home/ann'))).toBe('~user/x');
    expect(expandHomePath('a~b', l('/home/ann'))).toBe('a~b');
    expect(expandHomePath('D:\\books', w('C:\\Users\\ann'))).toBe('D:\\books');
    expect(expandHomePath('/mnt/books', l('/home/ann'))).toBe('/mnt/books');
  });
  it('empty home -> unchanged', () => {
    expect(expandHomePath('~/x', l(''))).toBe('~/x');
  });
  it('round-trips collapseHomePath for under-home paths on both platforms', () => {
    const wp = 'C:\\Users\\ann\\Audiobooks\\Lib';
    expect(expandHomePath(collapseHomePath(wp, w('C:\\Users\\ann')), w('C:\\Users\\ann'))).toBe(wp);
    const lp = '/home/ann/Audiobooks/Lib';
    expect(expandHomePath(collapseHomePath(lp, l('/home/ann')), l('/home/ann'))).toBe(lp);
  });
});
