// #4105 (PR #4106 review pass 1) on-box register checker: a published page that
// is merely BEHIND origin/main, against REAL git. Throwaway repositories; the
// unit tests in check-onbox-register.test.mjs drive the same matcher through a
// stubbed runner, which cannot tell a lane-only body from a main-only one or
// prove the CLI wires the matcher and the first-parent walk in.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkLiveView,
  makeCommittedBodyMatch,
  ROW_CONTENT_DRIFT_ERROR_PREFIX,
  BEHIND_MAIN_ADVISORY_PREFIX,
  BRANCH_BEHIND_MAIN_ERROR_PREFIX,
} from '../check-onbox-register.mjs';
import {
  buildRowContentLiveView,
  buildSingleGroupRegister,
  provGit,
  provRunner,
  PROV_LIVE,
  PROV_REGISTER,
  withCliRepo,
} from './check-onbox-register-test-support.mjs';

const LV = 'live.html';
const view = (body) => buildRowContentLiveView([{ id: 'A1', body }]);
const register = buildSingleGroupRegister('A', [1]);
const DRIFT = `${ROW_CONTENT_DRIFT_ERROR_PREFIX}A1: content differs between local and published`;

// A repo whose `main` has one commit per entry of `mainBodies` (oldest first,
// each a "Merge pull request #N" subject), plus an optional unmerged `lane`
// branch carrying `laneBody`. Leaves HEAD on main.
function withRepo(mainBodies, laneBody, fn) {
  const repo = mkdtempSync(join(tmpdir(), 'onbox-behind-'));
  try {
    provGit(repo, 'init', '-q', '-b', 'main');
    provGit(repo, 'config', 'user.email', 'test@example.com');
    provGit(repo, 'config', 'user.name', 'Test');
    provGit(repo, 'config', 'commit.gpgsign', 'false');
    mainBodies.forEach((body, i) => {
      writeFileSync(join(repo, LV), view(body));
      provGit(repo, 'add', LV);
      provGit(repo, 'commit', '-qm', `Merge pull request #${i + 1} from x/y`);
    });
    if (laneBody !== undefined) {
      provGit(repo, 'switch', '-q', '-c', 'lane');
      writeFileSync(join(repo, LV), view(laneBody));
      provGit(repo, 'commit', '-qam', 'lane-only edit');
      provGit(repo, 'switch', '-q', 'main');
    }
    return fn(repo, provGit(repo, 'rev-parse', 'main'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// What a lane whose tracked row is `trackedBody` gets for a live page carrying
// `publishedBody`, with main (the baseline) at its newest commit.
function check(repo, head, { tracked, published, branchBehindMain }) {
  const current = view(provGit(repo, 'show', `${head}:${LV}`).match(/<p>(.*)<\/p>/)[1]);
  return checkLiveView(register, view(published), {
    direction: 'extraOnly',
    baselineText: register,
    trackedLiveViewHtml: view(tracked),
    baselineLiveViewText: current,
    committedBodyMatch: makeCommittedBodyMatch(repo, LV, head, provRunner),
    branchBehindMain,
  });
}

test('#4105 real git: a body only an unmerged lane carried is drift — main-side history does not contain it', () => {
  withRepo(['v1 base'], 'v2 lane-only edit', (repo, head) => {
    assert.deepEqual(check(repo, head, { tracked: 'v1 base', published: 'v2 lane-only edit' }), [DRIFT]);
  });
});

test('#4105 real git: a body main carried earlier is behind, with an advisory naming the commits since', () => {
  withRepo(['v1 old', 'v2 new'], undefined, (repo, head) => {
    const [advisory, ...rest] = check(repo, head, { tracked: 'v2 new', published: 'v1 old' });
    assert.deepEqual(rest, []);
    assert.match(advisory, new RegExp(`^${BEHIND_MAIN_ADVISORY_PREFIX}A1: live = main@[0-9a-f]{8}; changed since by ${head.slice(0, 8)} \\(#2\\)$`));
  });
});

test('#4105 real git: main went v1 -> v2 -> v1 while the page shows v2 — a revert (ABA), drift', () => {
  withRepo(['v1 no result', 'v2 RESULT RECORDED', 'v1 no result'], undefined, (repo, head) => {
    assert.deepEqual(check(repo, head, { tracked: 'v1 no result', published: 'v2 RESULT RECORDED' }), [DRIFT]);
  });
});

test('#4105 real git: a stale lane over an already-current page is told to merge main; one that merged main may revert on purpose', () => {
  withRepo(['v1 old', 'v2 new'], undefined, (repo, head) => {
    const behindNow = () => provRunner(['merge-base', '--is-ancestor', head, 'HEAD'], repo).status === 1;
    provGit(repo, 'switch', '-q', '-c', 'stale', 'HEAD~1');
    const stale = check(repo, head, { tracked: 'v1 old', published: 'v2 new', branchBehindMain: behindNow });
    assert.deepEqual(stale, [`${BRANCH_BEHIND_MAIN_ERROR_PREFIX}A1: branch behind origin/main for A1; merge it first`]);
    provGit(repo, 'merge', '-q', '--no-edit', 'main');
    // Merged, then (deliberately) put the older text back: allowed.
    assert.deepEqual(check(repo, head, { tracked: 'v1 old', published: 'v2 new', branchBehindMain: behindNow }), []);
  });
});

// ---------------------------------------------------------------------------
// The CLI against a real origin (no ONBOX_TEST_BASELINE_FILE override): proves
// the matcher is wired in (M3) and walks origin/main's first-parent line, not
// every ref (M4), and that the stale-lane check is wired to a real ancestry
// test.
// ---------------------------------------------------------------------------
function cliPage(repo, nonce, body) {
  mkdirSync(join(repo, 'docs', 'testing'), { recursive: true });
  const html = buildRowContentLiveView([{ id: 'B101', body, title: 'title B101' }, { id: 'B102', body: 'x', title: 'title B102' }], 'B').replace(
    '<title>',
    `<div hidden data-published-as="1" data-publish-id="${nonce}"></div>\n<title>`,
  );
  writeFileSync(join(repo, PROV_LIVE), html);
  writeFileSync(join(repo, PROV_REGISTER), buildSingleGroupRegister('B', [101, 102], 103));
  return html;
}
function cliCommitPage(repo, nonce, body) {
  const html = cliPage(repo, nonce, body);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', `Merge pull request #${Number(nonce.replace(/\D/g, ''))} from x/y`);
  return html;
}

test('#4105 CLI: a page behind origin/main passes with an advisory; a lane-only body and a stale lane are refused', () => {
  withCliRepo((repo, cli) => {
    const saved = (name, html) => {
      writeFileSync(join(repo, name), html);
      return name;
    };
    const v1 = cliCommitPage(repo, 'main0001', 'row body v1');
    provGit(repo, 'push', '-q', 'origin', 'main');
    // An unmerged lane edits the row; its page is never on main.
    provGit(repo, 'switch', '-q', '-c', 'fix/server-lane');
    const laneHtml = cliCommitPage(repo, 'lane0001', 'row body LANE ONLY');
    provGit(repo, 'switch', '-q', 'main');
    const v2 = cliCommitPage(repo, 'main0002', 'row body v2');
    provGit(repo, 'push', '-q', 'origin', 'main');

    // main (tracked == origin/main = v2); live page still v1: behind, advisory.
    const behind = cli(['--against-published', saved('behind.saved.html', v1)]);
    assert.equal(behind.status, 0, `${behind.stdout}\n${behind.stderr}`);
    assert.match(behind.stderr, /B101: live = main@[0-9a-f]{8}; changed since by [0-9a-f]{8} \(#2\)/);

    // The live page carries the lane's unmerged body: no main commit has it.
    const laneOnly = cli(['--against-published', saved('lane.saved.html', laneHtml)]);
    assert.equal(laneOnly.status, 1, `${laneOnly.stdout}\n${laneOnly.stderr}`);
    assert.ok(laneOnly.stderr.includes('row-content-drift: B101'), laneOnly.stderr);

    // A lane still on v1 over a live page already on main's v2.
    provGit(repo, 'switch', '-q', '-c', 'fix/server-stale', 'HEAD~1');
    const stale = cli(['--against-published', saved('v2.saved.html', v2)]);
    assert.equal(stale.status, 1, `${stale.stdout}\n${stale.stderr}`);
    assert.ok(stale.stderr.includes('branch behind origin/main for B101; merge it first'), stale.stderr);
    provGit(repo, 'merge', '-q', '--no-edit', 'main');
    // (After merging main the tracked copy is v2 again: nothing to report.)
    const merged = cli(['--against-published', saved('v2.saved.html', v2)]);
    assert.equal(merged.status, 0, `${merged.stdout}\n${merged.stderr}`);
  });
});
