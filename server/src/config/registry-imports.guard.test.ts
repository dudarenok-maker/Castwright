/* config/registry-imports.guard.test.ts — enforces "the frontend-reachable
   config module graph is pure data", the invariant that makes it safe for
   the FRONTEND bundle to import server/src/config/*.ts at runtime.

   src/lib/api.ts imports registry.ts AND descriptors.ts directly (not
   through the server's HTTP boundary) to build the mock config catalogue as
   a projection over the same KNOBS the real GET /api/config route serves
   (#2259). That is only safe today because every import those two files
   (transitively) reach is TYPE-ONLY — e.g. registry.ts's `import type {
   ConfigGroup, ConfigKnob } from './types.js'` — which TypeScript erases
   completely, so nothing runtime-side from './types.js' (or anything it
   imports) ever executes inside the Vite bundle.

   If a future edit adds a VALUE import (or a value RE-EXPORT) that reaches
   outside this type-erased graph, that module's own top-level code now runs
   inside the browser. Two concrete ways this breaks, both of which this
   guard must catch:

     1. `import { resolveKnob } from './resolver.js';` added to
        descriptors.ts — plausible: descriptors.ts sits right next to
        resolver.ts and projecting a knob's *effective* value alongside its
        `default` is a natural edit. resolver.ts imports
        `../workspace/user-settings.js`, which imports the `zod` package and
        `node:fs`/`node:fs/promises` — none of which exist in a browser.

     2. `export { PROMPT_IDS } from './prompts.js';` added to registry.ts —
        a RE-EXPORT, not an import. It is NOT erased at compile time (only
        `export type { ... } from` is), so it is just as dangerous as a
        value import: prompts.ts pulls in `node:fs/promises`, `node:fs`,
        `node:path`, `node:url`, `node:os`.

   Either failure mode fails the Vite build outright or ships and throws the
   first time the mock-mode Advanced/config page renders — a failure surface
   no other test exercises, because every other consumer of these files runs
   server-side under Node.

   WHAT THIS CHECKS: starting from the specific `server/src/config/*` module
   specifiers src/lib/api.ts itself imports (discovered by scanning
   api.ts — not a hardcoded file list, so a THIRD such import added to
   api.ts is automatically swept into the graph for free, and a broken/empty
   discovery is caught by the non-vacuity assertion below rather than
   silently checking a stale set), this walks the import graph: for every
   top-level `import ...;` or re-export `export ... from '...';` statement in
   every reached file, type-only forms are skipped (erased, so whatever they
   point at never runs); a value form is followed if its specifier is
   relative and resolves to another local .ts file (added to the graph and
   checked in turn); anything else — a bare/`node:` specifier, or a relative
   specifier that doesn't resolve to a real file — is a violation, because it
   is a value that reaches outside the graph this guard can vouch for.

   This is a textual scan (import/export keyword to the next semicolon), not
   a type-checker or a bundler — deliberately no more than this guard needs;
   it is not meant to generalise to arbitrary TypeScript. Import/export
   detection is anchored to the START OF A LINE (`^\s*import\b` /
   `^\s*export\b`), not just any occurrence of the word — because "import"
   and "export" also appear inside ordinary string literals in these files
   (e.g. registry.ts's label "Pin Coqui import order at startup"), which an
   unanchored scan would misread as a bogus statement.

   MUTATION-PROOF: verified this guard reddens for (1) a value import added
   to descriptors.ts, (2) a value re-export added to registry.ts, and (3) a
   value import added to registry.ts (the original, narrower guard's own
   case) — then reverted all three. See the PR description for the observed
   failure messages. */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const API_PATH = join(REPO_ROOT, 'src/lib/api.ts');

/** Every top-level `import ... ;` OR re-export `export ... from '...';`
    statement's full text, keyword to the next semicolon. Anchored to the
    START OF A LINE — see file header for why. Re-export detection requires
    the structural shape `export (type )?({ ... } | *) from '...';` rather
    than a loose "contains from", so a help-text string like `help: 'exports
    the report';` can never false-positive (it doesn't start the line with
    `export`, and even a line that did wouldn't match the required
    brace/star + quoted-specifier shape). */
function collectStatements(src: string): string[] {
  const importMatches = src.match(/^\s*import\s[^;]*;/gm) ?? [];
  const exportFromMatches =
    src.match(/^\s*export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s+from\s+['"][^'"]+['"];/gm) ?? [];
  return [...importMatches, ...exportFromMatches].map((s) => s.trim());
}

/** True iff every named binding in a `{ ... }` import/export clause is
    individually `type`-qualified, e.g. `{ type A, type B }`. Used for the
    mixed shape `import { type A } from '...'` / `export { type A } from
    '...'`, both of which are also fully erased. */
function everyNamedBindingIsTypeQualified(clause: string): boolean {
  const names = clause
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/** True iff `statement` (full `import ... ;` or `export ... from ...;` text)
    is erased at compile time. `export * from '...'` (no braces) can never be
    type-only here — there's no per-binding qualifier to check, and a bare
    `export * from` re-exports whatever the target has, type or value. */
function isTypeOnlyStatement(statement: string): boolean {
  if (/^import\s+type\b/.test(statement)) return true;
  if (/^export\s+type\b/.test(statement)) return true;

  const importBrace = statement.match(/^import\s*\{([^}]*)\}\s*from/);
  if (importBrace) return everyNamedBindingIsTypeQualified(importBrace[1]);

  const exportBrace = statement.match(/^export\s*\{([^}]*)\}\s*from/);
  if (exportBrace) return everyNamedBindingIsTypeQualified(exportBrace[1]);

  return false;
}

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

const JS_EXT_TO_TS: Record<string, string> = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };

/** Resolves a relative import/export specifier from `fromFile` to a local
    .ts file, translating the NodeNext `.js`-suffixed specifier convention
    (`./registry.js` -> registry.ts) back to the real source file. Returns
    null if nothing on disk matches — treated as a violation by the caller,
    fail-closed rather than silently skipping an unresolvable specifier. */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
  const dir = dirname(fromFile);
  const jsExt = Object.keys(JS_EXT_TO_TS).find((ext) => specifier.endsWith(ext));
  const candidate = jsExt
    ? join(dir, specifier.slice(0, -jsExt.length) + JS_EXT_TO_TS[jsExt])
    : /\.[a-z]+$/i.test(specifier)
      ? join(dir, specifier)
      : join(dir, specifier + '.ts');
  if (existsSync(candidate)) return candidate;
  const indexCandidate = join(dir, specifier, 'index.ts');
  if (existsSync(indexCandidate)) return indexCandidate;
  return null;
}

/** The `server/src/config/*` module specifiers src/lib/api.ts itself
    imports — the roots of the graph this guard walks. Discovered by
    scanning api.ts, not hardcoded, so a new such import is automatically
    covered. */
function findConfigRootSpecifiers(apiSrc: string): string[] {
  const matches = [
    ...apiSrc.matchAll(/^\s*import\s[^;]*from\s+['"](\.\.\/\.\.\/server\/src\/config\/[^'"]+)['"];/gm),
  ];
  return matches.map((m) => m[1]);
}

interface Violation {
  file: string;
  statement: string;
  reason: string;
}

function scanGraph(roots: string[]): { visited: Set<string>; violations: Violation[]; totalStatements: number } {
  const visited = new Set<string>();
  const violations: Violation[] = [];
  const queue = [...roots];
  let totalStatements = 0;

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const src = readFileSync(file, 'utf8');
    const statements = collectStatements(src);
    totalStatements += statements.length;

    for (const statement of statements) {
      if (isTypeOnlyStatement(statement)) continue;

      const specMatch = statement.match(/from\s+['"]([^'"]+)['"]/);
      const specifier = specMatch ? specMatch[1] : null;

      if (!specifier || !isRelativeSpecifier(specifier)) {
        violations.push({
          file: relative(REPO_ROOT, file),
          statement,
          reason: 'non-relative value import/re-export — leaves the type-erased local graph',
        });
        continue;
      }

      const resolved = resolveRelativeSpecifier(file, specifier);
      if (!resolved) {
        violations.push({
          file: relative(REPO_ROOT, file),
          statement,
          reason: `could not resolve '${specifier}' to a local .ts file — treated as unsafe`,
        });
        continue;
      }

      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  return { visited, violations, totalStatements };
}

describe('the frontend-reachable config module graph is pure data (only type-only imports)', () => {
  it("every value import/re-export reachable from src/lib/api.ts's config imports stays type-erased", () => {
    const apiSrc = readFileSync(API_PATH, 'utf8');
    const rootSpecifiers = findConfigRootSpecifiers(apiSrc);

    // If this ever fires, the entry-point scan itself found nothing to walk
    // from — make sure that's not silently masking a broken regex (or
    // src/lib/api.ts no longer importing server/src/config/* at all) rather
    // than an intentional, verified-safe state.
    expect(rootSpecifiers.length).toBeGreaterThan(0);

    const roots = rootSpecifiers.map((spec) => {
      const resolved = resolveRelativeSpecifier(API_PATH, spec);
      expect(
        resolved,
        `src/lib/api.ts imports '${spec}' from server/src/config/ but it could not be resolved to a file on disk`,
      ).not.toBeNull();
      return resolved!;
    });

    const { visited, violations, totalStatements } = scanGraph(roots);

    // Non-vacuity floor for the per-file scan too.
    expect(totalStatements).toBeGreaterThan(0);

    // Sanity floor: the two files this guard exists for must actually be
    // part of the scanned graph, not just named in a comment.
    const visitedBasenames = [...visited].map((f) => f.replace(/\\/g, '/').split('/').pop());
    expect(visitedBasenames).toEqual(expect.arrayContaining(['descriptors.ts', 'registry.ts']));

    expect(
      violations,
      'A file in the config module graph reachable from src/lib/api.ts has a value ' +
        'import/re-export that leaves type-erased territory — this breaks the "safe ' +
        'for the frontend bundle to import at runtime" invariant (see file header):\n' +
        violations.map((v) => `  [${v.file}] ${v.statement}\n    -> ${v.reason}`).join('\n'),
    ).toEqual([]);
  });
});
