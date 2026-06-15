#!/usr/bin/env node
// Run node:test against pinokio/lib/*.test.js (the CommonJS island). Mirrors
// scripts/run-hooks-tests.mjs; globs in JS (fast-glob) for cross-platform.
import { spawnSync } from 'node:child_process';
import fg from 'fast-glob';

const files = await fg('pinokio/lib/*.test.js', { onlyFiles: true });
if (files.length === 0) {
  process.stdout.write('[test:pinokio] no test files yet — skipping\n');
  process.exit(0);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`run-pinokio-tests: failed to spawn node: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
