// server/src/test-utils/guard-scan.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectSourceFiles,
  collectTestFiles,
  computeAstOpaqueRanges,
  computeTokenOpaqueRanges,
  findMatchingClose,
  isOpaque,
  isOpaqueInTokenRanges,
  lineOf,
  opaqueRangeAt,
} from './guard-scan.js';
import * as scanner from './guard-scan.js';

/* Unit tests for the shared guard scanner (#3685). Every case pins a behaviour
   the guard files relied on while each carried its own private copy, so drift
   in the shared module reddens HERE (the tokenizer cases below, and the
   no-private-copies block at the bottom) rather than in ten guards at once.
   Nothing writes inside the repo: the collector tests build a temp tree under
   os.tmpdir() and remove it in afterAll. */
describe('file collectors', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'guard-scan-'));
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.test.ts'), 'export const b = 1;\n');
    writeFileSync(join(root, 'c.txt'), 'not typescript\n');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'd.ts'), 'export const d = 1;\n');
    writeFileSync(join(root, 'nested', 'e.test.ts'), 'export const e = 1;\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('collectSourceFiles keeps non-test .ts files and walks nested directories', () => {
    expect(collectSourceFiles(root).sort()).toEqual(
      [join(root, 'a.ts'), join(root, 'nested', 'd.ts')].sort(),
    );
  });

  it('collectSourceFiles ignores non-.ts files and *.test.ts files', () => {
    const files = collectSourceFiles(root);
    expect(files).not.toContain(join(root, 'b.test.ts'));
    expect(files).not.toContain(join(root, 'nested', 'e.test.ts'));
    expect(files).not.toContain(join(root, 'c.txt'));
  });

  it('collectTestFiles is the complement: *.test.ts files only, nested included', () => {
    expect(collectTestFiles(root).sort()).toEqual(
      [join(root, 'b.test.ts'), join(root, 'nested', 'e.test.ts')].sort(),
    );
  });

  it('collectSourceFiles throws on a missing directory', () => {
    expect(() => collectSourceFiles(join(root, 'missing'))).toThrow();
  });

  it('collectTestFiles throws on a missing directory', () => {
    expect(() => collectTestFiles(join(root, 'missing'))).toThrow();
  });
});

describe('AST opaque ranges', () => {
  it('a regex literal holding a quote does not desync the tokenizer', () => {
    const src = "const re = /[\"'\\s]/;\nconst s = 'live';\n";
    const opaque = computeAstOpaqueRanges(src);
    // The regex literal itself is opaque...
    expect(isOpaque(opaque, src.indexOf('/["'))).toBe(true);
    // ...and the quote INSIDE it must not open a bogus string range: the later
    // real string is still opaque on its own, and the code between is live.
    expect(isOpaque(opaque, src.indexOf("'live'"))).toBe(true);
    expect(isOpaque(opaque, src.indexOf('const s'))).toBe(false);
  });

  it('a nested template literal is handled and a ${...} slot stays live code', () => {
    const src = 'const t = `a${`inner${x}`}b`;\n';
    const opaque = computeAstOpaqueRanges(src);
    expect(isOpaque(opaque, src.indexOf('`a'))).toBe(true);
    expect(isOpaque(opaque, src.indexOf('inner'))).toBe(true);
    expect(isOpaque(opaque, src.lastIndexOf('b'))).toBe(true);
    // The interpolation expression is not part of any literal chunk.
    expect(isOpaque(opaque, src.indexOf('x'))).toBe(false);
  });

  it('a comment that is the last line of a block is opaque', () => {
    const src = 'try {\n  something();\n  // historical: this used to be a nested call {\n}\n';
    const opaque = computeAstOpaqueRanges(src);
    expect(isOpaque(opaque, src.indexOf('// historical'))).toBe(true);
  });

  it('an end-of-line comment is opaque and the next line is live code', () => {
    const src = 'foo(); // withCastLock(\nbar();\n';
    const opaque = computeAstOpaqueRanges(src);
    expect(isOpaque(opaque, src.indexOf('// withCastLock('))).toBe(true);
    expect(isOpaque(opaque, src.indexOf('withCastLock('))).toBe(true);
    expect(isOpaque(opaque, src.indexOf('foo'))).toBe(false);
    expect(isOpaque(opaque, src.indexOf('bar'))).toBe(false);
  });

  it('an own-line comment before a literal is opaque and the surrounding code is live', () => {
    const src = "f(\n  // withCastLock(\n  'x',\n);\n";
    const opaque = computeAstOpaqueRanges(src);
    expect(isOpaque(opaque, src.indexOf('// withCastLock('))).toBe(true);
    expect(isOpaque(opaque, src.indexOf('withCastLock('))).toBe(true);
    expect(isOpaque(opaque, src.indexOf('f('))).toBe(false);
    expect(isOpaque(opaque, src.indexOf(');'))).toBe(false);
  });

  it('comments and literals in one file merge into ascending disjoint ranges', () => {
    const src = "a(); // one\nb('two'); /* three */\n// four\nc();\n";
    const opaque = computeAstOpaqueRanges(src);
    for (let i = 1; i < opaque.length; i++) {
      expect(opaque[i].start).toBeGreaterThan(opaque[i - 1].end - 1);
    }
    for (const word of ['one', 'two', 'three', 'four']) {
      expect(isOpaque(opaque, src.indexOf(word))).toBe(true);
    }
    for (const word of ['a()', 'b(', 'c()']) {
      expect(isOpaque(opaque, src.indexOf(word))).toBe(false);
    }
  });

  it('string content is opaque, surrounding code is not', () => {
    const src = "const s = 'not code';\n";
    const opaque = computeAstOpaqueRanges(src);
    expect(isOpaque(opaque, src.indexOf('not code'))).toBe(true);
    expect(isOpaque(opaque, src.indexOf('const s'))).toBe(false);
  });
});

describe('findMatchingClose and lineOf', () => {
  it('findMatchingClose skips opaque brackets and tracks nesting depth', () => {
    const src = "outer( inner( '))' ) )";
    const opaque = computeAstOpaqueRanges(src);
    const open = src.indexOf('outer(') + 'outer('.length - 1;
    const close = findMatchingClose(src, opaque, open, '(', ')');
    // The '))' inside the string literal must not count: the match is the
    // FINAL paren, not either of the string's.
    expect(close).toBe(src.length - 1);
  });

  it('findMatchingClose returns -1 when the bracket never closes', () => {
    const src = 'outer( inner( ';
    const opaque = computeAstOpaqueRanges(src);
    expect(findMatchingClose(src, opaque, src.indexOf('('), '(', ')')).toBe(-1);
  });

  it('lineOf is 1-based', () => {
    const src = 'a\nb\nc';
    expect(lineOf(src, 0)).toBe(1);
    expect(lineOf(src, 1)).toBe(1);
    expect(lineOf(src, 2)).toBe(2);
    expect(lineOf(src, 4)).toBe(3);
  });
});

describe('token-skipping opaque ranges', () => {
  it('a backslash-escaped quote does not end the string early', () => {
    const src = "x = 'a\\'b'; y = 1";
    const ranges = computeTokenOpaqueRanges(src);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('b'))).toBe(true);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('y'))).toBe(false);
  });

  it('a backtick string is opaque and holds a foreign quote', () => {
    const src = "x = `it's`; y = 1";
    const ranges = computeTokenOpaqueRanges(src);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('s`'))).toBe(true);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('y'))).toBe(false);
  });

  it('the character just past a block comment close is live code', () => {
    const src = '/* c */y = 1';
    const ranges = computeTokenOpaqueRanges(src);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('c'))).toBe(true);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('y'))).toBe(false);
  });

  it('blankOutOpaque blanks opaque spans, keeping length and newlines', () => {
    const src = "a('x'); // c\nb(/* d\ne */);";
    const out = scanner.blankOutOpaque(src);
    const sp = (n: number): string => ' '.repeat(n);
    expect(out).toHaveLength(src.length);
    expect(out).toBe(`a(${sp(3)});${sp(5)}\nb(${sp(4)}\n${sp(4)});`);
  });

  it('strings, line comments and block comments are all opaque; code is not', () => {
    const src = "x = 'str'; // line\n/* block */ y = 1";
    const ranges = computeTokenOpaqueRanges(src);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('str'))).toBe(true);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('line'))).toBe(true);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('block'))).toBe(true);
    expect(isOpaqueInTokenRanges(ranges, src.indexOf('y = 1'))).toBe(false);
  });

  it('isOpaqueInTokenRanges and opaqueRangeAt agree at a range boundary', () => {
    const src = "before 'opaque' after";
    const ranges = computeTokenOpaqueRanges(src);
    const start = src.indexOf("'opaque'");
    const end = opaqueRangeAt(ranges, start)?.end;
    expect(end).toBeDefined();
    // At the range's start: both agree it is opaque...
    expect(isOpaqueInTokenRanges(ranges, start)).toBe(true);
    expect(opaqueRangeAt(ranges, start)?.start).toBe(start);
    // ...and just past its end: both agree it is live code.
    expect(isOpaqueInTokenRanges(ranges, end ?? -1)).toBe(false);
    expect(opaqueRangeAt(ranges, end ?? -1)).toBeUndefined();
  });
});

/* Replaces the five retired byte-identical drift tests (#3685). Those compared
   per-guard copies of the tokenizer; the copies are gone, so the failure they
   guarded against is a guard growing a PRIVATE scanner again. Parsed, not
   regexed: guards quote these names in comments. The banned names are every
   runtime export of guard-scan.ts (so a new export is covered the moment it
   lands) plus the names a retired private copy went by.

   BLIND SPOTS, stated rather than implied: the match is by declared NAME, at
   any depth, for function declarations and variable declarations only. A copy
   under a RENAMED identifier, an object-literal method, or a class method
   passes - widening to match shapes was declined. */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // server/src
const RETIRED_SCANNER_ALIASES = ['computeOpaqueRanges', 'collectTsFiles', 'opaqueRangesFor', 'opaqueCache'];
const SHARED_SCANNER_NAMES = new Set([...Object.keys(scanner), ...RETIRED_SCANNER_ALIASES]);

/** A guard file is `*.guard.test.ts` or `*-guard.test.ts`. */
function isGuardFile(file: string): boolean {
  return file.endsWith('.guard.test.ts') || file.endsWith('-guard.test.ts');
}

/** `<relative file>: <name>` for each declaration at ANY depth (a function
    declaration, or a variable bound to anything) in `root`'s guard files that
    re-declares a shared scanner helper. */
function privateScannerCopies(root: string): { scanned: number; offenders: string[] } {
  const guards = collectTestFiles(root).filter(isGuardFile);
  const offenders: string[] = [];
  for (const file of guards) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const rel = relative(root, file).split(sep).join('/');
    const visit = (node: ts.Node): void => {
      let name: string | undefined;
      if (ts.isFunctionDeclaration(node) && node.name) name = node.name.text;
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) name = node.name.text;
      if (name && SHARED_SCANNER_NAMES.has(name)) offenders.push(`${rel}: ${name}`);
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { scanned: guards.length, offenders };
}

describe('guards share the scanner (no private copies)', () => {
  it('no guard file declares a copy of a shared scanner helper, at any depth', () => {
    const { scanned, offenders } = privateScannerCopies(SRC_ROOT);
    // Floor: a broken walk must not pass by finding nothing.
    expect(scanned).toBeGreaterThanOrEqual(27);
    expect(offenders).toEqual([]);
  });

  it('the banned names cover every runtime export of guard-scan.ts and the retired aliases', () => {
    for (const name of [
      'collectSourceFiles',
      'collectTestFiles',
      'computeAstOpaqueRanges',
      'isOpaque',
      'opaqueEnd',
      'findMatchingClose',
      'lineOf',
      'skipOpaqueToken',
      'computeTokenOpaqueRanges',
      'opaqueRangeAt',
      'isOpaqueInTokenRanges',
      'astOpaqueRangesFor',
      'computeOpaqueRanges',
      'collectTsFiles',
      'blankOutOpaque',
      'opaqueRangesFor',
      'opaqueCache',
    ]) {
      expect(SHARED_SCANNER_NAMES.has(name), name).toBe(true);
    }
  });

  describe('every declaration shape goes red (temp-tree fixtures)', () => {
    const shapes: Array<[string, string, string]> = [
      ['a top-level function', 'a.guard.test.ts', 'function lineOf() { return 1; }\n'],
      [
        'a function nested in a describe',
        'b.guard.test.ts',
        "describe('x', () => {\n  function lineOf() { return 1; }\n});\n",
      ],
      ['a top-level const arrow', 'c.guard.test.ts', 'const isOpaque = () => false;\n'],
      [
        'a top-level const function expression',
        'd.guard.test.ts',
        'const opaqueEnd = function () { return -1; };\n',
      ],
      ['collectTsFiles (retired alias)', 'e.guard.test.ts', 'function collectTsFiles() {}\n'],
      ['opaqueRangeAt', 'f.guard.test.ts', 'function opaqueRangeAt() {}\n'],
      ['computeTokenOpaqueRanges', 'g.guard.test.ts', 'function computeTokenOpaqueRanges() {}\n'],
      ['isOpaqueInTokenRanges', 'h.guard.test.ts', 'function isOpaqueInTokenRanges() {}\n'],
      ['astOpaqueRangesFor', 'i.guard.test.ts', 'function astOpaqueRangesFor() {}\n'],
      ['the *-guard.test.ts spelling', 'j-guard.test.ts', 'function lineOf() { return 1; }\n'],
    ];

    for (const [label, fileName, body] of shapes) {
      it(`flags ${label}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'guard-scan-shape-'));
        try {
          writeFileSync(join(root, fileName), body);
          expect(privateScannerCopies(root).offenders).toHaveLength(1);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }

    it('does not flag a non-guard test file or an unrelated name', () => {
      const root = mkdtempSync(join(tmpdir(), 'guard-scan-shape-'));
      try {
        writeFileSync(join(root, 'plain.test.ts'), 'function lineOf() { return 1; }\n');
        writeFileSync(join(root, 'ok.guard.test.ts'), 'function helper() { return 1; }\n');
        expect(privateScannerCopies(root).offenders).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
