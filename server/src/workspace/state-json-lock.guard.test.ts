/* #3700 — the static guard that stops the state.json lock invariant rotting.
   Mirrors `cast-lock.guard.test.ts` (same syntactic approach, same blind
   spots) for the per-book `state-json` leaf lock (`withStateJsonLock`,
   `workspace/file-lock.ts`).

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src` and, for
   each `writeStateJsonAtomic(` call (or `writeJsonAtomic(stateJsonPath(` /
   `writeJsonAtomicOrdered(stateJsonPath(`), asserts it sits inside a
   `withStateJsonLock(...)` call. `updateStateJsonLocked` (state-migrate.ts)
   is the shared locked read-modify-write helper; its OWN write sits inside a
   `withStateJsonLock(`, so it scans clean and callers of it need no token.
   The declaration `function writeStateJsonAtomic(` is not a call and is
   skipped. Only `withStateJsonLock` is accepted: the cast/design/revisions
   locks guard different keys and buy a state.json write nothing.

   METHOD: a paren-depth scan over raw source text with the same
   TypeScript-parser-backed opaque-range tokenizer as the cast guard (comments
   and string/regex/template-chunk text are skipped), copied byte-for-byte —
   a test below fails the build if the copy drifts from cast-lock.guard.test.ts.
   The existing `server/src/**` entry in vitest.config.ts's forceRerunTriggers
   already re-runs every guard here on any server/src change.

   FALSE NEGATIVES (unlocked writes this does NOT catch):
     - A hand-built path or extracted variable feeding a bare writer:
       `const p = stateJsonPath(d); writeJsonAtomic(p, ...)` — only the
       literal `writeJsonAtomic(stateJsonPath(` shape is seen. The bare
       writers that exist today are `writeStateJsonAtomic`'s own body in
       `state-migrate.ts` (`writeJsonAtomic(path, ...)`), the primitive every
       locked site calls through, and `import/scan-import-folder.ts`'s phase-2
       `rename(s.tmp, s.dest)` of a staged state.json, which this scan cannot
       see (no `stateJsonPath(` argument at the rename) and which is locked by
       hand under `withStateJsonLock` when an 'overwrite' import replaces an
       existing book (pinned by scan-import-folder.test.ts, not by this guard).
     - An aliased import (`import { writeStateJsonAtomic as w }`).
     - Lock IDENTITY is never checked, only PRESENCE: a write inside
       `withStateJsonLock(otherBook, ...)` passes.
     - ANY function-call indirection between the lock callback and the write
       (a locked helper called from an unlocked new site adds no occurrence
       text). `updateStateJsonLocked` is exactly such a helper; its callers
       are unchecked by design.
     - `scripts/*.mjs` and anything outside `server/src`.
     - READS are not checked: a lock only protects the read-modify-write if
       the read sits INSIDE it, which this scan cannot see.

   FALSE POSITIVES: a callback assigned to a const and passed by name, or a
   lock whose callback delegates to a same-file helper holding the write.

   Keyed on FILE AND COUNT, both directions, exactly as the cast guard. The
   allowlist is intentionally empty today. */
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

interface LockRange {
  start: number;
  end: number;
}

/** Every `withStateJsonLock(...)` call's span in `content`. */
function collectLockRanges(content: string, opaque: OpaqueRange[]): LockRange[] {
  const ranges: LockRange[] = [];
  const tokenRe = /\bwithStateJsonLock\(/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(content))) {
    const tokenStart = m.index;
    // Prose or a string quoting the token must not fabricate a lock range.
    if (isOpaque(opaque, tokenStart)) continue;
    const openParen = tokenStart + m[0].length - 1;
    const closeParen = findMatchingClose(content, opaque, openParen, '(', ')');
    if (closeParen === -1) continue; // malformed source
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

// `(?<!function\s)` skips the declaration itself; whitespace-tolerant between
// the parens so a Prettier-wrapped call is still seen.
const WRITE_RE = /(?<!function\s)\bwriteStateJsonAtomic\(|\bwriteJsonAtomic(?:Ordered)?\(\s*stateJsonPath\(/g;

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

  WRITE_RE.lastIndex = 0;
  let wm: RegExpExecArray | null;
  while ((wm = WRITE_RE.exec(content))) {
    if (isOpaque(opaque, wm.index)) continue; // prose/string quoting the pattern
    if (!isLocked(ranges, wm.index)) {
      writes++;
      details.push(`unlocked write @ line ${lineOf(content, wm.index)}`);
    }
  }

  if (writes === 0) return null;
  return { writes, details };
}

/* Empty by design: every state.json writer in server/src is locked. A file
   that scans clean must not be listed (the unmatched-key check below fails). */
const ALLOWED_UNLOCKED = new Map<string, { writes: number; why: string }>([]);

describe('state.json write lock — static guard (#3700)', () => {
  it('every writeStateJsonAtomic( / writeJsonAtomic(stateJsonPath( site sits inside withStateJsonLock, except the pinned allowlist', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const result = scanFile(readFileSync(file, 'utf8'));
      if (!result) continue;

      const allowed = ALLOWED_UNLOCKED.get(rel);
      if (allowed) {
        matchedAllowlistKeys.add(rel);
        if (result.writes !== allowed.writes) {
          problems.push(
            `${rel}: allowlisted for exactly ${allowed.writes} unlocked write(s) (${allowed.why}), ` +
              `but the scan found ${result.writes}:\n  ` +
              result.details.join('\n  '),
          );
        }
      } else {
        problems.push(
          `${rel}: ${result.writes} unlocked state.json write(s) — NOT on the allowlist:\n  ` +
            result.details.join('\n  '),
        );
      }
    }

    for (const [rel, allowed] of ALLOWED_UNLOCKED) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: allowlisted for ${allowed.writes} unlocked write(s), but the scan now finds ZERO — ` +
            'update or remove this allowlist entry.',
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('the scan is real: the known locked sites are seen (a scan that finds nothing proves nothing)', () => {
    const sawLocked = (rel: string): boolean => {
      const content = readFileSync(join(SRC_ROOT, rel), 'utf8');
      const opaque = computeOpaqueRanges(content);
      const ranges = collectLockRanges(content, opaque);
      WRITE_RE.lastIndex = 0;
      let wm: RegExpExecArray | null;
      let seen = 0;
      while ((wm = WRITE_RE.exec(content))) {
        if (!isOpaque(opaque, wm.index) && isLocked(ranges, wm.index)) seen++;
      }
      return seen > 0;
    };
    for (const rel of [
      'audio/finalize-chapter-write.ts',
      'routes/generation.ts',
      'routes/book-state.ts',
      'workspace/state-migrate.ts',
      'cover/store.ts',
      'routes/analysis.ts',
    ]) {
      expect(sawLocked(rel), `${rel}: expected at least one locked state.json write`).toBe(true);
    }
  });

  it('an unlocked writeStateJsonAtomic is reported, a locked one is not', () => {
    const src = [
      'await withStateJsonLock(p, async () => {',
      '  await writeStateJsonAtomic(p, s);',
      '});',
      'await writeStateJsonAtomic(other, s2);',
    ].join('\n');
    const result = scanFile(src);
    expect(result?.writes, JSON.stringify(result)).toBe(1);
    expect(result?.details.join('\n')).toContain('line 4');
  });

  it('a bare writeJsonAtomic(stateJsonPath(...)) is reported like writeStateJsonAtomic', () => {
    const result = scanFile('await writeJsonAtomic(\n  stateJsonPath(dir), s);');
    expect(result?.writes, JSON.stringify(result)).toBe(1);
  });

  it('withCastLock does not count as the state-json lock', () => {
    const src = 'await withCastLock(dir, async () => { await writeStateJsonAtomic(p, s); });';
    expect(scanFile(src)?.writes).toBe(1);
  });

  it('the function declaration, an import and prose are not call sites', () => {
    const src = [
      "import { writeStateJsonAtomic } from './state-migrate.js';",
      '// call writeStateJsonAtomic(p, s) only under withStateJsonLock(',
      'export async function writeStateJsonAtomic(path: string) {}',
    ].join('\n');
    expect(scanFile(src)).toBeNull();
  });

  it('prose quoting an unbalanced withStateJsonLock( does not fabricate a lock range', () => {
    const src = [
      'await run(async () => {',
      '  try {',
      '    await doSomething();',
      '  } catch {',
      '    // historical: this used to be withStateJsonLock(p, async () => {',
      '  }',
      '  await writeStateJsonAtomic(p, s);',
      '});',
    ].join('\n');
    const result = scanFile(src);
    expect(result?.writes, `fabricated lock range: ${JSON.stringify(result)}`).toBe(1);
    expect(collectLockRanges(src, computeOpaqueRanges(src))).toEqual([]);
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
