/* #3625 pass 6 (🟠1) - the static guard that keeps every state.json READ on
   the recovering path. Sibling of `state-json-lock.guard.test.ts` (which
   checks the writes): same syntactic approach, same tokenizer.

   WHY: a rotating write (`writeJsonAtomic` with `{ rotate }`, which every
   `writeStateJsonAtomic` is) renames main to `.bak.1` BEFORE it renames the new
   file in - the order #3625 chose because #3706's copy-then-replace failed with
   EPERM on Windows. For that window `.audiobook/state.json` is absent. A plain
   read there (`readJson` -> null, `existsSync` -> false, a raw `readFile` ->
   ENOENT) sees "no book": a series walk skips it, the library-voice DELETE
   misses its "in use" 409. `readStateJsonWithRecovery` (state-migrate.ts)
   serves `.bak.1` in that window instead, and still answers `null` for a
   genuinely absent book.

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src` except
   `workspace/state-io.ts` (the primitives) and `workspace/state-migrate.ts`
   (the recovering read itself), and fails on any of these outside a comment or
   string:
     - `readJson(stateJsonPath(` / `readJson<...>(stateJsonPath(`;
     - `readJson<BookStateJson>(` with any argument;
     - `readJsonWithRecovery(stateJsonPath(` (the bare primitive: without
       `recoverMissing` it reads the window as absent);
     - `existsSync` / `statSync` / `stat` / `access` / `readFile` /
       `readFileSync` / `copyFile` / `createReadStream` called on
       `stateJsonPath(`.

   FALSE NEGATIVES (plain reads this does NOT catch):
     - An extracted variable: `const sp = stateJsonPath(d); readFile(sp)` -
       exactly the shape `auto-backup.ts` had before this guard. Only a
       `stateJsonPath(` written inside the reader's own parens is seen.
     - A hand-built path: `join(dir, '.audiobook', 'state.json')` (the file
       name is a string literal, which the tokenizer skips). Today that is
       `routes/samples.ts`, which reads the COMMITTED sample bundles under
       `samples/` (nothing writes them at runtime, so they have no window), and
       `scan.ts`'s own recovering reads.
     - A path list: `workspace/upgrade-coordinator.ts` copies `state.json` by
       name out of `PER_BOOK_BACKUP_FILES` for its pre-migration snapshot.
     - An aliased import (`import { readJson as r }`), or a reader reached
       through a helper this scan cannot follow.
     - `scripts/*.mjs` and anything outside `server/src`.
     - A presence check that is correct on purpose reads the same as a plain
       one; such a site would go on the allowlist with its reason.

   FALSE POSITIVES: none known. Prose and strings quoting a pattern are
   skipped by the tokenizer (tested below).

   Keyed on FILE AND COUNT, both directions, like the write guard. The
   allowlist is empty today. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

/** The files that own the primitives and the recovering read itself. */
const EXEMPT = new Set(['workspace/state-io.ts', 'workspace/state-migrate.ts']);

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

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/* Whitespace-tolerant between the parens so a Prettier-wrapped call is seen. */
const READ_RE = new RegExp(
  [
    String.raw`\breadJson\s*(?:<[^()]*?>)?\s*\(\s*stateJsonPath\(`,
    String.raw`\breadJson\s*<\s*BookStateJson\b`,
    String.raw`\breadJsonWithRecovery\s*(?:<[^()]*?>)?\s*\(\s*stateJsonPath\(`,
    String.raw`\b(?:existsSync|statSync|stat|access|readFile|readFileSync|copyFile|createReadStream)\s*\(\s*stateJsonPath\(`,
  ].join('|'),
  'g',
);

interface ScanResult {
  reads: number;
  details: string[];
}

function scanFile(content: string): ScanResult | null {
  if (!content.includes('stateJsonPath') && !content.includes('BookStateJson')) return null;
  const opaque = computeOpaqueRanges(content);
  const details: string[] = [];
  READ_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = READ_RE.exec(content))) {
    if (isOpaque(opaque, m.index)) continue; // prose/string quoting the pattern
    details.push(`plain state.json read @ line ${lineOf(content, m.index)}: ${m[0].replace(/\s+/g, ' ')}`);
  }
  if (details.length === 0) return null;
  return { reads: details.length, details };
}

/* Empty by design: every state.json reader in server/src recovers. A file that
   scans clean must not be listed (the unmatched-key check below fails). */
const ALLOWED_PLAIN = new Map<string, { reads: number; why: string }>([]);

describe('state.json reads go through the recovering read — static guard (#3625 pass 6)', () => {
  it('no plain read of state.json outside state-io.ts / state-migrate.ts, except the pinned allowlist', () => {
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      if (EXEMPT.has(rel)) continue;
      const result = scanFile(readFileSync(file, 'utf8'));
      if (!result) continue;
      const allowed = ALLOWED_PLAIN.get(rel);
      if (allowed) {
        matchedAllowlistKeys.add(rel);
        if (result.reads !== allowed.reads) {
          problems.push(
            `${rel}: allowlisted for exactly ${allowed.reads} plain read(s) (${allowed.why}), ` +
              `but the scan found ${result.reads}:\n  ` +
              result.details.join('\n  '),
          );
        }
      } else {
        problems.push(
          `${rel}: ${result.reads} plain state.json read(s) — use readStateJsonWithRecovery:\n  ` +
            result.details.join('\n  '),
        );
      }
    }
    for (const [rel, allowed] of ALLOWED_PLAIN) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: allowlisted for ${allowed.reads} plain read(s), but the scan now finds ZERO — ` +
            'update or remove this allowlist entry.',
        );
      }
    }
    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('the scan is real: it reports the plain read the pre-fix voices.ts held (a scan that sees nothing proves nothing)', () => {
    const content = readFileSync(join(SRC_ROOT, 'routes/voices.ts'), 'utf8');
    const reverted = content.replace(/readStateJsonWithRecovery\(/g, 'readJson<BookStateJson>(');
    expect(reverted).not.toBe(content);
    expect(scanFile(reverted)?.reads ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('each plain-read shape is reported', () => {
    const src = [
      'const a = await readJson<BookStateJson>(stateJsonPath(dir));',
      'const b = await readJson(\n  stateJsonPath(dir),\n);',
      'const c = await readJson<BookStateJson>(somePath);',
      'if (!existsSync(stateJsonPath(dir))) return;',
      "const d = await readFile(stateJsonPath(dir), 'utf8');",
      'const e = await readJsonWithRecovery(stateJsonPath(dir), { keep: 3 });',
      'const f = await readJson<{ bookId?: string }>(stateJsonPath(dir));',
    ].join('\n');
    expect(scanFile(src)?.reads, JSON.stringify(scanFile(src))).toBe(7);
  });

  it('the recovering read, the writes, prose and strings are not plain reads', () => {
    const src = [
      'const s = await readStateJsonWithRecovery(stateJsonPath(dir));',
      'await writeStateJsonAtomic(stateJsonPath(dir), s);',
      'await withStateJsonLock(stateJsonPath(dir), async () => {});',
      '// never readJson<BookStateJson>(stateJsonPath(dir)) here',
      "const msg = 'existsSync(stateJsonPath(dir))';",
    ].join('\n');
    expect(scanFile(src)).toBeNull();
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
