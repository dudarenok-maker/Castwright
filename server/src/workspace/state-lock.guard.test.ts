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

   THE SCANNER IS SHARED: the file walker, the AST opaque-range tokenizer
   and the balanced-paren matcher live in `../test-utils/guard-scan.ts`
   (#3685), imported here and by `cast-lock.guard.test.ts` and
   `voice-library-write-seam.guard.test.ts`; only the lock-token regex and the
   write regexes below are this guard's own. Fixes to a failure mode recorded
   in cast-lock's header and in guard-scan.ts (opaque ranges for strings /
   templates / regexes / comments, balanced-paren lock spans) apply here
   equally - read both when changing this file.

   ALLOWLIST: keyed on file AND count, checked in BOTH directions (a stale
   entry fails, a count that moved fails). It starts empty; do not add an entry
   to silence a site that can be wrapped. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type OpaqueRange,
  collectSourceFiles,
  computeAstOpaqueRanges,
  findMatchingClose,
  isOpaque,
  lineOf,
} from '../test-utils/guard-scan.js';
import { STATE_LOCK_GUARD_SCAN_GLOB } from './state-lock.guard-targets.js';

// The file walker, AST opaque-range tokenizer (and its history) and balanced-paren
// matcher live in ../test-utils/guard-scan.ts (#3685).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src
const REPO_ROOT = join(SRC_ROOT, '..', '..');

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
  const opaque = computeAstOpaqueRanges(content);
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

  /* ===== Fixture self-tests (pure, no disk). Each mirrors a fail-open the
     cast-lock scanner once had (see `cast-lock.guard.test.ts` and the tokenizer
     header above): without them a scanner regression passes silently. ===== */

  // A nested template literal holding a `(` must not desync the paren balancer.
  it('a nested template literal inside a lock callback does not desync the paren balancer', () => {
    const src = [
      'await withStateLock(dir, async () => {',
      '  log(`a ${flag ? `b(` : `c`} d`);',
      '  await writeStateJsonAtomic(dir, next);',
      '});',
      'await writeStateJsonAtomic(other, next2);',
    ].join('\n');

    const result = scanFile(src);
    expect(result?.writes, JSON.stringify(result)).toBe(1);
    expect(result?.details.join('\n')).toContain('line 5');
  });

  // Prose quoting an unbalanced lock opener must not wrap the following real code.
  it('a withStateLock( that exists only in a // comment does not fabricate a lock range', () => {
    const src = [
      '// historical: this used to be withStateLock(dir, async () => {',
      'await writeStateJsonAtomic(dir, next);',
    ].join('\n');

    const result = scanFile(src);
    expect(result?.writes, `fabricated lock range: ${JSON.stringify(result)}`).toBe(1);
    expect(collectLockRanges(src, computeAstOpaqueRanges(src))).toEqual([]);
  });

  it('a withStateLock( in a /* */ comment on the LAST LINE OF A BLOCK fabricates no lock range either', () => {
    const src = [
      'await run(async () => {',
      '  try {',
      '    await doSomething();',
      '  } catch {',
      '    /* historical: this used to be withStateLock(dir, async () => { */',
      '  }',
      '  await writeStateJsonAtomic(dir, next);',
      '});',
    ].join('\n');

    const result = scanFile(src);
    expect(result?.writes, `fabricated lock range: ${JSON.stringify(result)}`).toBe(1);
    expect(result?.details.join('\n')).toContain('line 7');
    expect(collectLockRanges(src, computeAstOpaqueRanges(src))).toEqual([]);
  });

  it('a withStateLock( inside a string literal fabricates no lock range', () => {
    const src = [
      "const doc = 'withStateLock(dir, async () => {';",
      'await writeStateJsonAtomic(dir, next);',
    ].join('\n');

    const result = scanFile(src);
    expect(result?.writes, `fabricated lock range: ${JSON.stringify(result)}`).toBe(1);
    expect(collectLockRanges(src, computeAstOpaqueRanges(src))).toEqual([]);
  });

  it('the writeStateJsonAtomic definition is not counted as a call', () => {
    const src = 'export async function writeStateJsonAtomic(dir: string, doc: unknown) {}';

    expect(scanFile(src)).toBeNull();
  });

  it('an unlocked writeJsonAtomicOrdered(stateJsonPath(...)) is reported', () => {
    const src = 'await writeJsonAtomicOrdered(stateJsonPath(dir), doc);';

    const result = scanFile(src);
    expect(result?.writes, JSON.stringify(result)).toBe(1);
    expect(result?.details.join('\n')).toContain('line 1');
  });

  it('an unlocked writeJsonAtomic(stateJsonPath(...)) is reported', () => {
    const src = 'await writeJsonAtomic(stateJsonPath(dir), doc);';

    const result = scanFile(src);
    expect(result?.writes, JSON.stringify(result)).toBe(1);
    expect(result?.details.join('\n')).toContain('line 1');
  });

  it('a writeStateJsonAtomic( correctly inside withStateLock is not reported', () => {
    const src = [
      'await withStateLock(dir, async () => {',
      '  const state = await readJson(stateJsonPath(dir));',
      '  await writeStateJsonAtomic(dir, { ...state });',
      '});',
    ].join('\n');

    expect(scanFile(src)).toBeNull();
  });
});
