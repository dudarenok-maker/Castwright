// #3529 on-box register checker: retired-carried-rows record, collision
// retirement and owner-branch cases (git-backed throwaway repos).
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkLiveView, ROW_ID_COLLISION_ERROR_PREFIX, UNMERGED_LANE_ROW_ERROR_PREFIX, UNKNOWN_PROVENANCE_ERROR_PREFIX, PUBLISHING_FILE_ERROR_PREFIX, DISCHARGE_NAME_ERROR_PREFIX } from '../check-onbox-register.mjs';
import * as onbox from '../check-onbox-register.mjs';
import {
  buildSingleGroupRegister,
  buildRowContentLiveView,
  buildMultiGroupRegister,
  buildMultiGroupLiveView,
  REAL_LIVE_VIEW_HTML,
  REAL_REGISTER_TEXT,
  withHermeticBaseline,
  runCli,
  computeMaxRowNumber,
  renameLiveViewRowId,
  MINE_TITLE,
  THEIRS_TITLE,
  UNMERGED,
  merged,
  own,
  collisionOptions,
  baseRows,
  ofPrefix,
  PROV_LIVE,
  PROV_REGISTER,
  provGit,
  uView,
  uMerge,
  withUnionRepo,
  uCheck,
  realErrors,
  p4Commit,
  p4Other,
  p4Retire,
  X_TITLES,
  fakeGh,
  theirsB103,
  theirsB104,
  mineB105,
  unionFixture,
  withCliRepo,
  cliCommit,
} from './check-onbox-register-test-support.mjs';

const p4States = (entries) => ({
  available: true,
  states: new Map(entries.map(([pr, state, commits]) => [pr, { state, mergedAt: state === 'MERGED' ? '2030-01-04T00:00:00Z' : null, commits }])),
});

// K mints B103 first (older), renumbers it to B104 and merges (#3525's shape).
// X, forked before K merged, mints its own B103 later and publishes. Z is
// unrelated work cut from main after K merged; q is the publishing lane.
function p4CollisionWorld(fn) {
  return withUnionRepo((repo) => {
    const fork = provGit(repo, 'rev-parse', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-k');
    const kCommit = p4Commit(repo, '2030-01-01T00:00:00Z', 'kkkk0001', [101, 102, 103], 104, 'K mints B103', { 103: 'K row' });
    p4Commit(repo, '2030-01-01T01:00:00Z', 'kkkk0002', [101, 102, 104], 105, 'K renumbers to B104');
    provGit(repo, 'switch', '-q', 'main');
    uMerge(repo, 'fix/server-k', 'kkkk0002', [101, 102, 104], 105);
    provGit(repo, 'switch', '-q', '-c', 'fix/server-x', fork);
    const xCommit = p4Commit(repo, '2030-01-02T00:00:00Z', 'xxxx0001', [101, 102, 103], 104, 'X mints B103', X_TITLES);
    const pageX = uView('xxxx0001', [101, 102, 103], X_TITLES);
    provGit(repo, 'switch', '-q', '-c', 'fix/server-z', 'main');
    const zCommit = p4Other(repo, '2030-01-03T00:00:00Z', 'unrelated Z work');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-q', 'main');
    return fn(repo, { pageX, xCommit, kCommit, zCommit });
  });
}


test('#3529 pass 4 P4a: in a collision, a retirement naming an unrelated closed PR (or the publishing lane) is refused', () => {
  p4CollisionWorld((repo, { pageX, xCommit, zCommit }) => {
    for (const [pr, commits] of [[9001, [zCommit]], [9009, [provGit(repo, 'rev-parse', 'fix/server-q')]]]) {
      writeFileSync(join(repo, PROV_REGISTER), p4Retire(pr));
      const errors = realErrors(uCheck(repo, 'fix/server-q', pageX, { retiredPrStates: p4States([[pr, 'CLOSED', commits]]) }));
      const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
      assert.equal(retired.length, 1, `#${pr}: ${JSON.stringify(errors)}`);
      assert.ok(retired[0].includes(`#${pr}`) && retired[0].includes(xCommit), retired[0]);
      assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, 'B103 must still be carried');
    }
  });
});


test('#3529 pass 4 P4b: in a collision, the legitimate retirement (X closed unmerged) is honoured; one under merged K is not', () => {
  p4CollisionWorld((repo, { pageX, xCommit, kCommit }) => {
    writeFileSync(join(repo, PROV_REGISTER), p4Retire(9002));
    assert.deepEqual(realErrors(uCheck(repo, 'fix/server-q', pageX, { retiredPrStates: p4States([[9002, 'CLOSED', [xCommit]]]) })), []);
    writeFileSync(join(repo, PROV_REGISTER), p4Retire(9003));
    const errors = realErrors(uCheck(repo, 'fix/server-q', pageX, { retiredPrStates: p4States([[9003, 'MERGED', [kCommit]]]) }));
    assert.equal(ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX).length, 1, JSON.stringify(errors));
  });
});


test('#3529 pass 4 P4b2: in a collision, the unmerged-lane-row error names X\'s commit and branch, not K\'s', () => {
  p4CollisionWorld((repo, { pageX, xCommit, kCommit }) => {
    const errors = ofPrefix(realErrors(uCheck(repo, 'fix/server-q', pageX)), UNMERGED_LANE_ROW_ERROR_PREFIX);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok(errors[0].includes(xCommit.slice(0, 12)) && errors[0].includes(`--search ${xCommit}`), errors[0]);
    assert.ok(errors[0].includes('(on fix/server-x)'), errors[0]);
    assert.ok(!errors[0].includes(kCommit.slice(0, 12)) && !errors[0].includes('fix/server-k'), errors[0]);
  });
});


test('#3529 pass 4 P4i: K (closed, never merged) minted B103 first; retiring it under K cannot mute X\'s live, still-owed B103', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'fix/server-k');
    const kCommit = p4Commit(repo, '2030-01-01T00:00:00Z', 'kkkk0001', [101, 102, 103], 104, 'K mints B103', { 103: 'K row' });
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-x');
    const xCommit = p4Commit(repo, '2030-01-02T00:00:00Z', 'xxxx0001', [101, 102, 103], 104, 'X mints its own B103', X_TITLES);
    const pageX = uView('xxxx0001', [101, 102, 103], X_TITLES);
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-q');
    writeFileSync(join(repo, PROV_REGISTER), p4Retire(9010, [101, 102], 104));
    const errors = realErrors(uCheck(repo, 'fix/server-q', pageX, { retiredPrStates: p4States([[9010, 'CLOSED', [kCommit]]]) }));
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.ok(retired[0].includes('#9010') && retired[0].includes(xCommit), retired[0]);
    const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
    assert.equal(unmerged.length, 1, 'X is open: its live B103 must still be carried');
    assert.ok(unmerged[0].includes('(on fix/server-x)') && !unmerged[0].includes('fix/server-k'), unmerged[0]);
  });
});


// Review pass 4, 🟡1: PR identity, not branch names.
function p4LaneX(repo, { stacked = false } = {}) {
  provGit(repo, 'switch', '-q', '-c', 'fix/server-x');
  const xCommit = p4Commit(repo, '2030-01-02T00:00:00Z', 'xxxx0001', [101, 102, 103], 104, 'X mints B103', X_TITLES);
  const stackedCommit = stacked ? (provGit(repo, 'switch', '-q', '-c', 'fix/server-x-part2'), p4Other(repo, '2030-01-03T00:00:00Z', 'stacked')) : null;
  provGit(repo, 'switch', '-q', 'main');
  provGit(repo, 'switch', '-q', '-c', 'fix/server-q');
  return { xCommit, stackedCommit, pageX: uView('xxxx0001', [101, 102, 103], X_TITLES) };
}


test('#3529 pass 4 P4c: an older closed PR that reused the owner\'s branch name is refused (its commits are not X\'s)', () => {
  withUnionRepo((repo) => {
    const old = p4Other(repo, '2029-12-01T00:00:00Z', 'the older PR on fix/server-x');
    const { pageX, xCommit } = p4LaneX(repo);
    writeFileSync(join(repo, PROV_REGISTER), p4Retire(9004, [101, 102], 104));
    const errors = realErrors(uCheck(repo, 'fix/server-q', pageX, { retiredPrStates: p4States([[9004, 'CLOSED', [old]]]) }));
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.ok(retired[0].includes('#9004') && retired[0].includes(xCommit), retired[0]);
  });
});


test('#3529 pass 4 P4c2: a closed stacked PR cut from the owner\'s branch is refused while the owner is open', () => {
  withUnionRepo((repo) => {
    const { pageX, xCommit, stackedCommit } = p4LaneX(repo, { stacked: true });
    writeFileSync(join(repo, PROV_REGISTER), p4Retire(9007, [101, 102], 104));
    const errors = realErrors(uCheck(repo, 'fix/server-q', pageX, { retiredPrStates: p4States([[9007, 'CLOSED', [stackedCommit]]]) }));
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.ok(retired[0].includes('#9007') && retired[0].includes(xCommit), retired[0]);
  });
});


test('#3529 pass 4 P4d: the owner\'s branch deleted after close needs no fetch — the PR\'s own commit is still found', () => {
  withUnionRepo((repo) => {
    const { pageX, xCommit } = p4LaneX(repo);
    provGit(repo, 'branch', '-q', '-D', 'fix/server-x');
    writeFileSync(join(repo, PROV_REGISTER), p4Retire(9005, [101, 102], 104));
    assert.deepEqual(realErrors(uCheck(repo, 'fix/server-q', pageX, { retiredPrStates: p4States([[9005, 'CLOSED', [xCommit]]]) })), []);
  });
});


test('#3529 pass 4 P4e: a fork PR whose head branch is main is matched by its commits, and nothing names a local ref to write', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'fork-tmp');
    const fCommit = p4Commit(repo, '2030-01-02T00:00:00Z', 'ffff0001', [101, 102, 103], 104, 'fork mints B103', X_TITLES);
    const pageF = uView('ffff0001', [101, 102, 103], X_TITLES);
    provGit(repo, 'switch', '-q', 'main');
    const mainBefore = provGit(repo, 'rev-parse', 'main');
    provGit(repo, 'branch', '-q', '-D', 'fork-tmp');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-q');
    writeFileSync(join(repo, PROV_REGISTER), p4Retire(9006, [101, 102], 104));
    assert.deepEqual(realErrors(uCheck(repo, 'fix/server-q', pageF, { retiredPrStates: p4States([[9006, 'CLOSED', [fCommit]]]) })), []);
    // The fork's commit not in this checkout at all: refused, and the remedy
    // is a plain fetch — never a refspec that could move local main.
    const absent = '3333333333333333333333333333333333333333';
    const errors = realErrors(uCheck(repo, 'fix/server-q', pageF, { retiredPrStates: p4States([[9006, 'CLOSED', [absent]]]) }));
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.ok(retired[0].includes('#9006') && retired[0].includes(absent.slice(0, 12)), retired[0]);
    assert.match(retired[0], /run git fetch origin and re-run/);
    assert.ok(!/pull[/]|head:|:main/.test(retired[0]), retired[0]);
    assert.equal(provGit(repo, 'rev-parse', 'main'), mainBefore);
  });
});


test('#3529 pass 4: the owner of a row no commit this checkout holds is undeterminable, and the retirement says to git fetch origin', () => {
  withUnionRepo((repo) => {
    provGit(repo, 'switch', '-q', '-c', 'fix/server-q');
    const pageX = uView('xxxx0001', [101, 102, 103], X_TITLES);
    writeFileSync(join(repo, PROV_REGISTER), p4Retire(9011, [101, 102], 104));
    const absent = '4444444444444444444444444444444444444444';
    const errors = realErrors(uCheck(repo, 'fix/server-q', pageX, { retiredPrStates: p4States([[9011, 'CLOSED', [absent]]]) }));
    const retired = ofPrefix(errors, onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(errors));
    assert.match(retired[0], /#9011/);
    assert.match(retired[0], /444444444444/);
    assert.match(retired[0], /run git fetch origin and re-run/);
  });
});


test('#3529 pass 2: resolveRetiredPrStates reads gh through an injected runner, never the network', () => {
  const gh = fakeGh({
    3505: { state: 'CLOSED', commits: ['aaaa', 'bbbb'] },
    3506: { state: 'OPEN', commits: [] },
    3508: { state: 'MERGED', mergedAt: '2026-10-07T00:00:00Z', commits: ['cccc'] },
    3510: { state: 'CLOSED', commits: ['dddd', null] },
  });
  const r = onbox.resolveRetiredPrStates('/repo', [3505, 3506, 3507, 3508, 3510], gh);
  assert.equal(r.available, true);
  assert.deepEqual(r.states.get(3508), { state: 'MERGED', mergedAt: '2026-10-07T00:00:00Z', commits: ['cccc'] });
  assert.deepEqual(r.states.get(3505), { state: 'CLOSED', mergedAt: null, commits: ['aaaa', 'bbbb'] });
  assert.equal(r.states.get(3506).state, 'OPEN');
  assert.match(r.states.get(3507).error, /Could not resolve/);
  assert.equal(r.states.get(3510).commits, null, 'a commit without an oid poisons the list');
  assert.ok(gh.calls.some((c) => c.startsWith('api graphql --paginate --slurp') && c.includes('number=3505')), gh.calls.join('\n'));
  assert.ok(!gh.calls.some((c) => c.startsWith('pr view')), 'gh pr view caps its commit list at 100');
  assert.ok(!gh.calls.some((c) => c.includes('headRefName')), gh.calls.join('\n'));
  gh.calls.length = 0;
  assert.deepEqual(onbox.resolveRetiredPrStates('/repo', [], gh).states.size, 0);
  assert.deepEqual(gh.calls, [], 'no entries, no gh calls');
  const noGh = onbox.resolveRetiredPrStates('/repo', [3505], () => ({ error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }));
  assert.equal(noGh.available, false);
  const noAuth = onbox.resolveRetiredPrStates('/repo', [3505], (args) =>
    args[0] === 'auth' ? { status: 1, stdout: '', stderr: 'not logged in' } : assert.fail('must not query a PR unauthenticated'),
  );
  assert.equal(noAuth.available, false);
  assert.match(noAuth.reason, /not authenticated|not logged in/);
});


test('#3529 pass 5: resolveRetiredPrStates reads every page of a PR with more than 100 commits', () => {
  const oids = Array.from({ length: 120 }, (_, i) => `c${String(i).padStart(3, '0')}`);
  const r = onbox.resolveRetiredPrStates('/repo', [9040], fakeGh({ 9040: { state: 'CLOSED', commits: oids } }));
  assert.deepEqual(r.states.get(9040).commits, oids, 'all 120, in order, not the first 100');
  const bad = (out) => onbox.resolveRetiredPrStates('/repo', [1], (a) => (a[0] === 'auth' ? { status: 0 } : { status: 0, stdout: out, stderr: '' })).states.get(1);
  assert.match(bad('not json').error, /not JSON/);
  assert.match(bad(JSON.stringify([{ data: { repository: { pullRequest: null } } }])).error, /no such pull request|not found|no pull request/i);
});


test('#3529 pass 5: a commit list shorter than totalCount is reported as incomplete, never as complete', () => {
  const r = onbox.resolveRetiredPrStates('/repo', [9041], fakeGh({ 9041: { state: 'CLOSED', commits: ['aaaa', 'bbbb'], totalCount: 120 } }));
  const st = r.states.get(9041);
  assert.equal(st.commits, null, 'an incomplete list must not be matched against');
  assert.deepEqual(st.incompleteCommits, { have: 2, total: 120 });
});


test('#3529 pass 2: buildUnionLiveView inserts carried blocks in ID order and regenerates the derived figures', () => {
  const { tracked, live } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B104', 'B103']);
  assert.equal(union, buildRowContentLiveView([...baseRows, theirsB103, theirsB104, mineB105], 'B'));
});


// Review pass 3, 🟡5 (R2/R3): with two groups, a carried Group B row lands in
// Group B's section and raises only Group B's glance count and gcount. Every
// earlier union test had a single group, so a lookup that ignored the letter
// stayed green.
test('#3529 pass 3: in a two-group view the union carries each row into its own group and raises only its figures', () => {
  const twoGroup = (bRows) => {
    const a = buildRowContentLiveView([{ id: 'A101', body: 'a', title: 'ta' }], 'A');
    const html = a
      .replace('<div class="n owed">1</div>', `<div class="n owed">${1 + bRows.length}</div>`)
      .replace('    </tbody>', `      <tr><td><a href="#gb">B</a></td><td>Setup B</td><td>${bRows.length}</td></tr>\n    </tbody>`);
    const bBlocks = bRows
      .map(
        (r) =>
          `    <details class="item">\n      <summary><span class="num">${r.id}</span><span class="iname">${r.title}</span><span class="risk">default</span></summary>\n      <div class="body">\n        <p>${r.body}</p>\n      </div>\n    </details>`,
      )
      .join('\n');
    return html.replace(
      '</section>\n',
      `</section>\n\n  <section class="group" id="gb">\n    <h3 class="gtitle"><span class="gtag">B</span> Setup B <span class="gcount">${bRows.length} rows</span></h3>\n${bBlocks}\n  </section>\n`,
    );
  };
  const b = (n) => ({ id: `B${n}`, body: `b${n}`, title: `t${n}` });
  const tracked = twoGroup([b(101), b(102), b(105)]);
  const live = twoGroup([b(101), b(102), b(103), b(104)]);
  assert.equal(onbox.buildUnionLiveView(tracked, live, ['B104', 'B103']), twoGroup([b(101), b(102), b(103), b(104), b(105)]));
});


test('#3529 pass 2: a union built by buildUnionLiveView passes --publishing, CRLF or not', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']);
  assert.deepEqual(checkLiveView(working, live, { ...options, publishingHtml: union }), []);
  assert.deepEqual(checkLiveView(working, live, { ...options, publishingHtml: union.replace(/\n/g, '\r\n') }), [], 'CRLF');
});


test('#3529 pass 2 S6: a union missing one of your own rows fails, naming it', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']);
  const block101 = union.match(/ {4}<details class="item">\s*<summary><span class="num">B101<\/span>[\s\S]*?<\/details>\n/)[0];
  const errors = checkLiveView(working, live, { ...options, publishingHtml: union.replace(block101, '') });
  const pub = ofPrefix(errors, PUBLISHING_FILE_ERROR_PREFIX);
  assert.ok(pub.some((e) => /B101/.test(e)), JSON.stringify(errors));
});


test('#3529 pass 2: a union whose copy of your own row differs fails, naming it', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']).replace('<p>mine</p>', '<p>stale mine</p>');
  const pub = ofPrefix(checkLiveView(working, live, { ...options, publishingHtml: union }), PUBLISHING_FILE_ERROR_PREFIX);
  assert.ok(pub.some((e) => /B105/.test(e)), JSON.stringify(pub));
});


test('#3529 pass 2: a hand-built union whose derived figures were not regenerated fails, naming --build-union', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']).replace('<div class="n owed">5</div>', '<div class="n owed">3</div>');
  const pub = ofPrefix(checkLiveView(working, live, { ...options, publishingHtml: union }), PUBLISHING_FILE_ERROR_PREFIX);
  assert.equal(pub.length, 1, JSON.stringify(pub));
  assert.match(pub[0], /--build-union/);
});


test('#3529 pass 2: a union carrying a row that is neither yours nor live fails, naming it', () => {
  const { tracked, live, working, options } = unionFixture();
  const union = onbox.buildUnionLiveView(tracked, live, ['B103', 'B104']).replace('<span class="num">B104</span>', '<span class="num">B107</span>');
  const pub = ofPrefix(checkLiveView(working, live, { ...options, publishingHtml: union }), PUBLISHING_FILE_ERROR_PREFIX);
  assert.ok(pub.some((e) => /B107/.test(e) && /neither/.test(e)), JSON.stringify(pub));
});


test('#3529 pass 2: buildUnionLiveView refuses a carried row whose group has no section in your live view', () => {
  const tracked = buildRowContentLiveView(baseRows, 'B');
  const iView = buildRowContentLiveView([{ id: 'I101', body: 'theirs' }], 'I');
  const live = `${tracked}\n${iView.slice(iView.indexOf('  <section'))}`;
  assert.throws(() => onbox.buildUnionLiveView(tracked, live, ['I101']), /Group I/);
  assert.throws(() => onbox.buildUnionLiveView(tracked, live, ['B109']), /not on the live page/);
  assert.throws(() => onbox.buildUnionLiveView(tracked, live, ['B101']), /already in your live view/);
});


// 🟠4: the whole-group paths.
test('#3529 pass 2 S7: in a group this register dropped entirely, another lane’s row is classified, and --discharging cannot silence it', () => {
  const workingRegister = buildSingleGroupRegister('A', [1]);
  const baselineRegister = buildMultiGroupRegister([
    { letter: 'A', rowNumbers: [1] },
    { letter: 'F', rowNumbers: [1] },
  ]);
  const liveView = buildMultiGroupLiveView(3, [
    { letter: 'A', glanceCount: 1, headerCount: 1, rowIds: ['A1'] },
    { letter: 'F', glanceCount: 2, headerCount: 2, rowIds: ['F1', 'F2'] },
  ]);
  const opts = { direction: 'extraOnly', baselineText: baselineRegister, publishedProvenance: UNMERGED };
  for (const named of [['F1'], ['F1', 'F2']]) {
    const errors = checkLiveView(workingRegister, liveView, { ...opts, dischargingIds: named });
    const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
    assert.deepEqual(unmerged.map((e) => e.match(/^unmerged-lane-row: ([A-Z]\d+):/)?.[1]), ['F2'], JSON.stringify(errors));
    assert.ok(!errors.some((e) => /BEHIND/.test(e) && /F2/.test(e)), `F2 is not BEHIND-routed: ${JSON.stringify(errors)}`);
    assert.equal(ofPrefix(errors, DISCHARGE_NAME_ERROR_PREFIX).length, 0, JSON.stringify(errors));
  }
  // The discharge itself still passes when nothing else is on the page.
  const clean = buildMultiGroupLiveView(2, [
    { letter: 'A', glanceCount: 1, headerCount: 1, rowIds: ['A1'] },
    { letter: 'F', glanceCount: 1, headerCount: 1, rowIds: ['F1'] },
  ]);
  assert.deepEqual(checkLiveView(workingRegister, clean, { ...opts, dischargingIds: ['F1'] }), []);
});


// 🟡2: pass-2 survivors M7 and M8.
test('#3529 pass 2 (M7): on your own page, a row your stamp did NOT commit is not exempt from the collision check', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      // Your union publish carried B103 for another lane; your stamp did not.
      extra: { publishedProvenance: own(['B101', 'B102']) },
    }),
  );
  assert.equal(ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX).length, 1, JSON.stringify(errors));
});


test('#3529 pass 2 (M8): a same-ID title difference under unknown provenance is reported, not skipped', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      trackedRows: [...baseRows, { id: 'B103', body: 'mine', title: MINE_TITLE }],
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      extra: { publishedProvenance: { kind: 'unknown', nonce: 'ghost0x1', reason: 'x' } },
    }),
  );
  const unknown = ofPrefix(errors, UNKNOWN_PROVENANCE_ERROR_PREFIX);
  assert.equal(unknown.length, 1, JSON.stringify(errors));
  assert.match(unknown[0], /B103/);
  // B103 is in your own file, so "carry it" is not the way forward.
  assert.ok(!unknown[0].includes('--build-union'), unknown[0]);
  assert.match(unknown[0], /renumber/);
});


// 🟡3: an unreadable merge-base only matters when a verdict depends on it.
test('#3529 pass 2: an unreadable merge-base is silent unless an ID is shared with origin/main under another title', () => {
  const quiet = checkLiveView(
    ...collisionOptions({ trackedRows: baseRows, publishedRows: baseRows, extra: { mergeBaseText: null } }),
  );
  assert.deepEqual(quiet, []);
  const mainRegister = buildSingleGroupRegister('B', [101, 102, 103], 104).replace('### B103 · thing 103', '### B103 · Theirs');
  const mineRegister = buildSingleGroupRegister('B', [101, 102, 103], 104).replace('### B103 · thing 103', '### B103 · Mine');
  const loud = checkLiveView(mineRegister, buildRowContentLiveView(baseRows, 'B'), {
    direction: 'extraOnly',
    baselineText: mainRegister,
    publishedProvenance: merged(['B101', 'B102']),
    mergeBaseText: null,
  });
  const unknown = ofPrefix(loud, UNKNOWN_PROVENANCE_ERROR_PREFIX);
  assert.equal(unknown.length, 1, JSON.stringify(loud));
  assert.match(unknown[0], /B103/);
  assert.match(unknown[0], /merge-base/);
});


// 🟡4: the unknown-provenance error gives the next step.
test('#3529 pass 2: the unknown-provenance error names both ways forward — fetch, or carry the rows', () => {
  const errors = checkLiveView(
    ...collisionOptions({
      working: buildSingleGroupRegister('B', [101, 102], 103),
      trackedRows: baseRows,
      publishedRows: [...baseRows, { id: 'B103', body: 'theirs', title: THEIRS_TITLE }],
      extra: { publishedProvenance: { kind: 'unknown', nonce: 'ghost0x1', reason: 'x' } },
    }),
  );
  const unknown = ofPrefix(errors, UNKNOWN_PROVENANCE_ERROR_PREFIX)[0] ?? '';
  assert.match(unknown, /--build-union/);
  assert.match(unknown, /--publishing/);
});


test('#3529 pass 2 CLI: real provenance, merge-base, ever-carried, owner and gh lookups are all wired', () => {
  withCliRepo((repo, cli) => {
    cliCommit(repo, 'main0001', [101, 102], 103);
    provGit(repo, 'push', '-q', 'origin', 'main');
    // mine forks here, mints its own B103, discharges B102 and retires an
    // unrelated B109 (a retirement the real gh lookup must try to confirm).
    provGit(repo, 'switch', '-q', '-c', 'mine');
    cliCommit(repo, 'mine0001', [101, 103], 104, { 103: 'Mine' }, '| B109 | #1 | 2026-10-07 | test fixture |\n');
    // lane-y mints a different B103 and merges first.
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'lane-y');
    cliCommit(repo, 'yyyy0001', [101, 102, 103], 104, { 103: 'Theirs Y' });
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'merge', '-q', '--no-ff', '--no-edit', 'lane-y');
    provGit(repo, 'push', '-q', 'origin', 'main');
    // fix/server-x, unmerged, adds B104 and publishes.
    provGit(repo, 'switch', '-q', '-c', 'fix/server-x');
    cliCommit(repo, 'xxxx0001', [101, 102, 103, 104], 105, { 103: 'Theirs Y', 104: 'X row' });
    const xCommit = provGit(repo, 'rev-parse', 'HEAD');
    const page = readFileSync(join(repo, PROV_LIVE), 'utf8');
    // main then discharges B102 — which lane-x's page still carries.
    provGit(repo, 'switch', '-q', 'main');
    cliCommit(repo, 'main0003', [101, 103], 104, { 103: 'Theirs Y' });
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', 'mine');
    writeFileSync(join(repo, 'page.saved.html'), page);
    // gh made unauthenticated (or absent): the real lookup must say so.
    const ghHome = mkdtempSync(join(tmpdir(), 'onbox-gh-'));
    const env = { GH_CONFIG_DIR: ghHome };
    let r;
    try {
      r = cli(['--against-published', 'page.saved.html'], env);
    } finally {
      rmSync(ghHome, { recursive: true, force: true });
    }
    assert.ok(!r.stderr.includes('unmerged-lane-row: B102'), `main has carried B102 — a discharge: ${r.stderr}`);
    assert.match(r.stderr, /retired-row-warning: B109 .*\(gh (is not installed|is not authenticated|could not run)/);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(!/WARNING: .*injected/.test(r.stderr), 'no test override in play');
    assert.ok(r.stderr.includes('unmerged-lane-row: B104:'), r.stderr);
    assert.ok(r.stderr.includes(`(on fix/server-x)`), `names the owning lane: ${r.stderr}`);
    assert.ok(r.stderr.includes(`gh pr list --state all --search ${xCommit}`), `finds its PR by commit: ${r.stderr}`);
    assert.ok(r.stderr.includes('row-id-collision: B103:'), `merged-lane collision via the merge-base: ${r.stderr}`);
  });
});


test('#3529 pass 2 CLI: --build-union writes a union that then passes, and is refused without --against-published or with --publishing', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { newId, mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const env = { ONBOX_TEST_BASELINE_FILE: baselinePath, ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged' };
    const unionPath = join(dirname(publishedPath), 'union.html');
    const built = runCli(['--against-published', publishedPath, '--build-union', unionPath], env);
    assert.equal(built.status, 0, `stdout: ${built.stdout}\nstderr: ${built.stderr}`);
    assert.ok(built.stdout.includes(unionPath) && built.stdout.includes(newId), built.stdout);
    const union = readFileSync(unionPath, 'utf8');
    assert.ok(union.includes(`<span class="num">${newId}</span>`));
    const checked = runCli(['--against-published', publishedPath, '--publishing', unionPath], env);
    assert.equal(checked.status, 0, `stdout: ${checked.stdout}\nstderr: ${checked.stderr}`);
    const both = runCli(['--against-published', publishedPath, '--publishing', unionPath, '--build-union', unionPath], env);
    assert.equal(both.status, 1);
    assert.match(both.stderr, /--build-union cannot be combined with --publishing/);
  });
  const alone = runCli(['--build-union', 'x.html']);
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /--build-union only makes sense alongside --against-published/);
});

