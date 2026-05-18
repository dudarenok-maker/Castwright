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
process.exit(result.status ?? 1);
