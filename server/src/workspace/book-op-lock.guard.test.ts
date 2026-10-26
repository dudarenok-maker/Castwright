/* #3711 — the static guard that stops the per-book operation-lock invariant
   rotting (`withBookOp*` / `runBookJob`, `workspace/book-op-lock.ts` +
   `workspace/book-jobs.ts`; design of record docs/features/288-book-op-lock.md
   "Guard"). Mirrors `state-json-lock.guard.test.ts` (same syntactic approach,
   same opaque-range tokenizer, same file-AND-count keyed allowlist, same blind
   spots).

   WHAT IT CHECKS (walks every non-test `.ts` file under `server/src`):
     G1 MOVERS      outside `book-op-lock.ts`, a `rename(` / `renameWithRetry(` /
                    `rm(` / `rmdir(` / `cp(` whose first argument is `bookDir`,
                    `located.bookDir`, `book.bookDir`, `dir` or
                    `old(Series|Author)Dir` -- only the sanctioned movers
                    (`moveBookFolder` / `removeBookFolder`) may relocate or delete
                    a book folder.
     G2 HANDLERS    every guarded route handler contains `withBookOp(`,
                    `withBookOps(` or `runBookJob(`. Guarded = POST/PUT/PATCH/DELETE
                    under `/:bookId…` or `/:id/analysis…`, `GET /:bookId/export/
                    portable`, and the enumerated workspace-level writers. Also:
                    inside a `withBookOp*` callback, `runBookJob(`,
                    `withDesignLock(` and `withLibraryVoiceLock(` are FORBIDDEN
                    (lock order design -> library-voice -> book-op; a job takes
                    book-op itself).
     G3a RESOLVE    in a guarded handler, no `findBookByBookId(` /
                    `findBookByManuscriptId(` outside a `withBookOp*` / `runBookJob`
                    callback (`peekBook(` is the sanctioned pre-lock resolve).
     G3b LOOPS      in the four series-walking files, no `findBookByBookId(`
                    inside a `for` / `while` body (siblings resolve through the
                    step's handle).
     G4 MULTI-BOOK  every `withCastLocks(` sits inside a `withBookOps(` callback;
                    in `voices.ts` / `voice-library-usage.ts` every `withCastLock(`
                    sits inside a `withBookOp(` callback, except the permanent
                    `onlyBookDir` branch (count 1).
     G5 LONG JOBS   each long-job file carries at least its declared count of
                    `runBookJob(` tokens, and `runBookJob` stays the ONLY
                    registration function (`__addBookJobToken` is referenced only
                    by `book-jobs.ts`).

   ALLOWLISTS are keyed on FILE AND COUNT, both directions (a file that scans
   clean must not be listed; a count that drifts either way fails). The
   allowlist holds only `no-book-write` / `cross-book-walker` / `job-lease` (G2) and the
   permanent `onlyBookDir` exemption (G4); `ALLOW_PENDING` is false, so a
   `pending:T<n>` entry (the reason used while #3711 was converting sites) fails.

   G2 also forbids a nested `withBookOp(` / `withBookOps(` inside a `withBookOp*`
   callback (re-entry on the same id times out at 10s; two books go through ONE
   `withBookOps`).

   BLIND SPOTS (covered by tests and the review catalogue, not the guard):
     - G1 keys on the FIRST-ARGUMENT IDENTIFIER only: `rm(stagingDir, …)` /
       `rename(someAlias, …)` over a variable that holds a book folder is
       invisible, as is a book folder reached through a helper;
     - aliased imports or re-exports;
     - a captured `bookDir` used after a callback returns;
     - a new long job in a file G5 doesn't list;
     - an un-awaited book-writing child left outside `done`;
     - a writer reached through a helper (call-graph-blind);
     - a GET handler that writes: G2 scans only non-GET routes (plus the export /
       portable GETs), so e.g. `GET /:bookId/state`'s `updateStateJsonLocked`
       migration write is unguarded (safe today only because an absent state.json
       is skipped, not written);
     - a quick op misclassified as `no-book-write` or `job-lease`;
     - the right lock with the wrong id;
     - a `peekBook` result fed into a write.
   Lock IDENTITY is never checked, only PRESENCE. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

/** Every non-test `.ts` file under `server/src`, recursively. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
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

/** Scan forward from `openIndex` (which must hold `openChar`) for the
    matching `closeChar`, tracking nesting depth. String/template literals and
    comments are skipped whole (via the precomputed `opaque` ranges) so a
    bracket character inside one can't desync the count. `opaque` is passed in
    rather than derived here: this is called once per lock token, and deriving
    it internally would re-parse the entire file on every call. Returns -1 if
    unmatched (malformed source). */
function findMatchingClose(
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
function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

interface Span {
  start: number;
  end: number;
}

/** Non-opaque match indexes of `re` (must carry the `g` flag). */
function tokenIndexes(content: string, opaque: OpaqueRange[], re: RegExp): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (!isOpaque(opaque, m.index)) out.push(m.index);
  }
  return out;
}

/** The [token start, matching close paren] span of every non-opaque call whose
    match (of `re`) ends in `(`. */
function callSpans(content: string, opaque: OpaqueRange[], re: RegExp): Span[] {
  const spans: Span[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (isOpaque(opaque, m.index)) continue; // prose / a string quoting the token
    const open = m.index + m[0].length - 1;
    const close = findMatchingClose(content, opaque, open, '(', ')');
    if (close === -1) continue; // malformed source
    spans.push({ start: m.index, end: close });
  }
  return spans;
}

function inAny(spans: Span[], index: number): boolean {
  return spans.some((s) => index >= s.start && index <= s.end);
}

/* `(?<!function\s)` skips a declaration; whitespace-tolerant between the paren
   and the argument so a Prettier-wrapped call is still seen. */
const BOOK_OP_RE = /(?<!function\s)\bwithBookOp\(/g;
const BOOK_OPS_RE = /(?<!function\s)\bwithBookOps\(/g;
const BOOK_OP_ANY_RE = /(?<!function\s)\bwithBookOps?\(/g;
const BOOK_OP_OR_JOB_RE = /(?<!function\s)\b(?:withBookOps?|runBookJob)\(/g;
const FORBIDDEN_IN_BOOK_OP_RE = /\b(?:runBookJob|withDesignLock|withLibraryVoiceLock)\(/g;
const FIND_BOOK_RE = /\bfindBookBy(?:BookId|ManuscriptId)\(/g;
const FIND_BY_ID_RE = /\bfindBookByBookId\(/g;
const CAST_LOCKS_RE = /(?<!function\s)\bwithCastLocks\(/g;
const CAST_LOCK_RE = /(?<!function\s)\bwithCastLock\(/g;
const RUN_BOOK_JOB_RE = /(?<!function\s)\brunBookJob\(/g;
/* `(?![\w.$])` keeps `rm(dir.x…` / `rm(dirname(…` (a different value) from
   matching the bare `dir` / `bookDir` identifiers. */
const MOVER_RE =
  /\b(?:renameWithRetry|rename|rmdir|rm|cp)\(\s*(?:located\.bookDir|book\.bookDir|bookDir|dir|old(?:Series|Author)Dir)(?![\w.$])/g;
const ROUTE_RE = /\b\w*[Rr]outer\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`\n]*)\2/g;

/* ===== G1 ===================================================================== */

/** Files allowed to relocate / delete a book folder: the sanctioned movers. */
const MOVER_HOME = 'workspace/book-op-lock.ts';

function scanMovers(content: string): string[] {
  const opaque = computeOpaqueRanges(content);
  return tokenIndexes(content, opaque, MOVER_RE).map(
    (i) => `${content.slice(i, content.indexOf('\n', i) === -1 ? undefined : content.indexOf('\n', i)).trim()} @ line ${lineOf(content, i)}`,
  );
}

/* ===== G2 / G3a =============================================================== */

/** Workspace-level writers that are not under `/:bookId` but still write a
    book folder: `<file> <METHOD> <path>`. */
const ENUMERATED_WRITERS: ReadonlySet<string> = new Set([
  'routes/voices.ts PUT /:voiceId/override',
  'routes/voice-library.ts POST /:voiceUuid/assign',
  'routes/voice-library.ts DELETE /:voiceUuid/assign',
  'routes/voice-library.ts DELETE /:voiceUuid',
  'routes/library-cast-override.ts POST /library-cast/override',
  'routes/voice-library.ts POST /promote', // reads a book's cast.json (never writes it)
]);

/* G6: the book CREATORS. They are not `/:bookId` handlers, so G2 cannot see them,
   and the portable import's book-op (the overwrite path) lives in the library
   function, not the route handler -- so the route is covered here instead of by
   an `ENUMERATED_WRITERS` entry. Each creator must carry every token listed:
   the path claim for the collision check + placement, and the id-minting /
   already-loaded check that keeps bookIds unique. */
const CREATOR_TOKENS: ReadonlyMap<string, RegExp[]> = new Map([
  ['routes/import.ts', [/\bwithBookPathClaim\(/g, /\bmintBookId\(/g]],
  ['routes/samples.ts', [/\bwithBookPathClaim\(/g, /\bpeekBook\(/g]],
  ['import/scan-import-folder.ts', [/\bwithBookPathClaim\(/g, /\bwithBookOp\(/g, /\bmintBookIdFrom\(/g, /\btakenBookIds\(/g]],
]);

/** Creator files missing one of their required tokens (prose and strings do not count). */
function missingCreatorTokens(rel: string, content: string, required: RegExp[]): string[] {
  const opaque = computeOpaqueRanges(content);
  return required
    .filter((re) => tokenIndexes(content, opaque, re).length === 0)
    .map((re) => `${rel}: no ${re.source.replace(/\\b|\\\(/g, '')}( call`);
}

interface Handler extends Span {
  method: string;
  path: string;
  line: number;
}

function collectHandlers(content: string, opaque: OpaqueRange[]): Handler[] {
  const out: Handler[] = [];
  ROUTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_RE.exec(content))) {
    if (isOpaque(opaque, m.index)) continue;
    const open = m.index + m[0].indexOf('(');
    const close = findMatchingClose(content, opaque, open, '(', ')');
    if (close === -1) continue;
    out.push({
      method: m[1].toUpperCase(),
      path: m[3],
      start: m.index,
      end: close,
      line: lineOf(content, m.index),
    });
  }
  return out;
}

function isGuardedHandler(rel: string, h: Handler): boolean {
  if (h.method !== 'GET' && (h.path.startsWith('/:bookId') || h.path.startsWith('/:id/analysis'))) {
    return true;
  }
  if (h.method === 'GET' && h.path.startsWith('/:bookId/export/portable')) return true;
  return ENUMERATED_WRITERS.has(`${rel} ${h.method} ${h.path}`);
}

interface HandlerScan {
  /** Guarded handlers seen (for the "the scan is real" check). */
  guarded: string[];
  /** G2: guarded handlers with no `withBookOp*` / `runBookJob`. */
  uncovered: string[];
  /** G2: forbidden tokens inside a `withBookOp*` callback (any file). */
  forbidden: string[];
  /** G3a: a `findBookBy…` outside a lock callback in a guarded handler. */
  resolveBeforeLock: string[];
}

function scanHandlers(rel: string, content: string): HandlerScan {
  const opaque = computeOpaqueRanges(content);
  const result: HandlerScan = { guarded: [], uncovered: [], forbidden: [], resolveBeforeLock: [] };

  const bookOpSpans = callSpans(content, opaque, BOOK_OP_ANY_RE);
  for (const i of tokenIndexes(content, opaque, FORBIDDEN_IN_BOOK_OP_RE)) {
    if (inAny(bookOpSpans, i)) {
      result.forbidden.push(`${content.slice(i, content.indexOf('(', i) + 1)} inside a withBookOp* callback @ line ${lineOf(content, i)}`);
    }
  }
  /* A nested lock call sits STRICTLY inside another call's span (the call's own
     token starts the span, so `start < i` excludes itself). */
  for (const i of tokenIndexes(content, opaque, BOOK_OP_ANY_RE)) {
    if (bookOpSpans.some((s) => i > s.start && i <= s.end)) {
      result.forbidden.push(`${content.slice(i, content.indexOf('(', i) + 1)} nested inside a withBookOp* callback @ line ${lineOf(content, i)}`);
    }
  }

  if (!content.includes('Router')) return result;
  const lockOrJobSpans = callSpans(content, opaque, BOOK_OP_OR_JOB_RE);
  const findTokens = tokenIndexes(content, opaque, FIND_BOOK_RE);
  for (const h of collectHandlers(content, opaque)) {
    if (!isGuardedHandler(rel, h)) continue;
    const label = `${h.method} ${h.path} @ line ${h.line}`;
    result.guarded.push(label);
    if (!lockOrJobSpans.some((s) => s.start >= h.start && s.start <= h.end)) {
      result.uncovered.push(label);
    }
    for (const i of findTokens) {
      if (i >= h.start && i <= h.end && !inAny(lockOrJobSpans, i)) {
        result.resolveBeforeLock.push(`${label}: resolve before lock @ line ${lineOf(content, i)}`);
      }
    }
  }
  return result;
}

/* ===== G3b ==================================================================== */

/** Files that walk a series and must resolve each sibling through the step's
    handle, never a `findBookByBookId` in the loop body. */
const LOOP_FILES: readonly string[] = [
  'routes/cast-series-patch.ts',
  'routes/voice-override-linked.ts',
  'routes/voices.ts',
  'workspace/voice-library-usage.ts',
];

function loopBodies(content: string, opaque: OpaqueRange[]): Span[] {
  const bodies: Span[] = [];
  const re = /\b(?:for|while)\s*(?:await\s*)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (isOpaque(opaque, m.index)) continue;
    const headClose = findMatchingClose(content, opaque, m.index + m[0].length - 1, '(', ')');
    if (headClose === -1) continue;
    let b = headClose + 1;
    while (b < content.length && /\s/.test(content[b])) b++;
    const end =
      content[b] === '{'
        ? findMatchingClose(content, opaque, b, '{', '}')
        : content.indexOf(';', b);
    if (end === -1) continue;
    bodies.push({ start: b, end });
  }
  return bodies;
}

function scanLoopResolves(content: string): string[] {
  const opaque = computeOpaqueRanges(content);
  const bodies = loopBodies(content, opaque);
  return tokenIndexes(content, opaque, FIND_BY_ID_RE)
    .filter((i) => inAny(bodies, i))
    .map((i) => `findBookByBookId( inside a loop body @ line ${lineOf(content, i)}`);
}

/* ===== G4 ===================================================================== */

function scanCastLocks(content: string): string[] {
  const opaque = computeOpaqueRanges(content);
  const bookOps = callSpans(content, opaque, BOOK_OPS_RE);
  return tokenIndexes(content, opaque, CAST_LOCKS_RE)
    .filter((i) => !inAny(bookOps, i))
    .map((i) => `withCastLocks( outside a withBookOps( callback @ line ${lineOf(content, i)}`);
}

/** Files where a single-book `withCastLock(` must sit inside `withBookOp(`. */
const SINGLE_CAST_LOCK_FILES: readonly string[] = ['routes/voices.ts', 'workspace/voice-library-usage.ts'];

function scanSingleCastLocks(content: string): string[] {
  const opaque = computeOpaqueRanges(content);
  const bookOp = callSpans(content, opaque, BOOK_OP_RE);
  return tokenIndexes(content, opaque, CAST_LOCK_RE)
    .filter((i) => !inAny(bookOp, i))
    .map((i) => `withCastLock( outside a withBookOp( callback @ line ${lineOf(content, i)}`);
}

/* ===== G5 ===================================================================== */

/** `runBookJob(` token counts are only a MINIMUM per file: this guard cannot
    tell a registered long job from a missing one in a file it doesn't list (a
    blind spot, listed in the header). `pending` = the plan task that adds them. */
const LONG_JOB_FILES: ReadonlyMap<string, { min: number; pending: string | null }> = new Map([
  ['routes/generation.ts', { min: 2, pending: null }], // generation POST + triggerScoring
  ['routes/chapter-splice.ts', { min: 1, pending: null }],
  ['routes/chapter-qa-repair.ts', { min: 1, pending: null }],
  ['routes/qa-report.ts', { min: 1, pending: null }], // resume-scoring
  ['routes/analysis.ts', { min: 2, pending: null }], // main + subset
  ['routes/cast-design.ts', { min: 1, pending: null }],
  ['routes/single-design.ts', { min: 1, pending: null }],
  ['routes/qwen-voice.ts', { min: 1, pending: null }], // design-voice
  ['routes/voice-style.ts', { min: 2, pending: null }], // generate + generate-all
  ['routes/script-review.ts', { min: 1, pending: null }],
  ['routes/export.ts', { min: 1, pending: null }],
  ['routes/exports-portable.ts', { min: 1, pending: null }], // GET export/portable
]);

function countRunBookJob(content: string): number {
  return tokenIndexes(content, computeOpaqueRanges(content), RUN_BOOK_JOB_RE).length;
}

/** Function names a module exports (declarations only). */
function exportedFunctions(content: string): string[] {
  const opaque = computeOpaqueRanges(content);
  const out: string[] = [];
  const re = /\bexport\s+(?:async\s+)?function\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (!isOpaque(opaque, m.index)) out.push(m[1]);
  }
  return out;
}

/* ===== allowlists ============================================================= */

/* Off: no `pending:T<n>` entry may remain. The negative controls pass `true` explicitly to prove the other path. */
const ALLOW_PENDING = false;

interface AllowEntry {
  count: number;
  reason: string;
}

function allow(rows: Array<[string, number, string]>): Map<string, AllowEntry> {
  return new Map(rows.map(([rel, count, reason]) => [rel, { count, reason }]));
}

/* G1: file -> unconverted mover sites. A file that scans clean must not be listed. */
const ALLOW_G1 = allow([]);
/* G2: file -> guarded handlers with no book-op / runBookJob. Final reasons are
   `no-book-write`, `cross-book-walker`, and `job-lease` (the handler writes the
   book, but only on behalf of a live job whose `runBookJob` lease is held, so a
   move is refused for the whole write). */
const ALLOW_G2 = allow([
  ['routes/analysis.ts', 1, 'job-lease'], // POST /:id/analysis/pause: writes analysis-state.json (persistTerminalSnapshot) only for a live, un-aborted job, which holds its analysis lease until that write lands (it is folded into job.terminalWrites)
  ['routes/annotate-emotion.ts', 1, 'no-book-write'],
  ['routes/cast-design.ts', 1, 'no-book-write'], // POST design/pause: in-memory abort only
  ['routes/chapter-audio.ts', 2, 'no-book-write'], // DELETE previous + POST previous/restore: plan 286 retired both to 410 `moved`, touching no file
  ['routes/generation.ts', 1, 'no-book-write'], // POST generation/pause: in-memory abort only
  ['routes/instruct-annotation.ts', 1, 'no-book-write'],
  ['routes/script-review.ts', 2, 'no-book-write'], // cancel (in-memory abort) + attach (re-attach only)
  ['routes/share.ts', 1, 'no-book-write'], // POST /:bookId/share: writes only the workspace-level share-links.json
  ['routes/single-design.ts', 1, 'no-book-write'], // POST design-single/subscribe: re-attach only
  ['routes/voice-library.ts', 1, 'cross-book-walker'], // DELETE /:voiceUuid: library-voice -> per-book book-op in clearLibraryVoiceReferences
  ['routes/voice-match.ts', 1, 'no-book-write'],
  ['routes/voices.ts', 1, 'cross-book-walker'], // PUT /:voiceId/override: walker
]);
/* G3a: file -> a book resolved before the lock in a guarded handler. The
   no-book-write handlers (annotate-emotion, instruct-annotation, share) resolve
   through the lock-free \`peekBook\`, which G3a permits. */
const ALLOW_G3A = allow([]);
/* G3b: file -> findBookByBookId( inside a loop body. */
const ALLOW_G3B = allow([]);
/* G4a: file -> withCastLocks( outside withBookOps(. */
const ALLOW_G4A = allow([]);
/* G4b: file -> withCastLock( outside withBookOp(, on top of PERMANENT_G4B. */
const ALLOW_G4B = allow([
  ['routes/voices.ts', 1, 'cross-book-walker'], // the bookId-less book: cast lock only, no book-op
  ['workspace/voice-library-usage.ts', 1, 'cross-book-walker'], // same
]);
/* G4b permanent exemption: the `onlyBookDir` branch (the caller holds book-op
   for that book, or is that book's registered job). Added to the allowlist count. */
const PERMANENT_G4B = new Map<string, number>([['routes/voices.ts', 1]]);

const VALID_REASON = /^(?:pending:T(?:[2-9]|10)\b.*|no-book-write|cross-book-walker|job-lease)$/;

/** Compare `found` (file -> details) against `allow` in BOTH directions.
 *  `allowPending` is a PARAMETER (default: the real switch) so the negative
 *  controls can run the `false` path the const would otherwise make unreachable. */
function diffAllowlist(
  label: string,
  found: Map<string, string[]>,
  allow: Map<string, AllowEntry>,
  permanent: Map<string, number> = new Map(),
  allowPending: boolean = ALLOW_PENDING,
): string[] {
  const problems: string[] = [];
  for (const [rel, details] of found) {
    const entry = allow.get(rel);
    const expected = (entry?.count ?? 0) + (permanent.get(rel) ?? 0);
    if (!entry && permanent.has(rel) && details.length === expected) continue;
    if (!entry) {
      problems.push(`${label} ${rel}: ${details.length} site(s) — NOT on the allowlist:\n  ${details.join('\n  ')}`);
    } else if (details.length !== expected) {
      problems.push(
        `${label} ${rel}: allowlisted for exactly ${expected} (${entry.reason}), but the scan found ${details.length}:\n  ${details.join('\n  ')}`,
      );
    }
  }
  for (const [rel, entry] of allow) {
    if (!found.has(rel)) {
      problems.push(`${label} ${rel}: allowlisted for ${entry.count} (${entry.reason}), but the scan now finds ZERO — update or remove this entry.`);
    }
    if (!VALID_REASON.test(entry.reason)) {
      problems.push(`${label} ${rel}: invalid allowlist reason "${entry.reason}"`);
    }
    if (!allowPending && entry.reason.startsWith('pending:')) {
      problems.push(`${label} ${rel}: pending allowlist entry "${entry.reason}" must not remain`);
    }
  }
  return problems;
}

/** G5: each long-job file carries its declared minimum of `runBookJob(` tokens.
 *  A `pending` file may sit below its minimum only while `allowPending`. */
function checkLongJobs(
  counts: Map<string, number>,
  files: ReadonlyMap<string, { min: number; pending: string | null }>,
  allowPending: boolean,
): string[] {
  const problems: string[] = [];
  for (const [rel, { min, pending }] of files) {
    const have = counts.get(rel);
    if (have === undefined) {
      problems.push(`${rel}: listed in LONG_JOB_FILES but the file does not exist`);
      continue;
    }
    const required = pending && allowPending ? 0 : min;
    if (have < required) problems.push(`${rel}: expected >= ${required} runBookJob( token(s), found ${have}`);
    if (pending && !allowPending) problems.push(`${rel}: pending:${pending} must not remain`);
    if (pending && have >= min) problems.push(`${rel}: now meets its minimum (${min}) — clear its pending marker`);
  }
  return problems;
}

/** Files of allowlist entries still marked `pending:` -- must be empty once `allowPending` is off. */
function pendingEntries(maps: Array<Map<string, AllowEntry>>, allowPending: boolean): string[] {
  if (allowPending) return [];
  return maps.flatMap((m) => [...m].filter(([, e]) => e.reason.startsWith('pending:')).map(([k]) => k));
}

interface Scanned {
  g1: Map<string, string[]>;
  g2: Map<string, string[]>;
  g3a: Map<string, string[]>;
  g3b: Map<string, string[]>;
  g4a: Map<string, string[]>;
  g4b: Map<string, string[]>;
  forbidden: string[];
  guardedTotal: number;
  runBookJobCounts: Map<string, number>;
  addTokenUsers: string[];
  jobsExports: string[];
}

function scanTree(): Scanned {
  const s: Scanned = {
    g1: new Map(),
    g2: new Map(),
    g3a: new Map(),
    g3b: new Map(),
    g4a: new Map(),
    g4b: new Map(),
    forbidden: [],
    guardedTotal: 0,
    runBookJobCounts: new Map(),
    addTokenUsers: [],
    jobsExports: [],
  };
  const put = (m: Map<string, string[]>, rel: string, d: string[]): void => {
    if (d.length > 0) m.set(rel, d);
  };
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).split(sep).join('/');
    const content = readFileSync(file, 'utf8');
    if (rel !== MOVER_HOME) put(s.g1, rel, scanMovers(content));
    const h = scanHandlers(rel, content);
    s.guardedTotal += h.guarded.length;
    put(s.g2, rel, h.uncovered);
    put(s.g3a, rel, h.resolveBeforeLock);
    for (const f of h.forbidden) s.forbidden.push(`${rel}: ${f}`);
    if (LOOP_FILES.includes(rel)) put(s.g3b, rel, scanLoopResolves(content));
    if (rel !== 'workspace/cast-lock.ts') put(s.g4a, rel, scanCastLocks(content));
    if (SINGLE_CAST_LOCK_FILES.includes(rel)) put(s.g4b, rel, scanSingleCastLocks(content));
    if (LONG_JOB_FILES.has(rel)) s.runBookJobCounts.set(rel, countRunBookJob(content));
    if (
      rel !== 'workspace/book-jobs.ts' &&
      rel !== 'workspace/book-op-lock.ts' &&
      content.includes('__addBookJobToken(')
    ) {
      s.addTokenUsers.push(rel);
    }
    if (rel === 'workspace/book-jobs.ts') s.jobsExports = exportedFunctions(content);
  }
  return s;
}

describe('book-op lock — static guard (#3711)', () => {
  const scanned = scanTree();

  it('G1: no unsanctioned rename/rm/rmdir/cp of a book folder outside book-op-lock.ts, except the pinned allowlist', () => {
    expect(diffAllowlist('G1', scanned.g1, ALLOW_G1), '').toEqual([]);
  });

  it('G2: every guarded handler takes withBookOp / withBookOps / runBookJob, except the pinned allowlist', () => {
    expect(diffAllowlist('G2', scanned.g2, ALLOW_G2)).toEqual([]);
  });

  it('G2: no runBookJob / withDesignLock / withLibraryVoiceLock inside a withBookOp* callback', () => {
    expect(scanned.forbidden).toEqual([]);
  });

  it('G3a: no findBookByBookId / findBookByManuscriptId before the lock in a guarded handler, except the pinned allowlist', () => {
    expect(diffAllowlist('G3a', scanned.g3a, ALLOW_G3A)).toEqual([]);
  });

  it('G3b: no findBookByBookId inside a for/while body in the series-walking files, except the pinned allowlist', () => {
    expect(diffAllowlist('G3b', scanned.g3b, ALLOW_G3B)).toEqual([]);
  });

  it('G4: every withCastLocks sits inside withBookOps; single withCastLock inside withBookOp in the walker files', () => {
    expect(diffAllowlist('G4a', scanned.g4a, ALLOW_G4A)).toEqual([]);
    expect(diffAllowlist('G4b', scanned.g4b, ALLOW_G4B, PERMANENT_G4B)).toEqual([]);
  });

  it('G5: each long-job file carries its declared minimum of runBookJob( tokens', () => {
    expect(checkLongJobs(scanned.runBookJobCounts, LONG_JOB_FILES, ALLOW_PENDING)).toEqual([]);
  });

  it('G5: runBookJob is the ONLY registration function (book-jobs.ts exports; __addBookJobToken has no other caller)', () => {
    expect(scanned.jobsExports.sort()).toEqual(['runBookJob']);
    expect(scanned.addTokenUsers).toEqual([]);
  });

  it('G6: each book creator (manuscript import, sample load, portable import) takes the path claim and keeps bookIds unique', () => {
    const problems: string[] = [];
    for (const [rel, required] of CREATOR_TOKENS) {
      problems.push(...missingCreatorTokens(rel, readFileSync(join(SRC_ROOT, rel), 'utf8'), required));
    }
    expect(problems).toEqual([]);
  });

  it('G6 negative control: a creator without the claim / mint token is reported; prose and strings do not count', () => {
    const req = [/\bwithBookPathClaim\(/g, /\bmintBookId\(/g];
    expect(missingCreatorTokens('x.ts', 'const id = makeBookId(a, s, t);', req)).toHaveLength(2);
    expect(missingCreatorTokens('x.ts', 'await withBookPathClaim(async () => { const id = await mintBookId(a, s, t); });', req)).toEqual([]);
    expect(missingCreatorTokens('x.ts', '// withBookPathClaim( mintBookId( used to be here\nconst s = "mintBookId(";', req)).toHaveLength(2);
    expect(missingCreatorTokens('x.ts', 'await withBookPathClaim(async () => {});', req)).toHaveLength(1);
    /* the importer mints from a walk it already made (`mintBookIdFrom`, `takenBookIds`) */
    const walkReq = [/\bmintBookIdFrom\(/g, /\btakenBookIds\(/g];
    expect(missingCreatorTokens('x.ts', 'const id = await mintBookId(a, s, t);', walkReq)).toHaveLength(2);
    expect(missingCreatorTokens('x.ts', 'const ids = await takenBookIds(); mintBookIdFrom(ids, a, s, t);', walkReq)).toEqual([]);
    expect(missingCreatorTokens('x.ts', '// mintBookIdFrom( takenBookIds(\nconst s = "takenBookIds(";', walkReq)).toHaveLength(2);
  });

  it('no pending:T<n> allowlist entry remains', () => {
    const all = [ALLOW_G1, ALLOW_G2, ALLOW_G3A, ALLOW_G3B, ALLOW_G4A, ALLOW_G4B];
    expect(pendingEntries(all, ALLOW_PENDING)).toEqual([]);
  });

  it('the scan is real: it sees the known guarded handlers and long-job files', () => {
    expect(scanned.guardedTotal).toBeGreaterThan(40);
    for (const rel of LONG_JOB_FILES.keys()) {
      expect(scanned.runBookJobCounts.has(rel), `${rel} missing from the scan`).toBe(true);
    }
    const bookState = collectHandlers(
      readFileSync(join(SRC_ROOT, 'routes/book-state.ts'), 'utf8'),
      computeOpaqueRanges(readFileSync(join(SRC_ROOT, 'routes/book-state.ts'), 'utf8')),
    );
    expect(bookState.some((h) => h.method === 'PUT' && h.path === '/:bookId/state')).toBe(true);
    expect(bookState.some((h) => h.method === 'DELETE' && h.path === '/:bookId')).toBe(true);
  });

  /* ---- negative controls: each fixture MUST be reported ------------------------ */

  it('G1 negative control: a bare rename/rm/rmdir/cp of a book dir is reported; other args and prose are not', () => {
    expect(scanMovers('await renameWithRetry(bookDir, newDir);')).toHaveLength(1);
    expect(scanMovers('await rm(dir, { recursive: true });')).toHaveLength(1);
    expect(scanMovers('await rmdir(oldSeriesDir).catch(() => {});')).toHaveLength(1);
    expect(scanMovers('await cp(located.bookDir, dest, { recursive: true });')).toHaveLength(1);
    expect(scanMovers('await rename(book.bookDir, x);')).toHaveLength(1);
    expect(scanMovers('await rename(tmpPath, destPath);')).toHaveLength(0);
    expect(scanMovers('await rm(dirname(x));')).toHaveLength(0);
    expect(scanMovers('// await rename(bookDir, x) used to live here')).toHaveLength(0);
    expect(scanMovers("const s = 'rm(bookDir)';")).toHaveLength(0);
  });

  it('G2 negative control: an uncovered guarded handler is reported (single- and multi-line), a covered one is not', () => {
    const bad = [
      "bookRouter.put('/:bookId/state', async (req, res) => {",
      '  await writeThing(req.params.bookId);',
      '});',
    ].join('\n');
    expect(scanHandlers('routes/x.ts', bad).uncovered).toHaveLength(1);
    const multi = [
      'bookRouter.post(',
      "  '/:bookId/things',",
      '  async (req, res) => {},',
      ');',
    ].join('\n');
    expect(scanHandlers('routes/x.ts', multi).uncovered).toHaveLength(1);
    const covered = [
      "bookRouter.delete('/:bookId', async (req, res) => {",
      '  await withBookOp(req.params.bookId, async (b) => { await removeBookFolder(b); });',
      '});',
    ].join('\n');
    expect(scanHandlers('routes/x.ts', covered).uncovered).toHaveLength(0);
    const job = "bookRouter.post('/:bookId/go', async (req, res) => { await runBookJob(id, 'render', f); });";
    expect(scanHandlers('routes/x.ts', job).uncovered).toHaveLength(0);
    const analysis = "analysisRouter.post('/:id/analysis/pause', async (req, res) => {});";
    expect(scanHandlers('routes/x.ts', analysis).uncovered).toHaveLength(1);
    const portable = "r.get('/:bookId/export/portable', h); portableRouter.get('/:bookId/export/portable', async () => {});";
    expect(scanHandlers('routes/x.ts', portable).uncovered).toHaveLength(1);
    const enumerated = "voicesRouter.put('/:voiceId/override', async () => {});";
    expect(scanHandlers('routes/voices.ts', enumerated).uncovered).toHaveLength(1);
    expect(scanHandlers('routes/other.ts', enumerated).uncovered).toHaveLength(0);
  });

  it('G2 negative control: a plain GET and a route inside a comment are not guarded', () => {
    const src = [
      "// bookRouter.put('/:bookId/state', async () => {});",
      "bookRouter.get('/:bookId/state', async (req, res) => {});",
    ].join('\n');
    const r = scanHandlers('routes/x.ts', src);
    expect(r.guarded).toHaveLength(0);
  });

  it('G2 negative control: runBookJob / withDesignLock / withLibraryVoiceLock inside a withBookOp callback are reported', () => {
    const rj = "await withBookOp(id, async (b) => { await runBookJob(id, 'render', f); });";
    expect(scanHandlers('x.ts', rj).forbidden).toHaveLength(1);
    const dl = 'await withBookOps([a, b], async () => { await withDesignLock(p, async () => {}); });';
    expect(scanHandlers('x.ts', dl).forbidden).toHaveLength(1);
    const ll = 'await withBookOp(id, async () => { await withLibraryVoiceLock(u, async () => {}); });';
    expect(scanHandlers('x.ts', ll).forbidden).toHaveLength(1);
    const ok = 'await withDesignLock(p, async () => { await withBookOp(id, async () => {}); });';
    expect(scanHandlers('x.ts', ok).forbidden).toHaveLength(0);
  });

  it('G2 negative control: a nested withBookOp / withBookOps inside a withBookOp* callback is reported; siblings are not', () => {
    const nested = 'await withBookOp(a, async () => { await withBookOp(a, async () => {}); });';
    expect(scanHandlers('x.ts', nested).forbidden).toHaveLength(1);
    const multi = 'await withBookOp(a, async () => { await withBookOps([a, b], async () => {}); });';
    expect(scanHandlers('x.ts', multi).forbidden).toHaveLength(1);
    const inOps = 'await withBookOps([a, b], async () => { await withBookOp(c, async () => {}); });';
    expect(scanHandlers('x.ts', inOps).forbidden).toHaveLength(1);
    const siblings = 'await withBookOp(a, async () => {});\nawait withBookOp(b, async () => {});';
    expect(scanHandlers('x.ts', siblings).forbidden).toHaveLength(0);
    const prose = 'await withBookOp(a, async () => { /* never withBookOp( inside */ });';
    expect(scanHandlers('x.ts', prose).forbidden).toHaveLength(0);
    const declaration = 'export function withBookOp<T>(id: string) {}';
    expect(scanHandlers('x.ts', declaration).forbidden).toHaveLength(0);
  });

  it('G3a negative control: a resolve before the lock is reported; one inside a callback or via peekBook is not', () => {
    const bad = [
      "bookRouter.post('/:bookId/x', async (req, res) => {",
      '  const located = await findBookByBookId(req.params.bookId);',
      '  await withBookOp(req.params.bookId, async () => {});',
      '});',
    ].join('\n');
    expect(scanHandlers('routes/x.ts', bad).resolveBeforeLock).toHaveLength(1);
    const manuscript = [
      "bookRouter.post('/:bookId/x', async (req, res) => {",
      '  const located = await findBookByManuscriptId(req.params.bookId);',
      '  await runBookJob(id, "render", async () => {});',
      '});',
    ].join('\n');
    expect(scanHandlers('routes/x.ts', manuscript).resolveBeforeLock).toHaveLength(1);
    const ok = [
      "bookRouter.post('/:bookId/x', async (req, res) => {",
      '  const peeked = await peekBook(req.params.bookId);',
      '  await withBookOp(req.params.bookId, async () => { await findBookByBookId(x); });',
      '});',
    ].join('\n');
    expect(scanHandlers('routes/x.ts', ok).resolveBeforeLock).toHaveLength(0);
  });

  it('G3b negative control: findBookByBookId inside a for/while body is reported, outside is not', () => {
    const forBody = 'for (const s of siblings) {\n  const b = await findBookByBookId(s.id);\n}';
    expect(scanLoopResolves(forBody)).toHaveLength(1);
    const whileBody = 'while (more) { await findBookByBookId(x); }';
    expect(scanLoopResolves(whileBody)).toHaveLength(1);
    const awaitFor = 'for await (const s of gen()) { await findBookByBookId(s); }';
    expect(scanLoopResolves(awaitFor)).toHaveLength(1);
    const single = 'for (const s of xs) await findBookByBookId(s);';
    expect(scanLoopResolves(single)).toHaveLength(1);
    const outside = 'const b = await findBookByBookId(id);\nfor (const s of xs) { use(b, s); }';
    expect(scanLoopResolves(outside)).toHaveLength(0);
    expect(scanLoopResolves('// for (;;) { findBookByBookId(x) }')).toHaveLength(0);
  });

  it('G4 negative control: withCastLocks outside withBookOps / withCastLock outside withBookOp are reported', () => {
    expect(scanCastLocks('await withCastLocks([a, b], async () => {});')).toHaveLength(1);
    expect(scanCastLocks('await withBookOps([x, y], async ([A, B]) => withCastLocks([A.bookDir, B.bookDir], async () => {}));')).toHaveLength(0);
    expect(scanCastLocks('export async function withCastLocks<T>(d: string[]) {}')).toHaveLength(0);
    expect(scanSingleCastLocks('await withCastLock(dir, async () => {});')).toHaveLength(1);
    expect(scanSingleCastLocks('await withBookOp(id, async (b) => withCastLock(b.bookDir, async () => {}));')).toHaveLength(0);
    // a withBookOps callback does not satisfy the single-book rule's own token, and vice versa
    expect(scanCastLocks('await withBookOp(id, async () => withCastLocks([a], async () => {}));')).toHaveLength(1);
  });

  it('G5 negative control: runBookJob tokens are counted; prose, strings and the declaration are not', () => {
    expect(countRunBookJob('await runBookJob(id, "render", f);\nawait runBookJob(id, "export", g);')).toBe(2);
    expect(countRunBookJob('// runBookJob( goes here\nconst s = "runBookJob(x)";')).toBe(0);
    expect(countRunBookJob('export async function runBookJob<T>(id: string) {}')).toBe(0);
    expect(exportedFunctions('export async function runBookJob() {}\nexport function sneaky() {}\n// export function ghost() {}')).toEqual([
      'runBookJob',
      'sneaky',
    ]);
  });

  it('the allowlist diff reports drift in BOTH directions and unknown/invalid entries', () => {
    const found = new Map([['a.ts', ['x', 'y']]]);
    expect(diffAllowlist('T', found, new Map())).toHaveLength(1); // not on the allowlist
    expect(diffAllowlist('T', found, new Map([['a.ts', { count: 1, reason: 'no-book-write' }]]))).toHaveLength(1); // count drift up
    expect(diffAllowlist('T', found, new Map([['a.ts', { count: 3, reason: 'no-book-write' }]]))).toHaveLength(1); // count drift down
    expect(diffAllowlist('T', found, new Map([['a.ts', { count: 2, reason: 'no-book-write' }], ['b.ts', { count: 1, reason: 'no-book-write' }]]))).toHaveLength(1); // stale entry
    expect(diffAllowlist('T', found, new Map([['a.ts', { count: 2, reason: 'because' }]]))).toHaveLength(1); // invalid reason
    expect(diffAllowlist('T', found, new Map([['a.ts', { count: 2, reason: 'no-book-write' }]]))).toEqual([]);
    expect(diffAllowlist('T', found, new Map([['a.ts', { count: 1, reason: 'no-book-write' }]]), new Map([['a.ts', 1]]))).toEqual([]);
    expect(diffAllowlist('T', found, new Map(), new Map([['a.ts', 2]]))).toEqual([]);
  });

  it('allowPending=false negative controls: a pending allowlist entry, a pending G5 file and a leftover pending entry all FAIL', () => {
    const found = new Map([['a.ts', ['x']]]);
    const pendingEntry = new Map([['a.ts', { count: 1, reason: 'pending:T2' }]]);
    // control: while pending is allowed the same fixture is clean
    expect(diffAllowlist('T', found, pendingEntry, new Map(), true)).toEqual([]);
    expect(diffAllowlist('T', found, pendingEntry, new Map(), false)).toHaveLength(1);
    // a permanent reason is clean either way
    const permanentEntry = new Map([['a.ts', { count: 1, reason: 'no-book-write' }]]);
    expect(diffAllowlist('T', found, permanentEntry, new Map(), false)).toEqual([]);

    const files = new Map([
      ['p.ts', { min: 1, pending: 'T4' }],
      ['q.ts', { min: 2, pending: null }],
    ]);
    // pending allowed: p.ts may sit at 0; q.ts below its minimum still fails
    expect(checkLongJobs(new Map([['p.ts', 0], ['q.ts', 2]]), files, true)).toEqual([]);
    expect(checkLongJobs(new Map([['p.ts', 0], ['q.ts', 1]]), files, true)).toHaveLength(1);
    // pending forbidden: a pending file below its minimum fails (have < min), plus the "must not remain" report
    const off = checkLongJobs(new Map([['p.ts', 0], ['q.ts', 2]]), files, false);
    expect(off.some((p) => p.includes('expected >= 1'))).toBe(true);
    expect(off.some((p) => p.includes('must not remain'))).toBe(true);
    // pending forbidden and the marker cleared: clean
    const cleared = new Map([
      ['p.ts', { min: 1, pending: null }],
      ['q.ts', { min: 2, pending: null }],
    ]);
    expect(checkLongJobs(new Map([['p.ts', 1], ['q.ts', 2]]), cleared, false)).toEqual([]);
    // a file that meets its minimum while still marked pending is reported (allowed or not)
    expect(checkLongJobs(new Map([['p.ts', 1], ['q.ts', 2]]), files, true)).toHaveLength(1);

    expect(pendingEntries([pendingEntry], false)).toEqual(['a.ts']);
    expect(pendingEntries([pendingEntry], true)).toEqual([]);
    expect(pendingEntries([permanentEntry], false)).toEqual([]);
  });

  it('prose quoting an unbalanced withBookOp( does not fabricate a lock range', () => {
    const src = [
      "bookRouter.post('/:bookId/x', async (req, res) => {",
      '  try {',
      '    await work();',
      '  } catch {',
      '    // historical: this used to be withBookOp(id, async (b) => {',
      '  }',
      '  await write(req.params.bookId);',
      '});',
    ].join('\n');
    expect(scanHandlers('routes/x.ts', src).uncovered).toHaveLength(1);
  });

  it('the opaque-range tokenizer is byte-identical to cast-lock.guard.test.ts', () => {
    const BEGIN = '/* ===== SHARED OPAQUE-RANGE TOKENIZER - ' + 'BEGIN';
    const END = '/* ===== SHARED OPAQUE-RANGE TOKENIZER - ' + 'END';
    const extract = (path: string): string => {
      const text = readFileSync(path, 'utf8');
      const from = text.indexOf(BEGIN);
      const to = text.indexOf(END);
      expect(from, `${path}: missing tokenizer BEGIN sentinel`).toBeGreaterThanOrEqual(0);
      expect(to, `${path}: missing tokenizer END sentinel`).toBeGreaterThan(from);
      return text.slice(from, text.indexOf('*/', to) + 2);
    };
    const mine = extract(fileURLToPath(import.meta.url));
    const sibling = extract(join(__dirname, 'cast-lock.guard.test.ts'));
    expect(mine.length).toBeGreaterThan(1000);
    expect(sibling).toBe(mine);
  });
});
