/* #4336 — the canonical directory key and the unaddressed-directory set
   (spec 2026-11-13-chapter-take-lifecycle-design.md R5-7, R6-6, R7-11, R9-6). */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalDirKey,
  registerUnaddressedDir,
  releaseUnaddressedDir,
  isUnaddressedDir,
} from './book-dir-key.js';

const FOLDS = process.platform === 'win32' || process.platform === 'darwin';
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) releaseUnaddressedDir(d);
});

describe('canonicalDirKey (K1)', () => {
  const base = resolve('Library', 'Some Author', 'Book');

  it('folds case on win32 and darwin, and keeps it elsewhere', () => {
    const upper = base.toUpperCase();
    if (FOLDS) {
      expect(canonicalDirKey(upper)).toBe(canonicalDirKey(base));
      expect(canonicalDirKey(base)).toBe(canonicalDirKey(base).toLowerCase());
    } else {
      expect(canonicalDirKey(upper)).not.toBe(canonicalDirKey(base));
    }
  });

  it('writes `/` separators only', () => {
    expect(canonicalDirKey(base)).not.toContain(String.fromCharCode(92));
    if (process.platform === 'win32') {
      expect(canonicalDirKey(base.split(sep).join('/'))).toBe(canonicalDirKey(base));
    }
  });

  it('drops a trailing separator and collapses doubled ones', () => {
    expect(canonicalDirKey(`${base}${sep}`)).toBe(canonicalDirKey(base));
    expect(canonicalDirKey(`${base}/`)).toBe(canonicalDirKey(base));
    expect(canonicalDirKey(join(dirname(base), '/', '/', 'Book'))).toBe(canonicalDirKey(base));
  });
});

describe('the unaddressed-directory set', () => {
  it('registers once, refuses a second holder, and releases', () => {
    const dir = resolve('Library', 'Set', 'One');
    made.push(dir);
    expect(isUnaddressedDir(dir)).toBe(false);
    expect(registerUnaddressedDir(dir)).toBe(true);
    expect(isUnaddressedDir(dir)).toBe(true);
    expect(registerUnaddressedDir(`${dir}${sep}`)).toBe(false);
    releaseUnaddressedDir(dir);
    expect(isUnaddressedDir(dir)).toBe(false);
    expect(registerUnaddressedDir(dir)).toBe(true);
  });
});

describe('the leaf rule (R9-6)', () => {
  it('book-dir-key.ts imports node:path and nothing else', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'book-dir-key.ts'), 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const dyn = [...src.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect([...specs, ...dyn]).toEqual(['node:path']);
    expect(/^\s*export\s[^;]*\bfrom\s/m.test(src)).toBe(false);
  });
});
