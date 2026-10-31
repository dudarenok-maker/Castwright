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
import * as ts from 'typescript';
import { CHAPTER_TITLE_PARSER_VERSION } from './version.js';
import { PARSER_VERSION_GUARD_SCAN_GLOB } from './version.guard-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The repo-relative scan target, declared once in version.guard-targets.ts so
    the scoped-CI trigger in vitest.config.ts cannot drift from it. */
const BOOK_STATE = join(__dirname, '..', '..', '..', PARSER_VERSION_GUARD_SCAN_GLOB);

/* ===== SHARED OPAQUE-RANGE TOKENIZER - BEGIN =================================
   Duplicated BYTE-FOR-BYTE between
   `server/src/workspace/cast-lock.guard.test.ts` and
   `server/src/workspace/voice-library-write-seam.guard.test.ts`. A drift test in
   the latter fails the build if the two copies stop matching.

   It is duplicated rather than extracted to an imported module ON PURPOSE. The
   out-of-tree census harnesses that verify this tokenizer in both directions
   load it by transpiling a guard file standalone and reading
   `computeOpaqueRanges` / `isOpaque` out of that file's own module scope, so a
   tokenizer behind an `import` is invisible to them and the correctness
   property below becomes unmeasurable. The drift test is the enforceable
   stand-in for a shared module.

   WHAT IT IS FOR: both guards scan raw source text for a write primitive and
   must ignore a match that only appears in prose (a comment) or in data (a
   string / template / regex literal). Getting that wrong is dangerous in BOTH
   directions:
     - OVER-REACH (fails OPEN): a range that covers live code hides a real call
       site, so the guard passes on a genuine violation.
     - UNDER-REACH (fails CLOSED): a real comment left uncovered makes prose
       quoting the pattern count as a call site, reddening the guard on correct,
       unchanged code and destroying the negative control both headers
       advertise.

   WHY THE TypeScript PARSER AND NOT A HAND-ROLLED WALKER: the walker this
   replaces opened an opaque range on any `"`, `'` or backtick and ran to the
   next matching one. Two shapes desynced it, and both failed OPEN:
     1. A regex literal holding a quote - /["'\s]/ - opened a "string" at the
        quote INSIDE the character class and ran to the next quote anywhere
        later in the file.
     2. A NESTED template literal - a backtick inside a `${...}` slot - ended
        the outer range at the inner literal's OPENING backtick, leaving the
        walker permanently out of phase.
   A bare `ts.createScanner` does NOT fix (1): it cannot resolve the
   regex-vs-division ambiguity and emits a SlashToken. Only the parser knows.

   DELIBERATE SCOPE DECISION - `${...}` SLOTS ARE LIVE CODE. TemplateHead /
   TemplateMiddle / TemplateTail cover only a template's literal text chunks, so
   an expression inside an interpolation is NOT opaque and IS scanned. That is
   stricter than the walker it replaces, which skipped a template whole and so
   hid any real call site written inside a `${...}`.

   COMMENTS come from token trivia, not a text scan, because a `//` inside a
   string literal is not a comment. The walk descends through
   `node.getChildren(sf)` to the LEAF TOKENS and asks each leaf for its leading
   and trailing comment ranges, de-duplicated by span since one comment is
   reachable from two directions.

   WHY LEAF TOKENS AND NOT `ts.forEachChild` - this cost 276 uncovered comments.
   `forEachChild` yields only syntactically significant child NODES; it never
   yields punctuation tokens (`}`, `]`, `,`). Every comment in a file is the
   LEADING trivia of exactly one token, or the TRAILING trivia of the token
   before it on the same line - and `getTrailingCommentRanges` stops at the
   first newline. So a comment on its own line whose next token is punctuation
   belonged to a token `forEachChild` never visits, and nobody asked for it. The
   commonest shape there is is a comment as the last line of a block:

       try {
         something();
         // historical: this used to be withCastLock(dir, async () => {
       }

   Measured with a token-descent oracle, that left 276 comments across 79 of
   `server/src`'s 427 non-test files uncovered - `config/registry.ts` alone had
   92 - and it broke both guards in BOTH directions named above: prose quoting
   an unbalanced `withCastLock(dir, async () => {` in that position fabricated a
   lock range over a genuinely unlocked write (fails OPEN), and prose quoting a
   write primitive in that position counted as a real call site (fails CLOSED).
   `getChildren` DOES yield punctuation, so descending it to the leaves reaches
   every token and therefore every comment. It costs more - `getChildren`
   materialises a token array per node - which is why callers memoize the
   ranges per file content rather than recomputing them per match.

   LITERALS still come from the AST node kinds, NOT from the token stream: the
   parser is what resolves the regex-vs-division ambiguity (see (1) above), and
   a leaf-token walk that trusted a raw scanner would reintroduce it.
   ============================================================================ */
interface OpaqueRange {
  start: number;
  end: number;
}

/** Every [start, end) span of `content` that is a string / template-chunk /
    regex literal or a comment, sorted and merged so the spans are disjoint and
    ascending (`opaqueEnd` binary-searches them). Parses `content` ONCE - a
    caller scanning a file must compute these once and thread them through,
    never call this per match. */
function computeOpaqueRanges(content: string): OpaqueRange[] {
  const sf = ts.createSourceFile('guard-scan.ts', content, ts.ScriptTarget.Latest, true);
  const raw: OpaqueRange[] = [];
  const seenComments = new Set<string>();

  const addComment = (range: ts.CommentRange): void => {
    const key = `${range.pos}:${range.end}`;
    if (seenComments.has(key)) return;
    seenComments.add(key);
    raw.push({ start: range.pos, end: range.end });
  };

  const visit = (node: ts.Node): void => {
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        raw.push({ start: node.getStart(sf), end: node.getEnd() });
        break;
      default:
        break;
    }
    const children = node.getChildren(sf);
    if (children.length === 0) {
      /* A LEAF TOKEN - punctuation included, which is the whole point (see the
         block header). Asking only the leaves is sufficient AND cheaper than
         asking every node: a comment is always the leading trivia of some token
         or the trailing trivia of the token before it, and an interior node's
         `pos`/`end` coincide with its first/last leaf's anyway, so an interior
         node can never contribute a range a leaf does not. */
      for (const range of ts.getLeadingCommentRanges(content, node.pos) ?? []) addComment(range);
      for (const range of ts.getTrailingCommentRanges(content, node.end) ?? []) addComment(range);
      return;
    }
    for (const child of children) visit(child);
  };

  visit(sf);
  for (const range of ts.getLeadingCommentRanges(content, 0) ?? []) addComment(range);

  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: OpaqueRange[] = [];
  for (const range of raw) {
    const last = merged[merged.length - 1];
    // `>=` merges touching spans too. That adds no characters to the union, so
    // it cannot over-reach onto live code.
    if (last && last.end >= range.start) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

/** True iff `index` sits inside one of `ranges` - inside a literal or a
    comment, not real code. */
function isOpaque(ranges: OpaqueRange[], index: number): boolean {
  return opaqueEnd(ranges, index) !== -1;
}

/** The end offset of the opaque range containing `index`, or -1 when `index` is
    live code. Lets a character walker jump a literal or comment whole. */
function opaqueEnd(ranges: OpaqueRange[], index: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid];
    if (index < range.start) hi = mid - 1;
    else if (index >= range.end) lo = mid + 1;
    else return range.end;
  }
  return -1;
}
/* ===== SHARED OPAQUE-RANGE TOKENIZER - END =================================== */

/** `source` with every opaque range (comment, string, template, regex) blanked. */
function codeOnly(source: string): string {
  const opaque = computeOpaqueRanges(source);
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

  it('the opaque-range tokenizer is byte-identical to cast-lock.guard.test.ts', () => {
    const BEGIN = '/* ===== SHARED OPAQUE-RANGE TOKENIZER - ' + 'BEGIN';
    const END = '/* ===== SHARED OPAQUE-RANGE TOKENIZER - ' + 'END';
    const siblingPath = join(__dirname, '..', 'workspace', 'cast-lock.guard.test.ts');
    const extract = (path: string): string => {
      const text = readFileSync(path, 'utf8');
      const from = text.indexOf(BEGIN);
      const to = text.indexOf(END);
      expect(from, `${path}: missing tokenizer BEGIN sentinel`).toBeGreaterThanOrEqual(0);
      expect(to, `${path}: missing tokenizer END sentinel`).toBeGreaterThan(from);
      return text.slice(from, text.indexOf('*/', to) + 2);
    };
    expect(() => readFileSync(siblingPath, 'utf8'), `${siblingPath} must exist`).not.toThrow();
    const mine = extract(fileURLToPath(import.meta.url));
    const sibling = extract(siblingPath);
    expect(mine.length).toBeGreaterThan(1000);
    expect(sibling).toBe(mine);
  });
});
