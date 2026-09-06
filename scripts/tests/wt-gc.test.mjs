// Tests for scripts/wt-gc.mjs (#3051, ops-75 Part 4).
//
// Run via `npm run test:hooks` (node --test, no extra deps). Stubs
// git/gh/PowerShell via the injectable `runners` object, the same shape
// wt-merge.mjs's tests use — no real git/gh/PowerShell process is spawned
// by these tests. The junction-first teardown ORDER (junctions before
// `git worktree remove`) and the three refusal cases are the load-bearing
// assertions; each is proved against input that would otherwise make the
// guard fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  isPrimaryWorktree,
  refusalReasons,
  classifyWorktree,
  run,
} from '../wt-gc.mjs';

// ---- parseArgs ---------------------------------------------------------

test('parseArgs: report mode is the default (no --prune)', () => {
  const args = parseArgs([]);
  assert.equal(args.prune, false);
});

test('parseArgs: --prune must be explicit', () => {
  const args = parseArgs(['--prune']);
  assert.equal(args.prune, true);
});

test('parseArgs: unknown flag throws', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: -h/--help sets help', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
});

// ---- isPrimaryWorktree ---------------------------------------------------

test('isPrimaryWorktree: true when git-dir equals git-common-dir (the primary checkout)', () => {
  assert.equal(isPrimaryWorktree('C:\\repo\\.git', 'C:\\repo\\.git'), true);
});

test('isPrimaryWorktree: false when git-dir is a worktrees/<name> subdir (a linked worktree)', () => {
  assert.equal(
    isPrimaryWorktree('C:\\repo\\.git', 'C:\\repo\\.git\\worktrees\\feat-foo'),
    false,
  );
});

// ---- refusalReasons — the three mandatory refusals, one at a time ----------

test('refusalReasons: refuses the primary checkout', () => {
  const reasons = refusalReasons({ isPrimary: true, dirty: false, hasUpstream: true, unpushedCount: 0 });
  assert.ok(reasons.some((r) => r.includes('primary checkout')));
});

test('refusalReasons: does NOT flag primary-checkout reason when isPrimary is false (proves the flag is read, not always-on)', () => {
  const reasons = refusalReasons({ isPrimary: false, dirty: false, hasUpstream: true, unpushedCount: 0 });
  assert.ok(!reasons.some((r) => r.includes('primary checkout')));
});

test('refusalReasons: refuses a dirty tree (uncommitted changes)', () => {
  const reasons = refusalReasons({ isPrimary: false, dirty: true, hasUpstream: true, unpushedCount: 0 });
  assert.ok(reasons.some((r) => r.includes('uncommitted')));
});

test('refusalReasons: does NOT flag dirty reason when dirty is false (proves the flag is read, not always-on)', () => {
  const reasons = refusalReasons({ isPrimary: false, dirty: false, hasUpstream: true, unpushedCount: 0 });
  assert.ok(!reasons.some((r) => r.includes('uncommitted')));
});

test('refusalReasons: refuses a branch with unpushed commits', () => {
  const reasons = refusalReasons({ isPrimary: false, dirty: false, hasUpstream: true, unpushedCount: 3 });
  assert.ok(reasons.some((r) => r.includes('unpushed')));
});

test('refusalReasons: refuses a branch with NO upstream at all — unverifiable, not assumed safe', () => {
  const reasons = refusalReasons({ isPrimary: false, dirty: false, hasUpstream: false, unpushedCount: 0 });
  assert.ok(reasons.some((r) => r.includes('no upstream')));
});

test('refusalReasons: does NOT flag unpushed when hasUpstream and unpushedCount is 0 (proves the flag is read, not always-on)', () => {
  const reasons = refusalReasons({ isPrimary: false, dirty: false, hasUpstream: true, unpushedCount: 0 });
  assert.ok(!reasons.some((r) => r.includes('unpushed')));
  assert.ok(!reasons.some((r) => r.includes('no upstream')));
});

test('refusalReasons: a clean, merged-or-not, pushed, non-primary worktree has NO refusals (prunable)', () => {
  const reasons = refusalReasons({ isPrimary: false, dirty: false, hasUpstream: true, unpushedCount: 0 });
  assert.deepEqual(reasons, []);
});

test('refusalReasons: all three refusals can co-occur', () => {
  const reasons = refusalReasons({ isPrimary: true, dirty: true, hasUpstream: false, unpushedCount: 0 });
  assert.equal(reasons.length, 3);
});

// ---- classifyWorktree — merged / ahead classification ----------------------

test('classifyWorktree: reports mergedIntoMain true for a merged branch', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\a', branch: 'feat/a' },
    { isPrimary: false, dirty: false, mergedIntoMain: true, aheadCount: 0, hasUpstream: true, unpushedCount: 0 },
    null,
  );
  assert.equal(row.mergedIntoMain, true);
  assert.equal(row.aheadOfMain, 0);
});

test('classifyWorktree: reports mergedIntoMain false and a nonzero ahead count for an unmerged branch', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\b', branch: 'feat/b' },
    { isPrimary: false, dirty: false, mergedIntoMain: false, aheadCount: 5, hasUpstream: true, unpushedCount: 0 },
    null,
  );
  assert.equal(row.mergedIntoMain, false);
  assert.equal(row.aheadOfMain, 5);
});

test('classifyWorktree: PR state reported when prInfo is present, "unknown" when null (offline tolerance)', () => {
  const withPr = classifyWorktree(
    { path: 'C:\\wt\\c', branch: 'feat/c' },
    { isPrimary: false, dirty: false, mergedIntoMain: false, aheadCount: 1, hasUpstream: true, unpushedCount: 0 },
    { number: 42, state: 'OPEN' },
  );
  assert.equal(withPr.prState, '#42 OPEN');

  const withoutPr = classifyWorktree(
    { path: 'C:\\wt\\c', branch: 'feat/c' },
    { isPrimary: false, dirty: false, mergedIntoMain: false, aheadCount: 1, hasUpstream: true, unpushedCount: 0 },
    null,
  );
  assert.equal(withoutPr.prState, 'unknown');
});

// ---- run() — full flow against a stubbed runners object --------------------

// Some git calls (notably `rev-parse --git-dir`) must answer differently
// depending on WHICH worktree's cwd they're run from — the whole point of
// isPrimaryWorktree() is comparing a per-worktree git-dir against the
// shared common-dir, so a stub that ignores cwd can't distinguish the
// primary checkout from a linked worktree. `byCwd[cwd]` entries are tried
// first (longest-prefix match within that cwd's own map); the flat map is
// the fallback for cwd-independent calls (`worktree list`, etc).
function makeStubGit(canned, byCwd = {}) {
  const calls = [];
  const longestPrefixMatch = (map, argStr) => {
    let matchKey = null;
    for (const key of Object.keys(map)) {
      if (argStr.startsWith(key) && (matchKey === null || key.length > matchKey.length)) matchKey = key;
    }
    return matchKey;
  };
  return {
    fn(args, opts = {}) {
      const cwd = opts.cwd ?? null;
      calls.push({ args: args.join(' '), cwd });
      const argStr = args.join(' ');
      if (cwd && byCwd[cwd]) {
        const key = longestPrefixMatch(byCwd[cwd], argStr);
        if (key !== null) {
          const entry = byCwd[cwd][key];
          return { status: entry.status ?? 0, stdout: entry.stdout ?? '', stderr: entry.stderr ?? '' };
        }
      }
      const key = longestPrefixMatch(canned, argStr);
      if (key === null) return { status: 0, stdout: '', stderr: '' };
      const entry = canned[key];
      return { status: entry.status ?? 0, stdout: entry.stdout ?? '', stderr: entry.stderr ?? '' };
    },
    calls,
  };
}

const PORCELAIN_ONE_PRUNABLE = [
  'worktree C:/repo',
  'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'branch refs/heads/main',
  '',
  'worktree C:/wt-clean',
  'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'branch refs/heads/feat/clean-merged',
  '',
].join('\n');

function baseCanned() {
  return {
    'worktree list --porcelain': { stdout: PORCELAIN_ONE_PRUNABLE },
    'rev-parse --path-format=absolute --git-common-dir': { stdout: 'C:/repo/.git\n' },
    'status --porcelain': { stdout: '' },
    'merge-base --is-ancestor': { status: 0 },
    'rev-list --count main..': { stdout: '0\n' },
    'rev-parse --abbrev-ref --symbolic-full-name feat/clean-merged@{upstream}': { stdout: 'origin/feat/clean-merged\n' },
    'rev-list --count origin/feat/clean-merged..feat/clean-merged': { stdout: '0\n' },
  };
}

// `--git-dir` must differ by cwd: the primary checkout's git-dir equals the
// common-dir; a linked worktree's lives under `<common>/worktrees/<name>`.
function baseByCwd() {
  return {
    'C:/repo': { 'rev-parse --path-format=absolute --git-dir': { stdout: 'C:/repo/.git\n' } },
    'C:/wt-clean': { 'rev-parse --path-format=absolute --git-dir': { stdout: 'C:/repo/.git/worktrees/clean-merged\n' } },
  };
}

function makeRunners(overrides = {}) {
  const stubGit = makeStubGit({ ...baseCanned(), ...(overrides.canned ?? {}) }, overrides.byCwd ?? baseByCwd());
  const logs = [];
  const errs = [];
  const pathExistsCalls = [];
  return {
    runners: {
      git: stubGit.fn,
      ghPrState: overrides.ghPrState ?? (() => null),
      removeJunctions: overrides.removeJunctions ?? (() => []),
      removeWorktree: overrides.removeWorktree ?? (() => ({ status: 0, stdout: '', stderr: '' })),
      pathExists: overrides.pathExists ?? ((p) => { pathExistsCalls.push(p); return false; }),
      log: (t) => logs.push(t),
      err: (t) => errs.push(t),
    },
    logs,
    errs,
    pathExistsCalls,
    gitCalls: stubGit.calls,
  };
}

test('run(): report mode never calls removeJunctions or removeWorktree (no mutation by default)', () => {
  let junctionCalls = 0;
  let removeCalls = 0;
  const { runners } = makeRunners({
    removeJunctions: () => { junctionCalls += 1; return []; },
    removeWorktree: () => { removeCalls += 1; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: false, runners });

  assert.equal(code, 0);
  assert.equal(junctionCalls, 0);
  assert.equal(removeCalls, 0);
});

test('run(): report includes the primary checkout marked not-prunable', () => {
  const { runners, logs } = makeRunners();
  run({ prune: false, runners });
  const out = logs.join('');
  assert.match(out, /C:\/repo/);
  assert.match(out, /primary checkout/);
});

test('run(): --prune skips a worktree with a refusal reason and does not touch it', () => {
  let junctionCalls = 0;
  const { runners, logs } = makeRunners({
    // Make the "clean-merged" worktree dirty so it's refused too — isolates
    // this test to "every row refused -> nothing pruned".
    canned: { 'status --porcelain': { stdout: ' M some-file.txt\n' } },
    removeJunctions: () => { junctionCalls += 1; return []; },
  });

  const code = run({ prune: true, runners });

  assert.equal(code, 0);
  assert.equal(junctionCalls, 0, 'a refused worktree must never reach junction removal');
  assert.match(logs.join(''), /SKIP.*uncommitted/);
});

test('run(): --prune removes junctions BEFORE calling git worktree remove — the load-bearing order', () => {
  const order = [];
  const { runners } = makeRunners({
    removeJunctions: (root) => { order.push(`junctions:${root}`); return [{ Path: 'x', Removed: true, TargetStillExists: true }]; },
    removeWorktree: (path) => { order.push(`remove:${path}`); return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners });

  assert.equal(code, 0);
  assert.deepEqual(order, ['junctions:C:/wt-clean', 'remove:C:/wt-clean']);
});

test('run(): a junction that fails to clean removal (Removed:false) aborts BEFORE git worktree remove is called', () => {
  let removeWorktreeCalled = false;
  const { runners, errs } = makeRunners({
    removeJunctions: () => [{ Path: 'C:/wt-clean/node_modules', Removed: false, TargetStillExists: true, Error: null }],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners });

  assert.equal(code, 1);
  assert.equal(removeWorktreeCalled, false, 'must not proceed to worktree removal when a junction survived');
  assert.match(errs.join(''), /NOT cleanly removed/);
});

test('run(): a junction whose TARGET vanished (TargetStillExists:false) is flagged as a failure, not silently accepted', () => {
  // This is the catastrophic case: the junction was "removed" but so was
  // the real directory it pointed at (e.g. because `$false` was dropped
  // from Directory.Delete and it recursed). Must never read as success.
  let removeWorktreeCalled = false;
  const { runners, errs } = makeRunners({
    removeJunctions: () => [{ Path: 'C:/wt-clean/node_modules', Removed: true, TargetStillExists: false, Error: null }],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners });

  assert.equal(code, 1);
  assert.equal(removeWorktreeCalled, false);
  assert.match(errs.join(''), /NOT cleanly removed/);
});

test('run(): verifies worktree removal with pathExists, not the exit code alone', () => {
  const { runners, errs } = makeRunners({
    removeWorktree: () => ({ status: 0, stdout: 'ok', stderr: '' }), // reports success...
    pathExists: () => true, // ...but the directory is still there
  });

  const code = run({ prune: true, runners });

  assert.equal(code, 1);
  assert.match(errs.join(''), /still exists after removal/);
});

test('run(): a fully clean/merged/pushed worktree is pruned successfully end to end', () => {
  const { runners, logs } = makeRunners({
    removeJunctions: () => [{ Path: 'C:/wt-clean/node_modules', Removed: true, TargetStillExists: true, Error: null }],
  });

  const code = run({ prune: true, runners });

  assert.equal(code, 0);
  assert.match(logs.join(''), /removed 1 junction\(s\)/);
  assert.match(logs.join(''), /removed\.\n/);
});

// ---- Offline tolerance: gh absent/failing degrades to "unknown", never throws --

test('run(): gh unavailable (ghPrState returns null) reports PR state as "unknown", not an error, and completes normally', () => {
  const { runners, logs } = makeRunners({ ghPrState: () => null });

  const code = run({ prune: false, runners });

  assert.equal(code, 0);
  assert.match(logs.join(''), /unknown/);
});
