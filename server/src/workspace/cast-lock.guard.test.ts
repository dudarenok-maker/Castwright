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
        `computeOpaqueRanges` tokenizer the occurrence scan uses, see step 3 —
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
        comment, per the same `computeOpaqueRanges` tokenizer step 1 uses for
        its own paren/brace balancing — this task extracted that predicate into
        a standalone function and wired it into the occurrence scan too,
        which it previously bypassed entirely (see "Fixed" in the
        false-positives list below). #2405 replaced the hand-rolled character
        walker behind it with the TypeScript parser; see the tokenizer block's
        own header for the two shapes that used to desync it, both of which
        failed OPEN.

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
     - CLOSED by #2405, recorded here because this list is cited elsewhere:
       code hidden inside a template-literal `${...}` expression used to be a
       false negative. The old hand-rolled walker skipped a template whole
       (open backtick to close backtick), so a lock or write token inside an
       interpolation was invisible to BOTH the lock-range balancer and the
       occurrence scan. The tokenizer now marks only a template's literal text
       chunks (TemplateHead/Middle/Tail), so a `${...}` slot is scanned as the
       real, executable code it is. Verified: re-deriving every count in this
       file and in voice-library-write-seam.guard.test.ts under the new
       tokenizer moved nothing, so no write was in fact hiding there today.

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
       opposite failure — a fabricated pass. Occurrence matching is
       comment/string-aware via the same `computeOpaqueRanges` tokenizer as
       step 1, so prose that quotes the pattern is invisible to the scan in
       either position.

       "Both are closed now" was claimed here prematurely, twice, and was only
       ever true of the comments the tokenizer could actually SEE. Until the
       leaf-token descent landed it walked with `ts.forEachChild`, which never
       visits punctuation, so a comment whose only following token was `}`, `]`
       or `,` — a comment on the last line of a block, the commonest placement
       there is — was never marked opaque at all. 276 such comments across 79
       of this tree's 427 non-test files, and BOTH failures above were live
       through them: prose in that position quoting the write pattern counted
       as a call site (fails CLOSED), and prose in that position quoting an
       unbalanced `withCastLock(dir, async () => {` fabricated a lock range
       over a real unlocked write (fails OPEN). The regression test that was
       supposed to pin the second one passed only because its fixture sat on
       line 1, which `getLeadingCommentRanges(content, 0)` covers whatever the
       traversal does; it now has a last-line-of-block twin at the bottom of
       this file. Both directions are closed as of that change, verified at
       guard level and against an out-of-tree oracle whose comment reference
       is a `ts.createScanner` trivia stream. The scanner is the load-bearing
       detail: a leaf-token oracle would now share its traversal with this
       tokenizer and could only confirm itself, which is exactly how an
       earlier `forEachChild` oracle certified a `forEachChild` tokenizer as
       having zero uncovered comments while 276 went unseen.
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

/** Every `withCastLock(...)` / `withCastLocks(...)` call's span in `content`.
    Pure textual nesting — see file header "Removed" note for why this no
    longer chases a callback that delegates to a same-file helper. */
function collectLockRanges(content: string, opaque: OpaqueRange[]): LockRange[] {
  const ranges: LockRange[] = [];
  const tokenRe = /\bwithCastLocks?\(/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(content))) {
    const tokenStart = m.index;
    /* A `withCastLock(` that only exists in prose or a string must not open a
       lock range. This is REQUIRED by the #2405 tokenizer, not optional
       hardening: the balancer below now jumps a comment whole, so it no longer
       counts the comment's OWN parens. A comment quoting an unbalanced
       `withCastLock(dir, async () => {` therefore lets the following real
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
  const opaque = computeOpaqueRanges(content);
  const ranges = collectLockRanges(content, opaque);
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

  /* Regression for the lock-range balancer specifically. `findMatchingClose`
     walks parens character by character and skips literals/comments whole; with
     the old hand-rolled walker a NESTED template literal inside a lock callback
     left it out of phase, so a stray `(` inside the template was counted as real
     nesting and the lock range closed in the wrong place. The write that IS
     locked then fell outside the range and was reported unlocked.

     Verified RED against HEAD's tokenizer: `scanFile` reported 2 unlocked writes
     for this fixture instead of 1. Tokenizer-level cases (regex literals,
     interpolation slots, comment opacity) live in
     voice-library-write-seam.guard.test.ts, which shares this exact tokenizer. */
  it('a nested template literal inside a lock callback does not desync the paren balancer', () => {
    const src = [
      'await withCastLock(dir, async () => {',
      '  log(`a ${flag ? `b(` : `c`} d`);',
      '  await writeJsonAtomic(castJsonPath(dir), cast);',
      '});',
      'await writeJsonAtomic(castJsonPath(other), cast2);',
    ].join('\n');

    const result = scanFile(src);
    // exactly the one genuinely-unlocked write on the last line
    expect(result?.writes, JSON.stringify(result)).toBe(1);
    expect(result?.rms).toBe(0);
    expect(result?.details.join('\n')).toContain('line 5');
  });

  /* Guards a hole the #2405 tokenizer OPENED and this file closes in the same
     change - the most dangerous shape there is here, a fabricated pass.

     Because the balancer now jumps an opaque range whole, it stops counting a
     comment's own parens. Prose quoting an unbalanced
     `withCastLock(dir, async () => {` then lets the FOLLOWING REAL CODE's
     parens close the range, wrapping a genuinely unlocked write in a lock that
     does not exist. Measured on this fixture: HEAD reports the write correctly
     (`writes: 1`); the tokenizer rewrite WITHOUT the opaque check in
     `collectLockRanges` reports `null` - zero unlocked writes, guard green, a
     real violation invisible. */
  it('a withCastLock( that exists only in prose does not fabricate a lock range', () => {
    const src = [
      '// historical: this used to be withCastLock(dir, async () => {',
      'await writeJsonAtomic(castJsonPath(dir), cast);',
    ].join('\n');

    const result = scanFile(src);
    expect(result?.writes, `fabricated lock range: ${JSON.stringify(result)}`).toBe(1);
    expect(collectLockRanges(src, computeOpaqueRanges(src))).toEqual([]);
  });

  /* THE SAME FABRICATED PASS, one line lower - and this is the version that
     actually bites.

     The test above survived the punctuation blind spot only because its prose
     sits on LINE 1, where `getLeadingCommentRanges(content, 0)` picks it up
     unconditionally. Move the identical comment to the last line of a block and
     the pre-fix tokenizer never reached it: its next token is `}`, which
     `ts.forEachChild` does not visit (see the tokenizer block header). The
     comment stayed live code, `collectLockRanges`'s `isOpaque` guard therefore
     never fired, and the enclosing `run(...)` call's own `)` closed the range
     the prose had opened - swallowing a genuinely unlocked write.

     Measured against the pre-fix tokenizer on this exact fixture:
       scanFile      -> null                          (guard GREEN, violation invisible)
       collectLockRanges -> [{ start: 104, end: 191 }]  (a lock that does not exist)
     After the fix: `writes: 1` naming line 7, and zero lock ranges. */
  it('prose on the LAST LINE OF A BLOCK does not fabricate a lock range either', () => {
    const src = [
      'await run(async () => {',
      '  try {',
      '    await doSomething();',
      '  } catch {',
      '    // historical: this used to be withCastLock(dir, async () => {',
      '  }',
      '  await writeJsonAtomic(castJsonPath(dir), cast);',
      '});',
    ].join('\n');

    const result = scanFile(src);
    expect(result?.writes, `fabricated lock range: ${JSON.stringify(result)}`).toBe(1);
    expect(result?.details.join('\n')).toContain('line 7');
    expect(collectLockRanges(src, computeOpaqueRanges(src))).toEqual([]);
  });
});
