/* Regression coverage for the two independent ways this suite's
   `forceRerunTriggers` have silently matched nothing:

   ops-30/#1848 — vitest's documented default entry for config files (a
   brace-alternation with a wildcarded extension, followed by a trailing
   wildcard suffix) matches NOTHING under picomatch 4: a wildcard inside a
   path segment kills the trailing-wildcard-suffix-also-matches-the-file
   behaviour. Both vitest.config.ts and server/vitest.config.ts re-list
   vitest's defaults (setting forceRerunTriggers replaces rather than extends
   them), so both silently inherited the dead pattern.

   ops-33/#1868 — picomatch's `**` refuses to cross a dot-prefixed path
   segment unless `{ dot: true }` is passed, and vitest passes no options
   when it builds these matchers. Claude-Code-harness worktrees live under
   `.claude/worktrees/…`, so every entry matched nothing whenever the suite
   ran from one.

   Either way the consequence is the same and it reads as success:
   `vitest run --changed <base>` (verify.yml) selects ZERO tests and exits 0,
   so the change merges without being exercised.

   This imports the REAL forceRerunTriggers array (not a re-declared copy)
   and checks it against every file this suite's config documents as needing
   full-rerun coverage, at three checkout shapes. A regression to either
   broken glob, or a covered file going missing, fails this test. */
import { describe, it, expect } from 'vitest';
import picomatch from 'picomatch';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../../vitest.config';

const triggers = config.test?.forceRerunTriggers ?? [];
const REPO_ROOT = resolve(__dirname, '..', '..');

function matchesTrigger(absPath: string): boolean {
  return triggers.some((pattern) => picomatch(pattern)(absPath));
}

/* Vitest normalises to forward slashes (it resolves through `pathe`) before
   consulting these patterns, but node's `path.resolve` does not. Without
   this, the real-checkout assertion below would fail on Windows for reasons
   that have nothing to do with the patterns. */
const toPosix = (p: string): string => p.replace(/\\/g, '/');

/* Every covered file is asserted at all three shapes.

   The dot-prefixed shape is the ops-33 pin, and it is REQUIRED even though
   CI never runs from such a path: without it, dropping the dot-tolerant half
   of a trigger would pass CI unnoticed and break only on developer machines
   — which is precisely how #1868 survived as long as it did.

   The real on-disk shape proves the mechanism works where this suite is
   actually executing, not merely in the abstract. Before #1868 was fixed
   that assertion could not be made at all: this suite runs from
   `.claude/worktrees/…` often enough that it would have failed for reasons
   unrelated to the patterns. */
const ROOT_SHAPES = [
  { shape: 'a clean checkout', root: '/repo' },
  { shape: 'a dot-prefixed checkout', root: '/repo/.claude/worktrees/wt' },
  { shape: 'this checkout', root: toPosix(REPO_ROOT) },
];

const COVERED = [
  { rel: 'package.json', file: 'root package.json' },
  { rel: 'vitest.config.ts', file: 'this config file' },
  /* Pins the `vite` half of the brace. Without a case for it, narrowing the
     trigger to `vitest.config.ts` would leave every assertion green while
     silently dropping coverage for the vite build config — plugins, the `@`
     alias, build options. */
  { rel: 'vite.config.ts', file: 'the vite build config' },
  { rel: 'src/test/setup.ts', file: 'the injected test-setup file' },
  { rel: 'openapi.yaml', file: 'the API contract' },
];

/* Real files that must NOT match. More than one shape, so widening a dead
   trigger to something like `**` plus a suffix glob is caught rather than
   only the crudest `**`. */
const NOT_COVERED = [
  { rel: 'src/main.tsx', file: 'an ordinary source file' },
  { rel: 'tsconfig.json', file: 'a JSON file that is not a manifest' },
  { rel: 'apps/android/pubspec.yaml', file: 'a YAML file that is not the contract' },
];

const crossProduct = (files: typeof COVERED) =>
  files.flatMap((entry) => ROOT_SHAPES.map((rootShape) => ({ ...entry, ...rootShape })));

describe('vitest.config.ts forceRerunTriggers', () => {
  it.each(COVERED)('$file is a real file, so the trigger covers something', ({ rel }) => {
    expect(existsSync(resolve(REPO_ROOT, rel))).toBe(true);
  });

  it.each(crossProduct(COVERED))(
    'covers $file from $shape so a config-only diff still forces a full --changed run',
    ({ rel, root }) => {
      expect(matchesTrigger(`${root}/${rel}`)).toBe(true);
    },
  );

  /* Guards against "fixing" a dead trigger by widening it to something that
     matches everything — that would force a full run on every diff and
     quietly undo the point of --changed. */
  it.each(NOT_COVERED)('$file is a real file, so the negative control is honest', ({ rel }) => {
    expect(existsSync(resolve(REPO_ROOT, rel))).toBe(true);
  });

  it.each(crossProduct(NOT_COVERED))('does not match $file from $shape', ({ rel, root }) => {
    expect(matchesTrigger(`${root}/${rel}`)).toBe(false);
  });
});
