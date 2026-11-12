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
  parseLiveViewRowBodies,
  resolveBranchBase,
  stripHtmlComments,
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
  REAL_LIVE_VIEW_HTML,
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
function check(repo, head, { tracked, published }) {
  const current = view(provGit(repo, 'show', `${head}:${LV}`).match(/<p>(.*)<\/p>/)[1]);
  return checkLiveView(register, view(published), {
    direction: 'extraOnly',
    baselineText: register,
    trackedLiveViewHtml: view(tracked),
    baselineLiveViewText: current,
    committedBodyMatch: makeCommittedBodyMatch(repo, LV, head, provRunner),
    branchBase: resolveBranchBase(repo, LV, head, provRunner),
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
    provGit(repo, 'switch', '-q', '-c', 'stale', 'HEAD~1');
    const base = provGit(repo, 'rev-parse', 'HEAD').slice(0, 8);
    const stale = check(repo, head, { tracked: 'v1 old', published: 'v2 new' });
    assert.deepEqual(stale, [
      `${BRANCH_BEHIND_MAIN_ERROR_PREFIX}A1: branch behind origin/main for A1; merge it first (main changed A1 since this branch's base ${base})`,
    ]);
    provGit(repo, 'merge', '-q', '--no-edit', 'main');
    // Merged, then (deliberately) put the older text back: allowed.
    assert.deepEqual(check(repo, head, { tracked: 'v1 old', published: 'v2 new' }), []);
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

// ===========================================================================
// PR #4106 review pass 2.
// ===========================================================================

function breakBody(html, id) {
  const i = html.indexOf(`<span class="num">${id}</span>`);
  const j = html.indexOf('<div class="body">', i);
  return html.slice(0, j) + '<div class="body wide">' + html.slice(j + '<div class="body">'.length);
}

// --- 🟠1: "this branch is behind main" is decided from the MERGE BASE ------

const cliSaved = (repo, name, html) => {
  writeFileSync(join(repo, name), html);
  return name;
};
const refused = (res) => res.status === 1 && res.stderr.includes('branch behind origin/main for B101; merge it first');

test('#4105 pass 2 P7 CLI: main went v1 -> v2 -> v1; a lane cut at v2 over the current (v1) page is refused', () => {
  withCliRepo((repo, cli) => {
    cliCommitPage(repo, 'main0001', 'row body v1');
    cliCommitPage(repo, 'main0002', 'row body v2');
    const v1again = cliCommitPage(repo, 'main0003', 'row body v1');
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-stale', 'HEAD~1');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', v1again)]);
    assert.ok(refused(res), `${res.stdout}\n${res.stderr}`);
  });
});

test('#4105 pass 2 P8 CLI: main v1 -> v2 -> v3, page at v2; a lane cut at v1 is refused, not just warned', () => {
  withCliRepo((repo, cli) => {
    cliCommitPage(repo, 'main0001', 'row body v1');
    const v2 = cliCommitPage(repo, 'main0002', 'row body v2');
    cliCommitPage(repo, 'main0003', 'row body v3');
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-stale', 'HEAD~2');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', v2)]);
    assert.ok(refused(res), `${res.stdout}\n${res.stderr}`);
  });
});

test('#4105 pass 2 S5 CLI: an unreadable OLDER version of an unrelated row does not switch the stale-lane check off', () => {
  withCliRepo((repo, cli) => {
    // B102's body div has an extra class in the oldest commit only.
    const first = cliPage(repo, 'main0001', 'row body v0');
    writeFileSync(join(repo, PROV_LIVE), breakBody(first, 'B102'));
    provGit(repo, 'add', '-A');
    provGit(repo, 'commit', '-qm', 'Merge pull request #1 from x/y');
    cliCommitPage(repo, 'main0002', 'row body v1');
    const v2 = cliCommitPage(repo, 'main0003', 'row body v2');
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-stale', 'HEAD~1');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', v2)]);
    assert.ok(refused(res), `${res.stdout}\n${res.stderr}`);
  });
});

test('#4105 pass 2 CLI: a lane that merged main is never refused, even though main changed the row after its first base', () => {
  withCliRepo((repo, cli) => {
    cliCommitPage(repo, 'main0001', 'row body v1');
    const v2 = cliCommitPage(repo, 'main0002', 'row body v2');
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-merged', 'HEAD~1');
    provGit(repo, 'merge', '-q', '--no-edit', 'main');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', v2)]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  });
});

// Function level: the shape of the decision, with a stubbed base.
const BASE_REG = buildSingleGroupRegister('A', [1]);
function baseCheck({ tracked, published, baseline, branchBase }) {
  return checkLiveView(BASE_REG, view(published), {
    direction: 'extraOnly',
    baselineText: BASE_REG,
    trackedLiveViewHtml: view(tracked),
    baselineLiveViewText: view(baseline),
    branchBase,
  });
}
const baseAt = (body, mergeBase = 'mb111111aaaa') => ({
  mergeBase,
  bodies: parseLiveViewRowBodies(view(body)).bodies,
  unknown: () => false,
});
const BEHIND_ERR = (why) =>
  `${BRANCH_BEHIND_MAIN_ERROR_PREFIX}A1: branch behind origin/main for A1; merge it first (${why})`;

test('#4105 pass 2: main changed the row since the branch base and the tracked copy is not main\'s — refused, whatever the page carries', () => {
  const why = 'main changed A1 since this branch\'s base mb111111';
  for (const published of ['v2', 'v3', 'something else']) {
    assert.deepEqual(baseCheck({ tracked: 'v1', published, baseline: 'v2', branchBase: baseAt('v1') }), [BEHIND_ERR(why)], published);
  }
});

test('#4105 pass 2: a row main did not change since the base, a tracked copy equal to main\'s, or a branch that is not behind is never refused', () => {
  const isBehind = (errors) => errors.filter((e) => e.startsWith(BRANCH_BEHIND_MAIN_ERROR_PREFIX));
  // The lane edited A1; main still has the base text.
  assert.deepEqual(isBehind(baseCheck({ tracked: 'lane edit', published: 'v1', baseline: 'v1', branchBase: baseAt('v1') })), []);
  // The tracked copy IS main's current body.
  assert.deepEqual(isBehind(baseCheck({ tracked: 'v2', published: 'v1', baseline: 'v2', branchBase: baseAt('v1') })), []);
  // Branch not behind (undefined): no claim.
  assert.deepEqual(isBehind(baseCheck({ tracked: 'v1', published: 'v2', baseline: 'v2', branchBase: undefined })), []);
});

test('#4105 pass 2: a merge base that cannot be established, or whose row cannot be read, fails closed and says why', () => {
  assert.deepEqual(
    baseCheck({ tracked: 'v1', published: 'v2', baseline: 'v2', branchBase: { failed: 'git merge-base failed' } }),
    [
      `${BRANCH_BEHIND_MAIN_ERROR_PREFIX}A1: branch behind origin/main for A1; fetch full history first (the clone may be shallow or not share history with origin/main) (could not establish where this branch diverged from origin/main: git merge-base failed)`,
    ],
  );
  const unreadable = { ...baseAt('v1'), unknown: () => true };
  assert.deepEqual(
    baseCheck({ tracked: 'v1', published: 'v2', baseline: 'v2', branchBase: unreadable }),
    [BEHIND_ERR('A1 cannot be read from the live view at the merge base mb111111')],
  );
});

const TWO_REG = buildSingleGroupRegister('A', [1, 2]);
function twoRowView(a1, { breakA2 = false } = {}) {
  const html = buildRowContentLiveView([{ id: 'A1', body: a1 }, { id: 'A2', body: 'other' }]);
  return breakA2 ? breakBody(html, 'A2') : html;
}
// `html: null` deletes the file in that commit.
function withViews(commits, fn) {
  const repo = mkdtempSync(join(tmpdir(), 'onbox-behind2-'));
  try {
    provGit(repo, 'init', '-q', '-b', 'main');
    provGit(repo, 'config', 'user.email', 'test@example.com');
    provGit(repo, 'config', 'user.name', 'Test');
    provGit(repo, 'config', 'commit.gpgsign', 'false');
    commits.forEach((c, i) => {
      if (c.html === null) {
        provGit(repo, 'rm', '-q', LV);
      } else {
        writeFileSync(join(repo, LV), c.html);
        provGit(repo, 'add', LV);
      }
      provGit(repo, 'commit', '-qm', c.message ?? `Merge pull request #${i + 1} from x/y`);
    });
    return fn(repo, provGit(repo, 'rev-parse', 'main'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test('#4105 pass 2 P10: one unparseable version of an UNRELATED row keeps the stale-lane check on (it failed open)', () => {
  withViews(
    [{ html: twoRowView('v0', { breakA2: true }) }, { html: twoRowView('v1') }, { html: twoRowView('v2') }],
    (repo, head) => {
      provGit(repo, 'switch', '-q', '-c', 'stale', 'HEAD~1');
      const branchBase = resolveBranchBase(repo, LV, head, provRunner);
      const errors = checkLiveView(TWO_REG, twoRowView('v2'), {
        direction: 'extraOnly',
        baselineText: TWO_REG,
        trackedLiveViewHtml: twoRowView('v1'),
        baselineLiveViewText: twoRowView('v2'),
        branchBase,
      });
      assert.equal(errors.filter((e) => e.startsWith(BRANCH_BEHIND_MAIN_ERROR_PREFIX)).length, 1, JSON.stringify(errors));
    },
  );
});

test('#4105 pass 3: resolveBranchBase answers undefined for a branch that contains main; any git answer other than 0 or 1 fails closed', () => {
  withViews([{ html: twoRowView('v1') }, { html: twoRowView('v2') }], (repo, head) => {
    assert.equal(resolveBranchBase(repo, LV, head, provRunner), undefined);
    for (const answer of [{ status: 128, stdout: '', stderr: 'fatal' }, { status: null, error: new Error('ETIMEDOUT') }, { status: null }]) {
      // Only the ancestry question gets the bad answer; the merge base itself is readable.
      const got = resolveBranchBase(repo, LV, head, (args, cwd) => (args.includes('--is-ancestor') ? answer : provRunner(args, cwd)));
      assert.equal(typeof got?.failed, 'string', JSON.stringify(answer));
    }
  });
});

// --- 🟠2: unknowns are tracked PER ROW ------------------------------------

function rowCheck({ repo, head, published, current = 'v2' }) {
  return checkLiveView(TWO_REG, twoRowView(published), {
    direction: 'extraOnly',
    baselineText: TWO_REG,
    trackedLiveViewHtml: twoRowView(current),
    baselineLiveViewText: twoRowView(current),
    committedBodyMatch: makeCommittedBodyMatch(repo, LV, head, provRunner),
  });
}
const DRIFT_A1 = `${ROW_CONTENT_DRIFT_ERROR_PREFIX}A1: content differs between local and published`;

test('#4105 pass 2: an UNRELATED row unreadable at an older version leaves the exemption on — an advisory, not drift', () => {
  withViews(
    [{ html: twoRowView('v0', { breakA2: true }) }, { html: twoRowView('v1') }, { html: twoRowView('v2') }],
    (repo, head) => {
      const errors = rowCheck({ repo, head, published: 'v1' });
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.ok(errors[0].startsWith(BEHIND_MAIN_ADVISORY_PREFIX), errors[0]);
    },
  );
});

test('#4105 pass 2: the row ITSELF unreadable somewhere in the window withholds the exemption and names the commit', () => {
  withViews(
    [{ html: breakBody(twoRowView('v0'), 'A1') }, { html: twoRowView('v1') }, { html: twoRowView('v2') }],
    (repo, head) => {
      const first = provGit(repo, 'rev-list', '--max-parents=0', 'main');
      const errors = rowCheck({ repo, head, published: 'v1' });
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.ok(errors[0].startsWith(DRIFT_A1), errors[0]);
      assert.ok(errors[0].includes(first.slice(0, 8)), errors[0]);
      assert.match(errors[0], /could not be read/);
      assert.doesNotMatch(errors[0], /hand-edit/);
    },
  );
});

test('#4105 pass 2: an error that names no row makes only the rows missing from that version unknown', () => {
  // A block with no <span class="num"> hides whichever row it was; A1 parses fine, so A1 is known there.
  const noNum = (html) => html + '\n<details class="item">\n<summary>no id</summary>\n</details>\n';
  withViews([{ html: noNum(twoRowView('v0')) }, { html: twoRowView('v1') }, { html: twoRowView('v2') }], (repo, head) => {
    const errors = rowCheck({ repo, head, published: 'v1' });
    assert.ok(errors[0].startsWith(BEHIND_MAIN_ADVISORY_PREFIX), JSON.stringify(errors));
  });
});

test('#4105 pass 2: a commit that deleted the live view means "row absent", not "unreadable"', () => {
  withViews(
    [{ html: twoRowView('v0') }, { html: null }, { html: twoRowView('v1') }, { html: twoRowView('v2') }],
    (repo, head) => {
      const errors = rowCheck({ repo, head, published: 'v1' });
      assert.equal(errors.length, 1, JSON.stringify(errors));
      assert.ok(errors[0].startsWith(BEHIND_MAIN_ADVISORY_PREFIX), errors[0]);
    },
  );
});

test('#4105 pass 2 CI: the no-flag check rejects a live view whose row markup the drift check cannot read', () => {
  withCliRepo((repo, cli) => {
    const good = cliPage(repo, 'main0001', 'row body v1');
    assert.equal(cli([]).status, 0, 'a well-formed live view passes');
    writeFileSync(join(repo, PROV_LIVE), breakBody(good, 'B102'));
    const res = cli([]);
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stderr, /B102: could not extract body content/);
  });
});

test('#4105 pass 2 CI: the tracked live view in this repository passes the same row-markup check', () => {
  assert.deepEqual(parseLiveViewRowBodies(stripHtmlComments(REAL_LIVE_VIEW_HTML)).errors, []);
});

// --- 🟡3: mutation-killers on the history walk ------------------------------

test('#4105 pass 2 (M2): two commits carry the live body — the NEWEST is named, and the commits after it are the "changed since"', () => {
  // oldest first: P, X, P, C  (no ABA: C was never the body before)
  withViews(
    [{ html: twoRowView('P') }, { html: twoRowView('X') }, { html: twoRowView('P') }, { html: twoRowView('C') }],
    (repo, head) => {
      const newestP = provGit(repo, 'rev-parse', 'main~1');
      const [advisory] = rowCheck({ repo, head, published: 'P', current: 'C' });
      assert.equal(advisory, `${BEHIND_MAIN_ADVISORY_PREFIX}A1: live = main@${newestP.slice(0, 8)}; changed since by ${head.slice(0, 8)} (#4)`);
    },
  );
});

test('#4105 pass 2 (M2): P, C, P, C — main went back to C after P, so the page at P is a revert, drift', () => {
  withViews(
    [{ html: twoRowView('P') }, { html: twoRowView('C') }, { html: twoRowView('P') }, { html: twoRowView('C') }],
    (repo, head) => {
      assert.deepEqual(rowCheck({ repo, head, published: 'P', current: 'C' }), [DRIFT_A1]);
    },
  );
});

test('#4105 pass 2 (M7): a --no-ff merge — a body only the merged lane\'s own commit carried is drift; the merge result is behind', () => {
  const repo = mkdtempSync(join(tmpdir(), 'onbox-behind3-'));
  try {
    provGit(repo, 'init', '-q', '-b', 'main');
    provGit(repo, 'config', 'user.email', 'test@example.com');
    provGit(repo, 'config', 'user.name', 'Test');
    provGit(repo, 'config', 'commit.gpgsign', 'false');
    const put = (body, msg) => {
      writeFileSync(join(repo, LV), twoRowView(body));
      provGit(repo, 'add', LV);
      provGit(repo, 'commit', '-qm', msg);
    };
    put('v1', 'Merge pull request #1 from x/y');
    provGit(repo, 'switch', '-q', '-c', 'lane');
    put('LANE DRAFT', 'lane-internal commit');
    put('LANE FINAL', 'lane-internal commit 2');
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'merge', '-q', '--no-ff', '--no-commit', 'lane');
    writeFileSync(join(repo, LV), twoRowView('MERGE RESULT'));
    provGit(repo, 'add', LV);
    provGit(repo, 'commit', '-qm', 'Merge pull request #2 from x/lane');
    put('v4', 'Merge pull request #3 from x/z');
    const head = provGit(repo, 'rev-parse', 'main');
    assert.deepEqual(rowCheck({ repo, head, published: 'LANE DRAFT', current: 'v4' }), [DRIFT_A1]);
    const [advisory] = rowCheck({ repo, head, published: 'MERGE RESULT', current: 'v4' });
    assert.ok(advisory.startsWith(BEHIND_MAIN_ADVISORY_PREFIX), advisory);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('#4105 pass 2 (M8) CLI: run from a branch whose OWN history carries the live body — the walk uses origin/main, not HEAD', () => {
  withCliRepo((repo, cli) => {
    cliCommitPage(repo, 'main0001', 'row body v1');
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', '-c', 'fix/server-lane');
    const draft = cliCommitPage(repo, 'lane0001', 'row body LANE DRAFT');
    provGit(repo, 'switch', '-q', 'main');
    cliCommitPage(repo, 'main0002', 'row body v2');
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', 'fix/server-lane');
    provGit(repo, 'merge', '-q', '-X', 'theirs', '--no-edit', 'main');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', draft)]);
    assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}`);
    assert.ok(res.stderr.includes('row-content-drift: B101'), res.stderr);
    assert.ok(!res.stderr.includes('live = main@'), res.stderr);
  });
});

// ===========================================================================
// PR #4106 review pass 3.
// ===========================================================================

// A multi-row CLI page: rows = { 101: 'body', 102: 'x' }.
let pass3PrNumber = 0;
function rowsPage(repo, nonce, rows) {
  mkdirSync(join(repo, 'docs', 'testing'), { recursive: true });
  const nums = Object.keys(rows).map(Number).sort((a, b) => a - b);
  const html = buildRowContentLiveView(nums.map((k) => ({ id: `B${k}`, body: rows[k], title: `title B${k}` })), 'B').replace(
    '<title>',
    `<div hidden data-published-as="1" data-publish-id="${nonce}"></div>\n<title>`,
  );
  writeFileSync(join(repo, PROV_LIVE), html);
  writeFileSync(join(repo, PROV_REGISTER), buildSingleGroupRegister('B', nums, 110));
  return html;
}
function rowsCommit(repo, nonce, rows) {
  const html = rowsPage(repo, nonce, rows);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', `Merge pull request #${++pass3PrNumber} from x/y`);
  return html;
}
const refusedFor = (res, id, reason) =>
  res.status === 1 && res.stderr.includes(`branch behind origin/main for ${id}; merge it first (${reason}`);

test('#4105 pass 3 N4 CLI: main discharged (removed) a row and published; a lane cut earlier that still carries it is refused', () => {
  withCliRepo((repo, cli) => {
    rowsCommit(repo, 'm0001', { 101: 'v1', 102: 'x', 103: 'owed row' });
    provGit(repo, 'switch', '-q', '-c', 'fix/server-lane');
    rowsCommit(repo, 'l0001', { 101: 'LANE', 102: 'x', 103: 'owed row' });
    provGit(repo, 'switch', '-q', 'main');
    const discharged = rowsCommit(repo, 'm0002', { 101: 'v1', 102: 'x' });
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', 'fix/server-lane');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', discharged)]);
    assert.ok(refusedFor(res, 'B103', "main removed B103 since this branch's base"), `${res.stdout}\n${res.stderr}`);
  });
});

test('#4105 pass 3 N4b CLI: same removal, the lane only edited another row — the removed row is still refused', () => {
  withCliRepo((repo, cli) => {
    rowsCommit(repo, 'm0001', { 101: 'v1', 102: 'x', 103: 'owed row' });
    provGit(repo, 'switch', '-q', '-c', 'fix/server-lane');
    rowsCommit(repo, 'l0001', { 101: 'v1', 102: 'LANE', 103: 'owed row' });
    provGit(repo, 'switch', '-q', 'main');
    const discharged = rowsCommit(repo, 'm0002', { 101: 'v1', 102: 'x' });
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', 'fix/server-lane');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', discharged)]);
    assert.ok(refusedFor(res, 'B103', "main removed B103 since this branch's base"), `${res.stdout}\n${res.stderr}`);
  });
});

test('#4105 pass 3 CLI: a row only the lane added (absent at the base, absent on main) is never refused', () => {
  withCliRepo((repo, cli) => {
    rowsCommit(repo, 'm0001', { 101: 'v1', 102: 'x' });
    provGit(repo, 'switch', '-q', '-c', 'fix/server-lane');
    rowsCommit(repo, 'l0001', { 101: 'v1', 102: 'x', 104: 'lane new row' });
    provGit(repo, 'switch', '-q', 'main');
    const v2 = rowsCommit(repo, 'm0002', { 101: 'v2', 102: 'x' });
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', 'fix/server-lane');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', v2)]);
    assert.ok(!res.stderr.includes('branch behind origin/main for B104'), `${res.stdout}\n${res.stderr}`);
  });
});

test('#4105 pass 3 CP CLI: a row main added after the base (the lane cherry-picked an earlier version of it) and then changed is refused', () => {
  withCliRepo((repo, cli) => {
    rowsCommit(repo, 'm0001', { 101: 'v1', 102: 'x' });
    provGit(repo, 'switch', '-q', '-c', 'fix/server-k');
    rowsCommit(repo, 'k0001', { 101: 'v1', 102: 'x', 105: 'K1' });
    const k1 = provGit(repo, 'rev-parse', 'HEAD').trim();
    provGit(repo, 'switch', '-q', '-c', 'fix/server-lane', 'main');
    provGit(repo, 'cherry-pick', k1);
    provGit(repo, 'switch', '-q', 'fix/server-k');
    rowsCommit(repo, 'k0002', { 101: 'v1', 102: 'x', 105: 'K2' });
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'merge', '-q', '--no-ff', '--no-edit', 'fix/server-k');
    const live = rowsCommit(repo, 'm0003', { 101: 'v1', 102: 'x', 105: 'K2' });
    provGit(repo, 'push', '-q', 'origin', 'main');
    provGit(repo, 'switch', '-q', 'fix/server-lane');
    const res = cli(['--against-published', cliSaved(repo, 'live.saved.html', live)]);
    assert.ok(refusedFor(res, 'B105', "main changed B105 since this branch's base"), `${res.stdout}\n${res.stderr}`);
  });
});

test('#4105 pass 3 Q10: v1 -> v3 -> v2 -> v1 with the live page at v2 — main went back to v1 after v2, so the page is not merely behind', () => {
  // Oldest first. v2 matches the page; v1 (main's body now) occurs AFTER it,
  // two versions on, beyond a one-version look-ahead.
  withViews(
    [{ html: twoRowView('v1') }, { html: twoRowView('v3') }, { html: twoRowView('v2') }, { html: twoRowView('v1') }],
    (repo, head) => {
      assert.deepEqual(rowCheck({ repo, head, published: 'v2', current: 'v1' }), [DRIFT_A1]);
    },
  );
});

test('#4105 pass 3 Q8: a shallow clone with no merge base fails closed, and the advice fits a shallow clone', () => {
  const root = mkdtempSync(join(tmpdir(), 'onbox-shallow-'));
  try {
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const clone = join(root, 'clone');
    provGit(root, 'init', '-q', '--bare', '-b', 'main', origin);
    mkdirSync(seed);
    provGit(seed, 'init', '-q', '-b', 'main');
    provGit(seed, 'config', 'user.email', 'test@example.com');
    provGit(seed, 'config', 'user.name', 'Test');
    provGit(seed, 'config', 'commit.gpgsign', 'false');
    provGit(seed, 'remote', 'add', 'origin', origin);
    for (const [i, body] of ['v1', 'v2', 'v3'].entries()) {
      writeFileSync(join(seed, LV), view(body));
      provGit(seed, 'add', LV);
      provGit(seed, 'commit', '-qm', `Merge pull request #${i + 1} from x/y`);
    }
    provGit(seed, 'push', '-q', 'origin', 'main');
    // A depth-1 clone holds only v3; origin then moves on and a depth-1 fetch
    // brings a tip whose parent this clone does not have: no merge base.
    provGit(root, 'clone', '-q', '--depth', '1', `file://${origin.replace(/\\/g, '/')}`, clone);
    writeFileSync(join(seed, LV), view('v4'));
    provGit(seed, 'add', LV);
    provGit(seed, 'commit', '-qm', 'Merge pull request #4 from x/y');
    provGit(seed, 'push', '-q', 'origin', 'main');
    provGit(clone, 'fetch', '-q', '--depth', '1', 'origin', 'main');
    const tip = provGit(clone, 'rev-parse', 'FETCH_HEAD').trim();
    const got = resolveBranchBase(clone, LV, tip, provRunner);
    assert.equal(typeof got?.failed, 'string', JSON.stringify(got));
    const errors = baseCheck({ tracked: 'v1', published: 'v2', baseline: 'v2', branchBase: got });
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /fetch full history first \(the clone may be shallow/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
