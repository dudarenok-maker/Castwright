/*
 * Shared source-tree scanner for the repo's static guard tests (#3625, #3685).
 * One home for helpers each guard file used to carry a private copy of. No
 * guard's behaviour changes: every guard keeps finding exactly what it found
 * before.
 *
 * THREE KINDS OF USER, and TWO TOKENIZER FAMILIES that must stay separate
 * because they find different things on comment and regex edge cases - a
 * guard keeps the family it was written and verified against; moving one
 * across would change what it detects.
 *
 *   - AST family (`computeAstOpaqueRanges` and friends): book-op-lock,
 *     cast-lock, state-json-lock, state-json-read and voice-library-write-seam
 *     (under `server/src/workspace/`), plus `server/src/parsers/version.guard.test.ts`.
 *     Built on the TypeScript parser; the block header below records why the
 *     hand-rolled walker it replaced was removed.
 *   - Token-skipping family (`skipOpaqueToken`, `computeTokenOpaqueRanges`,
 *     `isOpaqueInTokenRanges`, `opaqueRangeAt`): state-language and
 *     state-fixture-language. A quote-to-quote walker that does NOT understand
 *     regex literals or nested templates; kept as-is because migrating those
 *     two guards would change what they detect.
 *   - File collector only: state-lock, and
 *     `server/src/store/cast-history-threading.guard.test.ts` (`collectSourceFiles`).
 *     Neither uses a shared tokenizer; cast-history-threading carries its own
 *     comment/string blanker (`blankOutOpaque`), which
 *     `routes/generation-cast-history-seq.guard.test.ts` copies - deliberately
 *     not shared, so neither guard's matching changes.
 *
 * This is a non-test file under `server/src/**`, so every tree-scanning guard
 * scans it too. It therefore contains no write-primitive text outside a
 * comment, string or regex; keep it that way.
 *
 * OUT-OF-TREE CENSUS HARNESSES: the repo owner decided on 2026-10-31, in
 * #3685, to share this tokenizer instead of keeping one copy per guard file.
 * Any harness that used to transpile a single guard standalone and read
 * `computeOpaqueRanges` / `isOpaque` from its module scope must now load this
 * module instead (the AST entry point is named `computeAstOpaqueRanges`).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

/** Every non-test `.ts` file under `dir`, recursively. */
export function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every `*.test.ts` file under `dir`, recursively — the complement of
    `collectSourceFiles`. */
export function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/* ===== AST OPAQUE-RANGE TOKENIZER ============================================
   WHAT IT IS FOR: the AST-family guards scan raw source text for a write primitive and
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
export interface OpaqueRange {
  start: number;
  end: number;
}

/** Every [start, end) span of `content` that is a string / template-chunk /
    regex literal or a comment, sorted and merged so the spans are disjoint and
    ascending (`opaqueEnd` binary-searches them). Parses `content` ONCE - a
    caller scanning a file must compute these once and thread them through,
    never call this per match. */
export function computeAstOpaqueRanges(content: string): OpaqueRange[] {
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
export function isOpaque(ranges: OpaqueRange[], index: number): boolean {
  return opaqueEnd(ranges, index) !== -1;
}

/** The end offset of the opaque range containing `index`, or -1 when `index` is
    live code. Lets a character walker jump a literal or comment whole. */
export function opaqueEnd(ranges: OpaqueRange[], index: number): number {
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

/** `computeAstOpaqueRanges` parses the whole file, so a guard that scans every
    file more than once memoizes per content string rather than re-parsing. */
const astOpaqueCache = new Map<string, OpaqueRange[]>();
export function astOpaqueRangesFor(content: string): OpaqueRange[] {
  let ranges = astOpaqueCache.get(content);
  if (!ranges) {
    ranges = computeAstOpaqueRanges(content);
    astOpaqueCache.set(content, ranges);
  }
  return ranges;
}

/** Scan forward from `openIndex` (which must hold `openChar`) for the
    matching `closeChar`, tracking nesting depth. String/template literals and
    comments are skipped whole (via the precomputed `opaque` ranges) so a
    bracket character inside one can't desync the count. `opaque` is passed in
    rather than derived here: this is called once per lock token, and deriving
    it internally would re-parse the entire file on every call. Returns -1 if
    unmatched (malformed source). */
export function findMatchingClose(
  src: string,
  opaque: OpaqueRange[],
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let i = openIndex;
  const n = src.length;
  while (i < n) {
    const skip = opaqueEnd(opaque, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const ch = src[i];
    if (ch === openChar) {
      depth++;
      i++;
      continue;
    }
    if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

export function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/* ===== TOKEN-SKIPPING OPAQUE-RANGE TOKENIZER =================================
   The older quote-to-quote walker, used by state-language and
   state-fixture-language only. It opens a range on any quote or backtick and
   runs to the next matching one, and it knows nothing of regex literals or
   nested templates, so it can desync where the AST family does not. That is
   why it is NOT unified with the AST family above. ============================ */
/** If `src[i]` opens a string/template literal or a line/block comment, return
    the index just past its end (handling backslash escapes inside quotes, and
    the unterminated-comment case by running to EOF). Otherwise return -1.
    Shared by the two token-skipping guards (#3685). */
export function skipOpaqueToken(src: string, i: number): number {
  const n = src.length;
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === '`') {
    const quote = ch;
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === quote) {
        j++;
        break;
      }
      j++;
    }
    return j;
  }
  if (ch === '/' && src[i + 1] === '/') {
    let j = i + 2;
    while (j < n && src[j] !== '\n') j++;
    return j;
  }
  if (ch === '/' && src[i + 1] === '*') {
    let j = i + 2;
    while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
    j += 2;
    return j;
  }
  return -1;
}

/** Every [start, end) span in `content` that is a string/template literal or a
    comment, per `skipOpaqueToken`. */
export function computeTokenOpaqueRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const n = content.length;
  let i = 0;
  while (i < n) {
    const skip = skipOpaqueToken(content, i);
    if (skip !== -1) {
      ranges.push({ start: i, end: skip });
      i = skip;
      continue;
    }
    i++;
  }
  return ranges;
}

/** The range of `ranges` containing `index`, if any. */
export function opaqueRangeAt<R extends { start: number; end: number }>(
  ranges: R[],
  index: number,
): R | undefined {
  return ranges.find((r) => index >= r.start && index < r.end);
}

/** True iff `index` falls inside one of `ranges` — a string/template/comment,
    not real code. */
export function isOpaqueInTokenRanges(
  ranges: Array<{ start: number; end: number }>,
  index: number,
): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}
