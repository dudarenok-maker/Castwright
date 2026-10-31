// server/src/test-utils/guard-scan.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/* Unit tests for the shared guard scanner (#3685). Every case pins a behaviour
   the guard files relied on while each carried its own private copy, so drift
   in the shared module reddens HERE rather than in eight guards at once.
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
