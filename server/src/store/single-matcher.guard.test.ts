/* Plan 291 (#4031) Task 28 — the static guard that keeps `matchFreshToPrior`
   the ONLY fresh<->prior identity matcher.

   WHAT IT CHECKS (non-test `.ts` under `server/src`):
     1. EXPLICIT LIST, EXACT COUNTS BOTH WAYS. Seven files may hold a name /
        id comparator; each is pinned to its exact per-comparator counts
        (`ALLOWED`). A comparator added anywhere on the list fails; one
        removed fails too until the table is updated (so the table cannot
        drift above reality). `plan-overlay.ts` and `analysis-cast-io.ts` are
        pinned at ZERO: the overlay and the persist seam apply a plan, they
        never re-derive an identity. `routes/analysis.ts` is pinned to its
        two quote normalisations (`normaliseForMatch` over evidence quotes),
        which compare quotes, not people.
     2. NARROWED READS-PRIOR RULE. Any file NOT on the list that imports or
        calls `readPriorCastForMerge` / `readPriorCastLockFree` /
        `materialisePriorAtRunStart` and contains a comparator fails: a job's
        prior reader has no business next to a second matcher. (The nine
        other cast-reading files compare names for user-driven purposes and
        do not read through these three readers.)
     3. REVERSE CHECK. The matchers this plan replaced stay deleted: their
        files are absent and none of their symbols appears in non-test code.

   COMPARATORS: `normaliseNameKey(`, `normaliseForMatch(`,
   `surnameTolerantMatch(`, `safeId(`, `unicodeKebab(`, `.trim().toLowerCase()`.

   METHOD: regex over source text, with matches inside comments / strings /
   template chunks skipped via the shared TypeScript-backed opaque ranges
   (`test-utils/guard-scan.ts`, #3685).

   BLIND SPOTS (stated, not hidden):
     - A DYNAMIC IMPORT (`await import('...')`) of a reader or a comparator
       module is not an `import` the scan keys on; the call it feeds is still
       seen if it names the symbol, but `const m = await import(...); m[k]()`
       is not.
     - An IMPORT of a comparator that is never called adds no `name(` text; the
       first call does.
     - A comparator ASSEMBLED AT RUNTIME (`const f = [..].join('')`,
       `globalThis[name]`) or reached through an ALIAS (`import { safeId as
       s }`, `const k = normaliseNameKey; k(x)`) adds no matching text.
     - A NEW NAME FOR AN OLD COMPARATOR: re-implementing the same trim-lower-
       case or kebab logic inline under a different spelling
       (`.toLowerCase().trim()`, `.normalize('NFKC')...`) is invisible. The
       route tests A1/A2 are the behavioural defence for that.
     - Only `server/src` non-test `.ts`: `scripts/`, the frontend, and test
       files are out of scope.
     - Lock-free occurrence counting: a comparator moved between two
       functions of one listed file keeps the count and passes. */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { astOpaqueRangesFor, collectSourceFiles, isOpaque } from '../test-utils/guard-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..'); // server/src

const COMPARATORS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'normaliseNameKey', re: /\bnormaliseNameKey\(/g },
  { name: 'normaliseForMatch', re: /\bnormaliseForMatch\(/g },
  { name: 'surnameTolerantMatch', re: /\bsurnameTolerantMatch\(/g },
  { name: 'safeId', re: /\bsafeId\(/g },
  { name: 'unicodeKebab', re: /\bunicodeKebab\(/g },
  { name: 'trim-toLowerCase', re: /\.trim\(\)\.toLowerCase\(\)/g },
];

const READERS_RE = /\b(?:readPriorCastForMerge|readPriorCastLockFree|materialisePriorAtRunStart)\b/g;

/** Exact per-comparator counts (absent = 0) in code, comments/strings excluded. */
const ALLOWED: Record<string, Record<string, number>> = {
  'store/match-fresh-to-prior.ts': { normaliseNameKey: 6, normaliseForMatch: 2, surnameTolerantMatch: 1 },
  'store/cast-name-match.ts': { surnameTolerantMatch: 1 },
  // The heal (`dedupePriorCastByName`) - the survivor's name key + alias union.
  'store/merge-analysis-cast.ts': { normaliseNameKey: 1, 'trim-toLowerCase': 2 },
  'analyzer/roster-dedup.ts': { normaliseNameKey: 8, safeId: 1 },
  'store/plan-overlay.ts': {},
  'workspace/analysis-cast-io.ts': {},
  // Only the two evidence-quote normalisations (`normaliseForMatch(e.quote)`).
  'routes/analysis.ts': { normaliseForMatch: 2 },
};

const RETIRED_FILES = ['store/remap-fresh-to-prior.ts', 'workspace/cast-merge-base.ts'];
const RETIRED_SYMBOLS = [
  'remapFreshToPriorIds',
  'mergeAnalysisResultWithExistingCast',
  'overlayInterimCastForLiveView',
  'mergeCore',
  'applyRewriteToPriorCast',
  'seedReuseGuardsFromPriorCast',
  'stripEstablishedAsciiRewrites',
  'tier1RewriteKeys',
  'buildInterimCast',
  'createCastMergeBase',
  'CastMergeBase',
  'noteExternalWrite',
  'markDeleted',
  'castBase',
  'CAST_MERGE_BASE_STALE_CODE',
];

function rel(file: string): string {
  return relative(SRC_ROOT, file).split(sep).join('/');
}

/** Every match of `re` in `content` that is real code (not prose / a string). */
function codeMatches(content: string, re: RegExp): number[] {
  const opaque = astOpaqueRangesFor(content);
  const hits: number[] = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = r.exec(content))) if (!isOpaque(opaque, m.index)) hits.push(m.index);
  return hits;
}

function comparatorCounts(content: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of COMPARATORS) {
    const n = codeMatches(content, c.re).length;
    if (n) out[c.name] = n;
  }
  return out;
}

const sources = collectSourceFiles(SRC_ROOT)
  .filter((f) => !rel(f).startsWith('test-utils/'))
  .map((f) => ({ path: rel(f), content: readFileSync(f, 'utf8') }));

describe('single-matcher guard (plan 291 / #4031)', () => {
  it('every listed file holds exactly its pinned comparator counts (both directions)', () => {
    const actual: Record<string, Record<string, number>> = {};
    for (const p of Object.keys(ALLOWED)) {
      const f = sources.find((s) => s.path === p);
      expect(f, `${p} is on the allowlist but missing - renamed or deleted?`).toBeDefined();
      actual[p] = comparatorCounts(f!.content);
    }
    expect(actual).toEqual(ALLOWED);
  });

  it('a file outside the list that reads the prior cast holds no comparator', () => {
    const offenders: string[] = [];
    for (const s of sources) {
      if (s.path in ALLOWED) continue;
      if (codeMatches(s.content, READERS_RE).length === 0) continue;
      const counts = comparatorCounts(s.content);
      if (Object.keys(counts).length) offenders.push(`${s.path}: ${JSON.stringify(counts)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the matchers matchFreshToPrior replaced stay deleted', () => {
    for (const f of RETIRED_FILES) expect(existsSync(join(SRC_ROOT, f)), `${f} is back`).toBe(false);
    const found: string[] = [];
    for (const s of sources) {
      for (const sym of RETIRED_SYMBOLS) {
        if (codeMatches(s.content, new RegExp(`\\b${sym}\\b`, 'g')).length) found.push(`${s.path}: ${sym}`);
      }
    }
    expect(found).toEqual([]);
  });

  describe('the scanner itself', () => {
    it('counts real comparator calls and skips prose / strings', () => {
      const src = [
        "// normaliseNameKey(x) in a line comment",
        '/* surnameTolerantMatch(a, b) in a block comment */',
        "const s = 'safeId(x)';",
        'const a = normaliseNameKey(n) === normaliseNameKey(m);',
        'const b = t.trim().toLowerCase();',
      ].join('\n');
      expect(comparatorCounts(src)).toEqual({ normaliseNameKey: 2, 'trim-toLowerCase': 1 });
    });

    it('sees a reader import / call but not a comment naming it', () => {
      expect(codeMatches('// readPriorCastLockFree\nconst x = 1;', READERS_RE)).toEqual([]);
      expect(codeMatches('import { readPriorCastLockFree } from "./x";', READERS_RE)).toHaveLength(1);
    });
  });
});
