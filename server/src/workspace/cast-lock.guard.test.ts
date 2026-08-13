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
        (skipping string/template literals and comments — via the same
        `skipOpaqueToken` predicate the occurrence scan uses, see step 3 —
        so a stray `(`/`)` inside one can't desync the count), until the
        matching `)`. Everything between the token and that matching paren —
        the whole call, including an inline block-bodied or
        expression-bodied callback — counts as locked. Pure textual nesting,
        nothing more: this scan does NOT chase a callback that only
        delegates to a same-file helper (see "Removed" below).
     2. REMOVED (this task, #1981 Task 12 hardening): an earlier draft folded
        a same-file `function name(...)` declaration's body into the lock
        range whenever a lock's callback was a bare call to that name — meant
        to cover `voice-override-linked.ts`'s `applyToBook`, which is
        `withCastLock(bookDir, () => applyToBookLocked(...))` with the actual
        read-modify-write one call away in `applyToBookLocked`. Independent
        review found it unsound two ways, either alone fatal: (a) it resolved
        by NAME with no caller check, so a second, genuinely unlocked caller
        of the same-named function stayed folded-as-locked and the guard
        stayed green on a real unserialised write; (b) `findFunctionBodyRange`
        took the first textual match of the name anywhere in the file with no
        scope awareness, so a second, inner declaration of the same name
        would silently fold the WRONG body. Deleted outright rather than
        patched — a resolver that has to reason about caller identity and
        lexical scope to be sound is no longer a "raw source text" scan, it's
        a hand-rolled partial parser with the bugs to match. The one real site
        it existed for is now on the pinned allowlist below instead, with an
        honest "can't prove it, human-verified" `why`.
     3. Each `writeJsonAtomic(castJsonPath(` / `rm(castJsonPath(` occurrence
        is a match of `/\bwriteJsonAtomic\(\s*castJsonPath\(/` /
        `/\brm\(\s*castJsonPath\(/` (whitespace-tolerant between the two
        opening parens — see "Prettier-wrap" in the false-negatives list
        below for why the earlier exact-adjacency version was itself a hole)
        whose start index (a) falls inside some lock range for that file, per
        step 1, AND (b) is not itself inside a string/template literal or a
        comment, per the same `skipOpaqueToken` predicate step 1 uses for its
        own paren/brace balancing — this task extracted that predicate into
        a standalone function and wired it into the occurrence scan too,
        which it previously bypassed entirely (see "Fixed" in the
        false-positives list below).

   ACCEPTANCE TARGET (pinned literally, not derived): `routes/voice-override-
   linked.ts` is the one allowed exception — its one `writeJsonAtomic` (inside
   `applyToBookLocked`) IS genuinely locked, via `applyToBook`'s
   `withCastLock(bookDir, () => applyToBookLocked(...))`, but this scan is
   deliberately syntactic-only (see "Removed" above) and cannot prove a call
   crosses a function boundary, so it reports the site as unlocked; an unsound
   fold that pretended otherwise was worse. `routes/analysis.ts` was the
   second allowed exception through #2015/#2155 — its five merge-base
   `writeJsonAtomic` calls (four rejected designs for closing them are
   recorded in cast-lock.ts's own header) were deferred, with an entry here;
   its one `rm` (the "Start fresh" delete, Task 11) was never deferred — it
   IS locked, and always was. #2155 Task 5 closed the deferred half: the five
   writes now go through `createCastMergeBase`'s `writeChecked`, which takes
   the lock itself — true, but **this guard cannot check that claim**. The
   write it actually emits (`cast-merge-base.ts`'s `const path =
   castJsonPath(bookDir); … writeJsonAtomic(path, payload)`) is the
   extracted-path-variable false negative documented below, so the scan
   never sees an occurrence there to test at all; `writeChecked`'s locking is
   proven by `cast-merge-base.test.ts`'s concurrency test instead (see the
   false-negatives entry for the full pointer), not by this file going green.
   What this file's green DOES prove is that `analysis.ts` now scans clean —
   its entry is gone (see below), not zeroed, which is a real fact about
   `analysis.ts`'s own source text even though it says nothing about what's
   inside `writeChecked`. The allowlist is keyed on FILE **AND** COUNT, never
   file alone, and the count is asserted in BOTH directions — a fix that
   makes a file's unlocked count go DOWN must shrink or remove its entry just
   as much as a regression that makes it go UP must fail the guard; drifting
   either way without updating the entry means the allowlist is stale, not
   that the file is clean. A file-level exemption would blind the guard to
   any OTHER unlocked write in that file — for `voice-override-linked.ts`
   that means a second, genuinely unlocked write landing there would inherit
   the same exemption as the one verified site; keying on count instead means
   it fails the guard, not silently passes under a stale exemption.

   FALSE NEGATIVES (unlocked writes the guard does NOT catch — it stays
   green when it should not):
     - An extracted path variable: `const p = castJsonPath(dir); await
       writeJsonAtomic(p, …)` — the literal `writeJsonAtomic(castJsonPath(`
       substring never appears, so the occurrence regex never fires. **Live,
       not just illustrative, as of #2015/#2155**: `workspace/cast-merge-
       base.ts`'s `writeChecked` is written exactly this way (`const path =
       castJsonPath(bookDir); … writeJsonAtomic(path, payload)`), so this
       guard pins ZERO facts about the write path all five of Task 5's sites
       now go through — it neither proves `writeChecked` takes the lock nor
       would catch a regression that dropped the `withCastLock` around it.
       The compensating control lives elsewhere: `cast-merge-base.test.ts`'s
       "two concurrent `writeChecked` calls do not interleave
       read-compare-write" is the outcome-shaped proof that the lock is
       real — it asserts exactly one conflict is observed under real
       concurrency, not that a `withCastLock` token appears at the call
       site, so it can't be satisfied by a lock-shaped no-op the way a
       source-text scan could be.
     - An aliased writer import: `import { writeJsonAtomic as saveJson }
       from '../workspace/state-io.js'` — the occurrence regex matches the
       literal name `writeJsonAtomic`, not the binding, so a call written as
       `saveJson(castJsonPath(dir), …)` is invisible.
     - An aliased path import: `import { castJsonPath as castPath } from
       '../workspace/paths.js'` — same gap, mirrored on the other name.
     - A hand-built path: `writeJsonAtomic(join(d, 'cast.json'), c)` — no
       `castJsonPath(` call at all, so the occurrence never fires even though
       the file written is the same one.
     - Lock IDENTITY is never checked, only lock PRESENCE: a site shaped
       `withCastLock('/unrelated/book', () => { … writeJsonAtomic(
       castJsonPath(bookDir), … ) })` passes, because the scan only asks
       "is this write's index inside *some* `withCastLock(...)` call's
       parens", never "does that call's first argument match the `bookDir`
       the write itself resolves against". Out of scope for the guard's
       stated spec ("lockedness only"), but on THIS branch, which has four
       cross-book routes (`voice-override-linked.ts`,
       `cast-not-linked-to.ts`, `cast-link-prior.ts`, `library-cast-override.ts`),
       a mismatched-book lock is a realistic regression shape, not a
       hypothetical one, so it is named here rather than left implicit.
     - ANY function-call indirection between a lock's callback and the write
       it actually guards — including the single-hop case the deleted
       extension used to resolve (see "Removed" above) and, further out, a
       genuinely new caller that reaches an already-locked private helper by
       a path that adds no new `writeJsonAtomic(castJsonPath(`/
       `rm(castJsonPath(` text of its own. The scan is entirely call-graph
       blind now: it only reacts to a change if that change also changes
       what OCCURRENCE TEXT exists in the file. A second, unlocked caller of
       `applyToBookLocked` that calls it directly (no new write text) would
       not move the count and so would not be caught — this is now an
       accepted, documented gap rather than an unsound attempt to close it.
     - A writer routed through `workspace/schema-migrate.ts`'s cast.json
       migration seam. **Latent, not live**: `migrateSeamDoc` is a pure
       transform (input document in, migrated document out) and does not
       call `writeJsonAtomic`/`castJsonPath` itself today — nothing currently
       writes through it unlocked. Named here so it is not forgotten if a
       future caller starts persisting its output directly, at which point
       this becomes a live gap rather than a latent one.
     - `scripts/*.mjs` cast.json writers are outside the scan entirely — it
       only walks `server/src`. Four exist today: `recover-missing-character`,
       `rekey-qwen-voices-to-uuid`, `relink-stripped-qwen-voices`,
       `backfill-qwen-voicestyle`. These are one-shot operator scripts, not
       request-serving code, so they cannot race a concurrent HTTP write the
       way the routes this guard covers can — but the guard cannot see them
       either way.
     - Code hidden inside a template-literal `${...}` expression — a
       template literal is skipped whole (open backtick to close backtick,
       via `skipOpaqueToken`) for BOTH the lock-range balancer and (since
       this task) the occurrence scan, so a lock or write token that only
       exists inside one is invisible on both sides equally. Unlike a plain
       string or a comment, a template literal's `${...}` holds real,
       executable code — but this guard does not special-case it, so a write
       hidden there is a false negative just like the ones above, not merely
       a formatting curiosity.

   FALSE POSITIVES (correct, genuinely-locked code the guard MAY redden —
   verified empirically for this task; only the shapes confirmed still to
   redden are listed):
     - A lock whose callback delegates through a SECOND hop reached from
       INSIDE an inline block body — e.g. `withCastLock(dir, async () => {
       await helper(dir); })` where `helper`'s own body (elsewhere in the
       file) holds the actual `writeJsonAtomic(castJsonPath(` call. This was
       never covered by the deleted extension either (which only resolved a
       BARE call expression callback, never a block body that calls out) —
       removing that extension changes nothing here; it was already a false
       positive and stays one. Confirmed still reddens.
     - A callback assigned to a `const` and referenced by name rather than
       written inline: `const doIt = async () => { await writeJsonAtomic(
       castJsonPath(dir), c); }; withCastLock(dir, doIt);` — the write's
       index sits inside `doIt`'s own declaration, not inside the
       `withCastLock(...)` call's parens, so it is reported unlocked even
       though `doIt` is only ever invoked through the lock. Confirmed still
       reddens.
     - FIXED by this task, no longer live: a comment or string literal that
       happens to spell out `writeJsonAtomic(castJsonPath(` / `rm(castJsonPath(`
       verbatim used to be counted as a real occurrence regardless of where it
       sat — the occurrence scan was plain text matching, not comment/string
       aware the way the lock-range balancer already was. A comment quoting
       the pattern OUTSIDE any lock range used to redden the guard on
       unchanged, correct code (the false positive that motivated this fix —
       an early draft of this very header did exactly that to itself); a
       comment quoting it INSIDE a lock range used to be silently absorbed as
       a "locked" site with no real write behind it at all, which is the
       opposite failure — a fabricated pass. Both are closed now: occurrence
       matching is comment/string-aware via the same `skipOpaqueToken`
       predicate as step 1, so prose that quotes the pattern is invisible to
       the scan in either position. Verified both directions for this task.
   An honest guard with stated limits beats one that implies total coverage.

   MUTATION-PROOF (see task-12-brief.md Step 2, and the report this task
   returns): this guard was verified able to fail every way listed above that
   it is claimed to catch — unwrapping a converted site (in two different
   files, in separate runs) so each reddens naming its own file; a
   Prettier-wrapped unlocked write still reddening despite the whitespace;
   widening `analysis.ts`'s own target count so a 6th unlocked write there is
   NOT silently absorbed (historical as of #2155 Task 5 — that entry is gone,
   not zeroed, so this specific recipe no longer applies; recorded here as
   what Task 12 itself verified at the time, not as a live how-to); a second
   unlocked write in `voice-override-linked.ts`
   on top of its own allowlisted one, likewise not absorbed;
   `withLibraryVoiceLock` correctly rejected as a substitute for
   `withCastLock` — and verified able to correctly stay green on a prose
   comment naming `applyToBookLocked` with zero code change. Every mutation
   was reverted exactly (`git diff` empty) before this file was finalised;
   the guard's own test run is the read-only, permanent check that ships. */
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

/** If `src[i]` opens a string/template literal (`"`, `'`, `` ` ``) or a
    comment (`//`, `/* … *​/`), return the index just past its end (handling
    backslash escapes inside quotes, and the unterminated-comment case by
    running to EOF). Otherwise return -1 — `i` is not the start of an opaque
    token. This is the single source of truth for "is this raw text actually
    executable code", shared by the paren/brace balancer (`findMatchingClose`,
    which needs it to avoid desyncing on a stray bracket inside a string) and
    the occurrence scan (`scanFile`, which needs it so a comment or string
    that happens to quote the write pattern verbatim isn't counted as a real
    site — see the false-positives list in the file header). */
function skipOpaqueToken(src: string, i: number): number {
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

/** Scan forward from `openIndex` (which must hold `openChar`) for the
    matching `closeChar`, tracking nesting depth. String/template literals and
    comments are skipped whole (via `skipOpaqueToken`) so a bracket character
    inside one can't desync the count. Returns -1 if unmatched (malformed
    source). */
function findMatchingClose(src: string, openIndex: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let i = openIndex;
  const n = src.length;
  while (i < n) {
    const skip = skipOpaqueToken(src, i);
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

/** Every [start, end) span in `content` that is a string/template literal or
    a comment, per `skipOpaqueToken`. Used so the occurrence scan can ignore a
    match that only exists in prose or a string, not real code. */
function computeOpaqueRanges(content: string): Array<{ start: number; end: number }> {
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

/** True iff `index` falls inside one of `ranges` — i.e. inside a
    string/template literal or a comment, not real code. */
function isOpaque(ranges: Array<{ start: number; end: number }>, index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
}

interface LockRange {
  start: number;
  end: number;
}

/** Every `withCastLock(...)` / `withCastLocks(...)` call's span in `content`.
    Pure textual nesting — see file header "Removed" note for why this no
    longer chases a callback that delegates to a same-file helper. */
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

// Whitespace-tolerant between the two opening parens — Prettier's
// printWidth:100 wraps a long argument onto its own line, which would
// otherwise silently drop a real occurrence out of coverage (see file
// header, false negatives).
const WRITE_RE = /\bwriteJsonAtomic\(\s*castJsonPath\(/g;
const RM_RE = /\brm\(\s*castJsonPath\(/g;

interface ScanResult {
  writes: number;
  rms: number;
  details: string[];
}

function scanFile(content: string): ScanResult | null {
  if (!content.includes('castJsonPath')) return null;
  const ranges = collectLockRanges(content);
  const opaque = computeOpaqueRanges(content);
  const details: string[] = [];
  let writes = 0;
  let rms = 0;

  WRITE_RE.lastIndex = 0;
  let wm: RegExpExecArray | null;
  while ((wm = WRITE_RE.exec(content))) {
    if (isOpaque(opaque, wm.index)) continue; // comment/string quoting the pattern, not real code
    if (!isLocked(ranges, wm.index)) {
      writes++;
      details.push(`unlocked write @ line ${lineOf(content, wm.index)}`);
    }
  }

  RM_RE.lastIndex = 0;
  let rmMatch: RegExpExecArray | null;
  while ((rmMatch = RM_RE.exec(content))) {
    if (isOpaque(opaque, rmMatch.index)) continue; // comment/string quoting the pattern, not real code
    if (!isLocked(ranges, rmMatch.index)) {
      rms++;
      details.push(`unlocked rm @ line ${lineOf(content, rmMatch.index)}`);
    }
  }

  if (writes === 0 && rms === 0) return null;
  return { writes, rms, details };
}

/* One entry by design.

   Keyed on file AND expected count, never on file alone, and the count check
   below fires on a mismatch in EITHER direction — a fix that removes an
   unlocked write must shrink or delete its entry, exactly as a regression
   that adds one must fail the guard.

   #2015/#2155 — routes/analysis.ts's entry is GONE, not zeroed: its five
   merge-base writes now go through createCastMergeBase's writeChecked (which
   takes the lock itself — see the file-header ACCEPTANCE TARGET paragraph
   for why this scan can't verify that claim directly) and its reuse-carryover
   rm rides the same hold as cast.json's. A file that scans clean must not
   stay on the allowlist; `scanFile` returns null for it and the trailing
   unmatched-key check below would fail. Any NEW unlocked write in that file
   now fails the guard directly, with no entry to inherit. */
const ALLOWED_UNLOCKED = new Map<string, { writes: number; rms: number; why: string }>([
  [
    'routes/voice-override-linked.ts',
    {
      writes: 1,
      rms: 0,
      why:
        "the write IS locked — applyToBook wraps it in withCastLock(bookDir, () => " +
        'applyToBookLocked(...)), one call away — but this scan is deliberately syntactic ' +
        "and can't prove a call crosses a function boundary. An earlier version tried to " +
        'resolve that one hop by name and was unsound (see file header, "Removed"); this ' +
        'allowlist entry is the honest replacement — human-verified, not guard-verified.',
    },
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
