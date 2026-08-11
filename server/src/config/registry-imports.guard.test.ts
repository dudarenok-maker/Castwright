/* config/registry-imports.guard.test.ts — enforces "registry.ts is pure
   data", the invariant that makes it safe for the FRONTEND bundle to import
   server/src/config/registry.ts at runtime.

   src/lib/api.ts imports registry.ts directly (not through the server's
   HTTP boundary) to build the mock config catalogue as a projection over
   the same KNOBS the real GET /api/config route serves (#2259). That is
   only safe today because registry.ts's only import — `import type {
   ConfigGroup, ConfigKnob } from './types.js'` — is TYPE-ONLY:
   TypeScript erases it completely, so nothing runtime-side from './types.js'
   (or anything it imports) ever executes inside the Vite bundle.

   If a future edit adds a VALUE import instead — e.g. `import { PROMPT_IDS }
   from './prompts.js'` (plausible: prompts.ts sits right next to registry.ts
   and is knob-related) — that module's own top-level code now runs inside
   the browser. `prompts.ts` pulls in `node:fs`/`node:path`, neither of
   which exists in a browser; depending on the bundler this either fails the
   Vite build outright or ships and throws the first time the mock-mode
   Advanced/config page renders — a failure surface no other test exercises,
   because every other consumer of registry.ts runs server-side under Node.

   WHAT THIS CHECKS: reads registry.ts's raw source and asserts every
   top-level `import` statement is type-only — either the whole statement is
   `import type { ... } from '...'`, or (a mixed import) every named binding
   is individually qualified: `import { type A, type B } from '...'`. A
   plain `import { X } from '...'` fails this guard even if `X` happens to
   only be used as a type today — the point is that the IMPORT ITSELF is
   erased at compile time, not that today's usage happens to be type-only.

   This is a textual scan (import keyword to the next semicolon), not a
   type-checker — deliberately no more than this one small, tightly-scoped
   file needs; it is not meant to generalise to arbitrary TypeScript.

   MUTATION-PROOF: verified this guard reddens when a value import (`import
   { PROMPT_IDS } from './prompts.js';`) is added to registry.ts, then
   reverted — see the PR description for the observed failure message. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(__dirname, 'registry.ts');

/** Every top-level `import ... ;` statement's full text, import-keyword to
    the next semicolon (registry.ts's imports are simple named/type imports
    with no semicolon inside the module specifier, so this is a safe split
    for this one file). Anchored to the START OF A LINE (`^\s*import\b`) —
    not just any occurrence of the word "import" — because the word also
    appears inside ordinary string literals in this file (e.g. the label
    "Pin Coqui import order at startup"), which an unanchored scan would
    misread as a second, bogus import statement. */
function collectImportStatements(src: string): string[] {
  const matches = src.match(/^\s*import\s[^;]*;/gm);
  return matches ? matches.map((m) => m.trim()) : [];
}

/** True iff every named binding in a `{ ... }` import clause is individually
    `type`-qualified, e.g. `{ type A, type B }`. Used for the mixed-import
    shape `import { type A } from '...'`, which is also fully erased. */
function everyNamedBindingIsTypeQualified(clause: string): boolean {
  const names = clause
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 && names.every((n) => /^type\s/.test(n));
}

/** True iff `statement` (full `import ... ;` text) is erased at compile
    time — either `import type ...` or every named binding is `type`-
    qualified. */
function isTypeOnlyImport(statement: string): boolean {
  if (/^import\s+type\b/.test(statement)) return true;
  const braceMatch = statement.match(/^import\s*\{([^}]*)\}\s*from/);
  if (braceMatch) return everyNamedBindingIsTypeQualified(braceMatch[1]);
  return false;
}

describe('registry.ts is pure data (only type-only imports)', () => {
  it('every import in registry.ts is erased at compile time', () => {
    const src = readFileSync(REGISTRY_PATH, 'utf8');
    const statements = collectImportStatements(src);

    // If this ever fires, the scan itself found nothing to check — make
    // sure that's not silently masking a broken regex rather than an
    // actually-import-free file.
    expect(statements.length).toBeGreaterThan(0);

    const valueImports = statements.filter((s) => !isTypeOnlyImport(s));
    expect(
      valueImports,
      `registry.ts has a non-type-only import — this breaks the "safe for the ` +
        `frontend bundle to import at runtime" invariant (see file header):\n  ` +
        valueImports.join('\n  '),
    ).toEqual([]);
  });
});
