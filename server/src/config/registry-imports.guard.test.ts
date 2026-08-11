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
   inside the browser — it either fails the Vite build outright or ships and
   throws the first time the mock-mode Advanced/config page renders, a
   failure surface no other test exercises (every other consumer of these
   files runs server-side under Node).

   THIS IS AN AST-BASED SCAN, NOT A REGEX, AND THAT IS LOAD-BEARING. This
   guard was regex-based through three prior review rounds, and a regex
   pattern lost to a syntax form it didn't enumerate FOUR separate times:

     1. the scan targeted the wrong file (registry.ts, not descriptors.ts);
     2. `export { X } from '...'` — a re-export — wasn't recognised as an edge;
     3. `export * as ns from '...'` — a namespace re-export — wasn't
        recognised either (verified live: making node:fs reachable through
        this exact form left the guard green);
     4. `export { X } from '../../server/src/config/prompts.js'` used as one
        of src/lib/api.ts's OWN root imports wasn't found by root discovery,
        and slipped past the old non-vacuity floor because the discovered
        root count merely dropped (3 real roots -> 2 found), not to zero.

   Each fix added another hand-written pattern to a regex that was already
   failing to enumerate the grammar it was trying to match. This version
   does not extend that regex — it deletes it. `ts.createSourceFile` parses
   every file in the graph with the real TypeScript grammar, so every import
   and re-export FORM the language defines (bare, named, default, namespace,
   `export *`, `export * as ns`, mixed default+named, per-specifier `type`)
   is classified by construction, not by a pattern this file had to think of
   in advance. A future reader who doesn't know that history may look at
   this and want to "simplify" it back to a text scan — don't; that is
   exactly the shape of the four bugs above.

   WHAT THIS CHECKS:
     - Root discovery: every top-level import/export-from statement in
       src/lib/api.ts whose specifier resolves under server/src/config/ is a
       root, found by walking api.ts's parsed AST (not a hardcoded file
       list) — so a root added via ANY statement form, including a re-export,
       is swept in automatically. This is cross-checked (see "non-vacuity"
       below) against every string literal anywhere in api.ts's AST that
       merely mentions the config path, so a root reachable only through a
       form root discovery doesn't walk (e.g. a dynamic `import(...)` call)
       still surfaces as a mismatch instead of silently going unwalked.
     - Graph walk: starting from those roots, every top-level import/export
       declaration in every reached file is classified as erased or not:
         * `ts.ImportDeclaration` — erased iff the whole clause is
           `import type`, or there is no default import and every named
           specifier is individually `type`-qualified. A declaration with NO
           import clause (`import './x.js';`, a side-effect import) is never
           erased — there are no bindings to qualify.
         * `ts.ExportDeclaration` with a module specifier — erased iff the
           whole declaration is `export type ... from`, or every named
           specifier is individually `type`-qualified. `export * from` and
           `export * as ns from` can never be type-only via a per-specifier
           qualifier (there's nothing to qualify), only via `export type *
           (as ns)? from`. An `ExportDeclaration` with NO module specifier is
           a local re-export (no edge) and is ignored.
       A non-erased edge is followed only if its specifier is relative and
       resolves (after the `.js` -> `.ts` NodeNext-style translation) to a
       real local file; anything else — a bare/`node:`/package specifier, or
       a relative specifier that doesn't resolve — is a violation, because it
       is a value that reaches outside the graph this guard can vouch for.

   This is deliberately narrow: it walks the top-level statement list of each
   file, it does not type-check or resolve `tsconfig.json` path aliases, and
   it does not follow dynamic `import()`/`require()` calls inside the
   interior graph (only api.ts's own roots get that broader cross-check). It
   is not meant to generalise beyond what this specific invariant needs. */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const API_PATH = join(REPO_ROOT, 'src/lib/api.ts');
const CONFIG_DIR = join(REPO_ROOT, 'server/src/config');

function parse(filePath: string): ts.SourceFile {
  const src = readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

const JS_EXT_TO_TS: Record<string, string> = { '.js': '.ts', '.mjs': '.mts', '.cjs': '.cts' };

/** Resolves a relative import/export specifier from `fromFile` to a local
    .ts file, translating the NodeNext `.js`-suffixed specifier convention
    (`./registry.js` -> registry.ts) back to the real source file, and also
    accepting an extensionless specifier (src/lib/api.ts's own style, e.g.
    `'../../server/src/config/registry'`). Returns null if nothing on disk
    matches — treated as a violation by the caller, fail-closed rather than
    silently skipping an unresolvable specifier. */
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

function isInsideConfigDir(filePath: string): boolean {
  const rel = relative(CONFIG_DIR, filePath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

interface Edge {
  /** Full statement source text, for violation reporting. */
  statementText: string;
  /** The module specifier's literal text, or null if it isn't a plain
      string literal (defensive — the TS grammar requires a string literal
      here, so this is effectively unreachable for valid syntax). */
  specifier: string | null;
  /** True iff TypeScript erases this whole declaration at compile time. */
  isTypeOnly: boolean;
}

/** True iff every element in a named import/export clause is individually
    `type`-qualified (`{ type A, type B }`), the shape TS erases entirely
    even though the declaration itself isn't `import type`/`export type`. */
function everyElementTypeOnly(elements: readonly { isTypeOnly: boolean }[]): boolean {
  return elements.length > 0 && elements.every((el) => el.isTypeOnly);
}

/** Every top-level import declaration and module-specifier-bearing export
    declaration in `sourceFile`, classified for erasure. Walks
    `sourceFile.statements` via the real TypeScript AST — every syntactic
    form the grammar defines is covered by construction, not enumerated by
    hand. See file header for why that distinction is the whole point. */
function collectEdges(sourceFile: ts.SourceFile): Edge[] {
  const edges: Edge[] = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const specifier = ts.isStringLiteralLike(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
      const clause = stmt.importClause;
      let isTypeOnly: boolean;
      if (!clause) {
        // Side-effect import (`import './x.js';`) — no bindings to qualify,
        // so it is never erased.
        isTypeOnly = false;
      } else if (clause.isTypeOnly) {
        isTypeOnly = true;
      } else if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        // No default import alongside — erased iff every named specifier is.
        isTypeOnly = everyElementTypeOnly(clause.namedBindings.elements);
      } else {
        // A default import and/or a namespace import (`import * as ns`) is
        // present and the clause itself isn't `import type` — a real value.
        isTypeOnly = false;
      }
      edges.push({ statementText: stmt.getText(sourceFile).trim(), specifier, isTypeOnly });
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      // No module specifier => a local re-export (`export { X };`), not an
      // edge leaving this file — ignored, per file header.
      const specifier = ts.isStringLiteralLike(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
      let isTypeOnly = stmt.isTypeOnly;
      if (!isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        isTypeOnly = everyElementTypeOnly(stmt.exportClause.elements);
      }
      // `export * from '...'` (exportClause undefined) and
      // `export * as ns from '...'` (exportClause is a NamespaceExport) both
      // fall through with isTypeOnly left at the declaration-level flag —
      // there is no per-specifier qualifier for either shape, so only
      // `export type * (as ns)? from` erases them.
      edges.push({ statementText: stmt.getText(sourceFile).trim(), specifier, isTypeOnly });
    }
  }

  return edges;
}

/** Every string literal anywhere in `sourceFile`'s AST that mentions the
    config directory — a deliberately dumb, structure-blind net used ONLY to
    cross-check root discovery (see below), so a root reachable through a
    form `collectEdges` doesn't inspect (e.g. a dynamic `import(...)` or
    `require(...)` call) still shows up as a mismatch instead of silently
    going unwalked. Comments are lexer trivia, not AST nodes, so a mention
    inside a comment (api.ts has two, in doc comments) can never appear
    here. */
function findAllConfigStringLiterals(sourceFile: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.includes('server/src/config/')) {
      found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

interface Violation {
  file: string;
  statement: string;
  reason: string;
}

function scanGraph(roots: string[]): { visited: Set<string>; violations: Violation[]; totalEdges: number } {
  const visited = new Set<string>();
  const violations: Violation[] = [];
  const queue = [...roots];
  let totalEdges = 0;

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const edges = collectEdges(parse(file));
    totalEdges += edges.length;

    for (const edge of edges) {
      if (edge.isTypeOnly) continue;

      if (edge.specifier === null) {
        violations.push({
          file: relative(REPO_ROOT, file),
          statement: edge.statementText,
          reason: 'module specifier is not a string literal — cannot verify where this edge leads',
        });
        continue;
      }

      if (!isRelativeSpecifier(edge.specifier)) {
        violations.push({
          file: relative(REPO_ROOT, file),
          statement: edge.statementText,
          reason: 'non-relative value import/re-export — leaves the type-erased local graph',
        });
        continue;
      }

      const resolved = resolveRelativeSpecifier(file, edge.specifier);
      if (!resolved) {
        violations.push({
          file: relative(REPO_ROOT, file),
          statement: edge.statementText,
          reason: `could not resolve '${edge.specifier}' to a local .ts file — treated as unsafe`,
        });
        continue;
      }

      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  return { visited, violations, totalEdges };
}

describe('the frontend-reachable config module graph is pure data (only type-only imports)', () => {
  it("every value import/re-export reachable from src/lib/api.ts's config imports stays type-erased", () => {
    const apiSourceFile = parse(API_PATH);
    const apiEdges = collectEdges(apiSourceFile);

    const discoveredRootSpecifiers = new Set<string>();
    const roots: string[] = [];
    for (const edge of apiEdges) {
      if (!edge.specifier || !isRelativeSpecifier(edge.specifier)) continue;
      const resolved = resolveRelativeSpecifier(API_PATH, edge.specifier);
      if (resolved && isInsideConfigDir(resolved)) {
        discoveredRootSpecifiers.add(edge.specifier);
        roots.push(resolved);
      }
    }

    // Non-vacuity floor for root discovery, strengthened beyond "found at
    // least one": the independently-derived ground truth (every string
    // literal in api.ts's AST that mentions the config path, found by a
    // structure-blind full-tree walk, not the statement-shape-aware one
    // root discovery uses) must be non-empty AND must exactly match what
    // root discovery found. A partial miss — root discovery finding fewer
    // roots than actually exist — fails here instead of silently walking a
    // smaller graph (this is exactly how case 4 in the file header slipped
    // through the old `length > 0` check).
    const allConfigStringLiterals = findAllConfigStringLiterals(apiSourceFile);
    expect(allConfigStringLiterals.size).toBeGreaterThan(0);
    expect(discoveredRootSpecifiers).toEqual(allConfigStringLiterals);

    for (const spec of discoveredRootSpecifiers) {
      const resolved = resolveRelativeSpecifier(API_PATH, spec);
      expect(
        resolved,
        `src/lib/api.ts imports '${spec}' from server/src/config/ but it could not be resolved to a file on disk`,
      ).not.toBeNull();
    }

    const { visited, violations, totalEdges } = scanGraph(roots);

    // Non-vacuity floor for the per-file scan too.
    expect(totalEdges).toBeGreaterThan(0);

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
