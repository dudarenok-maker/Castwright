/* Regression coverage for the two independent ways these configs'
   `forceRerunTriggers` have silently matched nothing:

   ops-30/#1848 — vitest's documented default entry for config files (a
   brace-alternation with a wildcarded extension, followed by a trailing
   wildcard suffix) matches NOTHING under picomatch 4: a wildcard inside a
   path segment kills the trailing-wildcard-suffix-also-matches-the-file
   behaviour. verify.yml runs BOTH server/vitest.config.ts and
   server/vitest.config.slow.ts with `--changed`; the main config re-listed
   the dead copy of vitest's defaults, and the slow config set no override at
   all, so it fell back to vitest's own broken default.

   ops-33/#1868 — picomatch's `**` refuses to cross a dot-prefixed path
   segment unless `{ dot: true }` is passed, and vitest passes no options
   when it builds these matchers. Claude-Code-harness worktrees live under
   `.claude/worktrees/…`, so every entry matched nothing whenever the suite
   ran from one.

   Either way the consequence is the same and it reads as success: a
   config-only diff selects zero tests, exits 0, and merges unexercised.

   This imports the REAL forceRerunTriggers array from each config module
   (not a re-declared copy) and checks it against every file that config
   documents as needing full-rerun coverage, at three checkout shapes. A
   regression to either broken glob, or a covered file going missing, fails
   this test. */
import { describe, it, expect } from 'vitest';
import picomatch from 'picomatch';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVER_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(SERVER_ROOT, '..');

type ViteConfigModule = { default: { test?: { forceRerunTriggers?: string[] } } };

/* server/vitest.config.ts and vitest.config.slow.ts live OUTSIDE server's
   rootDir (server/src), so `tsc -p .` (server typecheck) rejects a STATIC
   import of them ("File is not under rootDir"). A dynamic import with a
   runtime-computed specifier isn't statically resolved by TS, so it can't
   pull the file into the rootDir-checked program. */
async function loadForceRerunTriggers(configAbsPath: string): Promise<string[]> {
  const mod = (await import(pathToFileURL(configAbsPath).href)) as ViteConfigModule;
  return mod.default.test?.forceRerunTriggers ?? [];
}

const mainTriggers = await loadForceRerunTriggers(resolve(SERVER_ROOT, 'vitest.config.ts'));
const slowTriggers = await loadForceRerunTriggers(resolve(SERVER_ROOT, 'vitest.config.slow.ts'));

function matchesTrigger(triggers: string[], absPath: string): boolean {
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

/* Confirms `relFromBase` (relative to `base`) names a real file, then builds
   the absolute path to check under the given synthetic/real repo root.

   The composed path reflects `base`'s real nesting under the repo — finding
   11 of the ops-30 review: this used to return `/repo/${relFromBase}`
   regardless of `base`, so "server package.json" actually asserted against
   `/repo/package.json`, not `/repo/server/package.json`. Every trigger
   starts with a leading globstar segment, so nested paths match in reality
   either way, which is why the bug never failed a test — but the test wasn't
   proving what its own label claimed.

   The nesting is derived rather than compared against SERVER_ROOT: an
   identity check re-introduces exactly that bug the moment a third base is
   added (it would silently fall through to the repo-root branch). */
function absPathUnder(root: string, base: string, relFromBase: string): string {
  expect(existsSync(resolve(base, relFromBase))).toBe(true);
  return [root, toPosix(relative(REPO_ROOT, base)), relFromBase].filter(Boolean).join('/');
}

const MAIN_COVERED = [
  { rel: 'package.json', file: 'server package.json', base: SERVER_ROOT },
  { rel: 'vitest.config.ts', file: 'this config file', base: SERVER_ROOT },
  /* The slow config is NOT matched by the `{vitest,vite}.config.ts` brace —
     it needs its own trigger, and this suite is where its guard lives. */
  { rel: 'vitest.config.slow.ts', file: 'the slow-tier config', base: SERVER_ROOT },
  /* Pins the `vite` half of the brace. Without a case for it, narrowing the
     trigger to `vitest.config.ts` would leave every assertion green while
     silently dropping coverage for the vite build config. */
  { rel: 'vite.config.ts', file: 'the vite build config', base: REPO_ROOT },
  { rel: 'openapi.yaml', file: 'the API contract', base: REPO_ROOT },
  /* #2567 review round 3: spawn-windows-hide.test.ts (this suite) reads
     these trees as TEXT at RUNTIME to scan for a missing windowsHide —
     no module-graph edge, so a diff confined to any of them selected zero
     tests under `vitest run --changed` before these triggers existed. */
  { rel: 'scripts/verify-cache.mjs', file: 'an arbitrary scripts/** file', base: REPO_ROOT },
  {
    rel: 'server/tts-sidecar/scripts/install-ort.mjs',
    file: 'a server/tts-sidecar/scripts/** file (via the scripts/** trigger)',
    base: REPO_ROOT,
  },
  {
    rel: 'pinokio-scripts/lib/resolve-release.js',
    file: 'a pinokio-scripts/** file',
    base: REPO_ROOT,
  },
  { rel: 'e2e/global-teardown.ts', file: 'the e2e Playwright teardown', base: REPO_ROOT },
  { rel: 'launch.mjs', file: 'the versioned-dir launcher', base: REPO_ROOT },
  /* #2588 pass-2 review: venv-migration.test.ts (this suite) reads BOTH of these
     at RUNTIME — .gitattributes to assert the requirements/*.txt LF pin rule is
     declared, the requirements files themselves to assert the pin materialised
     and to hash reqHash oracles against. No module-graph edge to either. */
  { rel: '.gitattributes', file: 'the git line-ending/binary pin rules', base: REPO_ROOT },
  {
    rel: 'server/tts-sidecar/requirements/base.txt',
    file: 'a server/tts-sidecar/requirements/** file',
    base: REPO_ROOT,
  },
  /* #1932 (side-18) — coqui-residency-policy.guard.test.ts reads these three
     files at RUNTIME to catch cross-reference rot across the two eviction
     mechanisms and their policy doc. The sidecar main.py and docs file have no
     module-graph edges (same #1847 runtime-read trap); synthesise-chapter.ts
     IS importable but is included here for consistency with the guard's uniform
     readFileSync approach rather than being split into two separate tracking
     mechanisms. */
  { rel: 'src/tts/synthesise-chapter.ts', file: 'the Node Coqui eviction mechanism', base: SERVER_ROOT },
  {
    rel: 'server/tts-sidecar/main.py',
    file: 'the sidecar Coqui eviction mechanism (via the server/tts-sidecar/main.py trigger)',
    base: REPO_ROOT,
  },
  {
    rel: 'docs/features/264-vram-aware-gpu-placement.md',
    file: 'the Coqui residency policy doc',
    base: REPO_ROOT,
  },
];

const SLOW_COVERED = [
  { rel: 'package.json', file: 'server package.json', base: SERVER_ROOT },
  { rel: 'vitest.config.slow.ts', file: 'this config file', base: SERVER_ROOT },
];

/* Real files that must NOT match. More than one shape, so widening a dead
   trigger to something like `**` + a suffix glob is caught rather than only
   the crudest `**`. */
const NOT_COVERED = [
  { rel: 'src/index.ts', file: 'an ordinary server source file', base: SERVER_ROOT },
  { rel: 'tsconfig.json', file: 'a JSON file that is not a manifest', base: REPO_ROOT },
  { rel: 'apps/android/pubspec.yaml', file: 'a YAML file that is not the contract', base: REPO_ROOT },
];

const crossProduct = (covered: typeof MAIN_COVERED) =>
  covered.flatMap((entry) => ROOT_SHAPES.map((rootShape) => ({ ...entry, ...rootShape })));

describe('server/vitest.config.ts forceRerunTriggers', () => {
  it.each(crossProduct(MAIN_COVERED))(
    'covers $file from $shape so a config-only diff still forces a full --changed run',
    ({ rel, base, root }) => {
      expect(matchesTrigger(mainTriggers, absPathUnder(root, base, rel))).toBe(true);
    },
  );

  /* Guards against "fixing" a dead trigger by widening it to something that
     matches everything — that would force a full run on every diff and
     quietly undo the point of --changed. */
  it.each(crossProduct(NOT_COVERED))('does not match $file from $shape', ({ rel, base, root }) => {
    expect(matchesTrigger(mainTriggers, absPathUnder(root, base, rel))).toBe(false);
  });
});

describe('server/vitest.config.slow.ts forceRerunTriggers', () => {
  it.each(crossProduct(SLOW_COVERED))(
    'covers $file from $shape so a config-only diff still forces a full --changed run',
    ({ rel, base, root }) => {
      expect(matchesTrigger(slowTriggers, absPathUnder(root, base, rel))).toBe(true);
    },
  );

  it.each(crossProduct(NOT_COVERED))('does not match $file from $shape', ({ rel, base, root }) => {
    expect(matchesTrigger(slowTriggers, absPathUnder(root, base, rel))).toBe(false);
  });
});
