/* Regression coverage for ops-30/#1848: vitest's documented default
   `forceRerunTriggers` entry for config files — a brace-alternation with a
   wildcarded extension, followed by a trailing wildcard suffix — matches
   NOTHING under picomatch 4. A wildcard inside that path segment kills the
   trailing-wildcard-suffix-also-matches-the-file behaviour. verify.yml runs
   BOTH server/vitest.config.ts and server/vitest.config.slow.ts with
   `--changed`; the main config re-lists (and previously inherited the dead
   copy of) vitest's defaults, and the slow config set no override at all —
   which means it fell back to vitest's own broken default. Either way, a
   config-only diff could silently select zero tests and merge unexercised.

   This imports the REAL forceRerunTriggers array from each config module
   (not a re-declared copy) and checks it against the absolute path of every
   file that config documents as needing full-rerun coverage — the same
   shape vitest itself uses when matching. A regression back to the broken
   glob, or a covered file going missing, fails this test. */
import { describe, it, expect } from 'vitest';
import picomatch from 'picomatch';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

/* Confirms `relFromRoot` (relative to `root`) names a real file, then
   returns a SYNTHETIC absolute path (fixed `/repo/...` root, forward
   slashes) for the picomatch check. picomatch's `**` refuses to cross a
   dot-prefixed path segment (its default `dot: false`) — this checkout
   happens to live under `.claude/worktrees/...`, so matching the file's
   REAL on-disk absolute path would spuriously fail here regardless of the
   trigger patterns. A CI/production checkout has no such dot segment; the
   synthetic root keeps the assertion about the patterns, not about where
   this worktree sits.

   The synthetic path reflects `root`'s real nesting under the repo (`/repo`
   for REPO_ROOT, `/repo/server` for SERVER_ROOT) — finding 11 (ops-30
   review): this used to always return `/repo/${relFromRoot}` regardless of
   `root`, so "server package.json" actually asserted against
   `/repo/package.json`, not `/repo/server/package.json`. Both trigger
   patterns start with a leading globstar segment, so nested paths match in
   reality either way, which is why the bug never failed a test — but the
   test wasn't proving what its own label claimed. */
function realFileAsAbsPath(root: string, relFromRoot: string): string {
  expect(existsSync(resolve(root, relFromRoot))).toBe(true);
  const syntheticRoot = root === SERVER_ROOT ? '/repo/server' : '/repo';
  return `${syntheticRoot}/${relFromRoot}`;
}

describe('server/vitest.config.ts forceRerunTriggers', () => {
  it.each([
    { relFromRoot: 'package.json', label: 'server package.json', root: SERVER_ROOT },
    { relFromRoot: 'vitest.config.ts', label: 'this config file', root: SERVER_ROOT },
    { relFromRoot: 'openapi.yaml', label: 'the API contract', root: REPO_ROOT },
  ])('covers $label so a config-only diff still forces a full --changed run', ({ relFromRoot, root }) => {
    expect(matchesTrigger(mainTriggers, realFileAsAbsPath(root, relFromRoot))).toBe(true);
  });
});

describe('server/vitest.config.slow.ts forceRerunTriggers', () => {
  it.each([
    { relFromRoot: 'package.json', label: 'server package.json' },
    { relFromRoot: 'vitest.config.slow.ts', label: 'this config file' },
  ])('covers $label so a config-only diff still forces a full --changed run', ({ relFromRoot }) => {
    expect(matchesTrigger(slowTriggers, realFileAsAbsPath(SERVER_ROOT, relFromRoot))).toBe(true);
  });
});
