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
 *       block header in ../test-utils/guard-scan.ts), so a mid-block comment runs this row without exercising
 *       the case it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectSourceFiles,
  astOpaqueRangesFor,
  computeAstOpaqueRanges,
  isOpaque,
  lineOf,
} from '../test-utils/guard-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

// The file walker and the AST opaque-range tokenizer (with the history of why
// it replaced the hand-rolled walker) live in ../test-utils/guard-scan.ts (#3685).

/** Plain-substring, non-opaque occurrences of `re` in `content` with line nums. */
function countNonOpaque(content: string, re: RegExp): { count: number; lines: number[] } {
  const opaque = astOpaqueRangesFor(content);
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
   the byte-identical drift test this file used to carry (T4) was retired with the duplication it pinned when the tokenizer moved to ../test-utils/guard-scan.ts (#3685). */
describe('opaque-range tokenizer', () => {
  it('T1: a regex literal containing a quote does not open a runaway string range', () => {
    // /["'\s]/ - the old walker opened a "string" at the double quote INSIDE the
    // character class and ran to the next quote anywhere later in the file,
    // hiding everything between.
    const src = [String.raw`const RE = /["'\s]/;`, 'await writeEntry(entry);'].join('\n');
    const opaque = computeAstOpaqueRanges(src);

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
    const opaque = computeAstOpaqueRanges(src);

    // the inner template's own text is opaque
    expect(isOpaque(opaque, src.indexOf("it's"))).toBe(true);
    // the `${...}` slot holds LIVE CODE and is deliberately not opaque - see the
    // scope decision in the tokenizer block header (test-utils/guard-scan.ts)
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
    const opaque = computeAstOpaqueRanges(src);

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

  /* T5/T6 pin the PUNCTUATION blind spot - the `forEachChild` traversal that
     preceded the leaf-token descent never visited `}`, `]` or `,`, so a comment
     whose only following token was one of those was asked for by nobody and
     stayed live code. See the tokenizer block header in test-utils/guard-scan.ts for the mechanism.

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
    const opaque = computeAstOpaqueRanges(src);

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
    const opaque = computeAstOpaqueRanges(src);

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