// #3529 on-box register checker: row provenance, owner resolution and
// merge-order cases (git-backed throwaway repos).
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkRegister, checkLiveView, UNMERGED_LANE_ROW_ERROR_PREFIX } from '../check-onbox-register.mjs';
import * as onbox from '../check-onbox-register.mjs';
import {
  buildSingleGroupRegister,
  MAIN_B,
  THEIRS_TITLE,
  UNMERGED,
  merged,
  collisionOptions,
  baseRows,
  ofPrefix,
  PROV_LIVE,
  PROV_REGISTER,
  provEnv,
  provRunner,
  provGit,
  uView,
  uWrite,
  uCommit,
  uMerge,
  withUnionRepo,
  uCheck,
  realErrors,
  withRetired,
  OWNER_X,
  closedStates,
  p4Commit,
  p4Other,
} from './check-onbox-register-test-support.mjs';

// Review pass 2, S3/S3b: the verdict no longer depends on merge order.
function s3(xFirst) {
  return withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-x');
    uCommit(repo, 'xxxx0001', [101, 102, 103], 104);
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'lane-k');
    uCommit(repo, 'kkkk0001', [101, 102, 104], 105);
    // K's union publish: its own view plus X's B103.
    const union = uView('kkkk0001', [101, 102, 103, 104]);
    provGit(repo, 'switch', '-q', 'main');
    if (xFirst) {
      uMerge(repo, 'lane-x', 'xxxx0001', [101, 102, 103], 104);
      provGit(repo, 'switch', '-q', 'lane-k');
      uMerge(repo, 'main', 'kkkk0001', [101, 102, 103, 104], 105);
      provGit(repo, 'switch', '-q', 'main');
      uMerge(repo, 'lane-k', 'kkkk0001', [101, 102, 103, 104], 105);
    } else {
      uMerge(repo, 'lane-k', 'kkkk0001', [101, 102, 104], 105);
      provGit(repo, 'switch', '-q', 'lane-x');
      uMerge(repo, 'main', 'xxxx0002', [101, 102, 103, 104], 105);
      provGit(repo, 'switch', '-q', 'main');
      uMerge(repo, 'lane-x', 'xxxx0002', [101, 102, 103, 104], 105);
    }
    provGit(repo, 'switch', '-q', '-c', 'disch');
    uCommit(repo, 'disc0001', [101, 102, 104], 105, 'discharge B103');
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'disch', 'disc0001', [101, 102, 104], 105);
    provGit(repo, 'switch', '-q', '-c', 'q');
    return realErrors(uCheck(repo, 'q', union));
  });
}

test('#3529 pass 2 S3: a union-carried row whose carrier merged first, then its own lane, then a discharge — silent', () => {
  assert.deepEqual(s3(false), []);
});

test('#3529 pass 2 S3b: the same with the owning lane merging first — silent, consistent with S3', () => {
  assert.deepEqual(s3(true), []);
});


// Review pass 3, 🔴 (P3g): "main has ever carried it" follows main's own
// first-parent line. A merged lane that minted a colliding ID on its branch
// and renumbered it BEFORE merging (#3525's f980d2c8 B103) never put that ID
// in main's register, so it must not exempt the other lane's live copy.
test('#3529 pass 3 P3g: a merged lane that minted a colliding ID and renumbered it before merging does not exempt the other lane', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-x');
    uCommit(repo, 'xxxx0001', [101, 102, 103], 104);
    const pageX = uView('xxxx0001', [101, 102, 103]);
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'lane-k');
    uCommit(repo, 'kkkk0001', [101, 102, 103], 104, 'K mints B103 (collides with X)');
    uCommit(repo, 'kkkk0002', [101, 102, 104], 105, 'K renumbers B103 -> B104');
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'lane-k', 'kkkk0002', [101, 102, 104], 105);
    const mainSha = provGit(repo, 'rev-parse', 'main');
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B103', provRunner), false);
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B104', provRunner), true, 'the merge brought B104');
    provGit(repo, 'switch', '-q', '-c', 'q');
    const carryOut = new Set();
    const errors = realErrors(uCheck(repo, 'q', pageX, { carryOut }));
    assert.equal(ofPrefix(errors, `${UNMERGED_LANE_ROW_ERROR_PREFIX}B103`).length, 1, JSON.stringify(errors));
    assert.deepEqual([...carryOut], ['B103']);
  });
});


test('#3529 pass 2: a live-only row origin/main has ever carried is a discharge, whatever the provenance', () => {
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102], 104),
    baseline: buildSingleGroupRegister('B', [101, 102], 104),
    trackedRows: baseRows,
    publishedRows: [...baseRows, { id: 'B103', body: 'once on main', title: 'gone' }],
  });
  for (const provenance of [UNMERGED, merged(['B101', 'B102'])]) {
    const opts = { ...options, publishedProvenance: provenance };
    assert.deepEqual(checkLiveView(working, published, { ...opts, mainEverCarried: (id) => id === 'B103' }), []);
    const never = checkLiveView(working, published, { ...opts, mainEverCarried: () => false });
    assert.equal(ofPrefix(never, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, JSON.stringify(never));
    // A failed lookup (null) grants no exemption.
    const failed = checkLiveView(working, published, { ...opts, mainEverCarried: () => null });
    assert.equal(ofPrefix(failed, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, JSON.stringify(failed));
  }
});


test('#3529 pass 2 git: resolveMainEverCarried reads every register main has ever had', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'lane-l');
    uCommit(repo, 'lane0001', [101, 102, 103], 104);
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'lane-l', 'lane0001', [101, 102, 103], 104);
    const mainSha = uCommit(repo, 'main0002', [101, 102], 104, 'discharge B103');
    provGit(repo, 'switch', '-q', '-c', 'lane-y');
    uCommit(repo, 'yyyy0001', [101, 102, 104], 105);
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B103', provRunner), true);
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B104', provRunner), false, 'only on an unmerged lane');
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B10', provRunner), false, 'no prefix match');
    const failing = () => ({ status: 128, stdout: '', stderr: 'fatal' });
    assert.equal(onbox.resolveMainEverCarried(repo, PROV_REGISTER, mainSha, 'B103', failing), null);
  });
});


// 🟠2 sub-point: a union-carried row names its OWNER, never the carrier.
test('#3529 pass 2: a union-carried row names the lane that first committed it, not the carrier', () => {
  const owner = { commit: '0123456789abcdef0123456789abcdef01234567', refs: ['origin/fix/server-x'] };
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102], 103),
    trackedRows: baseRows,
    publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
    extra: { publishedProvenance: merged(['B101', 'B102']), rowOwnerLookup: (id) => (id === 'B103' ? owner : null) },
  });
  const errors = ofPrefix(checkLiveView(working, published, options), UNMERGED_LANE_ROW_ERROR_PREFIX);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.ok(errors[0].includes('0123456789ab'), errors[0]);
  assert.ok(errors[0].includes('(on origin/fix/server-x)'), errors[0]);
  // Decision 5: the PR is found by the commit, never by a branch name.
  assert.ok(errors[0].includes('gh pr list --state all --search 0123456789abcdef0123456789abcdef01234567'), errors[0]);
  assert.ok(!errors[0].includes('--head'), errors[0]);
  assert.ok(!errors[0].includes('def5678'), 'must not name the carrier commit');
  assert.ok(!errors[0].includes('main0x1'), 'must not name the carrier publish id');
});


test('#3529 pass 2 git: resolveRowOwner finds the commit and branch that first committed a row', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'fix/server-x');
    const xCommit = uCommit(repo, 'xxxx0001', [101, 102, 103], 104);
    uCommit(repo, 'xxxx0002', [101, 102, 103], 104, 'restamp');
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'lane-k');
    uCommit(repo, 'kkkk0001', [101, 102, 104], 105);
    // A carrier that later COMMITS a union with X's B103 (dated later, so
    // date order is unambiguous) must not be named as its owner.
    provGit(repo, 'switch', '-q', '-c', 'lane-c');
    uWrite(repo, 'cccc0001', [101, 102, 103, 104], 105);
    provGit(repo, 'add', '-A');
    const later = { ...provEnv(), GIT_AUTHOR_DATE: '2030-01-01T01:00:00Z', GIT_COMMITTER_DATE: '2030-01-01T01:00:00Z' };
    assert.equal(spawnSync('git', ['commit', '-qm', 'carrier commits a union'], { cwd: repo, env: later, windowsHide: true }).status, 0);
    provGit(repo, 'switch', '-q', 'lane-k');
    const mainRef = provGit(repo, 'rev-parse', 'main');
    const at = (id, title) => onbox.resolveRowOwner(repo, PROV_LIVE, id, { title, mainRef }, provRunner);
    const owner = at('B103', 'title B103');
    assert.equal(owner.commit, xCommit);
    assert.deepEqual(owner.refs, ['fix/server-x']);
    assert.equal(at('B109', 'title B109'), null);
    // Decision 5: the live row's summary, not the bare ID — and no title, or
    // no main to exclude, is no owner.
    assert.equal(at('B103', 'a different row under the same ID'), null);
    assert.equal(at('B103', undefined), null);
    assert.equal(onbox.resolveRowOwner(repo, PROV_LIVE, 'B103', { title: 'title B103' }, provRunner), null);
  });
});


// Decision 5 (review pass 4, 🟠): the owner is the commit that introduced
// the live row's own summary — ID plus normalised title — and never a commit
// main already contains.
test('#3529 pass 4 git: resolveRowOwner matches the normalised title, skips another lane\'s row under the same ID, and excludes main', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'fix/server-k');
    const kCommit = p4Commit(repo, '2030-01-01T00:00:00Z', 'kkkk0001', [101, 102, 103], 104, 'K mints B103', { 103: 'K &amp; its row' });
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-x');
    const xCommit = p4Commit(repo, '2030-01-02T00:00:00Z', 'xxxx0001', [101, 102, 103], 104, 'X mints B103', { 103: 'X row' });
    const xRetitle = p4Commit(repo, '2030-01-03T00:00:00Z', 'xxxx0002', [101, 102, 103], 104, 'X retitles B103', { 103: 'X row, retitled' });
    const mainRef = provGit(repo, 'rev-parse', 'main');
    const at = (title, extra = {}) => onbox.resolveRowOwner(repo, PROV_LIVE, 'B103', { title, mainRef, ...extra }, provRunner);
    assert.equal(at('X row').commit, xCommit);
    assert.deepEqual(at('X row').refs, ['fix/server-x']);
    assert.equal(at('X row, retitled').commit, xRetitle, 'a retitle introduces the live summary');
    assert.equal(at('K & its row').commit, kCommit, 'entities normalised the way the collision check reads titles');
    // Merge K into main: K's commit is now main's, so it owns nothing.
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'merge', '-q', '--no-ff', '--no-edit', 'fix/server-k');
    assert.equal(onbox.resolveRowOwner(repo, PROV_LIVE, 'B103', { title: 'K & its row', mainRef: provGit(repo, 'rev-parse', 'main') }, provRunner), null);
    const failing = () => ({ status: 128, stdout: '', stderr: 'fatal' });
    assert.equal(onbox.resolveRowOwner(repo, PROV_LIVE, 'B103', { title: 'X row', mainRef }, failing), null);
    // A failed parent lookup proves nothing was inherited, so it names no owner.
    const noParents = (args, cwd) => (args[0] === 'rev-list' ? failing() : provRunner(args, cwd));
    assert.equal(onbox.resolveRowOwner(repo, PROV_LIVE, 'B103', { title: 'X row', mainRef }, noParents), null);
    // A commit that DROPS the row is a -G hit too; with no title to match it
    // must not read as the introducer of "no title".
    provGit(repo, 'switch', '-q', 'fix/server-x');
    p4Commit(repo, '2030-01-04T00:00:00Z', 'xxxx0003', [101, 102], 104, 'X drops B103');
    assert.equal(at(undefined), null);
  });
});


// A lane that merges main brings main's rows in through that merge commit,
// which main does not contain and whose first-parent diff adds them. It
// introduced nothing: the row came from a parent (found replaying this very
// branch after it merged #3505, which named its own merge commit as B103's
// owner).
test('#3529 pass 4 git: a lane\'s merge of main is not the owner of the rows main brought in; a row its resolution added is', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'fix/server-k');
    p4Commit(repo, '2030-01-01T00:00:00Z', 'kkkk0001', [101, 102, 103], 104, 'K mints B103', { 103: 'K row' });
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-l');
    p4Other(repo, '2030-01-01T01:00:00Z', 'L works');
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'fix/server-k', 'kkkk0001', [101, 102, 103], 104, { 103: 'K row' });
    const mainRef = provGit(repo, 'rev-parse', 'main');
    provGit(repo, 'switch', '-q', 'fix/server-l');
    // L merges main; its resolution also adds a B104 of its own.
    const lMerge = uMerge(repo, 'main', 'llll0001', [101, 102, 103, 104], 105, { 103: 'K row', 104: 'L row' });
    const at = (id, title) => onbox.resolveRowOwner(repo, PROV_LIVE, id, { title, mainRef }, provRunner);
    assert.equal(at('B103', 'K row'), null, 'B103 came from main through the merge');
    assert.equal(at('B104', 'L row').commit, lMerge, 'B104 was introduced by the resolution itself');
  });
});


const ownerOfB103 = (owner) => (id) => (id === 'B103' ? owner : null);


test('#3529 pass 2: checkRegister accepts a well-formed Retired carried rows table, empty or not, and its absence', () => {
  const reg = MAIN_B();
  assert.deepEqual(checkRegister(reg), []);
  assert.deepEqual(checkRegister(withRetired(reg, '')), []);
  assert.deepEqual(checkRegister(withRetired(reg, '| B103 | #3505 | 2026-10-07 | closed in favour of #3525 |\n')), []);
});


test('#3529 pass 2: checkRegister rejects a malformed Retired carried rows table, naming what is wrong', () => {
  const reg = MAIN_B();
  const cases = [
    ['| B103 | 3505 | 2026-10-07 | r |\n', /PR/],
    ['| B103 | #3505 | Oct 7 | r |\n', /date/],
    ['| B10x | #3505 | 2026-10-07 | r |\n', /row ID/],
    ['| B103 | #3505 | 2026-10-07 |  |\n', /reason/],
    ['| B103 | #3505 | 2026-10-07 |\n', /four cells/],
    ['| B103 | #3505 | 2026-10-07 | r |\n| B103 | #3506 | 2026-10-07 | r |\n', /more than once/],
    ['| B101 | #3505 | 2026-10-07 | r |\n', /still a row/],
  ];
  for (const [rows, pattern] of cases) {
    const errors = checkRegister(withRetired(reg, rows));
    assert.equal(errors.length, 1, `${rows}: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /Retired carried rows/);
    assert.match(errors[0], pattern);
  }
  const wrongHeader = withRetired(reg, '').replace('| Row | Owning PR | Closed unmerged | Reason |', '| ID | PR | Date | Why |');
  assert.match(checkRegister(wrongHeader)[0] ?? '', /Retired carried rows.*table/);
  const noTable = reg.replace('## At a glance', '## Retired carried rows\n\nNo table here.\n\n## At a glance');
  assert.match(checkRegister(noTable)[0] ?? '', /Retired carried rows.*table/);
});


function retiredCase(registerRows, extra = {}) {
  return checkLiveView(
    ...collisionOptions({
      working: withRetired(buildSingleGroupRegister('B', [101, 102], 103), registerRows),
      trackedRows: baseRows,
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      extra: { rowOwnerLookup: ownerOfB103(OWNER_X), ...extra },
    }),
  );
}

const RETIRED_B103 = '| B103 | #3505 | 2026-10-07 | closed in favour of #3525 |\n';


test('#3529 pass 2: a retired row whose PR is closed unmerged is dropped from the must-carry set', () => {
  assert.deepEqual(retiredCase(RETIRED_B103, { retiredPrStates: closedStates('CLOSED') }), []);
});


test('#3529 pass 2: a malformed Retired carried rows table fails the --against-published run too', () => {
  const errors = retiredCase('| B103 | 3505 | 2026-10-07 | r |\n', { retiredPrStates: closedStates('CLOSED') });
  const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX ?? '\u0000');
  assert.equal(retired.length, 1, JSON.stringify(errors));
  assert.match(retired[0], /PR/);
});


test('#3529 pass 2: a retirement record naming an OPEN PR is refused, naming the PR, and mutes nothing', () => {
  const errors = retiredCase(RETIRED_B103, { retiredPrStates: closedStates('OPEN') });
  const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX ?? '\u0000');
  assert.equal(retired.length, 1, JSON.stringify(errors));
  assert.match(retired[0], /#3505/);
  assert.match(retired[0], /OPEN/);
  assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, 'the row still must be carried');
});


test('#3529 pass 2: a retirement record naming a MERGED PR is refused', () => {
  for (const states of [closedStates('MERGED', '2026-10-07T00:00:00Z'), closedStates('CLOSED', '2026-10-07T00:00:00Z')]) {
    const errors = retiredCase(RETIRED_B103, { retiredPrStates: states });
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX ?? '\u0000');
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.match(retired[0], /#3505/);
    assert.match(retired[0], /merged/i);
  }
});


test('#3529 pass 2: a PR whose state could not be read is refused; gh unavailable warns and accepts', () => {
  const unreadable = retiredCase(RETIRED_B103, {
    retiredPrStates: { available: true, states: new Map([[3505, { error: 'Could not resolve to a PullRequest' }]]) },
  });
  assert.equal(ofPrefix(unreadable, onbox.RETIRED_ROW_ERROR_PREFIX ?? '\u0000').length, 1, JSON.stringify(unreadable));
  for (const states of [{ available: false, reason: 'gh is not installed' }, undefined]) {
    const errors = retiredCase(RETIRED_B103, { retiredPrStates: states });
    const warnings = ofPrefix(errors, onbox.RETIRED_ROW_WARNING_PREFIX ?? '\u0000');
    assert.equal(warnings.length, 1, JSON.stringify(errors));
    assert.match(warnings[0], /#3505/);
    assert.match(warnings[0], /owns/);
    assert.deepEqual(errors.filter((e) => !warnings.includes(e)), []);
  }
});


test('#3529 pass 2: a retirement recorded on origin/main applies to a branch that predates it', () => {
  const [working, published, options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102], 103),
    baseline: withRetired(MAIN_B(), RETIRED_B103),
    trackedRows: baseRows,
    publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
    extra: { retiredPrStates: closedStates('CLOSED'), rowOwnerLookup: ownerOfB103(OWNER_X) },
  });
  assert.deepEqual(checkLiveView(working, published, options), []);
});


// Review pass 3, 🟡1 (P3a), and operator decision 5: a retirement is honoured
// only when the commit that introduced the live row is one of the named PR's
// own commits. Branch names play no part (review pass 4, 🟡1).
test('#3529 pass 3 P3a: a retirement naming an unrelated closed PR is refused, naming the PR and the introducing commit, and mutes nothing', () => {
  const states = { available: true, states: new Map([[3509, { state: 'CLOSED', mergedAt: null, commits: ['fedcba9876543210fedcba9876543210fedcba98'] }]]) };
  const errors = retiredCase('| B103 | #3509 | 2026-10-07 | typo for #3505 |\n', { retiredPrStates: states });
  const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
  assert.equal(retired.length, 1, JSON.stringify(errors));
  assert.match(retired[0], /#3509/);
  assert.ok(retired[0].includes(OWNER_X.commit), retired[0]);
  assert.match(retired[0], /not one of #3509.s 1 commit/);
  assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, 'the row still must be carried');
});


test('#3529 pass 4: a retirement whose PR commits include the introducing commit is honoured, wherever it sits in the list and in any case', () => {
  for (const commits of [[OWNER_X.commit], ['1111111111111111111111111111111111111111', OWNER_X.commit], [OWNER_X.commit.toUpperCase()]]) {
    const errors = retiredCase(RETIRED_B103, { retiredPrStates: closedStates('CLOSED', null, commits) });
    assert.deepEqual(errors, [], JSON.stringify(commits));
  }
});


test('#3529 pass 4: the owner lookup is handed the PR\'s own commits, so an introducing commit no branch holds still counts', () => {
  const seen = [];
  const errors = retiredCase(RETIRED_B103, {
    retiredPrStates: closedStates('CLOSED'),
    rowOwnerLookup: (id, prCommits) => (
      seen.push([id, prCommits]), id === 'B103' && prCommits?.includes(OWNER_X.commit) ? { commit: OWNER_X.commit, refs: [] } : null
    ),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(seen, [['B103', [OWNER_X.commit]]]);
});


test('#3529 pass 4: a retirement whose row owner cannot be determined is refused, naming the PR and to git fetch origin, never a local ref', () => {
  for (const rowOwnerLookup of [() => null, () => ({ commit: null, refs: [] }), undefined]) {
    const errors = retiredCase(RETIRED_B103, { retiredPrStates: closedStates('CLOSED'), rowOwnerLookup });
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.match(retired[0], /#3505/);
    assert.match(retired[0], /run git fetch origin and re-run/);
    assert.ok(!/pull[/]|refs[/]|head:/.test(retired[0]), `no ref target: ${retired[0]}`);
    assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, 'the row still must be carried');
  }
});


test('#3529 pass 4: a mismatch names any of the PR\'s commits this checkout lacks, and to git fetch origin', () => {
  const errors = retiredCase(RETIRED_B103, {
    retiredPrStates: closedStates('CLOSED', null, ['2222222222222222222222222222222222222222']),
    rowOwnerLookup: ownerOfB103({ ...OWNER_X, missingCommits: ['2222222222222222222222222222222222222222'] }),
  });
  const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
  assert.equal(retired.length, 1, JSON.stringify(errors));
  assert.ok(retired[0].includes(OWNER_X.commit), retired[0]);
  assert.match(retired[0], /222222222222/);
  assert.match(retired[0], /run git fetch origin and re-run/);
});


test('#3529 pass 4: a retirement whose PR commits gh did not report is refused', () => {
  // (undefined would take closedStates' default; gh's own missing field is
  // parsed to null by resolveRetiredPrStates, tested below.)
  for (const commits of [null, 'not a list', { oid: OWNER_X.commit }]) {
    const errors = retiredCase(RETIRED_B103, { retiredPrStates: closedStates('CLOSED', null, commits) });
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.match(retired[0], /#3505/);
    assert.match(retired[0], /did not report #3505.s commits/);
  }
});


test('#3529 pass 3: the owner is looked up only for a retired row the live page still carries', () => {
  let lookups = 0;
  const [working, published, options] = collisionOptions({
    working: withRetired(buildSingleGroupRegister('B', [101, 102], 103), RETIRED_B103),
    trackedRows: baseRows,
    publishedRows: baseRows,
    extra: { retiredPrStates: closedStates('CLOSED'), rowOwnerLookup: () => (lookups++, null) },
  });
  assert.deepEqual(checkLiveView(working, published, options), []);
  assert.equal(lookups, 0, 'a retired row no longer live needs no owner — its branch may be long gone');
});

