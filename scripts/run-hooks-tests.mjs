#!/usr/bin/env node
// Run node:test against scripts/tests/*.test.mjs without depending on shell
// glob expansion. cmd.exe doesn't expand globs, and `node --test <dir>` won't
// pick up our pattern across Node versions consistently — globbing in JS via
// fast-glob (already a dep) is the cross-platform path.

import { spawnSync } from 'node:child_process';
import fg from 'fast-glob';

const files = await fg('scripts/tests/*.test.mjs', { onlyFiles: true });
if (files.length === 0) {
  process.stderr.write('No hook test files found at scripts/tests/*.test.mjs\n');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`run-hooks-tests: failed to spawn node: ${result.error.message}\n`);
  process.exit(1);
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
// check-no-budget-poll.mjs used to run here. It now has its own verify step
// (`check:budget-poll`, scripts/verify-cache.mjs) with server/src/**/*.test.ts
// as its inputs, wired into every local --steps CSV in package.json
// (verify:fast, verify:fast:scoped, verify:fast:branch) as well as CI — so a
// server-only diff actually runs it, which this coupling prevented.
process.exit(0);
