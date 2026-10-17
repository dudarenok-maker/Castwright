/* #3400, pass 7 — the static guard that stops the `state.json` lock invariant
   rotting: every write of a book's `state.json` is either enclosed in a
   per-book-lock call or is on the pinned allowlist below with a stated reason.

   WHY: a chapter restructure holds `withBookLock` across its writes. A writer
   that derives a whole-file write from an earlier read and does NOT hold the
   lock can land after it and revert the restructured chapter list (pass 6 / 7
   of PR #3594 found six such writers, one class at a time). This guard makes a
   seventh fail the build instead of a review.

   WHAT IT CHECKS: walks every non-test `.ts` file under `server/src`, parses it
   with the TypeScript parser, and for each CALL whose callee is
     - `writeStateJsonAtomic(...)`, or
     - `writeJsonAtomic(...)` / `writeJsonAtomicOrdered(...)` whose FIRST
       ARGUMENT's source text contains `stateJsonPath(`,
   asserts that the call sits lexically inside the arguments of a call to
   `withBookLock`, `withLocatedBook` or `updateStateAtDir` (the last two are
   `book-state-update.ts`'s entry points; both take the book lock). AST-based,
   so a comment or a string quoting the pattern is never a call and a nested
   template slot is real code.

   ALLOWLIST: keyed on FILE **AND** COUNT, asserted in BOTH directions — a fix
   that lowers a file's unlocked count must shrink its entry, a regression that
   raises it fails. A file-level exemption would blind the guard to any other
   unlocked write in that file.

   BLIND SPOTS (the guard stays green when it should not):
     - Call-graph blind: a write inside a helper that is only ever CALLED under
       the lock (`refreshChapterTitles`, `applySlice`, `writeRestructure`) is
       reported as unlocked and sits on the allowlist with a human-verified
       reason; a NEW unlocked caller of such a helper adds no occurrence text and
       passes.
     - Lock identity is never checked: `withBookLock('some other book', …)`
       around a write passes. Presence only.
     - An aliased import (`writeStateJsonAtomic as save`), an extracted path
       (`const p = stateJsonPath(d); writeJsonAtomic(p, …)`), a hand-built path
       (`join(d, '.audiobook', 'state.json')`), or a write via `fs.writeFile`
       are invisible. `state-language.guard.test.ts` pins the sibling
       `stateJsonPath(`/`writeJsonAtomic(` surface; neither is a total net.
     - Python / `scripts/*.mjs` writers are outside the scan (one-shot operator
       scripts; `server/src` only).
     - Only `state.json` is covered. `manuscript-edits.json` (restructure also
       rewrites it) has its writers locked by their own tests, not by this scan.

   SCOPE: `server/src/**` — the same scan scope as `cast-lock.guard.test.ts`, so
   the existing `forceRerunTriggers` entry for it (force-rerun-triggers.test.ts,
   CAST_LOCK_GUARD_SCAN_GLOB) already re-runs this guard on any server/src diff.

   MUTATION-PROOF: adding an unlocked `writeStateJsonAtomic(` to a scratch file
   under server/src, or unwrapping `book-state.ts`'s held handler from
   `withLocatedBook`, fails the guard naming the file; the self-test at the
   bottom feeds the scanner a locked and an unlocked fixture so it can fail
   without touching the tree. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

const LOCK_CALLEES = new Set(['withBookLock', 'withLocatedBook', 'updateStateAtDir']);
const PLAIN_WRITERS = new Set(['writeStateJsonAtomic']);
const PATH_WRITERS = new Set(['writeJsonAtomic', 'writeJsonAtomicOrdered']);

/** Pinned exceptions: file (relative to server/src, posix) -> expected number of
    lexically-unlocked state.json writes, with why each is acceptable. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'routes/book-state.ts': {
    count: 4,
    why:
      'refreshChapterTitles (1) is only called from GET /state inside withLocatedBook; ' +
      "applySlice's `state` slice (2: the rename-then-write pair) only runs inside withBookLock " +
      '(lockedSlice); applyReparse (1) is reparse / replace-manuscript, NOT locked: it takes the ' +
      '`cast` lock inside, and `book` is taken while holding `cast`, never the reverse -- a ' +
      'design pass is owed for the order before it can move under the book lock.',
  },
  'routes/chapters-restructure.ts': {
    count: 1,
    why: 'writeRestructure is only called inside withBookLock (all six restructure routes).',
  },
  'routes/import.ts': {
    count: 1,
    why: 'creates a brand-new book folder (fresh bookId); no other writer can hold it yet.',
  },
  'routes/samples.ts': {
    count: 1,
    why: 'installs a sample bundle as a brand-new book (fresh bookId); no other writer yet.',
  },
  'routes/generation.ts': {
    count: 1,
    why: 'generation finalize: not blocked by the restructure lock (#3625 owns it).',
  },
  'audio/finalize-chapter-write.ts': {
    count: 1,
    why: 'generation finalize: not blocked by the restructure lock (#3625 owns it).',
  },
  'routes/analysis.ts': {
    count: 3,
    why:
      'analysis persist blocks run under cast locks across a long job; moving them under the ' +
      'book lock needs a design pass on the order (and on a minutes-long hold). Out of scope here.',
  },
};

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  line: number;
  locked: boolean;
}

/** Every state.json write call in `content`, with whether it sits inside a
    lock-call's arguments. Exported-shape for the self-test below. */
function scanStateWrites(content: string): Hit[] {
  const sf = ts.createSourceFile('scan.ts', content, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];

  const calleeName = (call: ts.CallExpression): string | undefined => {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    return undefined;
  };

  const isStateWrite = (call: ts.CallExpression): boolean => {
    const name = calleeName(call);
    if (!name) return false;
    if (PLAIN_WRITERS.has(name)) return true;
    if (PATH_WRITERS.has(name)) return !!call.arguments[0]?.getText(sf).includes('stateJsonPath(');
    return false;
  };

  const insideLock = (node: ts.Node): boolean => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isCallExpression(p)) {
        const name = calleeName(p);
        if (name && LOCK_CALLEES.has(name)) {
          // The write must be within the call's ARGUMENTS (the callback), not
          // its callee expression.
          if (node.pos >= p.arguments.pos) return true;
        }
      }
    }
    return false;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isStateWrite(node)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      hits.push({ line: line + 1, locked: insideLock(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe('state.json writes hold the per-book lock (#3400)', () => {
  it('every unlocked state.json write is on the pinned allowlist (file + count)', () => {
    const unlockedByFile = new Map<string, number[]>();
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const unlocked = scanStateWrites(readFileSync(file, 'utf8'))
        .filter((h) => !h.locked)
        .map((h) => h.line);
      if (unlocked.length) unlockedByFile.set(rel, unlocked);
    }

    const problems: string[] = [];
    for (const [rel, lines] of unlockedByFile) {
      const allowed = ALLOWED[rel];
      if (!allowed) {
        problems.push(
          `${rel}: ${lines.length} unlocked state.json write(s) at line(s) ${lines.join(', ')} -- ` +
            'wrap in withLocatedBook / updateStateAtDir (workspace/book-state-update.ts) or withBookLock',
        );
      } else if (allowed.count !== lines.length) {
        problems.push(
          `${rel}: expected ${allowed.count} unlocked write(s) per the allowlist, found ${lines.length} ` +
            `(line(s) ${lines.join(', ')}) -- update the entry (it is stale, not the file clean)`,
        );
      }
    }
    for (const rel of Object.keys(ALLOWED)) {
      if (!unlockedByFile.has(rel)) {
        problems.push(`${rel}: allowlisted but no unlocked state.json write found -- remove the entry`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every allowlist entry states a reason', () => {
    for (const [rel, entry] of Object.entries(ALLOWED)) {
      expect(entry.why.length, rel).toBeGreaterThan(20);
    }
  });

  /* The scanner can fail: fixtures, no tree edit needed. */
  it('self-test: locked writes pass, unlocked writes and path-shaped writes are flagged', () => {
    const src = `
      import { writeStateJsonAtomic } from './x';
      async function a() { await withBookLock(id, async () => { await writeStateJsonAtomic(p, s); }); }
      async function b() { await withLocatedBook(id, async (l) => { await writeStateJsonAtomic(p, s); }); }
      async function c() { await updateStateAtDir(d, (s) => { return s; }); }
      async function bad1() { await writeStateJsonAtomic(p, s); }
      async function bad2() { await writeJsonAtomic(stateJsonPath(d), s); }
      async function ok3() { await writeJsonAtomic(castJsonPath(d), s); }
      // writeStateJsonAtomic(p, s) in a comment is not a call
      const str = 'writeStateJsonAtomic(p, s)';
      async function bad3() { await withBookLock(id, () => 1); await writeStateJsonAtomic(p, s); }
    `;
    const hits = scanStateWrites(src);
    expect(hits.map((h) => h.locked)).toEqual([true, true, false, false, false]);
  });
});
