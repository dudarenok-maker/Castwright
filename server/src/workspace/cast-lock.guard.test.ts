/* #1981 Task 12 — the static guard that stops the cast-lock invariant rotting.
   This is the last line of defence for the 30+ call sites this branch
   converted, so it is written to be provably able to FAIL (see the
   "mutation-proof" note at the bottom of this header) — a guard that cannot
   fail is decorative, and decorative coverage is worse than none because it
   reads as protection to the next person who touches this code.

   WHAT IT CHECKS: walks every `.ts` file under `server/src` (recursively,
   excluding `*.test.ts`) that mentions `castJsonPath`, and for each
   `writeJsonAtomic(castJsonPath(` / `rm(castJsonPath(` occurrence, asserts it
   sits inside a `withCastLock(...)` / `withCastLocks(...)` call. Only those
   two are accepted — `withLibraryVoiceLock` guards a DIFFERENT map key
   (`library-voice:<uuid>`), so a cast write enclosed by it and nothing else
   is not serialised against the other 30+ writers at all. That is the exact
   regression class this guard exists to catch, so `withLibraryVoiceLock`
   buys a site nothing here.

   METHOD — a brace/paren-depth scan over raw source text, not a parser:

     1. Every `withCastLock(` / `withCastLocks(` token becomes a "lock
        range": walk forward from its opening `(`, tracking paren depth
        (skipping string/template literals and comments so a stray `(`/`)`
        inside one can't desync the count), until the matching `)`. Everything
        between the token and that matching paren — the whole call, including
        an inline block-bodied or expression-bodied callback — counts as
        locked.
     2. One deliberate extension on top of pure textual nesting: if the
        callback passed to the lock is a BARE call to a same-file named
        function (`() => someHelper(...)`, not a block body, and not a call to
        `writeJsonAtomic`/`rm` directly), the scan also resolves `someHelper`'s
        own `function` declaration in the file and folds its body's brace
        range into the same lock range. This exists because
        `voice-override-linked.ts`'s `applyToBook` is
        `withCastLock(bookDir, () => applyToBookLocked(...))` — the actual
        read-modify-write lives in `applyToBookLocked`, a private function one
        call away, not lexically inside `withCastLock`'s own parens. Without
        this extension the scan would flag that site as unlocked even though
        `applyToBookLocked` is a non-exported helper with exactly one caller,
        always invoked through the lock. The resolution is intentionally
        narrow: ONE level (it does not chase a second hop of indirection),
        same-file only, and only for a `function name(...)` declaration (not
        a `const name = (...) => ...` expression). Nothing else in this
        branch needs a second level, per cast-lock.ts rule 1 ("a locked
        function must not call another locked function on the same book") —
        a helper delegated to like this is by construction NOT itself locked,
        so there is nothing further to chase.
     3. Each `writeJsonAtomic(castJsonPath(` / `rm(castJsonPath(` occurrence
        (word-boundary literal match — deliberately narrow, see blind spots
        below) is "locked" iff its start index falls inside some lock range
        for that file.

   ACCEPTANCE TARGET (pinned literally, not derived): `routes/analysis.ts` is
   the one allowed exception — its five merge-base `writeJsonAtomic` calls are
   deferred to #2015 (four rejected designs are recorded in cast-lock.ts's own
   header; this guard is not the place to attempt a fifth). Its one `rm` (the
   "Start fresh" delete, Task 11) IS locked. The allowlist below is keyed on
   FILE **AND** COUNT, never file alone — a file-level exemption would also
   blind the guard to the one `rm` that Task 11 correctly locked, which is
   exactly spec §5 class 6's hole. A sixth unlocked write in that file, or a
   fewer/greater count anywhere else, fails the guard rather than silently
   passing under a stale exemption.

   KNOWN BLIND SPOTS — this guard sees ONE syntactic form per occurrence type,
   plus the one narrow delegate extension above. It does NOT catch:
     - An extracted path variable: `const p = castJsonPath(dir); await
       writeJsonAtomic(p, …)` — the literal `writeJsonAtomic(castJsonPath(`
       substring never appears, so the occurrence regex never fires.
     - A writer routed through `workspace/schema-migrate.ts`'s cast.json
       migration seam, which does not call `writeJsonAtomic`/`castJsonPath`
       directly by these names.
     - A second (or deeper) hop of function-call indirection beyond the one
       level the delegate extension resolves.
     - A callback assigned to a `const` and referenced by name, rather than
       either an inline body or a bare call expression.
     - Code hidden inside a template-literal `${...}` expression — template
       literals are treated as opaque text (skipped whole, like any other
       string) for the purposes of paren/brace balancing, so a lock or write
       token that only exists inside one would be invisible.
     - The occurrence search itself (step 3 above) is a plain text match, NOT
       comment/string-aware the way the lock-range balancer is — a comment or
       string literal that happens to spell out the exact substring
       `writeJsonAtomic(castJsonPath(` or `rm(castJsonPath(` would be counted
       as a real site. Found live while proving this guard can fail (see
       below): an early draft of this file's own header spelled out that
       literal in prose and the guard flagged ITSELF. Reworded here to avoid
       it; no file in this branch's real `server/src` source (as opposed to
       this guard's own prose) currently contains either substring inside a
       comment or string, so this is a latent gap, not a live false positive
       — but a future comment quoting the pattern verbatim would trip it.
   An honest guard with stated limits beats one that implies total coverage.

   MUTATION-PROOF (see task-12-brief.md Step 2, and the report this task
   returns): this guard was verified able to fail two different ways —
   unwrapping a converted site so it reddens naming that exact file, and
   widening the allowlist's own target count so a 6th unlocked write in
   analysis.ts is NOT silently absorbed — and verified able to correctly
   NOT accept `withLibraryVoiceLock` as a substitute lock. Every mutation was
   reverted exactly (`git diff` empty) before this file was finalised; the
   guard's own test run is the read-only, permanent check that ships. */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Scan forward from `openIndex` (which must hold `openChar`) for the
    matching `closeChar`, tracking nesting depth. String/template literals and
    comments are skipped whole so a bracket character inside one can't desync
    the count. Returns -1 if unmatched (malformed source). */
function findMatchingClose(src: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let i = openIndex;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
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

/** Locate a same-file `function <name>(...) { ... }` (optionally `async`)
    declaration and return its body's `[openBraceIndex, closeBraceIndex]`, or
    null if not found / malformed. */
function findFunctionBodyRange(content: string, fnName: string): [number, number] | null {
  const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declRe = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`);
  const declMatch = declRe.exec(content);
  if (!declMatch) return null;
  const paramsOpen = content.indexOf('(', declMatch.index);
  const paramsClose = findMatchingClose(content, paramsOpen, '(', ')');
  if (paramsClose === -1) return null;
  let i = paramsClose + 1;
  while (i < content.length && content[i] !== '{') i++;
  if (i >= content.length) return null;
  const bodyClose = findMatchingClose(content, i, '{', '}');
  if (bodyClose === -1) return null;
  return [i, bodyClose];
}

interface LockRange {
  start: number;
  end: number;
}

/** Every `withCastLock(...)` / `withCastLocks(...)` call's span in `content`,
    plus (see file header, extension 2) the resolved body range of a bare
    same-file function the callback delegates to in one hop. */
function collectLockRanges(content: string): LockRange[] {
  const ranges: LockRange[] = [];
  const tokenRe = /\bwithCastLocks?\(/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(content))) {
    const tokenStart = m.index;
    const openParen = tokenStart + m[0].length - 1;
    const closeParen = findMatchingClose(content, openParen, '(', ')');
    if (closeParen === -1) continue; // malformed source; nothing to do
    ranges.push({ start: tokenStart, end: closeParen });

    // Extension 2 — resolve a one-hop bare-call delegate (see file header).
    const arrowIdx = content.indexOf('=>', openParen);
    if (arrowIdx !== -1 && arrowIdx < closeParen) {
      let j = arrowIdx + 2;
      while (j < closeParen && /\s/.test(content[j])) j++;
      if (content[j] !== '{') {
        const rest = content.slice(j, closeParen);
        const callMatch = /^([A-Za-z_$][\w$]*)\(/.exec(rest);
        if (callMatch) {
          const calleeName = callMatch[1];
          if (calleeName !== 'writeJsonAtomic' && calleeName !== 'rm') {
            const bodyRange = findFunctionBodyRange(content, calleeName);
            if (bodyRange) ranges.push({ start: bodyRange[0], end: bodyRange[1] });
          }
        }
      }
    }
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

const WRITE_RE = /\bwriteJsonAtomic\(castJsonPath\(/g;
const RM_RE = /\brm\(castJsonPath\(/g;

interface ScanResult {
  writes: number;
  rms: number;
  details: string[];
}

function scanFile(content: string): ScanResult | null {
  if (!content.includes('castJsonPath')) return null;
  const ranges = collectLockRanges(content);
  const details: string[] = [];
  let writes = 0;
  let rms = 0;

  WRITE_RE.lastIndex = 0;
  let wm: RegExpExecArray | null;
  while ((wm = WRITE_RE.exec(content))) {
    if (!isLocked(ranges, wm.index)) {
      writes++;
      details.push(`unlocked write @ line ${lineOf(content, wm.index)}`);
    }
  }

  RM_RE.lastIndex = 0;
  let rmMatch: RegExpExecArray | null;
  while ((rmMatch = RM_RE.exec(content))) {
    if (!isLocked(ranges, rmMatch.index)) {
      rms++;
      details.push(`unlocked rm @ line ${lineOf(content, rmMatch.index)}`);
    }
  }

  if (writes === 0 && rms === 0) return null;
  return { writes, rms, details };
}

/* One entry by design: analysis.ts's five merge-base writes are deferred to
   #2015 and stay unlocked in this PR.

   Keyed on file AND expected count, never on file alone. A file-level
   exemption for analysis.ts would also blind the guard to the one rm that IS
   locked (Task 11) — the exact hole spec §5 class 6 exists to close. A sixth
   unlocked write in that file must fail the guard, not inherit the
   exemption. */
const ALLOWED_UNLOCKED = new Map<string, { writes: number; rms: number; why: string }>([
  [
    'routes/analysis.ts',
    { writes: 5, rms: 0, why: 'merge-base writes deferred to #2015; the rm IS locked (Task 11)' },
  ],
]);

describe('cast.json write lock — static guard (#1981 Task 12)', () => {
  it('every writeJsonAtomic(castJsonPath(...)) / rm(castJsonPath(...)) site sits inside withCastLock/withCastLocks, except the pinned allowlist', () => {
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
        if (result.writes !== allowed.writes || result.rms !== allowed.rms) {
          problems.push(
            `${rel}: allowlisted for exactly ${allowed.writes} unlocked write(s) / ${allowed.rms} unlocked rm(s) ` +
              `(${allowed.why}), but the scan found ${result.writes} write(s) / ${result.rms} rm(s):\n  ` +
              result.details.join('\n  '),
          );
        }
      } else {
        problems.push(
          `${rel}: ${result.writes} unlocked write(s), ${result.rms} unlocked rm(s) — NOT on the allowlist:\n  ` +
            result.details.join('\n  '),
        );
      }
    }

    for (const [rel, allowed] of ALLOWED_UNLOCKED) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: allowlisted for ${allowed.writes} unlocked write(s) / ${allowed.rms} unlocked rm(s), but the ` +
            'scan now finds ZERO unlocked occurrences there — update or remove this allowlist entry.',
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });
});
