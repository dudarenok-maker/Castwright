// #3529 / #3587 on-box register checker: real-CLI wiring cases (union files,
// pass 5 paging, BLK/UNC carry).
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkRegister, checkLiveView, ROW_ID_COLLISION_ERROR_PREFIX, UNMERGED_LANE_ROW_ERROR_PREFIX, UNKNOWN_PROVENANCE_ERROR_PREFIX, PUBLISHING_FILE_ERROR_PREFIX, DISCHARGE_NAME_ERROR_PREFIX } from '../check-onbox-register.mjs';
import * as onbox from '../check-onbox-register.mjs';
import {
  buildRowContentLiveView,
  REAL_LIVE_VIEW_HTML,
  REAL_REGISTER_TEXT,
  withHermeticBaseline,
  runCli,
  computeMaxRowNumber,
  renameLiveViewRowId,
  MAIN_B,
  MINE_TITLE,
  THEIRS_TITLE,
  UNMERGED,
  merged,
  own,
  baseRows,
  ofPrefix,
  PROV_LIVE,
  PROV_REGISTER,
  provEnv,
  provGit,
  uView,
  withUnionRepo,
  uCheck,
  realErrors,
  withRetired,
  OWNER_X,
  closedStates,
  p4Commit,
  p4Retire,
  fakeGh,
  theirsB103,
  withCliRepo,
  cliCommit,
} from './check-onbox-register-test-support.mjs';

// `count` p4Other-shaped commits (each rewrites other.txt) in ONE
// `git fast-import` instead of three git spawns apiece (#3701: 100 commits was
// ~300 spawns, the bulk of the #3529 pass 5 tests' 30-50 s on Windows).
// Returns their oids oldest first, with the work tree synced to the new tip.
function p4OtherMany(repo, count, dateOf, msgOf) {
  const ref = provGit(repo, 'symbolic-ref', 'HEAD');
  const base = provGit(repo, 'rev-parse', 'HEAD');
  let stream = '';
  for (let i = 0; i < count; i++) {
    const msg = msgOf(i);
    const when = `${Date.parse(dateOf(i)) / 1000} +0000`;
    stream += `commit ${ref}\ncommitter Test <test@example.com> ${when}\ndata ${Buffer.byteLength(msg)}\n${msg}\n`;
    if (i === 0) stream += `from ${base}\n`;
    stream += `M 100644 inline other.txt\ndata ${Buffer.byteLength(msg)}\n${msg}\n\n`;
  }
  const r = spawnSync('git', ['fast-import', '--quiet'], { cwd: repo, input: stream, env: provEnv(), windowsHide: true, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  provGit(repo, 'reset', '-q', '--hard', ref);
  return provGit(repo, 'rev-list', '--reverse', `${base}..HEAD`).split('\n');
}

test('#3529 pass 2 CLI: a hand-built union with stale figures is refused under --publishing', () => {
  const lastB = computeMaxRowNumber(REAL_REGISTER_TEXT, 'B');
  const { mutated } = renameLiveViewRowId(REAL_LIVE_VIEW_HTML, 'B', lastB, lastB + 1);
  const blockOf = (html, id) =>
    html.match(new RegExp(`<details\\b[^>]*class="item"[^>]*>\\s*<summary><span class="num">${id}</span>[\\s\\S]*?</details>`))[0];
  const mine = blockOf(REAL_LIVE_VIEW_HTML, `B${lastB}`);
  // Rows right, figures not regenerated — the 2026-10-07 hand-edit shape, minus the edit.
  const stale = REAL_LIVE_VIEW_HTML.replace(mine, `${mine}\n    ${blockOf(mutated, `B${lastB + 1}`)}`);
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const unionPath = join(dirname(publishedPath), 'union.html');
    writeFileSync(unionPath, stale, 'utf8');
    const r = runCli(['--against-published', publishedPath, '--publishing', unionPath], {
      ONBOX_TEST_BASELINE_FILE: baselinePath,
      ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged',
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /publishing-file: .*--build-union/);
  });
});


// Review pass 3 (operator decision 4, 🟡5 R4): the retirement check, end to
// end through real git (the owner lookup) and the ONBOX_TEST_GH_PR_STATES
// seam (gh). The seam answers only the PRs the run asks about, so an entry
// the CLI forgot to look up — one only origin/main's register records —
// reads as unresolvable rather than silently passing.
test('#3529 pass 4 CLI: a retirement is honoured only for the closed PR whose commits introduced the live row, including one only origin/main records', () => {
  withCliRepo((repo, cli) => {
    cliCommit(repo, 'main0001', [101, 102], 103);
    provGit(repo, 'push', '-q', 'origin', 'main');
    // fix/server-x, never merged, mints B103 and publishes the page.
    provGit(repo, 'switch', '-q', '-c', 'fix/server-x');
    cliCommit(repo, 'xxxx0001', [101, 102, 103], 104, { 103: 'X row' });
    const xCommit = provGit(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'page.saved.html'), readFileSync(join(repo, PROV_LIVE), 'utf8'));
    // old forks main before the retirement lands there.
    provGit(repo, 'switch', '-q', 'main');
    provGit(repo, 'switch', '-q', '-c', 'old');
    provGit(repo, 'switch', '-q', 'main');
    cliCommit(repo, 'main0002', [101, 102], 103, {}, '| B103 | #77 | 2026-10-08 | fix/server-x closed unmerged |\n');
    provGit(repo, 'push', '-q', 'origin', 'main');
    const other = provGit(repo, 'rev-parse', 'main');
    const states = (state, commits) => JSON.stringify({ 77: { state, commits } });
    const run = (branch, ghStates) => {
      provGit(repo, 'switch', '-q', branch);
      return cli(['--against-published', 'page.saved.html'], { ONBOX_TEST_GH_PR_STATES: ghStates });
    };
    for (const branch of ['main', 'old']) {
      const owned = run(branch, states('CLOSED', [xCommit]));
      assert.equal(owned.status, 0, `${branch}: stdout: ${owned.stdout}\nstderr: ${owned.stderr}`);
      assert.match(owned.stderr, /WARNING: gh PR states injected from ONBOX_TEST_GH_PR_STATES/);
    }
    const wrongPr = run('old', states('CLOSED', [other]));
    assert.equal(wrongPr.status, 1, wrongPr.stderr);
    assert.match(wrongPr.stderr, new RegExp(`retired-carried-row: B103: .*#77.*${xCommit}`));
    assert.ok(wrongPr.stderr.includes('unmerged-lane-row: B103:'), wrongPr.stderr);
    assert.ok(!/BEHIND what is already live/.test(wrongPr.stderr), wrongPr.stderr);
    const open = run('old', states('OPEN', [xCommit]));
    assert.equal(open.status, 1, open.stderr);
    assert.match(open.stderr, /retired-carried-row: B103: .*#77.*OPEN/);
    const unavailable = run('old', 'unavailable');
    assert.equal(unavailable.status, 0, unavailable.stderr);
    assert.match(unavailable.stderr, /retired-row-warning: B103 .*#77/);
    // The owner's branch gone from this checkout: its commit is still #77's
    // own, so no fetch is needed (review pass 4, P4d).
    provGit(repo, 'branch', '-q', '-D', 'fix/server-x');
    const branchless = run('old', states('CLOSED', [xCommit]));
    assert.equal(branchless.status, 0, branchless.stderr);
    // A commit this checkout lacks: fail closed, naming a plain fetch.
    const absent = run('old', states('CLOSED', ['5555555555555555555555555555555555555555']));
    assert.equal(absent.status, 1, absent.stderr);
    assert.match(absent.stderr, /retired-carried-row: B103: .*#77.*run git fetch origin and re-run/);
    assert.ok(!/pull[/]\d+[/]head/.test(absent.stderr), absent.stderr);
  });
});


// #3529 pass 5 (🟠): a lane whose row lands after its 100th commit. Real
// `gh pr view --json commits` reports only the first 100, so the owner's commit
// was never in the list and the retirement was refused forever, with a
// "names the wrong PR" diagnosis that pointed back at the same PR. The gh
// stand-in (fakeGh) keeps that cap on `pr view` and serves the full list only
// through paginated GraphQL.
function p5BigLane(repo) {
  provGit(repo, 'switch', '-q', '-c', 'fix/server-big');
  const oids = p4OtherMany(repo, 100, (i) => `2030-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, (i) => `work ${i}`);
  oids.push(p4Commit(repo, '2030-01-01T02:00:00Z', 'bbbb0001', [101, 102, 103], 104, 'big lane adds B103 late', { 103: 'X row' }));
  const page = uView('bbbb0001', [101, 102, 103], { 103: 'X row' });
  provGit(repo, 'switch', '-q', 'main');
  provGit(repo, 'switch', '-q', '-c', 'fix/server-q');
  writeFileSync(join(repo, PROV_REGISTER), p4Retire(9030, [101, 102], 104));
  return { oids, page };
}


test('#3529 pass 5: a closed PR whose row lands after its 100th commit is retired once the list is complete', () => {
  withUnionRepo((repo) => {
    const { oids, page } = p5BigLane(repo);
    assert.equal(oids.length, 101);
    const states = onbox.resolveRetiredPrStates(repo, [9030], fakeGh({ 9030: { state: 'CLOSED', commits: oids } }));
    assert.equal(states.states.get(9030).commits.length, 101);
    assert.deepEqual(realErrors(uCheck(repo, 'fix/server-q', page, { retiredPrStates: states })), []);
  });
});


test('#3529 pass 5: an incomplete commit list fails closed and says so, not "names the wrong PR"', () => {
  withUnionRepo((repo) => {
    const { oids, page } = p5BigLane(repo);
    const states = onbox.resolveRetiredPrStates(repo, [9030], fakeGh({ 9030: { state: 'CLOSED', commits: oids.slice(0, 100), totalCount: 101 } }));
    const retired = ofPrefix(realErrors(uCheck(repo, 'fix/server-q', page, { retiredPrStates: states })), onbox.RETIRED_ROW_ERROR_PREFIX);
    assert.equal(retired.length, 1, JSON.stringify(retired));
    assert.match(retired[0], /#9030/);
    assert.match(retired[0], /incomplete|only 100 of 101/i);
    assert.ok(!/names the wrong PR/.test(retired[0]), retired[0]);
    assert.match(retired[0], /must still be carried/);
  });
});


// ---------------------------------------------------------------------------
// #3587: --against-published classifies Blocked/Unconfirmed rows by ID, with
// the same verdicts a lettered row gets. Fixtures reuse the #3529 harness
// (`merged`/`own`/`UNMERGED`, `withRetired`) with a Blocked or Unconfirmed
// section appended to the Group B register and live view.
// ---------------------------------------------------------------------------
const TITLED_CASES = [
  {
    prefix: 'BLK',
    heading: '## Blocked — hardware not available',
    row: (n, title) => `### BLK${n} · ${title}\n\nText.\n`,
    sectionAttrs: 'class="group is-blocked" id="blocked"',
    label: 'Blocked',
  },
  {
    prefix: 'UNC',
    heading: '## Unconfirmed — not debts until substantiated',
    row: (n, title) => `- **UNC${n} · ${title}** (z)\n`,
    sectionAttrs: 'class="group is-soft" id="unconfirmed"',
    label: 'Unconfirmed',
  },
];


function titledRegister(tc, rows, nextId) {
  const body = rows.map(([n, title]) => tc.row(n, title)).join('\n');
  return `${MAIN_B()}\n${tc.heading}\n\n<!-- next-id: ${tc.prefix}${nextId} -->\n\n${body}`;
}


function titledLiveView(tc, rows) {
  const details = rows
    .map(
      ({ id, body, title }) => `    <details class="item">
      <summary><span class="num">${id}</span><span class="iname">${title ?? 't'}</span><span class="risk">default</span></summary>
      <div class="body">
        <p>${body}</p>
      </div>
    </details>`,
    )
    .join('\n');
  return `${buildRowContentLiveView(baseRows, 'B')}
  <section ${tc.sectionAttrs}>
    <h3 class="gtitle"><span class="gtag">${tc.prefix}</span> ${tc.label} <span class="gcount">${rows.length} rows</span></h3>
${details}
  </section>
`;
}


for (const tc of TITLED_CASES) {
  const P = tc.prefix;
  const id1 = `${P}101`;
  const id2 = `${P}102`;
  const reg = (rows = [[101, 'mine one']], next = 102) => titledRegister(tc, rows, next);
  const own1 = { id: id1, body: 'x', title: 'mine one' };
  const theirs2 = { id: id2, body: 'theirs', title: THEIRS_TITLE };
  const ownerOfId2 = (id) => (id === id2 ? OWNER_X : null);
  const run = ({ working, baseline, tracked, published, extra = {} }) =>
    checkLiveView(working ?? reg(), titledLiveView(tc, published ?? [own1, theirs2]), {
      direction: 'extraOnly',
      baselineText: baseline ?? reg(),
      trackedLiveViewHtml: titledLiveView(tc, tracked ?? [own1]),
      publishedProvenance: UNMERGED,
      ...extra,
    });

  test(`#3587 ${P} (a): a live-only ${id2} from an unmerged lane fails as unmerged-lane-row, in the ${tc.label} section's words`, () => {
    const errors = run({ extra: { rowOwnerLookup: ownerOfId2 } });
    const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
    assert.equal(unmerged.length, 1, JSON.stringify(errors));
    assert.match(unmerged[0], new RegExp(`^unmerged-lane-row: ${id2}:`));
    assert.ok(unmerged[0].includes(`${tc.label} section`), unmerged[0]);
    assert.ok(!/Group (BLK|UNC)/.test(unmerged[0]), unmerged[0]);
    assert.ok(unmerged[0].includes(OWNER_X.commit.slice(0, 12)), 'names the owner commit');
    assert.match(unmerged[0], /--publishing/);
  });

  test(`#3587 ${P} (b): the same row is silent on a merged or own publish, and unknown-provenance when the publish is untraceable`, () => {
    for (const provenance of [merged(['B101', 'B102', id1, id2]), own(['B101', 'B102', id1, id2])]) {
      assert.deepEqual(run({ extra: { publishedProvenance: provenance } }), [], provenance.kind);
    }
    const errors = run({
      extra: { publishedProvenance: { kind: 'unknown', nonce: 'ghost0x1', reason: 'not found in any git history' } },
    });
    const unknown = ofPrefix(errors, UNKNOWN_PROVENANCE_ERROR_PREFIX);
    assert.equal(unknown.length, 1, JSON.stringify(errors));
    assert.match(unknown[0], new RegExp(id2));
    assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 0);
  });

  test(`#3587 ${P} (b): a live-only row origin/main has ever carried is a discharge, whatever the provenance`, () => {
    assert.deepEqual(run({ extra: { mainEverCarried: (id) => id === id2 } }), []);
  });

  test(`#3587 ${P} (b): a row the --publishing file carries verbatim is not dropped`, () => {
    const errors = run({ extra: { publishingHtml: titledLiveView(tc, [own1, theirs2]) } });
    assert.equal(ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 0, JSON.stringify(errors));
  });

  test(`#3587 ${P} (c): the same ${id2} under a different title on the live page is a row-id-collision naming both titles`, () => {
    const errors = run({
      working: reg([[101, 'mine one'], [102, MINE_TITLE]], 103),
      tracked: [own1, { id: id2, body: 'mine', title: MINE_TITLE }],
      published: [own1, theirs2],
    });
    const collision = ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX);
    assert.equal(collision.length, 1, JSON.stringify(errors));
    assert.match(collision[0], new RegExp(`^row-id-collision: ${id2}:`));
    assert.ok(collision[0].includes(MINE_TITLE) && collision[0].includes(THEIRS_TITLE), collision[0]);
    // the register's next-id (103) and the live page's highest + 1 (103)
    assert.match(collision[0], new RegExp(`Renumber your row to ${P}103\\b`));
  });

  test(`#3587 ${P} (c): ${id2} on origin/main under a different title, with a merge-base lacking it, is the merged-lane collision`, () => {
    const mineRegister = reg([[101, 'mine one'], [102, 'Mine']], 103);
    const mainRegister = reg([[101, 'mine one'], [102, 'Theirs']], 104);
    const mainPage = titledLiveView(tc, [own1, { id: id2, body: 'theirs', title: 'Theirs' }]);
    const options = (mergeBaseText) => ({
      direction: 'extraOnly',
      baselineText: mainRegister,
      trackedLiveViewHtml: titledLiveView(tc, [own1, { id: id2, body: 'mine', title: 'Mine' }]),
      baselineLiveViewText: mainPage,
      publishedProvenance: merged(['B101', 'B102', id1, id2]),
      mergeBaseText,
    });
    const errors = checkLiveView(mineRegister, mainPage, options(reg()));
    const collision = ofPrefix(errors, ROW_ID_COLLISION_ERROR_PREFIX);
    assert.equal(collision.length, 1, JSON.stringify(errors));
    assert.match(collision[0], new RegExp(`^row-id-collision: ${id2}:`));
    // origin/main's next-id (104) clears the register's (103)
    assert.match(collision[0], new RegExp(`Renumber your row to ${P}104\\b`));
    // rebased onto main (the merge-base has it): main's own row, no collision
    const rebased = checkLiveView(mineRegister, mainPage, options(mainRegister));
    assert.equal(ofPrefix(rebased, ROW_ID_COLLISION_ERROR_PREFIX).length, 0, JSON.stringify(rebased));
  });

  test(`#3587 ${P} (d): --discharging ${id1} for a row the register dropped is consumed and silent; a name that is not live-only is refused`, () => {
    const dropped = reg([[102, 'later row']], 103);
    assert.deepEqual(
      run({ working: dropped, tracked: [], published: [own1], extra: { dischargingIds: [id1] } }),
      [],
    );
    // Without the name the register is BEHIND what is published.
    const unnamed = run({ working: dropped, tracked: [], published: [own1] });
    assert.equal(unnamed.length, 1, JSON.stringify(unnamed));
    assert.match(unnamed[0], new RegExp(`${tc.label} section has row ${id1}`));
    // Naming an ID the live page does not carry is the existing #2272 refusal.
    const notLive = run({ published: [own1], extra: { dischargingIds: [id2] } });
    assert.equal(ofPrefix(notLive, DISCHARGE_NAME_ERROR_PREFIX).length, 1, JSON.stringify(notLive));
  });

  test(`#3587 ${P} (e): a row in "Retired carried rows" (PR closed unmerged, owner confirmed) is not required to be carried`, () => {
    const retired = `| ${id2} | #3505 | 2026-10-07 | closed in favour of #3525 |\n`;
    const extra = { retiredPrStates: closedStates('CLOSED'), rowOwnerLookup: ownerOfId2 };
    assert.deepEqual(run({ working: withRetired(reg(), retired), extra }), []);
    const stillOwed = run({ extra });
    assert.equal(ofPrefix(stillOwed, UNMERGED_LANE_ROW_ERROR_PREFIX).length, 1, JSON.stringify(stillOwed));
  });

  test(`#3587 ${P}: a register with no ${P} row or marker still classifies the page's ${id2}`, () => {
    const errors = run({
      working: MAIN_B(),
      baseline: MAIN_B(),
      tracked: [],
      published: [theirs2],
      extra: { rowOwnerLookup: ownerOfId2 },
    });
    const unmerged = ofPrefix(errors, UNMERGED_LANE_ROW_ERROR_PREFIX);
    assert.equal(unmerged.length, 1, JSON.stringify(errors));
    assert.ok(unmerged[0].includes(`${tc.label} section`), unmerged[0]);
  });
}


test("#3587 (f): a live page with — rows and a ? Unconfirmed section against today's register shape has no new error", () => {
  const legacyRegister = `${MAIN_B()}
## Blocked — hardware not available

### Not numbered yet

Text.

## Unconfirmed — not debts until substantiated

- **fs-38** x
`;
  assert.deepEqual(checkRegister(legacyRegister), []);
  const live = `${buildRowContentLiveView(baseRows, 'B')}
  <section class="group is-blocked" id="blocked">
    <h3 class="gtitle"><span class="gtag">BLK</span> Blocked <span class="gcount">1 rows</span></h3>
    <details class="item"><summary><span class="num">—</span><span class="iname">t</span></summary></details>
  </section>
  <section class="group is-soft" id="unconfirmed">
    <h3 class="gtitle"><span class="gtag">?</span> Unconfirmed <span class="gcount">1 rows</span></h3>
    <details class="item"><summary><span class="num">—</span><span class="iname">t</span></summary></details>
  </section>
`;
  for (const direction of ['extraOnly', 'both']) {
    const errors = checkLiveView(legacyRegister, live, {
      direction,
      baselineText: legacyRegister,
      publishedProvenance: UNMERGED,
    });
    assert.deepEqual(errors, [], `${direction}: ${JSON.stringify(errors)}`);
  }
});


// ---------------------------------------------------------------------------
// #3587 child 5 (#3643): --build-union / --publishing carry BLK/UNC row blocks
// and raise their strip tiles and section gcounts — never the owed count.
// ---------------------------------------------------------------------------
function unionDetails(rows) {
  return rows
    .map(
      ({ id, body, title }) => `    <details class="item">
      <summary><span class="num">${id}</span><span class="iname">${title ?? 't'}</span><span class="risk">default</span></summary>
      <div class="body">
        <p>${body}</p>
      </div>
    </details>`,
    )
    .join('\n');
}

const plural = (n) => `${n} ${n === 1 ? 'row' : 'rows'}`;
// A page with a lettered group (E), a Blocked section and an Unconfirmed
// section, and a strip carrying the owed, Blocked and Unconfirmed tiles.
function blkUncUnionView({ eRows = [], blkRows = [], uncRows = [] }) {
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="stat"><div class="n owed">${10 + eRows.length}</div><div class="l">Owed</div></div>
    <div class="stat"><div class="n blk">${blkRows.length}</div><div class="l">Blocked</div></div>
    <div class="stat"><div class="n">${uncRows.length}</div><div class="l">Unconfirmed</div></div>
  </div>

  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#ge">E</a></td><td>Setup E</td><td>${eRows.length}</td></tr>
    </tbody>
  </table>

  <section class="group" id="ge">
    <h3 class="gtitle"><span class="gtag">E</span> Setup E <span class="gcount">${plural(eRows.length)}</span></h3>
${unionDetails(eRows)}
  </section>

  <section class="group is-blocked" id="blocked">
    <header>
      <h3 class="gtitle"><span class="gtag">BLK</span> Blocked <span class="gcount">${plural(blkRows.length)}</span></h3>
      <p class="setup">Blocked setup.</p>
    </header>
${unionDetails(blkRows)}
  </section>

  <section class="group is-soft" id="unconfirmed">
    <header>
      <h3 class="gtitle"><span class="gtag">UNC</span> Unconfirmed <span class="gcount">${plural(uncRows.length)}</span></h3>
      <p class="setup">Unconfirmed setup.</p>
    </header>
${unionDetails(uncRows)}
  </section>
`;
}

const uRow = (id) => ({ id, body: `body ${id}`, title: `title ${id}` });


for (const tc of TITLED_CASES) {
  const P = tc.prefix;
  const key = P === 'BLK' ? 'blkRows' : 'uncRows';
  const id1 = `${P}101`;
  const id2 = `${P}102`;
  const view = (ids, eRows = []) => blkUncUnionView({ eRows, [key]: ids.map(uRow) });
  const reg = (rows = [[101, 'mine one']], next = 102) => titledRegister(tc, rows, next);
  const mineRow = { id: id1, body: 'x', title: 'mine one' };
  const theirsRow = { id: id2, body: 'theirs', title: THEIRS_TITLE };
  const tiled = (rows) =>
    titledLiveView(tc, rows).replace(
      '<div class="l">Owed</div>',
      `<div class="l">Owed</div><div class="n${P === 'BLK' ? ' blk' : ''}">${rows.length}</div><div class="l">${tc.label}</div>`,
    );
  const checkPublishing = (publishingHtml) =>
    checkLiveView(reg(), tiled([mineRow, theirsRow]), {
      direction: 'extraOnly',
      baselineText: reg(),
      trackedLiveViewHtml: tiled([mineRow]),
      publishedProvenance: UNMERGED,
      rowOwnerLookup: (id) => (id === id2 ? OWNER_X : null),
      ...(publishingHtml === undefined ? {} : { publishingHtml }),
    });
  const stripTile = (html, label) => html.match(new RegExp(`<div class="n[^"]*">(\\d+)</div><div class="l">${label}</div>`))[1];

  test(`#3587 ${P} (a): a carried ${id2} lands after ${id1}, raises the ${tc.label} tile and gcount, and leaves owed alone`, () => {
    const union = onbox.buildUnionLiveView(view([id1]), view([id1, id2]), [id2]);
    assert.equal(union, view([id1, id2]));
    assert.ok(union.indexOf(`>${id1}<`) < union.indexOf(`>${id2}<`), 'block order');
    assert.equal(stripTile(union, tc.label), '2');
    assert.ok(union.includes('<span class="gcount">2 rows</span>'));
    assert.ok(union.includes('<div class="n owed">10</div>'), 'owed untouched');
    assert.ok(union.includes('<td>0</td>'), 'glance cell untouched');
  });

  test(`#3587 ${P} (a): the carried-row union passes --publishing, where the same run without it fails unmerged-lane-row`, () => {
    const unmerged = ofPrefix(checkPublishing(), UNMERGED_LANE_ROW_ERROR_PREFIX);
    assert.equal(unmerged.length, 1, JSON.stringify(unmerged));
    const union = onbox.buildUnionLiveView(tiled([mineRow]), tiled([mineRow, theirsRow]), [id2]);
    assert.deepEqual(checkPublishing(union), []);
  });

  test(`#3587 ${P} (d): a hand-built union with owed raised, or the ${tc.label} tile not raised, fails --publishing naming --build-union`, () => {
    const good = onbox.buildUnionLiveView(tiled([mineRow]), tiled([mineRow, theirsRow]), [id2]);
    assert.equal(stripTile(good, tc.label), '2');
    const owedRaised = good.replace('<div class="n owed">2</div>', '<div class="n owed">3</div>');
    const tileStale = good.replace(new RegExp(`(<div class="n[^"]*">)2(</div><div class="l">${tc.label}</div>)`), '$11$2');
    for (const bad of [owedRaised, tileStale]) {
      assert.notEqual(bad, good);
      const pub = ofPrefix(checkPublishing(bad), PUBLISHING_FILE_ERROR_PREFIX);
      assert.equal(pub.length, 1, JSON.stringify(pub));
      assert.match(pub[0], /--build-union/);
    }
  });

  test(`#3587 ${P} (f): a ${id2} absent from the live page, or already in the tracked view, is refused in the existing words`, () => {
    const tracked = view([id1]);
    assert.throws(() => onbox.buildUnionLiveView(tracked, view([id1]), [id2]), /not on the live page/);
    assert.throws(() => onbox.buildUnionLiveView(tracked, view([id1, id2]), [id1]), /already in your live view/);
    const noSection = tracked.replace(`<span class="gtag">${P}</span>`, '<span class="gtag">?</span>');
    assert.throws(() => onbox.buildUnionLiveView(noSection, view([id1, id2]), [id2]), new RegExp(`${tc.label} section`));
  });
}


for (const [P, key, id] of [['BLK', 'blkRows', 'BLK102'], ['UNC', 'uncRows', 'UNC102']]) {
  test(`#3587 (b): a ${P} row carries into an empty section after </header>, never inside it, and raises only its tile and gcount`, () => {
    const live = blkUncUnionView({ [key]: [uRow(id)] });
    const tracked = blkUncUnionView({});
    const union = onbox.buildUnionLiveView(tracked, live, [id]);
    const sec = union.match(new RegExp(`<section[^>]*id="${P === 'BLK' ? 'blocked' : 'unconfirmed'}"[\\s\\S]*?</section>`))[0];
    assert.ok(sec.indexOf('</header>') < sec.indexOf(`>${id}<`), 'block sits after </header>');
    assert.ok(sec.includes('<span class="gcount">1 row</span>'));
    assert.ok(union.includes(`<div class="l">${P === 'BLK' ? 'Blocked' : 'Unconfirmed'}</div>`) && !union.includes('<div class="n owed">11'), 'owed untouched');
    assert.equal(union.replace(/\n\n( {2}<\/section>)/g, '\n$1'), live.replace(/\n\n( {2}<\/section>)/g, '\n$1'));
  });
}


test('#3587 (c): a mixed E + BLK carry raises owed by one, the E glance cell by one, and the Blocked tile by one', () => {
  const tracked = blkUncUnionView({ eRows: [uRow('E101')], blkRows: [uRow('BLK101')] });
  const live = blkUncUnionView({ eRows: [uRow('E101'), uRow('E115')], blkRows: [uRow('BLK101'), uRow('BLK102')] });
  const union = onbox.buildUnionLiveView(tracked, live, ['BLK102', 'E115']);
  assert.equal(union, live);
  assert.ok(union.includes('<div class="n owed">12</div>'), 'owed 11 -> 12');
  assert.ok(union.includes('<td>2</td>'), 'E glance cell 1 -> 2');
});


test('#3587 (c): a BLK-only carry does not need an owed tile to exist; a lettered one still does', () => {
  const owedTile = /<div class="stat"><div class="n owed">\d+<\/div><div class="l">Owed<\/div><\/div>\n/;
  const tracked = blkUncUnionView({ blkRows: [uRow('BLK101')] }).replace(owedTile, '');
  assert.ok(!tracked.includes('n owed'));
  const union = onbox.buildUnionLiveView(tracked, blkUncUnionView({ blkRows: [uRow('BLK101'), uRow('BLK102')] }), ['BLK102']);
  assert.ok(union.includes('<span class="num">BLK102</span>'));
  const lettered = blkUncUnionView({ eRows: [uRow('E101')] }).replace(owedTile, '');
  assert.throws(() => onbox.buildUnionLiveView(lettered, blkUncUnionView({ eRows: [uRow('E101'), uRow('E102')] }), ['E102']), /n owed/);
});


test('#3587 (c): a BLK row is placed among BLK rows by number', () => {
  const tracked = blkUncUnionView({ blkRows: [uRow('BLK101'), uRow('BLK105')] });
  const live = blkUncUnionView({ blkRows: [uRow('BLK101'), uRow('BLK103'), uRow('BLK104'), uRow('BLK105')] });
  assert.equal(onbox.buildUnionLiveView(tracked, live, ['BLK104', 'BLK103']), live);
});


test('#3587 (e) CLI: --build-union writes a union carrying a BLK row, and --publishing of it exits 0', () => {
  const block = `    <details class="item">
      <summary><span class="num">BLK107</span><span class="iname">other lane blocked row</span><span class="risk">default</span></summary>
      <div class="body">
        <p>body BLK107</p>
      </div>
    </details>`;
  const section = REAL_LIVE_VIEW_HTML.match(/<section\b[^>]*id="blocked"[\s\S]*?<\/section>/);
  assert.ok(section, 'the tracked live view has a Blocked section');
  const mutated = REAL_LIVE_VIEW_HTML.replace(section[0], (s) => s.replace(/(\s*)<\/section>$/, `\n${block}$1</section>`));
  assert.notEqual(mutated, REAL_LIVE_VIEW_HTML);
  withHermeticBaseline(mutated, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const env = { ONBOX_TEST_BASELINE_FILE: baselinePath, ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged' };
    const unionPath = join(dirname(publishedPath), 'union.html');
    const without = runCli(['--against-published', publishedPath], env);
    assert.equal(without.status, 1, without.stderr);
    assert.match(without.stderr, /unmerged-lane-row: BLK107/);
    const built = runCli(['--against-published', publishedPath, '--build-union', unionPath], env);
    assert.equal(built.status, 0, `stdout: ${built.stdout}\nstderr: ${built.stderr}`);
    assert.ok(readFileSync(unionPath, 'utf8').includes('<span class="num">BLK107</span>'));
    const checked = runCli(['--against-published', publishedPath, '--publishing', unionPath], env);
    assert.equal(checked.status, 0, `stdout: ${checked.stdout}\nstderr: ${checked.stderr}`);
  });
});


// ---------------------------------------------------------------------------
// #3587 review: the glance table's Blocked/Unconfirmed cells feed the strip
// tiles, so they are checked against the body like a lettered group's.
// ---------------------------------------------------------------------------
for (const [label, cellRegex] of [
  ['Blocked', /(\| — \| \*\*Blocked\*\*[^|]*\| )(\d+)( \|)/],
  ['Unconfirmed', /(\| — \| \*\*Unconfirmed\*\*[^|]*\| )(\d+)( \|)/],
]) {
  test(`#3587 review: a stale ${label} glance cell is reported against the body, the real register is clean`, () => {
    assert.deepEqual(checkRegister(REAL_REGISTER_TEXT), []);
    const stale = REAL_REGISTER_TEXT.replace(cellRegex, (_m, a, n, c) => `${a}${Number(n) + 1}${c}`);
    assert.notEqual(stale, REAL_REGISTER_TEXT);
    const errors = checkRegister(stale);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok(errors[0].startsWith(`${label}: glance table says `), errors[0]);
    assert.match(errors[0], /, body has \d+ rows?\. Update the table or the body\.$/);
  });
}


test('#3587 review: legacy `—` rows on the live Blocked/Unconfirmed sections raise an advisory warning only when the register carries IDs', () => {
  const run = (html, register = REAL_REGISTER_TEXT) =>
    ofPrefix(
      checkLiveView(register, html, {
        direction: 'extraOnly',
        baselineText: register,
        trackedLiveViewHtml: REAL_LIVE_VIEW_HTML,
        publishedProvenance: UNMERGED,
      }),
      onbox.LEGACY_LIVE_ROW_WARNING_PREFIX,
    );
  assert.deepEqual(run(REAL_LIVE_VIEW_HTML), [], 'the tracked page has IDs, so nothing to warn about');
  const legacy = REAL_LIVE_VIEW_HTML.replace(/<span class="num">(?:BLK|UNC)\d+<\/span>/g, '<span class="num">—</span>');
  assert.notEqual(legacy, REAL_LIVE_VIEW_HTML);
  const warnings = run(legacy);
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  const countRows = (prefix) => (REAL_LIVE_VIEW_HTML.match(new RegExp(`<span class="num">${prefix}\\d+</span>`, 'g')) ?? []).length;
  const plural = (n) => `row${n === 1 ? '' : 's'}`;
  assert.match(warnings[0], new RegExp(`Blocked section has ${countRows('BLK')} legacy ${plural(countRows('BLK'))} with no BLK ID`));
  assert.match(warnings[1], new RegExp(`Unconfirmed section has ${countRows('UNC')} legacy ${plural(countRows('UNC'))} with no UNC ID`));
  const idless = REAL_REGISTER_TEXT.replace(/^### BLK\d+ · /gm, '### ').replace(/^(- \*\*)UNC\d+ · /gm, '$1').replace(/^<!-- next-id: (?:BLK|UNC)\d+ -->\r?\n/gm, '');
  assert.notEqual(idless, REAL_REGISTER_TEXT);
  assert.deepEqual(run(legacy, idless), [], 'a register with no BLK/UNC IDs is the pre-#3587 state: no warning');
});


test('#3587 review: the legacy-row warning is non-blocking through the real CLI (exit 0, warning on stderr)', () => {
  const legacy = REAL_LIVE_VIEW_HTML.replace(/<span class="num">(?:BLK|UNC)\d+<\/span>/g, '<span class="num">—</span>');
  assert.notEqual(legacy, REAL_LIVE_VIEW_HTML);
  withHermeticBaseline(legacy, REAL_REGISTER_TEXT, (publishedPath, baselinePath) => {
    const env = { ONBOX_TEST_BASELINE_FILE: baselinePath, ONBOX_TEST_PUBLISHED_PROVENANCE: 'unmerged' };
    const res = runCli(['--against-published', publishedPath], env);
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /Legacy live-page rows \(not blocking/);
    assert.match(res.stderr, /Blocked section has \d+ legacy rows? with no BLK ID/);
  });
});


test('#3587 review: a carried row into an EMPTY section with no <header> falls back to anchoring after </h3>', () => {
  const live = buildRowContentLiveView([theirsB103], 'B');
  const tracked = buildRowContentLiveView([], 'B');
  assert.ok(!tracked.includes('</header>'), 'the fixture section is bare-<h3>, the shape the fallback serves');
  const union = onbox.buildUnionLiveView(tracked, live, ['B103']);
  assert.ok(union.includes('<span class="num">B103</span>'), union);
  assert.ok(union.indexOf('</h3>') < union.indexOf('<span class="num">B103</span>'), 'the block lands after the heading');
});

