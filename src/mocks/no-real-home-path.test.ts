import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mock data must never carry a real home folder (#4875): it would surface in
// any capture or demo. Only obviously fake account names are allowed.
const FAKE_NAMES = new Set(['you', 'alice', 'user', 'example']);
// System / CI accounts identify no one.
const SYSTEM_ACCOUNTS = new Set(['public', 'runner', 'runneradmin']);
const isPlaceholder = (name: string) => {
  // A name can be followed by prose punctuation ("you,", "(C:\Users\you)").
  const n = name.replace(/[.,;:)\]}!?]+$/, '');
  return (
    n === '' ||
    FAKE_NAMES.has(n.toLowerCase()) ||
    SYSTEM_ACCOUNTS.has(n.toLowerCase()) ||
    /^<[^>]*>$/.test(n) ||
    n.startsWith('$')
  );
};

const SEP = String.raw`[\\/]+`;
// An account name: anything up to a separator, quote, whitespace or `&`; the
// negated class (not [A-Za-z0-9]) keeps non-ASCII names from failing open.
const NAME = String.raw`([^\\/%\s'"` + '`' + String.raw`&]+)`;
const NOT_PATH_CHAR = String.raw`(?<![\w.\-/\\])`;
const HOME_PATHS = [
  // Windows / macOS home with the capital: C:\Users\<n>, C:\\Users\\<n>, /Users/<n>
  new RegExp(`Users${SEP}${NAME}`, 'g'),
  // Case-insensitive spellings: c:\users\<n>, /c/users/<n> (Git Bash),
  // /mnt/c/users/<n> (WSL), and a bare /users/<n> at the start of a path
  // (macOS is case-insensitive). A /users/ inside a longer path (github.com/users/<x>,
  // /api/users/<x>) is not preceded by a path boundary, so it is left alone.
  new RegExp(
    `(?:[A-Za-z]:${SEP}|(?<![\\w.\\-])/(?:mnt/)?[A-Za-z]/|${NOT_PATH_CHAR}/)users${SEP}${NAME}`,
    'gi',
  ),
  // Linux home
  new RegExp(`${NOT_PATH_CHAR}/home/${NAME}`, 'g'),
];

// %XX runs decoded once, so every URL-encoded spelling (any separator case,
// any non-ASCII name) is matched by the plain-text patterns above.
function decode(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Lengths of every non-placeholder account name found in `text`. */
function realHomeNameLengths(text: string): number[] {
  const out: number[] = [];
  const decoded = decode(text);
  for (const t of decoded === text ? [text] : [text, decoded]) {
    for (const re of HOME_PATHS) {
      for (const m of t.matchAll(re)) if (!isPlaceholder(m[1])) out.push(m[1].length);
    }
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
    ['macOS, lowercase', '/users/bob/x'],
    ['macOS, uppercase', '/USERS/bob'],
    ['lowercase backslash', 'c:\\users\\bob\\x'],
    ['lowercase forward slash', 'c:/users/bob/x'],
    ['Git Bash drive-less', '/c/users/bob/x'],
    ['WSL', '/mnt/c/users/bob/x'],
    ['non-ASCII name', 'C:\\Users\\Ünal\\x'],
    ['Linux home', '/home/bob/x'],
    ['URL-encoded backslash', 'C%3A%5CUsers%5Cbob%5Cx'],
    ['URL-encoded slash', 'C%3A%2Fusers%2Fbob'],
    ['URL-encoded non-ASCII first letter', 'C%3A%5CUsers%5C%C3%9Cnal%5Cx'],
    ['lowercase-hex slash, no drive', '%2fUsers%2fbob'],
    ['lowercase-hex slash, lowercase users', '%2fusers%2fbob'],
  ])('flags %s', (_label, text) => {
    expect(realHomeNameLengths(text).length).toBeGreaterThan(0);
  });

  it.each([
    ['fake name', 'C:\\Users\\you\\x'],
    ['fake name, macOS', '/Users/alice/x'],
    ['uppercase placeholder', 'c:/users/<NAME>'],
    ['angle placeholder', 'C:\\Users\\<name>\\x'],
    ['Linux fake name', '/home/you/x'],
    ['template placeholder', '/home/${user}/x'],
    ['github users URL', 'https://github.com/users/someone/projects/1'],
    ['API route', '/api/users/someone'],
    ['fake name then comma', 'see C:\\Users\\you, then'],
    ['fake name in parens', '(C:\\Users\\you)'],
    ['fake name then period', '/home/you.'],
    ['angle placeholder then period', 'C:\\Users\\<name>.'],
    ['guard comment form', '/Users/<n>, C:\\Users\\<n>'],
    ['Windows Public', 'C:\\Users\\Public\\x'],
    ['CI runner', '/home/runner/work'],
    ['CI runneradmin', 'C:\\Users\\runneradmin\\x'],
  ])('allows %s', (_label, text) => {
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
