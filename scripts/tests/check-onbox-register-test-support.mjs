// Shared fixtures for the scripts/tests/check-onbox-register*.test.mjs files
// (#3701: that suite was one ~6500-line file, so node:test ran it on a single
// core; it is now split by topic and each file imports these). Not a test file.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { checkLiveView, THREE_WAY_CONTENT_WARNING_PREFIX, parseNextIdMarker } from '../check-onbox-register.mjs';
import { readNormalized } from '../lib/read-normalized.mjs';
import { scrubGitEnvForThrowawayRepo } from '../git-env.mjs';
import * as onbox from '../check-onbox-register.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI_PATH = join(HERE, '..', 'check-onbox-register.mjs');
export const REAL_LIVE_VIEW_PATH = join(
  HERE,
  '..',
  '..',
  'docs',
  'testing',
  'onbox-acceptance-register-live-view.html',
);

export const REAL_REGISTER_PATH = join(
  HERE,
  '..',
  '..',
  'docs',
  'testing',
  'onbox-acceptance-register.md',
);


// #3587 child 3: the live-view parse layer and baseline helpers read BLK/UNC IDs.
export const item = (id, title) =>
  `<details class="item"><summary><span class="num">${id}</span><span class="iname">${title}</span></summary><div class="body"><p>b ${id}</p></div></details>`;
export const blkUncLiveView = ({ blkTag = 'BLK', uncTag = 'UNC', extraBlk = '' } = {}) => `
<section class="group is-blocked" id="blocked"><h3><span class="gtag">${blkTag}</span> Blocked <span class="gcount">2 rows</span></h3>
${item('BLK101', 'no gpu')}${item('—', 'legacy blocked')}${extraBlk}</section>
<section class="group is-soft" id="unconfirmed"><h3><span class="gtag">${uncTag}</span> Unconfirmed <span class="gcount">1 row</span></h3>
${item('UNC101', 'maybe')}${item('—', 'legacy unconfirmed')}</section>
`;


// ---------------------------------------------------------------------------
// #2199: `extraOnly` + `baselineText` — discharge-aware --against-published.
//
// A discharge (removing a row, which contiguity then renumbers the
// survivors) makes the still-live page look "ahead" in exactly the same
// shape as a genuine competing-lane publish: a live-page row/group the
// working register doesn't have. `checkLiveView` disambiguates the two by
// checking whether a SECOND register text — meant to be origin/main's copy,
// injected here directly rather than fetched via git, per the design's
// "keep checkLiveView unit-testable, do the git show in the CLI layer"
// requirement — also lacks the row: baseline-lacks-it-too means discharged
// (not reported); baseline-still-has-it means genuinely behind (reported).
// ---------------------------------------------------------------------------


// A minimal single-group register/live-view pair, parameterised by letter and
// row numbers — reused for all four #2199 scenarios (in check-onbox-register.test.mjs) so each test only
// states the one thing that differs (working rows vs. baseline rows vs.
// live-page rows).
export function buildSingleGroupRegister(letter, rowNumbers, nextId = 101) {
  const body = rowNumbers.map((n) => `### ${letter}${n} · thing ${n}\n\nBody text.\n`).join('\n');
  const marker = nextId === null ? '' : `\n<!-- next-id: ${letter}${nextId} -->\n`;
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **${letter}** | Setup ${letter} | ${rowNumbers.length} |

**${rowNumbers.length} owed.** Oldest: **2026-01-01**.

---

## Group ${letter} — setup ${letter.toLowerCase()}
${marker}
${body}
---
`;
}


// ---------------------------------------------------------------------------
// #2599/A41: per-row content hashing for `--against-published`. A row can
// keep the same ID and the same per-group count while its own BODY TEXT
// silently regresses on the published page (PR #2578 review rounds 13-18 —
// caught only by manual byte-diffing, because nothing mechanical compared
// row content). Design decision: dudarenok-maker/Castwright#2599 comment
// 5484697345 — hash each row's body, keyed by ID, comparing only IDs present
// on BOTH sides.
//
// This compares the TRACKED local live view (`options.trackedLiveViewHtml`)
// against the PUBLISHED snapshot (`checkLiveView`'s second argument) — NOT
// the register. The register and its HTML twin are deliberately different
// documents that only have to agree on structure, not row wording — hashing
// the real committed register against the real committed live view produces
// a mismatch for nearly every row even in a healthy state (this was checked
// against this repo's own files while building this check, and is why the
// end-to-end CLI tests in the sibling check-onbox-register.*.test.mjs files, which read both real files, would
// otherwise turn permanently red). The tracked live view and a snapshot of
// what's actually live, by contrast, ARE supposed to carry the same row
// content whenever nothing has changed — see `parseLiveViewRowBodies`'s own
// header for the fuller account.
//
// A row ID tracked-only (edited locally, not yet published) is tolerated —
// the normal pre-publish state. A row ID published-only is untouched by
// this check (existing discharge handling decides it).
// ---------------------------------------------------------------------------


// A controllable set of `<details class="item">` / `<div class="body">` rows
// for one glance-table group — real live-view row markup, since that is the
// one shape `parseLiveViewRowBodies` reads (mirrors the tracked
// live-view.html and every real `--against-published` snapshot;
// `buildLiveView`/`buildSingleGroupLiveView` above deliberately skip it,
// which is also why none of the tests using them exercise this check at
// all).
export function buildRowContentLiveView(rows, letter = 'A') {
  const detailsBlocks = rows
    .map(
      ({ id, body, risk, title }) => `    <details class="item">
      <summary><span class="num">${id}</span><span class="iname">${title ?? 't'}</span><span class="risk">${risk ?? 'default'}</span></summary>
      <div class="body">
        <p>${body}</p>
      </div>
    </details>`,
    )
    .join('\n');
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="n owed">${rows.length}</div><div class="l">Owed</div>
  </div>

  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
      <tr><td><a href="#g${letter.toLowerCase()}">${letter}</a></td><td>Setup ${letter}</td><td>${rows.length}</td></tr>
    </tbody>
  </table>

  <section class="group" id="g${letter.toLowerCase()}">
    <h3 class="gtitle"><span class="gtag">${letter}</span> Setup ${letter} <span class="gcount">${rows.length} rows</span></h3>
${detailsBlocks}
  </section>
`;
}


// ---------------------------------------------------------------------------
// #2272 review finding 1: a discharge that removes a group's LAST row makes
// the whole group vanish from the working register (not just one row within
// a group the register still has) — a shape the per-row `extra`/`staleExtra`
// logic above never sees, because it only runs for letters `mdBodyGroups`
// still has. This is live today: Group F has exactly one row in the real
// register, so discharging it removes the whole group. Builds a register
// with more than one group so a whole-group discharge can be modelled
// without disturbing the group that survives.
// ---------------------------------------------------------------------------


// A register/baseline pair spanning MULTIPLE groups — buildSingleGroupRegister
// only ever produces one group, which can't model "the register still has
// Group A but has lost Group F entirely".
export function buildMultiGroupRegister(groups) {
  const glanceRows = groups
    .map(({ letter, rowNumbers }) => `| **${letter}** | Setup ${letter} | ${rowNumbers.length} |`)
    .join('\n');
  const total = groups.reduce((sum, g) => sum + g.rowNumbers.length, 0);
  const bodySections = groups
    .map(({ letter, rowNumbers }) => {
      const body = rowNumbers
        .map((n) => `### ${letter}${n} · thing ${n}\n\nBody text.\n`)
        .join('\n');
      return `## Group ${letter} — setup ${letter.toLowerCase()}\n\n<!-- next-id: ${letter}101 -->\n\n${body}---\n`;
    })
    .join('\n');
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
${glanceRows}

**${total} owed.** Oldest: **2026-01-01**.

---

${bodySections}`;
}


export function buildMultiGroupLiveView(owed, groups) {
  const glanceRows = groups
    .map(({ letter, glanceCount }) => {
      const lower = letter.toLowerCase();
      return `      <tr><td><a href="#g${lower}">${letter}</a></td><td>Setup ${letter}</td><td>${glanceCount}</td></tr>`;
    })
    .join('\n');
  const sections = groups
    .map(({ letter, headerCount, rowIds }) => {
      const lower = letter.toLowerCase();
      const rowSpans = rowIds
        .map(
          (id) =>
            `      <summary><span class="num">${id}</span><span class="iname">t</span></summary>`,
        )
        .join('\n');
      return `  <section class="group" id="g${lower}">
    <h3 class="gtitle"><span class="gtag">${letter}</span> Setup ${letter} <span class="gcount">${headerCount} rows</span></h3>
${rowSpans}
  </section>`;
    })
    .join('\n\n');
  return `<title>On-box acceptance register — Castwright</title>

  <div class="strip">
    <div class="n owed">${owed}</div><div class="l">Owed</div>
  </div>

  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
${glanceRows}
    </tbody>
  </table>

${sections}
`;
}


// ---------------------------------------------------------------------------
// `--against-published <file>` — #1931's "re-read immediately before
// publishing" step, mechanised (2036 review round 2 / R3 amendment). CI has
// no credentials to fetch the published artifact, so this mode takes a
// LOCALLY SAVED COPY of the page fetched by hand right before a publish and
// diffs it against the register with the exact same `checkLiveView` used for
// the tracked live-view file — these tests spawn the real CLI (not the
// imported functions) so the argument parsing and file-reading are actually
// exercised, not just the comparator underneath them.
//
// The real, committed `docs/testing/onbox-acceptance-register.md` is what
// the CLI's REGISTER path always reads (it is not overridable), so these
// tests start from a copy of the real, currently-committed live view —
// known-agreeing with the real register at the time these tests run — and
// mutate the copy, never the checked-in files.
//
// #2199 review round 3 (A4/A5): most of these tests use
// `ONBOX_TEST_BASELINE_FILE` (see that env var's own comment in
// `scripts/check-onbox-register.mjs`) to supply a KNOWN, hermetic baseline
// instead of letting the CLI run a real `git fetch`/`git show` against
// whatever `origin/main` happens to contain at test-run time. Two defects
// that shape used to cause, both fixed by using this seam:
//   - **A5**: a real `git fetch` makes these tests (and therefore
//     `test:hooks`, wired into pre-commit/pre-push via `verify:fast:scoped`/
//     `verify:fast:branch`) require network access, so any commit touching
//     the on-box register could no longer be made offline.
//   - **A4**: a test whose expected verdict depends on live `origin/main`
//     content is itself a latent bug — a fixture computed as "one past
//     Group B's highest row, so it's surely not on origin/main yet" breaks
//     the moment ANY lane merges a new Group B row while this branch is
//     open, including the exact discharge-and-renumber workflow #2199
//     exists to unblock.
// The one deliberate exception is the real-git-fetch-FAILURE test further
// down, which does NOT use this override — a live `git fetch` failing is
// the entire point there, and it's engineered (via an unreachable proxy) to
// fail deterministically rather than depending on ambient network state.
// Deliberately raw, unlike REAL_REGISTER_TEXT immediately below: every
// live-view parser in check-onbox-register.mjs is `[\s\S]*?`/`[^<]*` plus a
// trim, so a `\r` cannot move any of them (measured on CRLF input: byte-
// identical results). Raw here is a decision, not an oversight.
export const REAL_LIVE_VIEW_HTML = readFileSync(REAL_LIVE_VIEW_PATH, 'utf8');
// readNormalized, not a bare readFileSync: buildAheadBaselineText below scans
// this text for literal '\n---\n' / '\n## ' delimiters, which miss on a
// CRLF checkout (#2291) — see scripts/lib/read-normalized.mjs.
export const REAL_REGISTER_TEXT = readNormalized(REAL_REGISTER_PATH);


// Writes BOTH the published-page HTML and a baseline register text to their
// own files in one temp dir, for tests that inject a hermetic baseline via
// `ONBOX_TEST_BASELINE_FILE` rather than letting the CLI fetch a real one.
export function withHermeticBaseline(publishedHtml, baselineText, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'onbox-hermetic-'));
  const publishedPath = join(dir, 'published.html');
  const baselinePath = join(dir, 'baseline.md');
  writeFileSync(publishedPath, publishedHtml, 'utf8');
  writeFileSync(baselinePath, baselineText, 'utf8');
  try {
    return fn(publishedPath, baselinePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


export function runCli(args, envOverrides) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
    windowsHide: true,
  });
}


// The highest row number Group `letter` has in `registerText`, computed from
// the register's OWN `### <Letter><N>` body headings — the authoritative
// source, not the live view — so a fixture built from it is correct by
// construction regardless of whether the live view happens to be in sync.
export function computeMaxRowNumber(registerText, letter) {
  const numbers = [...registerText.matchAll(new RegExp(`^### ${letter}(\\d+)\\b`, 'gm'))].map((m) =>
    Number(m[1]),
  );
  assert.ok(
    numbers.length > 0,
    `fixture setup: Group ${letter} must have at least one row in the register`,
  );
  const max = Math.max(...numbers);
  // Callers use `max + 1` as "an ID that does not exist yet", inserting it
  // as a synthetic row via buildAheadBaselineText for the "ahead baseline"
  // fixtures. That helper now bumps ITS OWN copy's next-id marker past the
  // row it inserts (see its own comment), so the result stays
  // checkRegister-consistent regardless of how much headroom THIS
  // (unmutated) register text's next-id currently has — headroom here is no
  // longer a precondition for correctness. Only the marker's presence is
  // still required, for callers that read it directly.
  const nextId = parseNextIdMarker(registerText, letter);
  assert.ok(
    nextId !== null,
    `fixture setup: Group ${letter} must have a "<!-- next-id: ${letter}N -->" marker`,
  );
  return max;
}


// Renames one live-view row span from `<letter><oldNumber>` to
// `<letter><newNumber>` — used to synthesise "the live page has a row this
// register doesn't" without depending on any row ID that doesn't already
// exist in the fixture.
export function renameLiveViewRowId(liveViewHtml, letter, oldNumber, newNumber) {
  const oldId = `${letter}${oldNumber}`;
  const newId = `${letter}${newNumber}`;
  const mutated = liveViewHtml.replace(
    `<span class="num">${oldId}</span>`,
    `<span class="num">${newId}</span>`,
  );
  assert.notEqual(
    mutated,
    liveViewHtml,
    `fixture setup: the ${oldId} row ID must have matched in the live view`,
  );
  return { newId, mutated };
}


// ---------------------------------------------------------------------------
// #3529: ways `--against-published` passed a publish that would have broken
// another lane's rows (the 2026-10-07 PR #3525 / #3505 incident), and how the
// check now tells them apart.
//
//  1. A row-ID COLLISION: two lanes each allocated B103, with different
//     titles. Matching by ID alone called them equal.
//  2. An UNMERGED LANE'S live-only row: #2199 reads "live has it, origin/main
//     lacks it" as a discharge, but a row an unmerged PR ADDED has the same
//     shape. What separates them is PROVENANCE: which commit stamped the live
//     page's `data-publish-id`, and whether origin/main (or your own HEAD)
//     contains it — `publishedProvenance` below, resolved from real git by
//     `resolvePublishedProvenance` (covered against throwaway repos further
//     down).
//
// Fixtures are minimal and synthetic: Group B, main's marker at B103.
// ---------------------------------------------------------------------------


export const MAIN_B = () => buildSingleGroupRegister('B', [101, 102], 103);
export const MINE_TITLE = 'Ollama structured-output modes on a real model';
export const THEIRS_TITLE = 'Abort and drain on a local Ollama analyzer';


// A page published by a branch origin/main has not merged.
export const UNMERGED = { kind: 'unmerged', nonce: 'lane0x1', commit: 'abc1234' };
// A merged / own publish whose committed live view carried exactly `ids`.
export const merged = (ids) => ({ kind: 'merged', nonce: 'main0x1', commit: 'def5678', stampedRowIds: ids });
export const own = (ids) => ({ kind: 'own', nonce: 'mine0x1', commit: 'aaa9999', stampedRowIds: ids });


export function collisionOptions({ trackedRows, publishedRows, working, baseline, extra = {} }) {
  return [
    working ?? buildSingleGroupRegister('B', [101, 102, 103], 104),
    buildRowContentLiveView(publishedRows, 'B'),
    {
      direction: 'extraOnly',
      baselineText: baseline ?? MAIN_B(),
      trackedLiveViewHtml: buildRowContentLiveView(trackedRows, 'B'),
      publishedProvenance: UNMERGED,
      ...extra,
    },
  ];
}


export const baseRows = [
  { id: 'B101', body: 'x' },
  { id: 'B102', body: 'x' },
];


export const ofPrefix = (errors, prefix) => errors.filter((e) => e.startsWith(prefix));


// ---------------------------------------------------------------------------
// #3529: `resolvePublishedProvenance` / `resolveMergeBaseRegister` against
// REAL git. Throwaway repositories, every spawn through
// `scrubGitEnvForThrowawayRepo` — see publish-token-git.test.mjs's header for
// why `cwd` alone does not isolate a git call. Self-contained (no network, no
// dependence on this checkout's depth), so they run the same on CI.
// ---------------------------------------------------------------------------


export const PROV_LIVE = 'docs/testing/onbox-acceptance-register-live-view.html';
export const PROV_REGISTER = 'docs/testing/onbox-acceptance-register.md';
export const provEnv = () => scrubGitEnvForThrowawayRepo();
export const provRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: provEnv(), windowsHide: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
};

export const provGit = (repo, ...args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: provEnv(), windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// ---------------------------------------------------------------------------
// #3529, PR #3532 review pass 2. Exports added by this round are read through
// the `onbox` namespace so a missing one fails its own test, not the import.
//
//   🟠1 the stamping commit is the OLDEST commit that introduced the nonce
//       (the stamp, not the merge commit that later brought it to main), and
//       a row ID origin/main's register has EVER carried is a discharge.
//   🟠2 the "Retired carried rows" record, its PR-state check, and naming a
//       carried row's OWNER rather than whoever carried it.
//   🟠3 `--publishing` checks the whole file against the deterministic union.
//   🟠4 the whole-group paths classify a row main lacks by provenance too.
// ---------------------------------------------------------------------------


// Real merges in a throwaway repo. `uMerge` makes a genuine `--no-ff` merge
// commit and writes the resolution explicitly — never `-X theirs`, which
// makes the merge commit's view equal the stamp's and hid the pass-2 defect.
// `titles` (number -> title) gives a lane its own row under a colliding ID.
export const U_ROW = (n, titles = {}) => ({ id: `B${n}`, body: `body B${n}`, title: titles[n] ?? `title B${n}` });
export const uView = (nonce, nums, titles = {}) =>
  buildRowContentLiveView(nums.map((n) => U_ROW(n, titles)), 'B').replace(
    '<title>',
    `<div hidden data-published-as="1" data-publish-id="${nonce}"></div>\n<title>`,
  );
export function uWrite(repo, nonce, nums, next, titles = {}) {
  mkdirSync(join(repo, 'docs', 'testing'), { recursive: true });
  writeFileSync(join(repo, PROV_LIVE), uView(nonce, nums, titles));
  writeFileSync(join(repo, PROV_REGISTER), buildSingleGroupRegister('B', nums, next));
}

export function uCommit(repo, nonce, nums, next, msg) {
  uWrite(repo, nonce, nums, next);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', msg ?? `stamp ${nonce}`);
  return provGit(repo, 'rev-parse', 'HEAD');
}

export function uMerge(repo, branch, nonce, nums, next, titles = {}) {
  spawnSync('git', ['merge', '--no-ff', '--no-commit', '-q', branch], {
    cwd: repo,
    env: provEnv(),
    encoding: 'utf8',
    windowsHide: true,
  });
  uWrite(repo, nonce, nums, next, titles);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', `Merge ${branch}`);
  const head = provGit(repo, 'rev-parse', 'HEAD');
  assert.equal(provGit(repo, 'rev-list', '--parents', '-n', '1', head).split(' ').length, 3, 'a real merge commit');
  return head;
}

export function withUnionRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'onbox-union-'));
  try {
    provGit(repo, 'init', '-q', '-b', 'main');
    provGit(repo, 'config', 'user.email', 'test@example.com');
    provGit(repo, 'config', 'user.name', 'Test');
    provGit(repo, 'config', 'commit.gpgsign', 'false');
    uCommit(repo, 'main0001', [101, 102], 103);
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// What a lane checked out at `branch` gets from --against-published, through
// the same real lookups the CLI wires in.
export function uCheck(repo, branch, page, extra = {}) {
  provGit(repo, 'switch', '-q', branch);
  const mainSha = provGit(repo, 'rev-parse', 'main');
  const provenance = onbox.resolvePublishedProvenance(repo, PROV_LIVE, page, mainSha, provRunner);
  const liveTitles = onbox.parseLiveViewRowTitles(page);
  return checkLiveView(readFileSync(join(repo, PROV_REGISTER), 'utf8'), page, {
    direction: 'extraOnly',
    baselineText: provGit(repo, 'show', `${mainSha}:${PROV_REGISTER}`) + '\n',
    baselineLiveViewText: provGit(repo, 'show', `${mainSha}:${PROV_LIVE}`) + '\n',
    trackedLiveViewHtml: readFileSync(join(repo, PROV_LIVE), 'utf8'),
    publishedProvenance: provenance,
    mergeBaseText: onbox.resolveMergeBaseRegister(repo, PROV_REGISTER, mainSha, provRunner),
    mainEverCarried: (id) => onbox.resolveMainEverCarried?.(repo, PROV_REGISTER, mainSha, id, provRunner),
    rowOwnerLookup: (id, prCommits) =>
      onbox.resolveRowOwner(repo, PROV_LIVE, id, { title: liveTitles.get(id), mainRef: mainSha, extraCommits: prCommits }, provRunner),
    ...extra,
  });
}

export const realErrors = (errors) => errors.filter((e) => !e.startsWith(THREE_WAY_CONTENT_WARNING_PREFIX));


// 🟠2: the committed retirement record.
export function withRetired(registerText, rowsMd) {
  return registerText.replace(
    '## At a glance',
    `## Retired carried rows\n\nPreamble.\n\n| Row | Owning PR | Closed unmerged | Reason |\n|---|---|---|---|\n${rowsMd}\n## At a glance`,
  );
}

// Operator decision 5 (review pass 4): gh also reports the PR's commits, one
// of which must be the commit that introduced the live row.
export const OWNER_X = { commit: '0123456789abcdef0123456789abcdef01234567', refs: ['origin/fix/server-x'] };
export const closedStates = (state, mergedAt = null, commits = [OWNER_X.commit]) => ({
  available: true,
  states: new Map([[3505, { state, mergedAt, commits }]]),
});

// Review pass 4, 🟠 (operator decision 5): the row's owner is the commit
// that introduced the LIVE row's own summary (ID plus normalised title), not
// the oldest commit carrying the bare ID, and never a commit main contains. A
// retirement is honoured only when that commit is one of the named PR's own
// commits. Real git, gh stubbed; explicit dates make "oldest" deterministic.
// Branches use this repo's <type>/<scope>-<slug> shape (review pass 4, 🟡3).
export function p4Commit(repo, date, nonce, nums, next, msg, titles = {}) {
  uWrite(repo, nonce, nums, next, titles);
  provGit(repo, 'add', '-A');
  const env = { ...provEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const r = spawnSync('git', ['commit', '-qm', msg ?? `stamp ${nonce}`], { cwd: repo, env, windowsHide: true, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return provGit(repo, 'rev-parse', 'HEAD');
}

export function p4Other(repo, date, msg) {
  writeFileSync(join(repo, 'other.txt'), msg);
  provGit(repo, 'add', '-A');
  const env = { ...provEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const r = spawnSync('git', ['commit', '-qm', msg], { cwd: repo, env, windowsHide: true, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return provGit(repo, 'rev-parse', 'HEAD');
}

export const p4Retire = (pr, nums = [101, 102, 104], next = 105) =>
  withRetired(buildSingleGroupRegister('B', nums, next), `| B103 | #${pr} | 2030-01-05 | probe |\n`);
export const X_TITLES = { 103: 'X row' };


// A stand-in for gh with the REAL caps (#3529 pass 5): `gh pr view --json
// commits` reports only a PR's first 100 commits (observed: #3505 has 120, gh
// 2.92.0 reports 100), while `gh api graphql --paginate --slurp` over
// `commits(first: 100, after: $endCursor)` reports them all, as an array of
// pages. `prs` maps a PR number to { state, mergedAt?, commits: [oid, ...],
// totalCount? }; `totalCount` defaults to the list's length.
export function fakeGh(prs, { pageSize = 100 } = {}) {
  const calls = [];
  const notFound = { status: 1, stdout: '', stderr: 'Could not resolve to a PullRequest' };
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = prs[Number(args[2])];
      if (!pr) return notFound;
      return {
        status: 0,
        stdout: JSON.stringify({ state: pr.state, mergedAt: pr.mergedAt ?? null, commits: (pr.commits ?? []).slice(0, 100).map((oid) => ({ oid })) }),
        stderr: '',
      };
    }
    assert.deepEqual(args.slice(0, 4), ['api', 'graphql', '--paginate', '--slurp'], args.join(' '));
    const pr = prs[Number(args.find((a) => a.startsWith('number=')).slice('number='.length))];
    if (!pr) return notFound;
    const oids = pr.commits ?? [];
    const pages = [];
    for (let i = 0; i === 0 || i < oids.length; i += pageSize) {
      const nodes = oids.slice(i, i + pageSize).map((oid) => (oid === null ? { commit: {} } : { commit: { oid } }));
      pages.push({
        data: {
          repository: {
            pullRequest: {
              state: pr.state,
              mergedAt: pr.mergedAt ?? null,
              commits: {
                totalCount: pr.totalCount ?? oids.length,
                pageInfo: { hasNextPage: i + pageSize < oids.length, endCursor: `c${i}` },
                nodes,
              },
            },
          },
        },
      });
    }
    return { status: 0, stdout: JSON.stringify(pages), stderr: '' };
  };
  run.calls = calls;
  return run;
}


// 🟠3: `--publishing` checks the WHOLE file.
export const theirsB103 = { id: 'B103', body: 'theirs a', title: THEIRS_TITLE };
export const theirsB104 = { id: 'B104', body: 'theirs b', title: 'second row from the unmerged lane' };
export const mineB105 = { id: 'B105', body: 'mine', title: MINE_TITLE };
export function unionFixture() {
  const tracked = buildRowContentLiveView([...baseRows, mineB105], 'B');
  const live = buildRowContentLiveView([...baseRows, theirsB103, theirsB104], 'B');
  const [working, , options] = collisionOptions({
    working: buildSingleGroupRegister('B', [101, 102, 105], 106),
    trackedRows: [...baseRows, mineB105],
    publishedRows: [],
  });
  return { tracked, live, working, options };
}


// ---------------------------------------------------------------------------
// CLI wiring against REAL git (🟡2: pass-2 mutants M20/M21 unwired the real
// provenance and merge-base lookups with the whole suite green, because every
// other CLI test runs under ONBOX_TEST_BASELINE_FILE, which skips both). A
// throwaway repo with a bare `origin`, the CLI copied into it, no overrides.
// ---------------------------------------------------------------------------
export const CLI_FILES = ['check-onbox-register.mjs', 'git-env.mjs', 'gh.mjs', 'publish-token.mjs', join('lib', 'is-main-module.mjs')];
// No ambient GitHub token may make the real gh lookup authenticated here.
export function withoutGhTokens(env) {
  for (const key of Object.keys(env)) {
    if (/^(GH|GITHUB)_(TOKEN|ENTERPRISE_TOKEN)$/i.test(key)) delete env[key];
  }
  return env;
}

export function withCliRepo(fn) {
  const root = mkdtempSync(join(tmpdir(), 'onbox-cli-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'work');
  try {
    mkdirSync(repo);
    provGit(root, 'init', '-q', '--bare', '-b', 'main', origin);
    provGit(repo, 'init', '-q', '-b', 'main');
    provGit(repo, 'config', 'user.email', 'test@example.com');
    provGit(repo, 'config', 'user.name', 'Test');
    provGit(repo, 'config', 'commit.gpgsign', 'false');
    provGit(repo, 'remote', 'add', 'origin', origin);
    for (const f of CLI_FILES) {
      mkdirSync(dirname(join(repo, 'scripts', f)), { recursive: true });
      writeFileSync(join(repo, 'scripts', f), readFileSync(join(HERE, '..', f)));
    }
    writeFileSync(join(repo, '.gitignore'), 'scripts/\n*.saved.html\n');
    return fn(repo, (args, env = {}) =>
      spawnSync(process.execPath, [join(repo, 'scripts', 'check-onbox-register.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 120000,
        env: withoutGhTokens({ ...provEnv(), ...env }),
        windowsHide: true,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const titled = (nums, titles) =>
  nums.map((n) => ({ id: `B${n}`, body: `body B${n}`, title: titles[n] ?? `title B${n}` }));
export function cliCommit(repo, nonce, nums, next, titles = {}, retiredRows = null) {
  mkdirSync(join(repo, 'docs', 'testing'), { recursive: true });
  writeFileSync(
    join(repo, PROV_LIVE),
    buildRowContentLiveView(titled(nums, titles), 'B').replace(
      '<title>',
      `<div hidden data-published-as="1" data-publish-id="${nonce}"></div>\n<title>`,
    ),
  );
  let reg = buildSingleGroupRegister('B', nums, next);
  for (const [n, t] of Object.entries(titles)) reg = reg.replace(`### B${n} · thing ${n}`, `### B${n} · ${t}`);
  if (retiredRows !== null) reg = withRetired(reg, retiredRows);
  writeFileSync(join(repo, PROV_REGISTER), reg);
  provGit(repo, 'add', '-A');
  provGit(repo, 'commit', '-qm', `stamp ${nonce}`);
}

