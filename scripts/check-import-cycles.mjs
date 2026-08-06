#!/usr/bin/env node
// scripts/check-import-cycles.mjs
//
// Guards server/src's import graph against an ALLOWLISTED set of circular
// dependencies (#2053). Runs madge — a `server/` devDependency (lockfile-
// pinned, not `npx --yes`, so the verdict is reproducible run to run) — and
// asserts the CURRENT cycle list is a subset of the committed allowlist
// (server/madge-cycles-allowlist.json).
//
// Deliberately NOT a count check: a count is blind to a SWAPPED cycle
// (remove one, introduce a different one, the count stays put, the guard
// stays green). Comparing the actual list catches that.
//
// A cycle's identity is the SET of files it walks through, not the order
// madge happened to report them in — so a harmless re-ordering of the same
// cycle (e.g. after an unrelated file is added to the graph) doesn't
// false-positive as "new".
//
// Usage: node scripts/check-import-cycles.mjs
// Exit 0: every cycle madge finds today is allowlisted.
// Exit 1: madge found a cycle that isn't, or madge itself failed to run.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const serverDir = join(repoRoot, 'server');
const allowlistPath = join(serverDir, 'madge-cycles-allowlist.json');

/** @param {string[]} cycle */
export function cycleSignature(cycle) {
  return [...cycle].sort().join(' <-> ');
}

/**
 * Runs `npx madge --circular --extensions ts --json src` from `server/` and
 * returns the parsed cycle list (array of arrays of paths relative to
 * `server/src`).
 * @param {{ cwd?: string }} [opts]
 */
export function runMadge({ cwd = serverDir } = {}) {
  // npx is a .cmd shim on Windows; Node refuses to spawn a .cmd directly
  // (EINVAL) unless routed through a shell (same idiom as
  // scripts/quarantine-health.mjs's runVitestJson). `npx` itself must stay
  // UNQUOTED in the command string — quoting it breaks Windows' npx.cmd
  // shim's own self-location logic.
  const args = ['madge', '--circular', '--extensions', 'ts', '--json', 'src'];
  const command = `npx ${args.map((a) => `"${a}"`).join(' ')}`;
  const result = spawnSync(command, {
    cwd,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`madge failed to run: ${result.error.message}`);
  }
  // madge exits 1 when it FINDS circular dependencies — that is the expected
  // common case, not a tool failure. Only unparsable stdout is a real
  // failure (missing devDependency, crashed process, etc).
  let cycles;
  try {
    cycles = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `madge did not emit parsable JSON (exit ${result.status}): ${err.message}\n` +
        `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!Array.isArray(cycles)) {
    throw new Error(`madge JSON output was not an array: ${result.stdout}`);
  }
  return cycles;
}

/** @param {string} [path] */
export function loadAllowlist(path = allowlistPath) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON array of cycles`);
  }
  return parsed;
}

/**
 * @param {string[][]} currentCycles
 * @param {string[][]} allowlistCycles
 * @returns {string[][]} current cycles NOT present (by signature) in the allowlist
 */
export function findUnallowedCycles(currentCycles, allowlistCycles) {
  const allowed = new Set(allowlistCycles.map(cycleSignature));
  return currentCycles.filter((cycle) => !allowed.has(cycleSignature(cycle)));
}

const invokedHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedHref && import.meta.url === invokedHref) {
  let current;
  try {
    current = runMadge();
  } catch (err) {
    process.stderr.write(`check-import-cycles: FAILED to run madge — ${err.message}\n`);
    process.exit(1);
  }

  let allowlist;
  try {
    allowlist = loadAllowlist();
  } catch (err) {
    process.stderr.write(`check-import-cycles: FAILED to load allowlist — ${err.message}\n`);
    process.exit(1);
  }

  const unallowed = findUnallowedCycles(current, allowlist);
  if (unallowed.length === 0) {
    process.stdout.write(
      `check-import-cycles: OK — ${current.length} circular dependenc${current.length === 1 ? 'y' : 'ies'} found, all allowlisted (server/madge-cycles-allowlist.json).\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `check-import-cycles: FAIL — ${unallowed.length} circular dependenc${unallowed.length === 1 ? 'y' : 'ies'} not in the allowlist:\n\n`,
  );
  for (const cycle of unallowed) {
    process.stderr.write(`  ${cycle.join(' > ')}\n`);
  }
  process.stderr.write(
    '\nIf this cycle is new and intentional, add it to server/madge-cycles-allowlist.json.\n' +
      'If it is accidental, break the cycle instead of allowlisting it.\n',
  );
  process.exit(1);
}
