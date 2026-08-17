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
 * non-opaque `updateEntry(` occurrences across `server/src` production files,
 * plus a global floor. A bare global floor is too slack: it would not notice a
 * file that ALIASES its `updateEntry` import (`import { updateEntry as ue }`
 * + renaming its uses) because the global total is unchanged. Requiring each
 * file's exact count is what makes an alias redden: the renamed file's count
 * collapses to zero while the floor stays satisfied by the other files.
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
 *       skipping is broken.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

/*
 * Helpers reused from cast-lock.guard.test.ts (server/src/workspace/). They are
 * not exported there, so copied verbatim - do not refactor the source file to
 * export them; that file is not this step's.
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

/** If `src[i]` opens a string/template literal or a comment, return the index
    just past its end; otherwise -1. */
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

/** Every [start, end) span in `content` that is a string/template literal or a
    comment. */
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

/** True iff `index` falls inside one of `ranges`. */
function isOpaque(ranges: Array<{ start: number; end: number }>, index: number): boolean {
  return ranges.some((r) => index >= r.start && index < r.end);
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
  const opaque = computeOpaqueRanges(content);
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
   production files, plus the global floor. Re-derived 2026-08-17: voice-library.ts
   scans at 1 (its :248/:253 `updateEntry(` hits are prose inside template
   literals and are OPAQUE). floor = 4+6+1+1+1 = 13. */
const G2_EXPECTED = new Map<string, number>([
  ['routes/voice-library.ts', 4],
  ['tts/clone-voice-resolver.ts', 6],
  ['tts/synthesise-chapter.ts', 1],
  ['workspace/purge-clone-artifacts.ts', 1],
  ['workspace/voice-library.ts', 1],
]);
const G2_GLOBAL_FLOOR = 13;
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

  it('G2: per-file `updateEntry(` counts fail closed, and the global floor holds', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    let globalTotal = 0;

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/');
      const content = readFileSync(file, 'utf8');
      const { count, lines } = countNonOpaque(content, UPDATE_RE);
      if (count === 0) continue;

      globalTotal += count;
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

    if (globalTotal < G2_GLOBAL_FLOOR) {
      problems.push(
        `global updateEntry( floor: found ${globalTotal}, expected >= ${G2_GLOBAL_FLOOR}`,
      );
    }

    expect(problems, problems.join('\n\n')).toEqual([]);
  });
});