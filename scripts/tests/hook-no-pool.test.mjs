// scripts/tests/hook-no-pool.test.mjs — the load-bearing invariant of
// docs/superpowers/specs/2026-09-05-commit-gate-rebalance-design.md's Part 1:
// "a hook may never spawn a process pool."
//
// An ALLOWLIST, not a denylist. A denylist of "known pool commands" misses
// `npm test`, `npm run verify`, `npm run test:server`, `playwright test`,
// `pytest` — anything not already on the list slips through silently. This
// checker instead asserts every non-comment, non-blank line in a `.husky/*`
// hook body matches one of a small set of KNOWN-SAFE invocations; anything
// else — including a command nobody thought to denylist — fails closed.
//
// Every test here asserts against input that would otherwise make the guard
// fire: the real hook files must pass TODAY, and a synthetic "fat" hook body
// (the shape a regression would look like — someone re-adding a battery)
// must fail, proving the checker can actually redden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();

// One pattern per line-shape that exists in a `.husky/*` hook today. Matched
// against the WHOLE trimmed line — deliberately narrow (no wildcard command
// names) so a line that merely resembles an allowed one, but names a
// different script or a different `--steps` value, still fails.
const ALLOWED_LINE_PATTERNS = [
  /^node scripts\/validate-commit-msg\.mjs "\$1"$/,
  /^node scripts\/hooks\/pre-commit-lint\.mjs$/,
  /^PUSH_REFS=\$\(cat\)$/,
  /^printf '%s\\n' "\$PUSH_REFS" \| node scripts\/guard-protected-push\.mjs "\$@" \|\| exit 1$/,
  /^printf '%s\\n' "\$PUSH_REFS" \| node scripts\/guard-commit-subjects\.mjs "\$@" \|\| exit 1$/,
  /^if printf '%s\\n' "\$PUSH_REFS" \| node scripts\/is-docs-only-push\.mjs "\$@"; then$/,
  /^exit [01]$/,
  /^fi$/,
  // The ONE budgeted local check pre-push may run: test:sidecar, scope-gated
  // to server/tts-sidecar/**, spawns pytest (not a vitest fork pool). Pinned
  // to this exact `--steps` value — a future edit that widens it to include
  // a pool step (test, test:server, ...) must fail this guard, not slide
  // through because "verify-cache.mjs" is on some broader allowlist.
  /^node scripts\/verify-cache\.mjs --steps test:sidecar --scope-branch$/,
];

/** True for a line that needs no allowlist entry: blank, or a `#` comment. */
function isInertLine(line) {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith('#');
}

/** Returns the trimmed, non-inert lines of `hookBody` that match none of
 *  ALLOWED_LINE_PATTERNS — i.e. the lines a reviewer would need to explain. */
export function findDisallowedHookLines(hookBody) {
  return String(hookBody)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !isInertLine(line))
    .filter((line) => !ALLOWED_LINE_PATTERNS.some((re) => re.test(line)));
}

/** Enumerate all hook files in .husky/ — excludes directories and dotfiles. */
function enumerateHookFiles() {
  const huskyDir = join(repoRoot, '.husky');
  const entries = readdirSync(huskyDir);
  return entries
    .filter((name) => {
      // Skip directories and dotfiles.
      if (name.startsWith('.')) return false;
      const stat = statSync(join(huskyDir, name));
      return stat.isFile();
    })
    .sort();
}

const HOOKS = enumerateHookFiles();

for (const hook of HOOKS) {
  test(`.husky/${hook} contains only allowlisted invocations`, () => {
    const body = readFileSync(join(repoRoot, '.husky', hook), 'utf8');
    const offenders = findDisallowedHookLines(body);
    assert.deepEqual(
      offenders,
      [],
      `.husky/${hook} has a line the allowlist doesn't recognize (a hook may never spawn a process pool):\n${offenders.join('\n')}`,
    );
  });
}

test('the checker actually fails on a hook body that regains a battery (proves it can redden)', () => {
  const fatHookBody = [
    '# a future regression: someone re-adds the full battery',
    'printf \'%s\\n\' "$PUSH_REFS" | node scripts/guard-protected-push.mjs "$@" || exit 1',
    'npm run verify:fast:branch',
  ].join('\n');
  const offenders = findDisallowedHookLines(fatHookBody);
  assert.deepEqual(offenders, ['npm run verify:fast:branch']);
});

// The brief's own named examples of what a denylist would miss — each must
// independently fail the allowlist, not just the one shape above.
const KNOWN_POOL_COMMANDS = [
  'npm test',
  'npm run verify',
  'npm run test:server',
  'npx playwright test',
  'pytest',
];

for (const command of KNOWN_POOL_COMMANDS) {
  test(`a hook body containing "${command}" fails the allowlist`, () => {
    const offenders = findDisallowedHookLines(command);
    assert.deepEqual(offenders, [command]);
  });
}

test('a widened --steps value on the sidecar check still fails (pinned, not pattern-matched loosely)', () => {
  const offenders = findDisallowedHookLines(
    'node scripts/verify-cache.mjs --steps test:sidecar,test:server --scope-branch',
  );
  assert.deepEqual(offenders, [
    'node scripts/verify-cache.mjs --steps test:sidecar,test:server --scope-branch',
  ]);
});
