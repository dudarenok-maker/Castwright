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

   METHOD: a paren-depth scan over raw source text using the shared
   TypeScript-parser-backed opaque-range tokenizer in
   `server/src/test-utils/guard-scan.ts` (#3685); comments and
   string/regex/template-chunk text are skipped.
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
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectSourceFiles,
  computeAstOpaqueRanges,
  findMatchingClose,
  isOpaque,
  lineOf,
  OpaqueRange,
} from '../test-utils/guard-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

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

// `(?<!function\s)` skips the declaration itself; whitespace-tolerant between
// the parens so a Prettier-wrapped call is still seen.
const WRITE_RE =
  /(?<!function\s)\bwriteStateJsonAtomic\(|\bwriteJsonAtomic(?:Ordered)?\(\s*stateJsonPath\(/g;

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
      const opaque = computeAstOpaqueRanges(content);
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
      'routes/chapters-restructure.ts',
      'workspace/auto-backup.ts',
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
    expect(collectLockRanges(src, computeAstOpaqueRanges(src))).toEqual([]);
  });
});
