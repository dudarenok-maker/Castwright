/*
 * #1826 Step 2 - the static guard that stops the write-seam invariant rotting.
 *
 * This guard is the build-failing tripwire for the serialization guarantee
 * step 1 just proved with regression tests. It is written to be provably able
 * to FAIL (see the mutation table at the bottom) - a guard that cannot fail is
 * decorative, and decorative coverage is worse than none because it reads as
 * protection to the next person who touches this code.
 *
 * WHAT THE SEAM IS: `server/src/workspace/voice-library.ts` gives callers two
 * ways to write a voice-library entry manifest:
 *
 *   - `writeEntry(entry)`  - a bare tmp+rename, NO lock. The primitive.
 *   - `updateEntry(uuid, mutate)` - the per-uuid-locked read-modify-write
 *     seam. Every production read-modify-write MUST go through this.
 *
 * Types cannot enforce that choice: both are exported and both compile. A
 * future caller that reads, mutates and writes with a bare `writeEntry`
 * silently reopens the lost-update hole #1826 is about, and nothing else
 * would notice. This file exists to make that the first thing that notices.
 *
 * METHOD - a plain textual scan, deliberately NOT a parser and deliberately
 * NOT a call-graph chaser. See cast-lock.guard.test.ts's header for the two
 * hardening lessons baked into this project's guard idiom: an earlier draft
 * that resolved a helper by name (with no caller check) stayed green on a real
 * unserialised write and was removed; the allowlist is keyed on FILE **AND**
 * COUNT, asserted in BOTH directions. A dumb, sound text scan plus a
 * human-verified allowlist beats a clever unsound one.
 *
 * TOKEN-MATCH RULE (declared, not implied): every count below is taken with a
 * PLAIN SUBSTRING match on `writeEntry(` / `updateEntry(` - NOT
 * word-boundary-aware. `writeEntry(` is a substring of `deps.writeEntry(`, so
 * a member call, a bare call, and an interface method declaration
 * (`writeEntry(entry: VoiceLibraryEntry): Promise<void>;`) all count. That is
 * intentional: it keeps the numbers below documentable by grep instead of by
 * parser mysticism, and it means the three interface-declaration sites must be
 * allowlisted BY COUNT with an explicit reason rather than silently skipped.
 *
 * G1 - SEAM EXCLUSIVITY. Every non-opaque `writeEntry(` occurrence outside the
 * seam file (`workspace/voice-library.ts`, which is EXEMPT, not allowlisted -
 * it is the definition site) is a finding UNLESS its file sits on the pinned
 * count-keyed allowlist with a written reason. A file listed for N occurs
 * fails if it now has N+1 (a new bypass slipped in) AND fails if it now has
 * fewer (the entry is stale) - the both-directions assertion.
 *
 * G2 - FAIL CLOSED ON ABSENT EVIDENCE. A per-file expected-count map of
 * non-opaque `updateEntry(` occurrences across `server/src` production files.
 * Requiring each file's exact count catches aliases and other mutations: a file
 * that aliases its `updateEntry` import (`import { updateEntry as ue }` + renaming
 * its uses) has that file's count collapse to zero, failing the presence check
 * that expects every mapped file to be present in scans.
 *
 * G3 - THE HEADER DECLARES THE BLIND SPOTS, VERBATIM AND IN FULL. A guard
 * whose limits are undocumented gets trusted past them. They are:
 *
 *   1. Aliased imports - `import { writeEntry as we }` + renaming its uses
 *      defeats G1 outright (the literal `writeEntry(` text vanishes; G2's
 *      per-file map is why the same stunt on `updateEntry` is caught, but the
 *      bare-`writeEntry` alias specifically is not covered by any counter).
 *   2. Call-graph indirection - a new *unlocked caller* of an already-correct
 *      helper adds no `writeEntry(` occurrence text and passes. Same blind
 *      spot cast-lock.guard.test.ts declares for its own seam. This scan never
 *      tries to resolve who calls whom (see the "Removed" lesson above).
 *   3. The three allowlisted creation sites are HUMAN-VERIFIED, not
 *      guard-verified. Each mints a brand-new `voiceUuid` and writes a
 *      first-ever manifest, so there is no prior entry to lose and no
 *      read-modify-write; if one of them ever starts writing over an entry
 *      that can already exist, this guard stays green - the scan cannot see
 *      the difference, only a human can.
 *   4. `scripts/*.mjs` / `*.mts` and anything else OUTSIDE `server/src` is not
 *      scanned at all. `collectSourceFiles` walks only `server/src`.
 *   5. Token-match coverage: a PLAIN SUBSTRING match covers member calls and
 *      bare calls alike, so the "not covered" side of the member-call /
 *      bare-call split is EMPTY here; what this match choice leaves open is
 *      the aliased-import rewrite above and interface *declaration text* that
 *      drifts into a form that no longer contains `writeEntry(` (e.g. a
 *      multi-line signature whose first parameter's name changes) - which is
 *      exactly why the three declaration sites are pinned BY COUNT.
 *
 * MUTATION TABLE (run one at a time, others reverted, `git diff` empty after):
 *   M1  add `await writeEntry(entry);` to a production file NOT on the
 *       allowlist (e.g. `workspace/purge-clone-artifacts.ts`)  ->  G1, naming
 *       that file.
 *   M2  add a FOURTH bare `writeEntry(` to `routes/voice-library.ts` (an
 *       allowlisted file)  ->  G1 on the count mismatch. Proves the allowlist
 *       is count-keyed, not merely file-keyed.
 *   M3  alias `import { updateEntry as ue }` in one file + rename its uses
 *       ->  G2's per-file map, naming that file.
 *   M4  delete ONE of the three creation-site `writeEntry(` calls in
 *       `routes/voice-library.ts` (real count 2 against an allowlisted 3)
 *       ->  G1 "stale allowlist entry", NOT a pass. Proves both directions.
 *   NC  negative control: with no code change, add (a) a prose comment quoting
 *       `await writeEntry(entry);` verbatim and (b) a string literal
 *       containing `writeEntry(`  ->  must stay GREEN, else the opaque-range
 *       skipping is broken. Place (a) as the LAST LINE OF A BLOCK, i.e. with
 *       `}` as its only following token, not mid-block: that placement is the
 *       one the tokenizer used to miss entirely (see T5/T6 and the tokenizer
 *       block header), so a mid-block comment runs this row without exercising
 *       the case it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src
const SIBLING_GUARD = join(__dirname, 'cast-lock.guard.test.ts');

/*
 * `collectSourceFiles` is reused from cast-lock.guard.test.ts (same directory);
 * it is small, stable and not exported there, so it stays copied. The
 * opaque-range tokenizer below is a different matter: it is duplicated
 * DELIBERATELY and its two copies are pinned byte-identical by the drift test
 * at the bottom of this file. See that block's own header for why it is not an
 * imported module.
 */
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

/** `computeOpaqueRanges` parses the whole file, and both G1 and G2 scan every
    file, so memoize per content string rather than parsing each file twice. */
const opaqueCache = new Map<string, OpaqueRange[]>();
function opaqueRangesFor(content: string): OpaqueRange[] {
  let ranges = opaqueCache.get(content);
  if (!ranges) {
    ranges = computeOpaqueRanges(content);
    opaqueCache.set(content, ranges);
  }
  return ranges;
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** Plain-substring, non-opaque occurrences of `re` in `content` with line nums. */
function countNonOpaque(content: string, re: RegExp): { count: number; lines: number[] } {
  const opaque = opaqueRangesFor(content);
  const lines: number[] = [];
  let count = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (isOpaque(opaque, m.index)) continue;
    count++;
    lines.push(lineOf(content, m.index));
  }
  return { count, lines };
}

const SEAM_REL = 'workspace/voice-library.ts';
const WRITE_RE = /writeEntry\(/g;
const UPDATE_RE = /updateEntry\(/g;

/* G1 allowlist - plain-substring, non-opaque `writeEntry(` occurrences outside
   the seam, keyed on FILE AND COUNT. Re-derived 2026-08-17 in this worktree. */
const G1_ALLOWLIST = new Map<string, { count: number; why: string }>([
  [
    'routes/voice-library.ts',
    {
      count: 3,
      why:
        ':250 design, :1035 promote, :1326 clone - each mints a brand-new voiceUuid and writes a ' +
        'first-ever manifest; no prior entry to lose, no read-modify-write, no lock owed. ' +
        'Human-verified, not guard-verified.',
    },
  ],
  [
    'tts/clone-voice-resolver.ts',
    { count: 2, why: ':309 and :810 - interface method declarations, not calls.' },
  ],
  [
    'tts/synthesise-chapter.ts',
    { count: 1, why: ':1125 - interface method declaration, not a call.' },
  ],
]);

/* G2 per-file expected counts of non-opaque `updateEntry(` across server/src
   production files. Re-derived 2026-08-17: voice-library.ts scans at 1 (its :248/:253
   `updateEntry(` hits are prose inside template literals and are OPAQUE). */
const G2_EXPECTED = new Map<string, number>([
  ['routes/voice-library.ts', 4],
  ['tts/clone-voice-resolver.ts', 6],
  ['tts/synthesise-chapter.ts', 1],
  ['workspace/purge-clone-artifacts.ts', 1],
  ['workspace/voice-library.ts', 1],
]);

describe('voice-library write seam - static guard (#1826 Step 2)', () => {
  it('G1: every `writeEntry(` occurrence outside the seam sits on the pinned count-keyed allowlist', () => {
    const problems: string[] = [];
    const matchedAllowlistKeys = new Set<string>();

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      if (rel === SEAM_REL) continue; // exempt definition site
      const content = readFileSync(file, 'utf8');
      const { count, lines } = countNonOpaque(content, WRITE_RE);
      if (count === 0) continue;

      const allowed = G1_ALLOWLIST.get(rel);
      if (allowed) {
        matchedAllowlistKeys.add(rel);
        if (count !== allowed.count) {
          const direction =
            count < allowed.count
              ? 'stale allowlist entry (fewer found than pinned)'
              : 'count mismatch (a new writeEntry( slipped in)';
          problems.push(
            `${rel}: ${direction} - allowlisted for exactly ${allowed.count} (${allowed.why}), ` +
              `but the scan found ${count}:\n    ` + lines.map((n) => `line ${n}`).join('\n    '),
          );
        }
      } else {
        problems.push(
          `${rel}: ${count} writeEntry( occurrence(s), NOT on the allowlist:\n    ` +
            lines.map((n) => `line ${n}`).join('\n    '),
        );
      }
    }

    for (const [rel, allowed] of G1_ALLOWLIST) {
      if (!matchedAllowlistKeys.has(rel)) {
        problems.push(
          `${rel}: stale allowlist entry - allowlisted for ${allowed.count} (${allowed.why}), but the ` +
            'scan now finds ZERO writeEntry( occurrences there; update or remove this entry.',
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });

  it('G2: per-file `updateEntry(` counts fail closed', () => {
    const problems: string[] = [];
    const seen = new Set<string>();

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const content = readFileSync(file, 'utf8');
      const { count, lines } = countNonOpaque(content, UPDATE_RE);
      if (count === 0) continue;

      seen.add(rel);
      const expected = G2_EXPECTED.get(rel);
      if (expected === undefined) {
        problems.push(
          `${rel}: ${count} updateEntry( occurrence(s) in a file the per-file map does not expect - ` +
            'fail closed (a new or aliased-updateEntry site):\n    ' +
            lines.map((n) => `line ${n}`).join('\n    '),
        );
      } else if (count !== expected) {
        problems.push(
          `${rel}: per-file updateEntry( mismatch - expected ${expected}, scan found ${count}:\n    ` +
            lines.map((n) => `line ${n}`).join('\n    '),
        );
      }
    }

    for (const [rel, expected] of G2_EXPECTED) {
      if (!seen.has(rel)) {
        problems.push(
          `${rel}: per-file updateEntry( map expects ${expected}, but the file scans at zero ` +
            'occurrences - stale map entry (or its import was aliased away).',
        );
      }
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });
});

/* Regression tests for the shared opaque-range tokenizer itself.

   Every case below was verified RED against the tokenizer it replaces before
   being written down - a tokenizer test that passes against the bug it is named
   for proves nothing, and the previous attempt at this fix shipped exactly that
   (a `${expr}` fixture with no nesting, which the old hand-rolled walker handled
   identically).

   T1/T2 are red against the hand-rolled walker at HEAD (both are OVER-reach: an
   opaque range swallowing live code, which fails OPEN). T3 is red against the
   AST rewrite that preceded this one, which collected comments only at offset 0
   and at EOF and so left every mid-file comment uncovered (UNDER-reach, which
   fails CLOSED and destroys the NC row in the mutation table above). T3 is green
   against HEAD by construction - HEAD's bug was over-reach, not under-reach - so
   its red phase is stated against the attempt it actually guards.

   T5/T6 are red against the `forEachChild` traversal that preceded the
   leaf-token descent (UNDER-reach again, and the one T3 was too weak to catch);
   T4 is the drift test and is red whenever the two copies disagree. */
describe('opaque-range tokenizer', () => {
  it('T1: a regex literal containing a quote does not open a runaway string range', () => {
    // /["'\s]/ - the old walker opened a "string" at the double quote INSIDE the
    // character class and ran to the next quote anywhere later in the file,
    // hiding everything between.
    const src = [String.raw`const RE = /["'\s]/;`, 'await writeEntry(entry);'].join('\n');
    const opaque = computeOpaqueRanges(src);

    // the regex body, quote and all, is opaque
    expect(isOpaque(opaque, src.indexOf('"'))).toBe(true);
    expect(isOpaque(opaque, src.indexOf("'"))).toBe(true);
    // ...and the real call on the next line is still LIVE CODE
    expect(isOpaque(opaque, src.indexOf('writeEntry('))).toBe(false);
  });

  it('T2: a nested template literal does not leave the tokenizer out of phase', () => {
    // A backtick inside a `${...}` slot. The old walker scanned backtick-to-next-
    // backtick, so it ended the OUTER range at the INNER template's OPENING
    // backtick and resumed mid-template - where the apostrophe in `it's` opened a
    // single-quoted "string" that ran to EOF.
    const src = ["const msg = `outer ${flag ? `it's` : `no`} tail`;", 'await writeEntry(entry);'].join(
      '\n',
    );
    const opaque = computeOpaqueRanges(src);

    // the inner template's own text is opaque
    expect(isOpaque(opaque, src.indexOf("it's"))).toBe(true);
    // the `${...}` slot holds LIVE CODE and is deliberately not opaque - see the
    // scope decision in the tokenizer block header
    expect(isOpaque(opaque, src.indexOf('flag'))).toBe(false);
    // and the real call after the template is still counted
    expect(isOpaque(opaque, src.indexOf('writeEntry('))).toBe(false);
  });

  it('T3: a mid-file comment is opaque, so prose quoting the pattern is not a call site', () => {
    // The negative control the mutation table's NC row depends on.
    const src = [
      'export function noop(): void {',
      '  // prose: never call writeEntry(entry) directly here.',
      '  return;',
      '}',
      '/* block prose: writeEntry(entry) is the unlocked primitive. */',
      'const tail = 1;',
    ].join('\n');
    const opaque = computeOpaqueRanges(src);

    const lineComment = src.indexOf('writeEntry(');
    const blockComment = src.indexOf('writeEntry(', lineComment + 1);
    expect(blockComment).toBeGreaterThan(lineComment);
    expect(isOpaque(opaque, lineComment)).toBe(true);
    expect(isOpaque(opaque, blockComment)).toBe(true);
    // real code after the block comment is untouched
    expect(isOpaque(opaque, src.indexOf('const tail'))).toBe(false);
    // ...and the whole-file scan agrees: zero non-opaque occurrences
    expect(countNonOpaque(src, /writeEntry\(/g).count).toBe(0);
  });

  it('T4: the tokenizer block is byte-identical in both guard files', () => {
    // The tokenizer is duplicated rather than imported (see the block header for
    // why the census harnesses require that). This is what stops the two copies
    // drifting - the failure mode that produced the bug T1/T2 fix.
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
    const sibling = extract(SIBLING_GUARD);
    expect(mine.length).toBeGreaterThan(1000);
    expect(sibling).toBe(mine);
  });

  /* T5/T6 pin the PUNCTUATION blind spot - the `forEachChild` traversal that
     preceded the leaf-token descent never visited `}`, `]` or `,`, so a comment
     whose only following token was one of those was asked for by nobody and
     stayed live code. See the tokenizer block header for the mechanism.

     Both are red against the tokenizer they replace, measured (not asserted):
       T5  isOpaque -> false, countNonOpaque -> 1   (want true / 0)
       T6  isOpaque -> false, false, countNonOpaque -> 2  (want true / true / 0)
     T3 above did NOT catch this: its line comment is followed by `return;` and
     its block comment by `const tail`, both of which `forEachChild` does visit. */
  it('T5: a comment as the LAST LINE of a block (next token `}`) is opaque', () => {
    const src = [
      'export function noop(): void {',
      '  doWork();',
      '  // prose: never call writeEntry(entry) directly here.',
      '}',
      'const tail = 1;',
    ].join('\n');
    const opaque = computeOpaqueRanges(src);

    expect(isOpaque(opaque, src.indexOf('writeEntry('))).toBe(true);
    // the real code either side of it is untouched - no over-reach
    expect(isOpaque(opaque, src.indexOf('doWork'))).toBe(false);
    expect(isOpaque(opaque, src.indexOf('const tail'))).toBe(false);
    expect(countNonOpaque(src, /writeEntry\(/g).count).toBe(0);
  });

  it('T6: a comment whose only following token is `]` or `,` is opaque', () => {
    const src = [
      'const nested = [',
      '  1',
      '  // prose before the close bracket: writeEntry(entry)',
      '];',
      'call(',
      '  arg',
      '  // prose before the comma: writeEntry(entry)',
      '  ,',
      '  other,',
      ');',
    ].join('\n');
    const opaque = computeOpaqueRanges(src);

    const beforeBracket = src.indexOf('writeEntry(');
    const beforeComma = src.indexOf('writeEntry(', beforeBracket + 1);
    expect(beforeComma).toBeGreaterThan(beforeBracket);
    expect(isOpaque(opaque, beforeBracket)).toBe(true);
    expect(isOpaque(opaque, beforeComma)).toBe(true);
    // no over-reach onto the surrounding live code
    expect(isOpaque(opaque, src.indexOf('arg'))).toBe(false);
    expect(isOpaque(opaque, src.indexOf('other'))).toBe(false);
    expect(countNonOpaque(src, /writeEntry\(/g).count).toBe(0);
  });
});