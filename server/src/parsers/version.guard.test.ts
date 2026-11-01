/* #3837 (M17) - the book-state GET tripwire for the parser version.

   WHY: `routes/book-state.ts`'s GET runs `refreshChapterTitles`, which pairs a
   no-hints book's chapters with a fresh parse BY POSITION whenever
   `chapterTitleParserVersion` is stale. Bumping `CHAPTER_TITLE_PARSER_VERSION`
   would therefore re-title a pre-#3703 reordered analysed book by position -
   the very mispairing plan 290's `checkParseHintsPairing` refuses everywhere
   else. That refresh is out of scope for #3837, so this guard pins it: the
   version stays at 2, OR `refreshChapterTitles` in book-state.ts must make a
   real `checkParseHintsPairing(` call (not one quoted in a comment or string,
   and not one elsewhere in the file).

   If this fails after a version bump, wire the pairing check into
   `refreshChapterTitles` before bumping - see
   docs/features/archive/290-parse-fallback-hints-proof.md (M17). */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAPTER_TITLE_PARSER_VERSION } from './version.js';
import { PARSER_VERSION_GUARD_SCAN_GLOB } from './version.guard-targets.js';
import { computeAstOpaqueRanges, isOpaque } from '../test-utils/guard-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The repo-relative scan target, declared once in version.guard-targets.ts so
    the scoped-CI trigger in vitest.config.ts cannot drift from it. */
const BOOK_STATE = join(__dirname, '..', '..', '..', PARSER_VERSION_GUARD_SCAN_GLOB);

/* The opaque-range tokenizer now lives in server/src/test-utils/guard-scan.ts (#3685). */

/** `source` with every opaque range (comment, string, template, regex) blanked. */
function codeOnly(source: string): string {
  const opaque = computeAstOpaqueRanges(source);
  let out = '';
  for (let i = 0; i < source.length; i++) out += isOpaque(opaque, i) ? ' ' : source[i];
  return out;
}

/** The span of `refreshChapterTitles` in `code` (already masked by `codeOnly`):
    from `function refreshChapterTitles` to its body's matching closing brace,
    or null when there is no such function. The body's `{` is the first one
    after the parameter list that is not inside a `<...>` (a return type such
    as `Promise<{ a: string }>`). */
function refreshChapterTitlesSpan(code: string): string | null {
  const head = /\bfunction\s+refreshChapterTitles\s*\(/.exec(code);
  if (!head) return null;
  let i = head.index + head[0].length;
  let parens = 1;
  for (; i < code.length && parens > 0; i++) {
    if (code[i] === '(') parens++;
    else if (code[i] === ')') parens--;
  }
  let angles = 0;
  for (; i < code.length; i++) {
    const c = code[i];
    if (c === '=' && code[i + 1] === '>') i++;
    else if (c === '<') angles++;
    else if (c === '>') angles--;
    else if (c === '{' && angles === 0) break;
  }
  let braces = 0;
  for (let j = i; j < code.length; j++) {
    if (code[j] === '{') braces++;
    else if (code[j] === '}' && --braces === 0) return code.slice(head.index, j + 1);
  }
  return null;
}

/** The M17 pin, as a pure function of the version and book-state.ts's source:
    the call must sit inside `refreshChapterTitles`, not anywhere in the file. */
function pinHolds(version: number, bookStateSource: string): boolean {
  if (version === 2) return true;
  const span = refreshChapterTitlesSpan(codeOnly(bookStateSource));
  return span !== null && span.includes('checkParseHintsPairing(');
}

/** A minimal book-state.ts whose `refreshChapterTitles` body is `body`. */
const inRefresh = (body: string): string =>
  `async function refreshChapterTitles(state: S, dir: string): Promise<{ a: number }> {\n${body}\n}\n`;

const PIN_MESSAGE =
  'CHAPTER_TITLE_PARSER_VERSION moved off 2 but refreshChapterTitles in routes/book-state.ts makes no real ' +
  'checkParseHintsPairing( call: it would re-title a reordered analysed book ' +
  'by position. Wire the pairing check in first (#3837, docs/features/archive/290-parse-fallback-hints-proof.md, M17).';

describe('parser-version tripwire (#3837, M17)', () => {
  it('self-test: a call that appears only in a comment fails the pin', () => {
    expect(pinHolds(3, inRefresh('// TODO checkParseHintsPairing(state)\nconst x = 1;'))).toBe(false);
    expect(pinHolds(3, inRefresh('/* checkParseHintsPairing(state) */'))).toBe(false);
  });

  it('self-test: a call that appears only in a string fails the pin', () => {
    expect(pinHolds(3, inRefresh("const s = 'checkParseHintsPairing(state)';"))).toBe(false);
    expect(pinHolds(3, inRefresh('const s = `checkParseHintsPairing(${x})`;'))).toBe(false);
  });

  it('self-test: a real call in refreshChapterTitles passes the pin, and version 2 passes without one', () => {
    expect(pinHolds(3, inRefresh('const r = checkParseHintsPairing(state);'))).toBe(true);
    expect(pinHolds(3, inRefresh('if (state) {\n  const r = checkParseHintsPairing(state);\n}\nreturn state;'))).toBe(true);
    expect(pinHolds(3, inRefresh('if (state) {\n  touch(state);\n}\nconst r = checkParseHintsPairing(state);'))).toBe(true);
    expect(pinHolds(2, '')).toBe(true);
  });

  it('self-test: a real call elsewhere in the file, not inside refreshChapterTitles, fails the pin', () => {
    const outside = 'function other(state: S) {\n  return checkParseHintsPairing(state);\n}\n';
    expect(pinHolds(3, outside + inRefresh('return state;'))).toBe(false);
    expect(pinHolds(3, inRefresh('return state;') + outside)).toBe(false);
    expect(pinHolds(3, 'const r = checkParseHintsPairing(state);')).toBe(false);
  });

  it('CHAPTER_TITLE_PARSER_VERSION is 2, or book-state.ts really calls checkParseHintsPairing(', () => {
    expect(pinHolds(CHAPTER_TITLE_PARSER_VERSION, readFileSync(BOOK_STATE, 'utf8')), PIN_MESSAGE).toBe(true);
  });

  it('book-state.ts still has a refreshChapterTitles the scan can find', () => {
    const span = refreshChapterTitlesSpan(codeOnly(readFileSync(BOOK_STATE, 'utf8')));
    expect(span, 'refreshChapterTitles moved or was renamed: re-point this guard').not.toBeNull();
    expect(span!.trimEnd().endsWith('}')).toBe(true);
  });
});
