import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock data must never carry a real home folder (#4875): it would surface in
// any capture or demo. Only obviously fake account names are allowed.
const FAKE_NAMES = new Set(['you', 'alice', 'user', 'example']);
const isPlaceholder = (name: string) =>
  FAKE_NAMES.has(name.toLowerCase()) || /^<[^>]*>$/.test(name) || name.startsWith('$');

// A path separator in any spelling: raw, repeated (JSON-escaped), or URL-encoded.
const SEP = String.raw`(?:[\\/]|%5C|%2F)+`;
// An account name: anything up to a separator, quote, whitespace or `&`; the
// negated class (not [A-Za-z0-9]) keeps non-ASCII names from failing open.
const NAME = String.raw`([^\\/%\s'"` + '`' + String.raw`&]+)`;
const HOME_PATHS = [
  // macOS / Windows home: /Users/<n>, C:\Users\<n>, C:\\Users\\<n>, Users%5C<n>
  new RegExp(`Users${SEP}${NAME}`, 'g'),
  // Windows paths are case-insensitive: c:\users\<n>, c:/users/<n>, c%3A%5Cusers%5C<n>
  new RegExp(`[A-Za-z](?::|%3A)${SEP}users${SEP}${NAME}`, 'gi'),
  // Linux home
  new RegExp(`/home/${NAME}`, 'g'),
];

/** Lengths of every non-placeholder account name found in `text`. */
function realHomeNameLengths(text: string): number[] {
  const out: number[] = [];
  for (const re of HOME_PATHS) {
    for (const m of text.matchAll(re)) if (!isPlaceholder(m[1])) out.push(m[1].length);
  }
  return out;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|json|md)$/.test(name) && !name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('home-path matcher spellings', () => {
  it.each([
    ['capital Users, backslash', 'C:\\Users\\bob\\x'],
    ['JSON-escaped backslashes', 'C:\\\\Users\\\\bob\\\\x'],
    ['forward slashes', 'C:/Users/bob/x'],
    ['macOS', '/Users/bob/x'],
    ['lowercase backslash', 'c:\\users\\bob\\x'],
    ['lowercase forward slash', 'c:/users/bob/x'],
    ['non-ASCII name', 'C:\\Users\\Ünal\\x'],
    ['Linux home', '/home/bob/x'],
    ['URL-encoded backslash', 'C%3A%5CUsers%5Cbob%5Cx'],
    ['URL-encoded slash', 'C%3A%2Fusers%2Fbob'],
  ])('flags %s', (_label, text) => {
    expect(realHomeNameLengths(text).length).toBeGreaterThan(0);
  });

  it.each([
    'C:\\Users\\you\\x',
    '/Users/alice/x',
    'c:/users/<NAME>',
    'C:\\Users\\<name>\\x',
    '/home/you/x',
    '/home/${user}/x',
    'https://github.com/users/someone/projects/1',
  ])('allows placeholder %s', (text) => {
    expect(realHomeNameLengths(text)).toEqual([]);
  });
});

describe('mock layer has no real home paths', () => {
  // Everything mock mode renders: api.ts, the mock layer, the design fixtures
  // it imports, and the e2e specs that seed it through URL seams.
  const files = [
    join(root, 'lib', 'api.ts'),
    ...walk(join(root, 'mocks')),
    ...walk(join(root, 'data')),
    ...walk(join(root, '..', 'e2e')),
  ];

  it('scans a non-empty file set that includes every root', () => {
    const posix = files.map((f) => f.replaceAll('\\', '/'));
    expect(posix.some((f) => f.endsWith('/src/lib/api.ts'))).toBe(true);
    expect(posix.some((f) => f.includes('/src/mocks/'))).toBe(true);
    expect(posix.some((f) => f.includes('/src/data/'))).toBe(true);
    expect(posix.some((f) => f.includes('/e2e/'))).toBe(true);
  });

  it('every home path uses a fake placeholder name', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const len of realHomeNameLengths(readFileSync(f, 'utf8')))
        offenders.push(`${f}: home path, name of ${len} chars`);
    }
    expect(offenders).toEqual([]);
  });
});
