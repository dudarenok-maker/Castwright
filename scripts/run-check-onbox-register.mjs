#!/usr/bin/env node
// Wrapper for the two-command check:onbox-register script. npm's && chain
// appends all trailing args (from `npm run check:onbox-register -- <args>`)
// to the LAST command, not the first. This wrapper routes them correctly:
// - Pass all argv to check-onbox-register.mjs
// - If it exits 0, run build-register-live-view.mjs --check (without the argv)
// - Exit with the appropriate status code.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// All CLI arguments after the script name (process.argv[0] is node, [1] is this script)
const cliArgs = process.argv.slice(2);

// Run check-onbox-register.mjs with all the CLI arguments
const checkResult = spawnSync(process.execPath, [join(HERE, 'check-onbox-register.mjs'), ...cliArgs], {
  stdio: 'inherit',
});

// If check-onbox-register failed, exit immediately with its status
if (checkResult.status !== 0) {
  process.exit(checkResult.status ?? 1);
}

// If check-onbox-register passed, run build-register-live-view.mjs --check
// (without the CLI args — it only needs --check, not the register-specific flags)
const buildResult = spawnSync(process.execPath, [join(HERE, 'build-register-live-view.mjs'), '--check'], {
  stdio: 'inherit',
});

// Exit with build-register-live-view's status
process.exit(buildResult.status ?? 1);
