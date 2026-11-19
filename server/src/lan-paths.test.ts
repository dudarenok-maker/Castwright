import { describe, it, expect } from 'vitest';
import { collapseHomePath } from './lan-paths.js';

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
