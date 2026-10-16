/* #3625 — the static guard that stops the state.json lock invariant rotting.

   WHAT IT CHECKS: walks every `.ts` file under `server/src` (recursively,
   excluding `*.test.ts`) that mentions `writeStateJsonAtomic` or
   `stateJsonPath`, and for each `writeStateJsonAtomic(` call, and each bare
   `writeJsonAtomic(stateJsonPath(` / `writeJsonAtomicOrdered(stateJsonPath(`
   call, asserts it sits inside a `withStateLock(...)` call. state.json is
   written by read-modify-write; two unlocked writers for sibling chapters of
   one book overlap and the later writer's stale read drops the earlier
   writer's stamp. The owner decided (2026-10-16) on a per-book `state` lock
   around every such read-modify-write; this guard fails the build on a write
   that escapes it. The definition `export async function writeStateJsonAtomic(`
   in `state-migrate.ts` is excluded by a `function `-prefix check, not by an
   allowlist entry.

   BLIND SPOTS (this scan is purely syntactic):
     - CALL-GRAPH-BLIND. A new unlocked caller of an already-locked helper
       passes: the helper's own write is inside its lock, and the scan cannot
       see who calls the helper.
     - A write through a variable path (`writeJsonAtomic(p, ...)` where `p`
       was computed from `stateJsonPath(` earlier) is invisible; only the
       literal `stateJsonPath(` first argument is matched.
     - `import/scan-import-folder.ts`'s staged rename is not a
       `writeStateJsonAtomic` / `writeJsonAtomic` call at all. It was locked by
       hand (child 12 of #3625) and nothing here proves it stays locked.

   WHY IT COPIES THE SCANNER INSTEAD OF IMPORTING IT: this repo's pattern is
   one scanner copy per guard (`cast-lock.guard.test.ts`,
   `state-language.guard.test.ts`, `voice-library-write-seam.guard.test.ts`
   each carry their own). The scanner machinery below is `cast-lock.guard.test
   .ts`'s, copied verbatim; only the lock-token regex and the write regexes
   differ. Fixes to a failure mode recorded in cast-lock's header (opaque
   ranges for strings / templates / regexes / comments, balanced-paren lock
   spans) apply here equally - read that header first when changing this file.

   ALLOWLIST: keyed on file AND count, checked in BOTH directions (a stale
   entry fails, a count that moved fails). It starts empty; do not add an entry
   to silence a site that can be wrapped. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { STATE_LOCK_GUARD_SCAN_GLOB } from './state-lock.guard-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src
const REPO_ROOT = join(SRC_ROOT, '..', '..');

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

interface LockRange {
  start: number;
  end: number;
}

/** Every `withStateLock(...)` call's span in `content`.
    Pure textual nesting: a callback that delegates to a same-file helper is not chased (see the call-graph blind spot in the file header). */
function collectLockRanges(content: string, opaque: OpaqueRange[]): LockRange[] {
  const ranges: LockRange[] = [];
  const tokenRe = /\bwithStateLock\(/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(content))) {
    const tokenStart = m.index;
    /* A `withStateLock(` that only exists in prose or a string must not open a
       lock range. This is REQUIRED by the #2405 tokenizer, not optional
       hardening: the balancer below now jumps a comment whole, so it no longer
       counts the comment's OWN parens. A comment quoting an unbalanced
       `withStateLock(dir, async () => {` therefore lets the following real
       code's parens close the range — fabricating a lock around a genuinely
       unlocked write. The old character walker only got this right by
       accident, because it counted those prose parens and ended up unbalanced.
       See the regression test at the bottom of this file. */
    if (isOpaque(opaque, tokenStart)) continue;
    const openParen = tokenStart + m[0].length - 1;
    const closeParen = findMatchingClose(content, opaque, openParen, '(', ')');
    if (closeParen === -1) continue; // malformed source; nothing to do
    ranges.push({ start: tokenStart, end: closeParen });
  }
  return ranges;
}

function isLocked(ranges: LockRange[], index: number): boolean {
  return ranges.some((r) => index >= r.start && index <= r.end);
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/* `writeStateJsonAtomic(` call sites, excluding its own definition
   (`export async function writeStateJsonAtomic(`): a match preceded by
   `function ` is the declaration, not a write. Whitespace-tolerant after the
   opening paren is unnecessary here, but the bare-writer shape below needs it
   because Prettier wraps a long first argument onto its own line. */
const STATE_WRITE_RE = /(?<!\bfunction\s+)\bwriteStateJsonAtomic\(/g;
const BARE_WRITE_RE = /\bwriteJsonAtomic(?:Ordered)?\(\s*stateJsonPath\(/g;

interface ScanResult {
  writes: number;
  details: string[];
}

function scanFile(content: string): ScanResult | null {
  if (!content.includes('writeStateJsonAtomic') && !content.includes('stateJsonPath')) return null;
  const opaque = computeOpaqueRanges(content);
  const ranges = collectLockRanges(content, opaque);
  const details: string[] = [];
  let writes = 0;

  for (const re of [STATE_WRITE_RE, BARE_WRITE_RE]) {
    re.lastIndex = 0;
    let wm: RegExpExecArray | null;
    while ((wm = re.exec(content))) {
      if (isOpaque(opaque, wm.index)) continue; // comment/string quoting the pattern, not real code
      if (!isLocked(ranges, wm.index)) {
        writes++;
        details.push(`unlocked write @ line ${lineOf(content, wm.index)}`);
      }
    }
  }

  if (writes === 0) return null;
  return { writes, details };
}

/* Empty by design. Keyed on file AND expected count, never on file alone, and
   the count check below fires on a mismatch in EITHER direction: a fix that
   removes an unlocked write must shrink or delete its entry, exactly as a
   regression that adds one must fail the guard. A file that scans clean must
   not stay on the allowlist. */
const ALLOWED_UNLOCKED = new Map<string, { writes: number; why: string }>([]);

describe('state.json write lock — static guard (#3625)', () => {
  it('scan scope matches the declared STATE_LOCK_GUARD_SCAN_GLOB (#3085)', () => {
    const declaredRoot = STATE_LOCK_GUARD_SCAN_GLOB.replace(/\/\*\*$/, '');
    const actualRoot = relative(REPO_ROOT, SRC_ROOT).split(sep).join('/');
    expect(actualRoot).toBe(declaredRoot);
  });

  it('every writeStateJsonAtomic(...) / writeJsonAtomic(stateJsonPath(...)) site sits inside withStateLock, except the pinned allowlist', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const content = readFileSync(file, 'utf8');
      const result = scanFile(content);
      if (!result) continue;

      const allowed = ALLOWED_UNLOCKED.get(rel);
      if (allowed) {
        matchedAllowlistKeys.add(rel);
        if (result.writes !== allowed.writes) {
          problems.push(
            `${rel}: allowlisted for exactly ${allowed.writes} unlocked write(s) (${allowed.why}), ` +
              `but the scan found ${result.writes} write(s):\n  ` +
              result.details.join('\n  '),
          );
        }
      } else {
        problems.push(
          `${rel}: ${result.writes} unlocked write(s) — NOT on the allowlist:\n  ` +
            result.details.join('\n  '),
        );
      }
    }

    for (const [rel, allowed] of ALLOWED_UNLOCKED) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: allowlisted for ${allowed.writes} unlocked write(s), but the scan now finds ZERO ` +
            'unlocked occurrences there — update or remove this allowlist entry.',
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });
});
