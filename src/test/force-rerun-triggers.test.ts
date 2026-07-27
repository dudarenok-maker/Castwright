/* Regression coverage for ops-30/#1848: vitest's documented default
   `forceRerunTriggers` entry for config files — a brace-alternation with a
   wildcarded extension, followed by a trailing wildcard suffix — matches
   NOTHING under picomatch 4. A wildcard inside that path segment kills the
   trailing-wildcard-suffix-also-matches-the-file behaviour. Both
   vitest.config.ts and server/vitest.config.ts re-list vitest's defaults
   (setting forceRerunTriggers replaces rather than extends them), so both
   silently inherited the dead pattern. Consequence: `vitest run --changed
   <base>` (verify.yml) selected ZERO tests for a config-only diff, which
   could merge without exercising the change.

   This imports the REAL forceRerunTriggers array (not a re-declared copy)
   and checks it against the absolute path of every file this suite's config
   documents as needing full-rerun coverage — the same shape vitest itself
   uses when matching. A regression back to the broken glob, or a covered
   file going missing, fails this test. */
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

/* Confirms `relFromRoot` names a real file, then returns a SYNTHETIC
   absolute path (fixed `/repo/...` root, forward slashes) for the picomatch
   check. picomatch's `**` refuses to cross a dot-prefixed path segment
   (its default `dot: false`) — this checkout happens to live under
   `.claude/worktrees/...`, so matching the file's REAL on-disk absolute
   path would spuriously fail here regardless of the trigger patterns. A
   CI/production checkout has no such dot segment; the synthetic root keeps
   the assertion about the patterns, not about where this worktree sits. */
function realFileAsAbsPath(relFromRoot: string): string {
  expect(existsSync(resolve(REPO_ROOT, relFromRoot))).toBe(true);
  return `/repo/${relFromRoot}`;
}

describe('vitest.config.ts forceRerunTriggers', () => {
  it.each([
    { relFromRoot: 'package.json', label: 'root package.json' },
    { relFromRoot: 'vitest.config.ts', label: 'this config file' },
    { relFromRoot: 'src/test/setup.ts', label: 'the injected test-setup file' },
    { relFromRoot: 'openapi.yaml', label: 'the API contract' },
  ])('covers $label so a config-only diff still forces a full --changed run', ({ relFromRoot }) => {
    expect(matchesTrigger(realFileAsAbsPath(relFromRoot))).toBe(true);
  });
});
