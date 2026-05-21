// Tests for scripts/wt-merge.mjs — argument parsing, dry-run, idempotent
// restart on a partially-merged integration branch, conflict abort with
// exit code 2 + conflict-file list, and verify-failure abort with exit
// code 3 + suggested follow-up.
//
// Run via `npm run test:hooks` (node --test, no extra deps). Stubs `git`
// and `npm` runners via the injectable `runners` object in wt-merge.mjs,
// so no real git or npm process is spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  parseMergedBranchesFromLog,
  defaultIntegrationBranch,
  runMerge,
} from '../wt-merge.mjs';

// ---- helpers ---------------------------------------------------------------

/**
 * Build a runners stub that pulls canned responses from a per-command queue.
 * Each git arg-prefix can map to either a single response or an array of
 * responses (consumed in order). Same for npm.
 *
 *   const runners = makeStubRunners({
 *     git: {
 *       'status --porcelain': { status: 0, stdout: '' },
 *       'fetch origin main': { status: 0 },
 *       'rev-parse --verify --quiet refs/heads/': { status: 1 }, // no resume
 *       'switch -c': { status: 0 },
 *       'fetch origin feat/a': { status: 0 },
 *       'merge --no-ff origin/feat/a': { status: 0 },
 *       'rev-parse HEAD': { status: 0, stdout: 'abc1234deadbeef\n' },
 *     },
 *     npm: {
 *       'run verify': { status: 0 },
 *     },
 *   });
 */
function makeStubRunners(canned = {}) {
  const calls = { git: [], npm: [], log: [], err: [] };
  const consume = (queueMap, args) => {
    const argStr = args.join(' ');
    // Prefer exact match, fall back to longest prefix match.
    let matchKey = null;
    if (Object.prototype.hasOwnProperty.call(queueMap, argStr)) {
      matchKey = argStr;
    } else {
      for (const key of Object.keys(queueMap)) {
        if (argStr.startsWith(key) && (matchKey === null || key.length > matchKey.length)) {
          matchKey = key;
        }
      }
    }
    if (matchKey === null) {
      return { status: 0, stdout: '', stderr: '' };
    }
    let entry = queueMap[matchKey];
    if (Array.isArray(entry)) {
      entry = entry.shift() ?? { status: 0, stdout: '', stderr: '' };
    }
    return {
      status: entry.status ?? 0,
      stdout: entry.stdout ?? '',
      stderr: entry.stderr ?? '',
    };
  };
  return {
    runners: {
      git(args) {
        calls.git.push(args.join(' '));
        return consume(canned.git ?? {}, args);
      },
      npm(args) {
        calls.npm.push(args.join(' '));
        return consume(canned.npm ?? {}, args);
      },
      log(text) {
        calls.log.push(text);
      },
      err(text) {
        calls.err.push(text);
      },
    },
    calls,
  };
}

// ---- parseArgs -------------------------------------------------------------

test('parseArgs collects positional branches', () => {
  const args = parseArgs(['feat/a', 'feat/b', 'feat/c']);
  assert.deepEqual(args.branches, ['feat/a', 'feat/b', 'feat/c']);
  assert.equal(args.into, null);
  assert.equal(args.dryRun, false);
});

test('parseArgs picks up --into and --dry-run', () => {
  const args = parseArgs(['--dry-run', 'feat/a', '--into', 'integration/2026-05-21', 'feat/b']);
  assert.deepEqual(args.branches, ['feat/a', 'feat/b']);
  assert.equal(args.into, 'integration/2026-05-21');
  assert.equal(args.dryRun, true);
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--mystery', 'feat/a']), /unknown flag/);
});

test('parseArgs rejects --into without value', () => {
  assert.throws(() => parseArgs(['--into']), /--into requires a value/);
});

// ---- parseMergedBranchesFromLog --------------------------------------------

test('parseMergedBranchesFromLog extracts quoted branch names from merge subjects', () => {
  const sample = [
    "Merge branch 'feat/server-foo' into integration/2026-05-21",
    "Merge branch 'feat/frontend-bar' into integration/2026-05-21",
    'Some non-merge subject that should be ignored',
    "Merge branch 'fix/scripts-baz' into integration/2026-05-21",
  ].join('\n');
  assert.deepEqual(parseMergedBranchesFromLog(sample), [
    'feat/server-foo',
    'feat/frontend-bar',
    'fix/scripts-baz',
  ]);
});

test('parseMergedBranchesFromLog tolerates empty input', () => {
  assert.deepEqual(parseMergedBranchesFromLog(''), []);
});

// ---- defaultIntegrationBranch ----------------------------------------------

test('defaultIntegrationBranch formats yyyy-mm-dd off the given date', () => {
  assert.equal(
    defaultIntegrationBranch(new Date(2026, 4, 21)), // May = month index 4
    'integration/2026-05-21',
  );
  assert.equal(
    defaultIntegrationBranch(new Date(2026, 0, 9)), // Jan 9 — pads single digit
    'integration/2026-01-09',
  );
});

// ---- runMerge: dry-run -----------------------------------------------------

test('dry-run prints the plan and never invokes git or npm', () => {
  const { runners, calls } = makeStubRunners();
  const code = runMerge({
    branches: ['feat/a', 'feat/b'],
    into: 'integration/2026-05-21',
    dryRun: true,
    runners,
  });
  assert.equal(code, 0);
  // No mutation calls. parseArgs / runMerge dry path emits only log() output.
  assert.equal(calls.git.length, 0, `git was called: ${calls.git.join('; ')}`);
  assert.equal(calls.npm.length, 0, `npm was called: ${calls.npm.join('; ')}`);
  // Plan output mentions both branches and the integration name.
  const logText = calls.log.join('');
  assert.match(logText, /integration\/2026-05-21/);
  assert.match(logText, /feat\/a/);
  assert.match(logText, /feat\/b/);
  assert.match(logText, /\[dry-run\]/);
});

test('runMerge returns exit 1 with usage when no branches passed', () => {
  const { runners, calls } = makeStubRunners();
  const code = runMerge({ branches: [], into: null, dryRun: false, runners });
  assert.equal(code, 1);
  assert.match(calls.err.join(''), /at least one branch argument is required/);
});

// ---- runMerge: validation -------------------------------------------------

test('runMerge aborts (exit 1) when the working tree is dirty', () => {
  const { runners, calls } = makeStubRunners({
    git: {
      'status --porcelain': { status: 0, stdout: ' M src/foo.ts\n' },
    },
  });
  const code = runMerge({
    branches: ['feat/a'],
    into: 'integration/test',
    dryRun: false,
    runners,
  });
  assert.equal(code, 1);
  assert.match(calls.err.join(''), /Working tree is not clean/);
});

// ---- runMerge: idempotent restart ------------------------------------------

test('idempotent restart skips branches whose merge commit already exists', () => {
  // Scenario: integration branch already exists locally. Previous run merged
  // feat/a successfully; on re-invoke with [feat/a, feat/b] we should skip
  // feat/a and merge only feat/b.
  const { runners, calls } = makeStubRunners({
    git: {
      'status --porcelain': { status: 0, stdout: '' },
      'fetch origin main': { status: 0 },
      'rev-parse --verify --quiet refs/heads/integration/test': { status: 0 },
      'checkout integration/test': { status: 0 },
      'log --merges --first-parent --format=%s origin/main..integration/test': {
        status: 0,
        stdout: "Merge branch 'feat/a' into integration/test\n",
      },
      'fetch origin feat/b': { status: 0 },
      'merge --no-ff origin/feat/b': { status: 0 },
      'rev-parse HEAD': { status: 0, stdout: 'abc1234567890def\n' },
    },
    npm: {
      'run verify': { status: 0 },
    },
  });
  const code = runMerge({
    branches: ['feat/a', 'feat/b'],
    into: 'integration/test',
    dryRun: false,
    runners,
  });
  assert.equal(code, 0, `expected exit 0, got ${code}. err=${calls.err.join('')}`);
  // feat/a must NOT have been re-merged (no `fetch origin feat/a` and no
  // `merge --no-ff origin/feat/a` call). feat/b must have been merged.
  const gitCallsStr = calls.git.join(' || ');
  assert.ok(!gitCallsStr.includes('merge --no-ff origin/feat/a'), 'should not re-merge feat/a');
  assert.ok(gitCallsStr.includes('merge --no-ff origin/feat/b'), 'should merge feat/b');
  // Skipped message surfaced in log.
  assert.match(calls.log.join(''), /Skipping already-merged branches: feat\/a/);
});

// ---- runMerge: conflict abort ----------------------------------------------

test('runMerge aborts with exit code 2 and lists conflict files on merge conflict', () => {
  const { runners, calls } = makeStubRunners({
    git: {
      'status --porcelain': { status: 0, stdout: '' },
      'fetch origin main': { status: 0 },
      'rev-parse --verify --quiet refs/heads/integration/test': { status: 1 },
      'switch -c integration/test origin/main': { status: 0 },
      'fetch origin feat/a': { status: 0 },
      // First (and only) merge fails with status 1.
      'merge --no-ff origin/feat/a': {
        status: 1,
        stderr: 'CONFLICT (content): Merge conflict in src/foo.ts\n',
      },
      'diff --name-only --diff-filter=U': {
        status: 0,
        stdout: 'src/foo.ts\nsrc/bar.ts\n',
      },
    },
    npm: {},
  });
  const code = runMerge({
    branches: ['feat/a', 'feat/b'],
    into: 'integration/test',
    dryRun: false,
    runners,
  });
  assert.equal(code, 2);
  const errText = calls.err.join('');
  assert.match(errText, /Merge of 'feat\/a' into integration\/test FAILED/);
  assert.match(errText, /src\/foo\.ts/);
  assert.match(errText, /src\/bar\.ts/);
  assert.match(errText, /git merge --abort/);
  // The follow-up command must omit the offending branch and retain the rest.
  assert.match(errText, /node scripts\/wt-merge\.mjs --into integration\/test feat\/b/);
});

// ---- runMerge: verify-failure abort ----------------------------------------

test('runMerge aborts with exit code 3 when verify fails after the 2nd merge', () => {
  // Scenario: merging feat/a is clean and verify is green. Merging feat/b
  // is clean but verify fails — exit 3 + suggested follow-up names feat/b.
  const { runners, calls } = makeStubRunners({
    git: {
      'status --porcelain': { status: 0, stdout: '' },
      'fetch origin main': { status: 0 },
      'rev-parse --verify --quiet refs/heads/integration/test': { status: 1 },
      'switch -c integration/test origin/main': { status: 0 },
      'fetch origin feat/a': { status: 0 },
      'merge --no-ff origin/feat/a': { status: 0 },
      'fetch origin feat/b': { status: 0 },
      'merge --no-ff origin/feat/b': { status: 0 },
    },
    npm: {
      // First verify (after feat/a) passes; second (after feat/b) fails.
      'run verify': [
        { status: 0 },
        {
          status: 1,
          stdout: 'FAIL src/foo.test.ts\n',
          stderr: 'verify failed: 1 test failing\n',
        },
      ],
    },
  });
  const code = runMerge({
    branches: ['feat/a', 'feat/b'],
    into: 'integration/test',
    dryRun: false,
    runners,
  });
  assert.equal(code, 3);
  const errText = calls.err.join('');
  assert.match(errText, /npm run verify FAILED after merging 'feat\/b'/);
  assert.match(errText, /verify failed: 1 test failing/);
  assert.match(errText, /git reset --merge HEAD~1/);
  // Suggested follow-up drops feat/b, retains feat/a (which already merged green).
  assert.match(errText, /node scripts\/wt-merge\.mjs --into integration\/test feat\/a/);
});

// ---- runMerge: happy path summary ------------------------------------------

test('runMerge prints summary with merged branches + final SHA on success', () => {
  const { runners, calls } = makeStubRunners({
    git: {
      'status --porcelain': { status: 0, stdout: '' },
      'fetch origin main': { status: 0 },
      'rev-parse --verify --quiet refs/heads/integration/test': { status: 1 },
      'switch -c integration/test origin/main': { status: 0 },
      'fetch origin feat/a': { status: 0 },
      'merge --no-ff origin/feat/a': { status: 0 },
      'fetch origin feat/b': { status: 0 },
      'merge --no-ff origin/feat/b': { status: 0 },
      'rev-parse HEAD': { status: 0, stdout: 'abc1234567890def\n' },
    },
    npm: {
      'run verify': { status: 0 },
    },
  });
  const code = runMerge({
    branches: ['feat/a', 'feat/b'],
    into: 'integration/test',
    dryRun: false,
    runners,
  });
  assert.equal(code, 0, `expected exit 0, got ${code}. err=${calls.err.join('')}`);
  const logText = calls.log.join('');
  assert.match(logText, /Reconciliation complete/);
  assert.match(logText, /feat\/a, feat\/b/);
  assert.match(logText, /abc123456789/); // first 12 chars of SHA
  assert.match(logText, /git push -u origin integration\/test/);
});
