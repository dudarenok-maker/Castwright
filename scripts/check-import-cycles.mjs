#!/usr/bin/env node
// scripts/check-import-cycles.mjs
//
// Guards server/src's import graph against an ALLOWLISTED set of circular
// dependencies (#2053). Runs madge at a PINNED version via `npx --yes
// madge@8.0.0` and asserts the CURRENT cycle list is a subset of the committed
// allowlist (server/madge-cycles-allowlist.json).
//
// Why `npx --yes madge@8.0.0` rather than a server/ devDependency: madge 8
// declares `peerOptional typescript@^5.4.4` and this repo is on typescript 6,
// so adding it to server/package.json produces a lockfile `npm ci` then
// REJECTS (PR #2159's first CI run: "Missing: ts-toolbelt@9.6.0 from lock
// file"). Forcing past the peer conflict would leave a lockfile that has to be
// re-forced on every future TypeScript bump. The version is still pinned in
// the spawn line below, so the verdict stays reproducible run to run — and
// this matches CLAUDE.md's own documented command shape. The cost is a network
// fetch on a cold cache, which is acceptable because this step is
// cloud/full-verify-only (never pre-commit, never pre-push) and the job it
// runs in already does `npm ci`.
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
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

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
  const args = ['--yes', 'madge@8.0.0', '--circular', '--extensions', 'ts', '--json', 'src'];
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

/**
 * The subset check above treats an EMPTY current list as "every cycle was
 * fixed" and passes. That is indistinguishable from madge walking a graph it
 * could not build — and madge exits 0 with stdout `[]` in exactly that case
 * (verified against 8.0.0: one wrong token in `--extensions`, or an empty
 * source dir, both yield `[] / exit 0`). The guard would then print a
 * reassuring success line forever while checking nothing.
 *
 * The committed allowlist is a free lower bound, so use it: a run that finds
 * zero cycles against a non-empty allowlist is either a real, celebratory
 * change that must update the allowlist in the same commit, or a broken
 * invocation. Both need a human, so fail closed and say which is which.
 *
 * @param {string[][]} currentCycles
 * @param {string[][]} allowlistCycles
 * @returns {string | null} an error message, or null when the floor holds
 */
export function checkCycleFloor(currentCycles, allowlistCycles) {
  if (allowlistCycles.length === 0 || currentCycles.length > 0) return null;
  return (
    `madge reported ZERO cycles, but the allowlist pins ${allowlistCycles.length}. ` +
    'A subset check passes vacuously on an empty list, so this fails instead of ' +
    'reporting a green it cannot justify.\n' +
    '  - If you genuinely broke every cycle: empty server/madge-cycles-allowlist.json ' +
    'in this same commit.\n' +
    '  - Otherwise madge walked nothing (a bad --extensions token or an empty ' +
    'source dir both exit 0 with `[]`) — check the invocation.'
  );
}

if (isDirectlyInvoked(import.meta.url)) {
  // Internal, undocumented test hook mirroring run-golden-audio.mjs's
  // RUN_GOLDEN_AUDIO_PROBE_GUARD_ONLY — the #2291 regression test needs a
  // real subprocess through a junction to genuinely exercise the
  // argv[1]-vs-import.meta.url resolution, but must not thereby spawn the
  // real `npx madge` (network-touching, ~10s) inside `npm run test:hooks`'s
  // pre-commit/pre-push/CI hot path — this file's own test suite already
  // documents that a real madge pass is deliberately kept out of test:hooks.
  // Proves the guard resolved TRUE before madge is spawned; the only caller
  // is scripts/tests/entry-point-guards.test.mjs.
  if (process.env.CHECK_IMPORT_CYCLES_PROBE_GUARD_ONLY === '1') {
    process.stdout.write('check-import-cycles: direct-invocation guard resolved TRUE (probe-only, madge not run)\n');
    process.exit(0);
  }
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

  const floorError = checkCycleFloor(current, allowlist);
  if (floorError) {
    process.stderr.write(`check-import-cycles: FAIL — ${floorError}\n`);
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
