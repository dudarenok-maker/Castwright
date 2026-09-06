// Tests for scripts/wt-gc.mjs (#3051, ops-75 Part 4).
//
// Run via `npm run test:hooks` (node --test, no extra deps). Stubs
// git/gh/PowerShell via the injectable `runners` object, the same shape
// wt-merge.mjs's tests use — no real git/gh/PowerShell process is spawned
// by these tests. The junction-first teardown ORDER (junctions before
// `git worktree remove`) and the six refusal cases are the load-bearing
// assertions; each is proved against input that would otherwise make the
// guard fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  isPrimaryWorktree,
  isSelfWorktree,
  refusalReasons,
  classifyWorktree,
  validateJunctionEntry,
  JUNCTION_RESULT_KEYS,
  run,
} from '../wt-gc.mjs';

const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));

// Every refusal is a separate `if`, so a single-refusal test must hand in a
// fact set that clears all the OTHERS — otherwise it passes for the wrong
// reason. This is that all-clear baseline: a non-primary, non-self, clean,
// merged, fully-pushed worktree whose branch gh confirmed carries no PR.
function clearFacts(overrides = {}) {
  return {
    isPrimary: false,
    isSelf: false,
    dirty: false,
    mergedIntoMain: true,
    hasUpstream: true,
    unpushedCount: 0,
    prAvailable: true,
    prOpen: false,
    prNumber: null,
    ...overrides,
  };
}

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

// ---- isSelfWorktree --------------------------------------------------------

test('isSelfWorktree: true when a self-path IS the worktree', () => {
  assert.equal(isSelfWorktree('C:/wt/a', ['C:/wt/a']), true);
});

test('isSelfWorktree: true when a self-path sits INSIDE the worktree (cwd deeper in the tree)', () => {
  assert.equal(isSelfWorktree('C:/wt/a', ['C:/wt/a/scripts/lib']), true);
});

test('isSelfWorktree: separator- and case-insensitive (Windows paths for the same directory)', () => {
  assert.equal(isSelfWorktree('C:/wt/a', ['c:\\WT\\A\\']), true);
});

test('isSelfWorktree: false for a sibling worktree with a shared prefix (no substring false-positive)', () => {
  // "C:/wt/a" must not match "C:/wt/abc" — the guard compares path segments,
  // not raw string prefixes.
  assert.equal(isSelfWorktree('C:/wt/a', ['C:/wt/abc']), false);
});

test('isSelfWorktree: false for an unrelated worktree', () => {
  assert.equal(isSelfWorktree('C:/wt/a', ['C:/repo', 'C:/wt/b']), false);
});

// ---- refusalReasons — every refusal, one at a time -------------------------

test('refusalReasons: refuses the primary checkout', () => {
  const reasons = refusalReasons(clearFacts({ isPrimary: true }));
  assert.ok(reasons.some((r) => r.includes('primary checkout')));
});

test('refusalReasons: does NOT flag primary-checkout reason when isPrimary is false (proves the flag is read, not always-on)', () => {
  const reasons = refusalReasons(clearFacts());
  assert.ok(!reasons.some((r) => r.includes('primary checkout')));
});

test("refusalReasons: refuses the worktree this process is running from", () => {
  const reasons = refusalReasons(clearFacts({ isSelf: true }));
  assert.ok(reasons.some((r) => r.includes('this process is running from')));
});

test('refusalReasons: does NOT flag self reason when isSelf is false (proves the flag is read, not always-on)', () => {
  const reasons = refusalReasons(clearFacts());
  assert.ok(!reasons.some((r) => r.includes('this process is running from')));
});

test('refusalReasons: refuses a dirty tree (uncommitted changes)', () => {
  const reasons = refusalReasons(clearFacts({ dirty: true }));
  assert.ok(reasons.some((r) => r.includes('uncommitted')));
});

test('refusalReasons: does NOT flag dirty reason when dirty is false (proves the flag is read, not always-on)', () => {
  const reasons = refusalReasons(clearFacts());
  assert.ok(!reasons.some((r) => r.includes('uncommitted')));
});

test('refusalReasons: refuses a branch NOT merged into main (#3051 acceptance 1)', () => {
  // The blocking finding on PR #3055: an unmerged tree is an in-flight lane,
  // and teardown destroys its per-worktree env/junctions/.venv, which do not
  // travel with the branch.
  const reasons = refusalReasons(clearFacts({ mergedIntoMain: false }));
  assert.ok(reasons.some((r) => r.includes('not merged into main')));
});

test('refusalReasons: does NOT flag merged reason for a merged branch (proves the flag is read, not always-on)', () => {
  const reasons = refusalReasons(clearFacts({ mergedIntoMain: true }));
  assert.ok(!reasons.some((r) => r.includes('not merged into main')));
});

test('refusalReasons: refuses a branch with unpushed commits', () => {
  const reasons = refusalReasons(clearFacts({ unpushedCount: 3 }));
  assert.ok(reasons.some((r) => r.includes('unpushed')));
});

test('refusalReasons: refuses a branch with NO upstream at all — unverifiable, not assumed safe', () => {
  const reasons = refusalReasons(clearFacts({ hasUpstream: false }));
  assert.ok(reasons.some((r) => r.includes('no upstream')));
});

test('refusalReasons: does NOT flag unpushed when hasUpstream and unpushedCount is 0 (proves the flag is read, not always-on)', () => {
  const reasons = refusalReasons(clearFacts());
  assert.ok(!reasons.some((r) => r.includes('unpushed')));
  assert.ok(!reasons.some((r) => r.includes('no upstream')));
});

test('refusalReasons: refuses a branch carrying an OPEN PR (an in-flight lane)', () => {
  const reasons = refusalReasons(clearFacts({ prOpen: true, prNumber: 3055 }));
  assert.ok(reasons.some((r) => r.includes('open PR #3055')));
});

test('refusalReasons: does NOT flag a PR reason for a MERGED/CLOSED PR (prOpen false, gh answered)', () => {
  const reasons = refusalReasons(clearFacts({ prOpen: false }));
  assert.ok(!reasons.some((r) => r.includes('PR')));
});

test('refusalReasons: refuses when PR state could NOT be determined (gh unavailable — fail closed)', () => {
  const reasons = refusalReasons(clearFacts({ prAvailable: false }));
  assert.ok(reasons.some((r) => r.includes('could not be determined')));
});

test('refusalReasons: prQueried:false suppresses ONLY the PR reasons, and cannot make a row prunable on its own', () => {
  // run() sets prQueried:false only for rows that already carry another
  // refusal. Prove both halves: the PR reasons vanish, and the row is still
  // refused on the ground that made it skip the gh call.
  const suppressed = refusalReasons(clearFacts({ dirty: true, prAvailable: false, prQueried: false }));
  assert.ok(!suppressed.some((r) => r.includes('could not be determined')));
  assert.ok(suppressed.some((r) => r.includes('uncommitted')));
  assert.ok(suppressed.length > 0);
});

test('refusalReasons: a clean, merged, pushed, PR-free, non-primary, non-self worktree has NO refusals (prunable)', () => {
  assert.deepEqual(refusalReasons(clearFacts()), []);
});

test('refusalReasons: refuses a tree marked by `git worktree lock`, quoting the reason', () => {
  const reasons = refusalReasons(clearFacts({ locked: true, lockReason: 'agent lane in flight' }));
  assert.deepEqual(reasons, ['locked by `git worktree lock`: agent lane in flight']);
});

test('refusalReasons: refuses a locked tree even when the lock carries no reason', () => {
  const reasons = refusalReasons(clearFacts({ locked: true, lockReason: '' }));
  assert.deepEqual(reasons, ['locked by `git worktree lock`']);
});

test('refusalReasons: does NOT flag the lock reason when locked is false (proves the flag is read, not always-on)', () => {
  assert.deepEqual(refusalReasons(clearFacts({ locked: false, lockReason: null })), []);
});

test('refusalReasons: all seven refusals can co-occur', () => {
  const reasons = refusalReasons({
    isPrimary: true,
    isSelf: true,
    locked: true,
    lockReason: 'held',
    dirty: true,
    mergedIntoMain: false,
    hasUpstream: false,
    unpushedCount: 0,
    prAvailable: false,
  });
  assert.equal(reasons.length, 7);
});

// ---- classifyWorktree — merged / ahead / PR-state classification ------------

test('classifyWorktree: reports mergedIntoMain true for a merged branch', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\a', branch: 'feat/a' },
    { ...clearFacts(), mergedIntoMain: true, aheadCount: 0, unpushedVerified: true },
    { available: true, pr: null },
  );
  assert.equal(row.mergedIntoMain, true);
  assert.equal(row.aheadOfMain, 0);
  assert.deepEqual(row.refusals, []);
});

test('classifyWorktree: an unmerged branch is reported AND refused — the report column feeds the decision', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\b', branch: 'feat/b' },
    { ...clearFacts(), mergedIntoMain: false, aheadCount: 5, unpushedVerified: true },
    { available: true, pr: null },
  );
  assert.equal(row.mergedIntoMain, false);
  assert.equal(row.aheadOfMain, 5);
  assert.ok(row.refusals.some((r) => r.includes('not merged into main')));
});

test('classifyWorktree: an OPEN PR is reported AND refused — the PR column feeds the decision', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\c', branch: 'feat/c' },
    { ...clearFacts(), aheadCount: 1, unpushedVerified: true },
    { available: true, pr: { number: 42, state: 'OPEN' } },
  );
  assert.equal(row.prState, '#42 OPEN');
  assert.ok(row.refusals.some((r) => r.includes('open PR #42')));
});

test('classifyWorktree: a MERGED PR is reported and does NOT refuse (proves the OPEN check reads state, not presence)', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\c', branch: 'feat/c' },
    { ...clearFacts(), aheadCount: 0, unpushedVerified: true },
    { available: true, pr: { number: 41, state: 'MERGED' } },
  );
  assert.equal(row.prState, '#41 MERGED');
  assert.deepEqual(row.refusals, []);
});

test('classifyWorktree: "gh answered: no PR" and "gh could not be asked" are DIFFERENT states, rendered differently', () => {
  const answered = classifyWorktree(
    { path: 'C:\\wt\\c', branch: 'feat/c' },
    { ...clearFacts(), aheadCount: 0, unpushedVerified: true },
    { available: true, pr: null },
  );
  const unavailable = classifyWorktree(
    { path: 'C:\\wt\\c', branch: 'feat/c' },
    { ...clearFacts(), aheadCount: 0, unpushedVerified: true },
    { available: false, pr: null },
  );

  assert.equal(answered.prState, 'none');
  assert.equal(unavailable.prState, 'unknown (gh unavailable)');
  assert.notEqual(answered.prState, unavailable.prState);
  // ...and only the undeterminable one is refused.
  assert.deepEqual(answered.refusals, []);
  assert.ok(unavailable.refusals.some((r) => r.includes('could not be determined')));
});

test('classifyWorktree: a null PR verdict is read as "could not be asked", never as "no PR"', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\c', branch: 'feat/c' },
    { ...clearFacts(), aheadCount: 0, unpushedVerified: true },
    null,
  );
  assert.equal(row.prState, 'unknown (gh unavailable)');
  assert.ok(row.refusals.some((r) => r.includes('could not be determined')));
});

test('classifyWorktree: an unverifiable unpushed count is reported as null, not as a number the row does not have', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\d', branch: 'feat/d' },
    { ...clearFacts(), hasUpstream: false, unpushedCount: null, unpushedVerified: false, aheadCount: 1 },
    { available: true, pr: null },
  );
  assert.equal(row.unpushedCount, null);
  assert.equal(row.unpushedVerified, false);
  assert.ok(row.refusals.some((r) => r.includes('no upstream')));
});

test('classifyWorktree: a verified count of 0 is marked verified (proves the flag is read, not always-false)', () => {
  const row = classifyWorktree(
    { path: 'C:\\wt\\e', branch: 'feat/e' },
    { ...clearFacts(), unpushedCount: 0, unpushedVerified: true, aheadCount: 0 },
    { available: true, pr: null },
  );
  assert.equal(row.unpushedCount, 0);
  assert.equal(row.unpushedVerified, true);
});

// ---- The PowerShell -> JS junction-report contract --------------------------

test('validateJunctionEntry: accepts an entry carrying every contract key', () => {
  assert.equal(
    validateJunctionEntry({ Path: 'p', Target: 't', Removed: true, TargetStillExists: true, Error: null }),
    null,
  );
});

test('validateJunctionEntry: rejects an entry missing TargetStillExists — the rename that would silently pass the catastrophic case', () => {
  const problem = validateJunctionEntry({ Path: 'p', Target: 't', Removed: true, Error: null });
  assert.ok(problem !== null);
  assert.match(problem, /TargetStillExists/);
});

test('validateJunctionEntry: rejects a non-object (a bare string, the shape the deleted -Action Find branch emitted)', () => {
  assert.ok(validateJunctionEntry('C:/wt/node_modules') !== null);
  assert.ok(validateJunctionEntry(null) !== null);
});

test('the .psm1 emits every key JUNCTION_RESULT_KEYS names — the PowerShell half of the two-sided seam pin', () => {
  // Renaming a property on the PowerShell side without touching wt-gc.mjs
  // is the failure this pins: `j.TargetStillExists === false` would become
  // permanently false and the "junction unlinked AND its target destroyed"
  // case would read as success.
  const psm1 = readFileSync(join(scriptsDir, 'lib', 'wt-gc-junctions.psm1'), 'utf8');
  const code = psm1
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  for (const key of JUNCTION_RESULT_KEYS) {
    assert.match(code, new RegExp(`^\\s*${key}\\s*=`, 'm'), `.psm1 must emit a '${key}' property`);
  }
});

test('the .ps1 wraps its result in the {items:[...]} envelope wt-gc.mjs destructures', () => {
  const ps1 = readFileSync(join(scriptsDir, 'lib', 'wt-gc-junctions.ps1'), 'utf8');
  const code = ps1
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.match(code, /@\{\s*items\s*=\s*@\(\$items\)\s*\}/);
  assert.match(code, /ConvertTo-Json/);
});

test('the .ps1 no longer offers the unreachable, shape-mismatched -Action Find', () => {
  const ps1 = readFileSync(join(scriptsDir, 'lib', 'wt-gc-junctions.ps1'), 'utf8');
  const code = ps1
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.match(code, /ValidateSet\('Remove'\)/);
  assert.ok(!/ValidateSet\([^)]*'Find'/.test(code), "'Find' must not be an accepted -Action value");
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

// A complete junction-report entry, matching what Remove-JunctionsRecursive
// actually emits — every key in JUNCTION_RESULT_KEYS. Written through the
// exported constant so a rename on either side breaks these stubs loudly
// instead of leaving them silently describing a shape that no longer exists.
function junctionEntry(overrides = {}) {
  const entry = {};
  for (const key of JUNCTION_RESULT_KEYS) entry[key] = null;
  return { ...entry, Path: 'C:/wt-clean/node_modules', Removed: true, TargetStillExists: true, ...overrides };
}

function makeRunners(overrides = {}) {
  const stubGit = makeStubGit({ ...baseCanned(), ...(overrides.canned ?? {}) }, overrides.byCwd ?? baseByCwd());
  const logs = [];
  const errs = [];
  const pathExistsCalls = [];
  const ghCalls = [];
  const ghPrState = overrides.ghPrState ?? (() => ({ available: true, pr: null }));
  return {
    runners: {
      git: stubGit.fn,
      ghPrState: (branch) => { ghCalls.push(branch); return ghPrState(branch); },
      removeJunctions: overrides.removeJunctions ?? (() => []),
      removeWorktree: overrides.removeWorktree ?? (() => ({ status: 0, stdout: '', stderr: '' })),
      pathExists: overrides.pathExists ?? ((p) => { pathExistsCalls.push(p); return false; }),
      log: (t) => logs.push(t),
      err: (t) => errs.push(t),
    },
    logs,
    errs,
    pathExistsCalls,
    ghCalls,
    gitCalls: stubGit.calls,
  };
}

// The stub tree paths are nowhere near this test process's real cwd, so the
// self-exclusion refusal is inert unless a test opts into it explicitly.
const NO_SELF = ['C:/somewhere-else'];

test('run(): report mode never calls removeJunctions or removeWorktree (no mutation by default)', () => {
  let junctionCalls = 0;
  let removeCalls = 0;
  const { runners } = makeRunners({
    removeJunctions: () => { junctionCalls += 1; return []; },
    removeWorktree: () => { removeCalls += 1; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: false, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.equal(junctionCalls, 0);
  assert.equal(removeCalls, 0);
});

test('run(): report includes the primary checkout marked not-prunable', () => {
  const { runners, logs } = makeRunners();
  run({ prune: false, runners, selfPaths: NO_SELF });
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

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.equal(junctionCalls, 0, 'a refused worktree must never reach junction removal');
  assert.match(logs.join(''), /SKIP.*uncommitted/);
});

test('run(): --prune removes junctions BEFORE calling git worktree remove — the load-bearing order', () => {
  const order = [];
  const { runners } = makeRunners({
    removeJunctions: (root) => { order.push(`junctions:${root}`); return [junctionEntry()]; },
    removeWorktree: (path) => { order.push(`remove:${path}`); return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.deepEqual(order, ['junctions:C:/wt-clean', 'remove:C:/wt-clean']);
});

test('run(): a junction that fails to clean removal (Removed:false) aborts BEFORE git worktree remove is called', () => {
  let removeWorktreeCalled = false;
  const { runners, errs } = makeRunners({
    removeJunctions: () => [junctionEntry({ Removed: false })],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

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
    removeJunctions: () => [junctionEntry({ TargetStillExists: false })],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 1);
  assert.equal(removeWorktreeCalled, false);
  assert.match(errs.join(''), /NOT cleanly removed/);
});

test('run(): a junction entry missing a contract key aborts instead of being read leniently (the rename hazard)', () => {
  // Drop TargetStillExists, exactly as a PowerShell-side rename would: the
  // `=== false` check below it can never fire, so without the shape check
  // this row would sail through to `git worktree remove --force`.
  let removeWorktreeCalled = false;
  const { runners, errs } = makeRunners({
    removeJunctions: () => [{ Path: 'C:/wt-clean/node_modules', Target: 'C:/repo/node_modules', Removed: true, Error: null }],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 1);
  assert.equal(removeWorktreeCalled, false);
  assert.match(errs.join(''), /does not match the expected contract/);
});

test('run(): a THROWING junction scan aborts the prune for that tree — an errored scan is never read as "no junctions"', () => {
  // The .psm1 now throws on any enumeration error rather than swallowing it
  // with -ErrorAction SilentlyContinue; the .ps1 turns that into a non-zero
  // exit and runJunctionScript() re-raises. This is the JS end of that
  // chain: the recursive `git worktree remove --force` must not run.
  let removeWorktreeCalled = false;
  const { runners, errs } = makeRunners({
    removeJunctions: () => { throw new Error('wt-gc: junction scan could not enumerate ... INCOMPLETE'); },
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 1);
  assert.equal(removeWorktreeCalled, false, 'an incomplete junction scan must never reach the recursive remove');
  assert.match(errs.join(''), /junction removal failed/);
  assert.match(errs.join(''), /INCOMPLETE/);
});

test('run(): verifies worktree removal with pathExists, not the exit code alone', () => {
  const { runners, errs } = makeRunners({
    removeJunctions: () => [junctionEntry()],
    removeWorktree: () => ({ status: 0, stdout: 'ok', stderr: '' }), // reports success...
    pathExists: () => true, // ...but the directory is still there
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 1);
  assert.match(errs.join(''), /still exists after removal/);
});

test('run(): a fully clean/merged/pushed/PR-free worktree is pruned successfully end to end', () => {
  const { runners, logs } = makeRunners({
    removeJunctions: () => [junctionEntry()],
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.match(logs.join(''), /removed 1 junction\(s\)/);
  assert.match(logs.join(''), /removed\.\n/);
});

// ---- The blocking refusals, proved through run() ---------------------------

test('run(): --prune REFUSES an unmerged worktree and never touches it', () => {
  let removeWorktreeCalled = false;
  const { runners, logs } = makeRunners({
    // `merge-base --is-ancestor` exits 1 => not an ancestor of main.
    canned: {
      'merge-base --is-ancestor': { status: 1 },
      'rev-list --count main..': { stdout: '4\n' },
    },
    removeJunctions: () => [junctionEntry()],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.equal(removeWorktreeCalled, false);
  assert.match(logs.join(''), /SKIP C:\/wt-clean — .*not merged into main/);
});

test('run(): --prune REFUSES a worktree whose branch carries an OPEN PR', () => {
  let removeWorktreeCalled = false;
  const { runners, logs } = makeRunners({
    ghPrState: () => ({ available: true, pr: { number: 3055, state: 'OPEN' } }),
    removeJunctions: () => [junctionEntry()],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.equal(removeWorktreeCalled, false);
  assert.match(logs.join(''), /SKIP C:\/wt-clean — open PR #3055/);
});

test('run(): --prune REFUSES a `git worktree lock`d tree, and does not strip its junctions first', () => {
  // The whole point of the refusal: `git worktree remove --force` DOES refuse
  // a locked tree (exit 128, `fatal: cannot remove a locked working tree`),
  // but removeJunctions() runs BEFORE it. Without the refusal the tree
  // survives stripped of node_modules/.venv/voices and is reported as a
  // failure — git's backstop protects the directory, not the environment.
  let junctionsCalled = false;
  let removeWorktreeCalled = false;
  const { runners, logs } = makeRunners({
    canned: {
      'worktree list --porcelain': {
        stdout: [
          'worktree C:/repo',
          'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'branch refs/heads/main',
          '',
          'worktree C:/wt-clean',
          'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'branch refs/heads/feat/clean-merged',
          'locked agent lane in flight',
          '',
        ].join('\n'),
      },
    },
    removeJunctions: () => { junctionsCalled = true; return [junctionEntry()]; },
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.equal(junctionsCalled, false, 'the junction sweep must not run on a locked tree');
  assert.equal(removeWorktreeCalled, false);
  assert.match(logs.join(''), /SKIP C:\/wt-clean — locked by `git worktree lock`: agent lane in flight/);
});

test('run(): the SAME tree unlocked IS pruned — proves the lock refusal reads the marker, not the fixture', () => {
  let junctionsCalled = false;
  let removeWorktreeCalled = false;
  const { runners } = makeRunners({
    removeJunctions: () => { junctionsCalled = true; return [junctionEntry()]; },
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.equal(junctionsCalled, true);
  assert.equal(removeWorktreeCalled, true);
});

test("run(): --prune REFUSES the worktree the process is running from", () => {
  // git worktree remove --force from inside its own tree deletes every file
  // and deregisters the worktree, THEN fails the final rmdir with exit 255 —
  // leaving an orphaned directory git no longer lists, which wt-gc itself can
  // never see again. The refusal has to come before the call.
  let removeWorktreeCalled = false;
  const { runners, logs } = makeRunners({
    removeJunctions: () => [junctionEntry()],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const code = run({ prune: true, runners, selfPaths: ['C:/wt-clean/scripts'] });

  assert.equal(code, 0);
  assert.equal(removeWorktreeCalled, false);
  assert.match(logs.join(''), /SKIP C:\/wt-clean — .*this process is running from/);
});

test('run(): --prune REFUSES every tree when git cannot resolve --git-common-dir (fail closed, not fail open)', () => {
  // The one that points the destructive path at the primary checkout: an
  // unresolvable common-dir used to make isPrimary false for EVERY row,
  // including C:/repo itself, and removeJunctions() would then sweep the
  // primary checkout's real node_modules before git refused the last step.
  const swept = [];
  const { runners, logs } = makeRunners({
    canned: { 'rev-parse --path-format=absolute --git-common-dir': { status: 128, stderr: 'unknown option\n' } },
    removeJunctions: (root) => { swept.push(root); return [junctionEntry()]; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.deepEqual(swept, [], 'no tree may reach junction removal when the primary check is unanswerable');
  assert.match(logs.join(''), /SKIP C:\/repo — primary checkout/);
  assert.match(logs.join(''), /SKIP C:\/wt-clean — primary checkout/);
});

test('run(): --prune REFUSES every tree when git cannot resolve a worktree --git-dir (fail closed)', () => {
  const swept = [];
  const { runners, logs } = makeRunners({
    byCwd: {
      'C:/repo': { 'rev-parse --path-format=absolute --git-dir': { status: 128, stderr: 'dubious ownership\n' } },
      'C:/wt-clean': { 'rev-parse --path-format=absolute --git-dir': { status: 128, stderr: 'dubious ownership\n' } },
    },
    removeJunctions: (root) => { swept.push(root); return [junctionEntry()]; },
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.deepEqual(swept, []);
  assert.match(logs.join(''), /SKIP C:\/wt-clean — primary checkout/);
});

// ---- Offline tolerance: gh absent degrades the REPORT, refuses the PRUNE ---

test('run(): gh unavailable reports "unknown (gh unavailable)", completes normally, and REFUSES the prune', () => {
  let removeWorktreeCalled = false;
  const { runners, logs } = makeRunners({
    ghPrState: () => ({ available: false, pr: null }),
    removeJunctions: () => [junctionEntry()],
    removeWorktree: () => { removeWorktreeCalled = true; return { status: 0, stdout: '', stderr: '' }; },
  });

  const reportCode = run({ prune: false, runners, selfPaths: NO_SELF });
  assert.equal(reportCode, 0, 'an unreachable gh must never abort the report');
  assert.match(logs.join(''), /unknown \(gh unavailable\)/);

  const pruneCode = run({ prune: true, runners, selfPaths: NO_SELF });
  assert.equal(pruneCode, 0);
  assert.equal(removeWorktreeCalled, false, 'a tree whose PR state could not be checked must not be pruned');
  assert.match(logs.join(''), /could not be determined/);
});

test('run(): gh answering "no PR" reads as none and stays prunable — the two states are not collapsed', () => {
  const { runners, logs } = makeRunners({
    ghPrState: () => ({ available: true, pr: null }),
    removeJunctions: () => [junctionEntry()],
  });

  const code = run({ prune: true, runners, selfPaths: NO_SELF });

  assert.equal(code, 0);
  assert.match(logs.join(''), /removed\.\n/);
});

// ---- gh: skipped only under --prune, where the answer cannot change anything

test('run(): --prune does NOT query gh for a row that already carries another refusal', () => {
  const { runners, ghCalls } = makeRunners({
    canned: { 'status --porcelain': { stdout: ' M x.txt\n' } },
  });

  run({ prune: true, runners, selfPaths: NO_SELF });

  assert.deepEqual(ghCalls, [], 'a row that cannot become prunable must not cost a gh round-trip');
});

test('run(): REPORT mode queries gh even for an already-refused row — the table is the product', () => {
  // The skip was applied to report mode too and made 16 of 18 rows on this
  // box render `not queried`, blanking exactly the open-PR cells that make
  // the report readable. Report mode asks about every branched row.
  const { runners, ghCalls, logs } = makeRunners({
    canned: { 'status --porcelain': { stdout: ' M x.txt\n' } },
    ghPrState: () => ({ available: true, pr: { number: 3055, state: 'OPEN' } }),
  });

  run({ prune: false, runners, selfPaths: NO_SELF });

  assert.deepEqual(ghCalls, ['main', 'feat/clean-merged']);
  assert.match(logs.join(''), /#3055 OPEN/);
  assert.ok(!logs.join('').includes('not queried'), 'report mode must not blank the PR column');
});

test('run(): --prune DOES query gh for a row with no other refusal — the skip can never make a row prunable', () => {
  const { runners, ghCalls } = makeRunners();

  run({ prune: true, runners, selfPaths: NO_SELF });

  assert.deepEqual(ghCalls, ['feat/clean-merged']);
});

test('run(): a row skipped for gh under --prune renders "not queried", distinct from both "none" and "unknown"', () => {
  const { runners, logs } = makeRunners({
    canned: { 'status --porcelain': { stdout: ' M x.txt\n' } },
  });

  run({ prune: true, runners, selfPaths: NO_SELF });

  assert.match(logs.join(''), /not queried/);
});
