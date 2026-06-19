# ops-17 KGP / built-in-Kotlin guardrail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight guardrail for ops-17 — a monthly scheduled "deps watch" that nudges on all-deps drift (A1) while giving the rare KGP-plugin-migration event its own dedicated notification (A2), plus PR-time assertions that the escape-hatch flags and the Flutter pin can't drift silently.

**Architecture:** A single **pure, unit-tested helper** (`scripts/deps-watch.mjs`) parses `flutter pub outdated --json --show-all` and computes everything (which direct/dev deps are behind, the three KGP plugins' status, transitions vs. prior state, and the rendered markdown). A thin **IO orchestrator** (`scripts/deps-watch-run.mjs`) wires it to `gh`/the job summary. A new **scheduled workflow** (`.github/workflows/app-deps-watch.yml`) runs it monthly. Two **grep assertions** added to the existing `app.yml` guard the escape hatch + pin lockstep.

**Tech Stack:** Node ESM (`.mjs`, `node:test`), GitHub Actions, `gh` CLI (REST `gh api`), Flutter `pub outdated`, Bash steps.

## Global Constraints

Copy these verbatim into every relevant task — they are the spec's non-negotiables.

- **KGP plugins (the only three A2 tracks):** `audio_session`, `flutter_foreground_task`, `mobile_scanner`.
- **Sticky-comment marker:** `<!-- ops-17-deps-watch -->` (carries a `<!-- state: {...} -->` block).
- **Tracking issue:** `#790` (override in tests via env `OPS17_ISSUE`); repo from `${{ github.repository }}` / `GITHUB_REPOSITORY` — never hardcode owner/name.
- **Transition @mention:** `@dudarenok-maker`.
- **Flutter pin:** `3.44.1` (must equal `app.yml`'s pin — Trip B asserts lockstep).
- **"Behind" = `latest.version` > `current.version`** — use the **`latest`** column, NOT `resolvable` (the plugins are pinned at latest; a new major shows only in `latest`).
- **Direct-ness = the `kind` field** (`"direct"` | `"dev"` | `"transitive"`) — there is **no** `isDirect` field. A1 reds on `kind ∈ {direct, dev}`; a package **absent** from the payload = "at latest", not an error.
- Always pass **`--show-all`** (else up-to-date packages are omitted).
- Sticky edits use **`gh api ... --method PATCH`** on the **numeric REST comment `id`** (from `gh api .../comments`, not `gh issue view --json` which returns GraphQL node ids). `gh issue comment --edit-last` is forbidden.
- Workflow: `permissions: issues: write`; set **`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`** in env (`gh` does not auto-read it); add a **`concurrency:`** group with **`cancel-in-progress: false`** (serialize, never cancel mid-PATCH); fetch comments with **`--paginate`**.
- Let `flutter pub outdated`'s own non-zero exit (env faults: 65/69) surface as a **distinct tooling failure (exit 2)**, never conflated with A1's "deps behind" (exit 1).
- **Out of scope:** bumping/forking the plugins; Dependabot; building against Flutter beta. The `build.gradle` KGP-grep strengthening is **deferred** (A2 uses honest "verify whether it removed KGP" wording instead).

---

### Task 1: Pure helper — parsing & version comparison

**Files:**
- Create: `scripts/deps-watch.mjs`
- Test: `scripts/tests/deps-watch.test.mjs`

**Interfaces:**
- Produces: `KGP_PLUGINS: string[]`, `STICKY_MARKER: string`, `compareSemver(a, b) -> -1|0|1`, `parseOutdated(jsonTextOrObj) -> Map<name, {kind, current, latest}>`, `parsePins(pubspecText, names) -> {name: version}`.

- [ ] **Step 1: Write the failing test**

```js
// scripts/tests/deps-watch.test.mjs
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KGP_PLUGINS,
  compareSemver,
  parseOutdated,
  parsePins,
} from '../deps-watch.mjs';

test('KGP_PLUGINS is exactly the three tracked plugins', () => {
  assert.deepEqual(
    [...KGP_PLUGINS].sort(),
    ['audio_session', 'flutter_foreground_task', 'mobile_scanner'],
  );
});

test('compareSemver orders by numeric component, not string', () => {
  assert.equal(compareSemver('0.2.4', '0.2.3'), 1);
  assert.equal(compareSemver('7.2.0', '7.10.0'), -1); // 2 < 10 numerically
  assert.equal(compareSemver('9.2.2', '9.2.2'), 0);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta'), 0); // prerelease/build ignored
});

test('parseOutdated reads kind + current/latest, tolerating nulls', () => {
  const payload = {
    packages: [
      { package: 'audio_session', kind: 'direct', current: { version: '0.2.3' }, latest: { version: '0.2.3' } },
      { package: 'build_runner', kind: 'dev', current: { version: '2.15.0' }, latest: { version: '2.16.0' } },
      { package: 'meta', kind: 'transitive', current: null, latest: { version: '1.0.0' } },
    ],
  };
  const map = parseOutdated(payload);
  assert.equal(map.get('audio_session').kind, 'direct');
  assert.equal(map.get('build_runner').latest, '2.16.0');
  assert.equal(map.get('meta').current, null);
});

test('parseOutdated accepts a JSON string too', () => {
  const map = parseOutdated('{"packages":[{"package":"x","kind":"direct","current":{"version":"1.0.0"},"latest":{"version":"1.0.1"}}]}');
  assert.equal(map.get('x').latest, '1.0.1');
});

test('parsePins strips the caret and reads only requested names', () => {
  const pubspec = [
    '  flutter_foreground_task: ^9.2.2',
    '  audio_session: ^0.2.3',
    '  connectivity_plus: 6.1.0',
    '  mobile_scanner: ^7.2.0',
  ].join('\n');
  const pins = parsePins(pubspec, KGP_PLUGINS);
  assert.deepEqual(pins, {
    audio_session: '0.2.3',
    flutter_foreground_task: '9.2.2',
    mobile_scanner: '7.2.0',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:hooks`
Expected: FAIL — `Cannot find module '../deps-watch.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/deps-watch.mjs
// Pure helpers for the ops-17 deps-watch (#790). NO IO here — see
// scripts/deps-watch-run.mjs for the orchestrator. Unit-tested under
// scripts/tests/deps-watch.test.mjs (npm run test:hooks).

export const KGP_PLUGINS = ['audio_session', 'flutter_foreground_task', 'mobile_scanner'];
export const STICKY_MARKER = '<!-- ops-17-deps-watch -->';

/**
 * -1/0/1 by numeric semver core; prerelease/build metadata ignored.
 * Known limitation: collapses prerelease ordering, so `1.0.0` vs `1.0.0-beta`
 * compares EQUAL (stable-over-prerelease is under-reported). Safe for the three
 * KGP plugins (all pinned at stable). Revisit if a plugin pins a `-beta`/`-dev`.
 */
export function compareSemver(a, b) {
  const core = (v) => String(v).split('+')[0].split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** `flutter pub outdated --json --show-all` -> Map<name,{kind,current,latest}>. */
export function parseOutdated(jsonTextOrObj) {
  const data = typeof jsonTextOrObj === 'string' ? JSON.parse(jsonTextOrObj) : jsonTextOrObj;
  const map = new Map();
  for (const pkg of data.packages ?? []) {
    map.set(pkg.package, {
      kind: pkg.kind ?? 'transitive',
      current: pkg.current?.version ?? null,
      latest: pkg.latest?.version ?? null,
    });
  }
  return map;
}

/** Read `name: ^x.y.z` (or bare `x.y.z`) pins for the requested names. */
export function parsePins(pubspecText, names) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // names are a param — never trust them raw in a RegExp
  const pins = {};
  for (const name of names) {
    const m = pubspecText.match(new RegExp(`^\\s*${escape(name)}:\\s*\\^?([0-9][^\\s#]*)`, 'm'));
    if (m) pins[name] = m[1];
  }
  return pins;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:hooks`
Expected: PASS (all Task 1 tests green).

- [ ] **Step 5: Commit**

```bash
git add scripts/deps-watch.mjs scripts/tests/deps-watch.test.mjs
git commit -m "feat(scripts): ops-17 deps-watch helper — parsing + semver core"
```

---

### Task 2: Pure helper — report logic (behind / plugin status / transitions / state)

**Files:**
- Modify: `scripts/deps-watch.mjs`
- Test: `scripts/tests/deps-watch.test.mjs`

**Interfaces:**
- Consumes: `KGP_PLUGINS`, `compareSemver` (Task 1).
- Produces: `computeBehind(pkgMap) -> [{name,kind,current,latest}]`; `computePluginStatus(pkgMap, pins, plugins?) -> [{name,pin,latest,ahead}]`; `extractState(commentBody) -> {name:{latest,ahead}}`; `buildState(pluginStatus) -> {name:{latest,ahead}}`; `computeTransitions(pluginStatus, priorState) -> string[]`; `exitCodeFor(behind) -> 0|1`; `findSticky(comments, marker?) -> comment|null`; `stickyRequest(existing, repo, issue) -> {method:'PATCH'|'POST', path}`.

- [ ] **Step 1: Write the failing test**

```js
// append to scripts/tests/deps-watch.test.mjs
import {
  computeBehind,
  computePluginStatus,
  extractState,
  buildState,
  computeTransitions,
  exitCodeFor,
  findSticky,
  stickyRequest,
} from '../deps-watch.mjs';

const pkgMap = (entries) => new Map(Object.entries(entries));

test('computeBehind: only direct/dev with latest>current', () => {
  const map = pkgMap({
    audio_session: { kind: 'direct', current: '0.2.3', latest: '0.2.3' }, // current
    build_runner: { kind: 'dev', current: '2.15.0', latest: '2.16.0' },   // behind (dev)
    just_audio: { kind: 'direct', current: '0.10.5', latest: '0.10.6' },  // behind (direct)
    meta: { kind: 'transitive', current: '1.0.0', latest: '2.0.0' },      // transitive: ignored
  });
  const behind = computeBehind(map).map((b) => b.name).sort();
  assert.deepEqual(behind, ['build_runner', 'just_audio']);
});

test('exitCodeFor: red iff something is behind', () => {
  assert.equal(exitCodeFor([]), 0);
  assert.equal(exitCodeFor([{ name: 'x' }]), 1);
});

test('computePluginStatus: ahead when latest>pin; absent pkg treated as at-pin', () => {
  const pins = { audio_session: '0.2.3', flutter_foreground_task: '9.2.2', mobile_scanner: '7.2.0' };
  const map = pkgMap({
    audio_session: { kind: 'direct', current: '0.2.3', latest: '0.2.4' }, // newer
    flutter_foreground_task: { kind: 'direct', current: '9.2.2', latest: '9.2.2' },
    // mobile_scanner absent -> at pin
  });
  const status = computePluginStatus(map, pins);
  const byName = Object.fromEntries(status.map((s) => [s.name, s]));
  assert.equal(byName.audio_session.ahead, true);
  assert.equal(byName.audio_session.latest, '0.2.4');
  assert.equal(byName.flutter_foreground_task.ahead, false);
  assert.equal(byName.mobile_scanner.ahead, false);
  assert.equal(byName.mobile_scanner.latest, '7.2.0'); // falls back to pin
});

test('extractState parses the embedded JSON; empty/garbage -> {}', () => {
  const body = `${'<!-- ops-17-deps-watch -->'}\n<!-- state: {"audio_session":{"latest":"0.2.3","ahead":false}} -->\nbody`;
  assert.deepEqual(extractState(body), { audio_session: { latest: '0.2.3', ahead: false } });
  assert.deepEqual(extractState(undefined), {});
  assert.deepEqual(extractState('no marker here'), {});
});

test('computeTransitions: fires only on at-pin -> ahead', () => {
  const status = [
    { name: 'audio_session', ahead: true },
    { name: 'mobile_scanner', ahead: true },
  ];
  // audio_session was already ahead last run; mobile_scanner just flipped.
  const prior = { audio_session: { ahead: true }, mobile_scanner: { ahead: false } };
  assert.deepEqual(computeTransitions(status, prior), ['mobile_scanner']);
  // empty prior (first run) -> every currently-ahead plugin transitions
  assert.deepEqual(computeTransitions(status, {}), ['audio_session', 'mobile_scanner']);
});

test('computeTransitions: ahead->ahead does NOT re-fire (transition fires once)', () => {
  // The core A2 guarantee: a plugin already ahead last run must not re-spam #790.
  const status = [{ name: 'audio_session', ahead: true }];
  assert.deepEqual(computeTransitions(status, { audio_session: { ahead: true } }), []);
});

test('computeBehind: empty payload -> [] and exitCodeFor -> 0 (the green baseline)', () => {
  // parseOutdated is imported in the Task 1 block of this same test file.
  assert.deepEqual(computeBehind(parseOutdated('{}')), []);
  assert.deepEqual(computeBehind(parseOutdated('{"packages":[]}')), []);
  assert.equal(exitCodeFor(computeBehind(parseOutdated('{}'))), 0);
});

test('computeBehind: a direct dep ABSENT from the payload cannot be behind (absent = at latest)', () => {
  const map = pkgMap({ just_audio: { kind: 'direct', current: '0.10.5', latest: '0.10.5' } });
  assert.deepEqual(computeBehind(map), []); // audio_session etc. simply absent -> not behind, not an error
});

test('computePluginStatus: a MAJOR bump the caret pin blocks still reads as ahead (drives off latest)', () => {
  // The headline A2 scenario: pin ^7.2.0 caps resolvable, but latest shows 8.0.0.
  const pins = { mobile_scanner: '7.2.0' };
  const map = pkgMap({ mobile_scanner: { kind: 'direct', current: '7.2.0', latest: '8.0.0' } });
  const [s] = computePluginStatus(map, pins, ['mobile_scanner']);
  assert.equal(s.ahead, true);
  assert.equal(s.latest, '8.0.0');
});

test('extractState: marker present but JSON malformed -> {} (no throw)', () => {
  const body = '<!-- ops-17-deps-watch -->\n<!-- state: {not valid json -->\nbody';
  assert.deepEqual(extractState(body), {});
});

test('buildState round-trips through extractState; records ahead:false too', () => {
  const status = [
    { name: 'audio_session', pin: '0.2.3', latest: '0.2.4', ahead: true },
    { name: 'mobile_scanner', pin: '7.2.0', latest: '7.2.0', ahead: false },
  ];
  const state = buildState(status);
  assert.deepEqual(state, {
    audio_session: { latest: '0.2.4', ahead: true },
    mobile_scanner: { latest: '7.2.0', ahead: false },
  });
});

test('findSticky: locates the marker comment even when a human commented later', () => {
  const comments = [
    { id: 1, body: 'a human note' },
    { id: 2, body: '<!-- ops-17-deps-watch -->\nstatus' },
    { id: 3, body: 'a later human note' },
  ];
  assert.equal(findSticky(comments).id, 2);
  assert.equal(findSticky([{ id: 9, body: 'nothing here' }]), null);
  assert.equal(findSticky([]), null);
});

test('stickyRequest: PATCH on the existing numeric id, else POST to the issue', () => {
  assert.deepEqual(stickyRequest({ id: 42 }, 'o/r', '790'), {
    method: 'PATCH',
    path: 'repos/o/r/issues/comments/42',
  });
  assert.deepEqual(stickyRequest(null, 'o/r', '790'), {
    method: 'POST',
    path: 'repos/o/r/issues/790/comments',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:hooks`
Expected: FAIL — `computeBehind` (and the other new names) `is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to scripts/deps-watch.mjs

/** direct/dev packages whose latest exceeds current. */
export function computeBehind(pkgMap) {
  const behind = [];
  for (const [name, p] of pkgMap) {
    if ((p.kind === 'direct' || p.kind === 'dev') && p.current && p.latest && compareSemver(p.latest, p.current) > 0) {
      behind.push({ name, kind: p.kind, current: p.current, latest: p.latest });
    }
  }
  return behind;
}

export function exitCodeFor(behind) {
  return behind.length ? 1 : 0;
}

/** Per-plugin {pin, latest, ahead}; an absent package is treated as at-pin. */
export function computePluginStatus(pkgMap, pins, plugins = KGP_PLUGINS) {
  return plugins.map((name) => {
    const pin = pins[name] ?? null;
    const latest = pkgMap.get(name)?.latest ?? pin;
    const ahead = !!(pin && latest && compareSemver(latest, pin) > 0);
    return { name, pin, latest, ahead };
  });
}

export function extractState(commentBody) {
  if (!commentBody) return {};
  const m = commentBody.match(/<!--\s*state:\s*([\s\S]*?)\s*-->/);
  if (!m) return {};
  try {
    return JSON.parse(m[1]);
  } catch {
    return {};
  }
}

export function buildState(pluginStatus) {
  const state = {};
  for (const s of pluginStatus) state[s.name] = { latest: s.latest, ahead: s.ahead };
  return state;
}

/** Plugins that are ahead now but were not ahead in the prior state. */
export function computeTransitions(pluginStatus, priorState) {
  return pluginStatus.filter((s) => s.ahead && !priorState[s.name]?.ahead).map((s) => s.name);
}

/** The single sticky comment (by marker), or null. Found even if a human
 *  commented after it — so the orchestrator never creates a duplicate. */
export function findSticky(comments, marker = STICKY_MARKER) {
  return comments.find((c) => (c.body || '').includes(marker)) || null;
}

/** The gh-api REST request for refreshing the sticky: PATCH the existing
 *  comment by its NUMERIC id, else POST a new one to the issue. */
export function stickyRequest(existing, repo, issue) {
  return existing
    ? { method: 'PATCH', path: `repos/${repo}/issues/comments/${existing.id}` }
    : { method: 'POST', path: `repos/${repo}/issues/${issue}/comments` };
}
```

(`STICKY_MARKER` is exported from the Task 1 block; `findSticky` references it as the default arg.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:hooks`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/deps-watch.mjs scripts/tests/deps-watch.test.mjs
git commit -m "feat(scripts): ops-17 deps-watch — behind/plugin-status/transition logic"
```

---

### Task 3: Pure helper — rendering (summary / sticky / transition comment)

**Files:**
- Modify: `scripts/deps-watch.mjs`
- Test: `scripts/tests/deps-watch.test.mjs`

**Interfaces:**
- Consumes: `STICKY_MARKER`, `buildState` (Tasks 1-2).
- Produces: `renderBody({pluginStatus, behind, today}) -> string`; `renderSummary` (= `renderBody`); `renderSticky({pluginStatus, behind, today}) -> string` (marker + state + body); `renderTransitionComment(transitions, pluginStatus, mention?) -> string|null`.

- [ ] **Step 1: Write the failing test**

```js
// append to scripts/tests/deps-watch.test.mjs
import {
  STICKY_MARKER,
  renderSticky,
  renderSummary,
  renderTransitionComment,
} from '../deps-watch.mjs';

const STATUS_CLEAN = [
  { name: 'audio_session', pin: '0.2.3', latest: '0.2.3', ahead: false },
  { name: 'flutter_foreground_task', pin: '9.2.2', latest: '9.2.2', ahead: false },
  { name: 'mobile_scanner', pin: '7.2.0', latest: '7.2.0', ahead: false },
];
const STATUS_AHEAD = [
  { name: 'audio_session', pin: '0.2.3', latest: '0.3.0', ahead: true },
  { name: 'flutter_foreground_task', pin: '9.2.2', latest: '9.2.2', ahead: false },
  { name: 'mobile_scanner', pin: '7.2.0', latest: '7.2.0', ahead: false },
];

test('renderSticky embeds the marker + a parseable state block', () => {
  const md = renderSticky({ pluginStatus: STATUS_AHEAD, behind: [], today: '2026-07-01' });
  assert.ok(md.includes(STICKY_MARKER));
  assert.match(md, /<!-- state: .*audio_session.*-->/);
  assert.ok(md.includes('⚠️')); // banner when a plugin is ahead
  assert.ok(md.includes('verify')); // honest "verify whether it removed KGP" wording
});

test('renderSummary (no marker) shows the all-clear line when nothing is ahead', () => {
  const md = renderSummary({ pluginStatus: STATUS_CLEAN, behind: [], today: '2026-07-01' });
  assert.ok(!md.includes(STICKY_MARKER));
  assert.ok(/still at their pin/i.test(md));
  assert.ok(/None — all direct\/dev deps current/i.test(md));
});

test('renderSummary lists behind deps in a table', () => {
  const md = renderSummary({
    pluginStatus: STATUS_CLEAN,
    behind: [{ name: 'build_runner', kind: 'dev', current: '2.15.0', latest: '2.16.0' }],
    today: '2026-07-01',
  });
  assert.ok(md.includes('build_runner'));
  assert.ok(md.includes('2.16.0'));
});

test('renderTransitionComment: null when no transitions; @mention + recipe otherwise', () => {
  assert.equal(renderTransitionComment([], STATUS_AHEAD), null);
  const md = renderTransitionComment(['audio_session'], STATUS_AHEAD);
  assert.ok(md.includes('@dudarenok-maker'));
  assert.ok(md.includes('audio_session'));
  assert.ok(md.includes('0.3.0'));
  assert.ok(/flutter build apk --release/.test(md));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:hooks`
Expected: FAIL — render functions not exported.

- [ ] **Step 3: Write minimal implementation**

```js
// append to scripts/deps-watch.mjs

/** The human-visible markdown (used for both the job summary and sticky body). */
export function renderBody({ pluginStatus, behind, today }) {
  const anyAhead = pluginStatus.some((s) => s.ahead);
  const lines = [`### ops-17 deps watch — updated ${today}`, ''];
  if (anyAhead) {
    const names = pluginStatus
      .filter((s) => s.ahead)
      .map((s) => `\`${s.name}\` (pin ${s.pin} → latest ${s.latest})`)
      .join(', ');
    lines.push(`> ⚠️ **A KGP plugin has a newer version: ${names}.**`);
    lines.push('> A newer version is **not** proof it removed KGP — verify: bump locally → `flutter build apk --release` → confirm the KGP warning is gone.');
    lines.push('');
  } else {
    lines.push('_All three KGP plugins are still at their pin — no migrated release yet (blocked upstream, ops-17)._');
    lines.push('');
  }
  lines.push('| KGP plugin | pin | latest | newer? |', '|---|---|---|---|');
  for (const s of pluginStatus) {
    lines.push(`| \`${s.name}\` | ${s.pin ?? '?'} | ${s.latest ?? '?'} | ${s.ahead ? '**yes**' : 'no'} |`);
  }
  lines.push('', `#### Direct/dev deps behind latest (${behind.length})`);
  if (behind.length) {
    lines.push('| package | kind | current | latest |', '|---|---|---|---|');
    for (const b of behind) lines.push(`| \`${b.name}\` | ${b.kind} | ${b.current} | ${b.latest} |`);
  } else {
    lines.push('_None — all direct/dev deps current._');
  }
  return lines.join('\n');
}

export const renderSummary = renderBody;

export function renderSticky(args) {
  const state = buildState(args.pluginStatus);
  return [STICKY_MARKER, `<!-- state: ${JSON.stringify(state)} -->`, '', renderBody(args)].join('\n');
}

export function renderTransitionComment(transitions, pluginStatus, mention = '@dudarenok-maker') {
  if (!transitions.length) return null;
  const items = transitions.map((name) => {
    const s = pluginStatus.find((x) => x.name === name);
    return `- \`${name}\`: pin ${s.pin} → latest ${s.latest}`;
  });
  return [
    `${mention} — ops-17: a KGP plugin now has a newer version. Verify whether it removed KGP (built-in Kotlin / AGP 9):`,
    '',
    ...items,
    '',
    'Recipe: bump locally → `flutter build apk --release` → if the KGP warning is gone, bump the pin, drop the escape-hatch flags + the `app.yml` Trip-B flag assertion, and close #790.',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:hooks`
Expected: PASS (full Task 1-3 suite green).

- [ ] **Step 5: Commit**

```bash
git add scripts/deps-watch.mjs scripts/tests/deps-watch.test.mjs
git commit -m "feat(scripts): ops-17 deps-watch — summary/sticky/transition rendering"
```

---

### Task 4: IO orchestrator (`deps-watch-run.mjs`)

**Files:**
- Create: `scripts/deps-watch-run.mjs`

**Interfaces:**
- Consumes: every export of `scripts/deps-watch.mjs` — note the **create-vs-edit decision** (`findSticky`/`stickyRequest`) and **transition-once** logic are pure and already unit-tested in Tasks 2-3, so this file is a thin wire-up. The remaining un-unit-tested surface is only the live `gh` round-trip + exit-code plumbing, validated by the `workflow_dispatch` acceptance run (Task 7).
- Produces: a CLI entrypoint the workflow calls as `node ../../scripts/deps-watch-run.mjs <outdated-json-path>`. No new exports. Exit contract: **0** clean · **1** A1 (a direct/dev dep behind) · **2** tooling fault (disjoint, via try/catch).

- [ ] **Step 1: Write the orchestrator**

```js
// scripts/deps-watch-run.mjs
// ops-17 deps-watch IO orchestrator (#790). Pure logic lives in
// scripts/deps-watch.mjs (unit-tested); this file does only IO:
// read pubspec + the pub-outdated JSON, fetch/refresh the sticky comment via
// `gh api`, write the job summary, post the A2 transition comment, set exit code.
// Exercised by the workflow_dispatch acceptance run, not by node --test.
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  KGP_PLUGINS,
  parseOutdated,
  parsePins,
  computeBehind,
  computePluginStatus,
  extractState,
  computeTransitions,
  findSticky,
  stickyRequest,
  renderSticky,
  renderSummary,
  renderTransitionComment,
  exitCodeFor,
} from './deps-watch.mjs';

// Exit codes are a deliberate, DISJOINT signalling contract (spec):
//   0 = clean, nothing behind        1 = A1 catch-up nudge (a direct/dev dep behind)
//   2 = TOOLING fault (bad env, gh/network/IO error) — NEVER conflated with A1.
const TOOLING_FAULT = 2;

const repo = process.env.GITHUB_REPOSITORY;
const issue = process.env.OPS17_ISSUE || '790';
const today = new Date().toISOString().slice(0, 10);
const outdatedPath = process.argv[2] || 'outdated.json';

// `-f` (raw field) — NOT `-F`. execFileSync passes literal bytes (no shell), so
// real newlines / backticks / `|` transmit fine and gh JSON-encodes them. `-F`
// would re-escape and would interpret the transition body's leading `@mention`
// as a file (gh community #148257). Do not "fix" this to `-F`.
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' });

try {
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');

  // 1. Inputs (path resolves from this file: scripts/ -> repo-root/apps/android)
  const pubspec = readFileSync(new URL('../apps/android/pubspec.yaml', import.meta.url), 'utf8');
  const pins = parsePins(pubspec, KGP_PLUGINS);
  const pkgMap = parseOutdated(readFileSync(outdatedPath, 'utf8'));

  // 2. Compute (pure)
  const behind = computeBehind(pkgMap);
  const pluginStatus = computePluginStatus(pkgMap, pins);

  // 3. Prior state from the existing sticky comment (REST list -> numeric id).
  //    `--paginate` returns ONE merged JSON array; [] on a zero-comment thread.
  const raw = gh(['api', `repos/${repo}/issues/${issue}/comments`, '--paginate']).trim();
  const comments = raw ? JSON.parse(raw) : [];
  const existing = findSticky(comments);
  const transitions = computeTransitions(pluginStatus, extractState(existing?.body));

  // 4. Job summary
  const summary = renderSummary({ pluginStatus, behind, today });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  // 5. Sticky comment — edit in place, or create once (decision is pure)
  const stickyBody = renderSticky({ pluginStatus, behind, today });
  const req = stickyRequest(existing, repo, issue);
  gh(['api', req.path, '--method', req.method, '-f', `body=${stickyBody}`]);

  // 6. A2 transition notification (a NEW comment => a real GitHub notification)
  const transitionComment = renderTransitionComment(transitions, pluginStatus);
  if (transitionComment) {
    gh(['api', `repos/${repo}/issues/${issue}/comments`, '--method', 'POST', '-f', `body=${transitionComment}`]);
  }

  console.log(`deps-watch: ${behind.length} direct/dev behind; transitions: ${transitions.join(',') || 'none'}`);
  process.exit(exitCodeFor(behind)); // 0 or 1 — the clean path only
} catch (err) {
  // gh/network/IO/parse fault => exit 2, NEVER the A1 exit 1.
  console.error(`::error::deps-watch tooling fault — ${err.message}`);
  process.exit(TOOLING_FAULT);
}
```

> **Why this is structured as try/catch → exit 2:** `execFileSync('gh', …)` throws on any non-zero `gh` exit (403, rate-limit, network). Without the catch, that throw makes Node exit 1 — indistinguishable from A1's "a dep is behind". The catch routes every tooling fault to the disjoint exit 2, satisfying the spec's "tooling faults are never conflated with A1" contract on the `gh` side too (the workflow's bash wrapper already does it for the `flutter pub outdated` side).

- [ ] **Step 2: Syntax-check the orchestrator**

Run: `node --check scripts/deps-watch-run.mjs`
Expected: no output, exit 0 (parses clean).

- [ ] **Step 3: Smoke-test the wiring offline (no `gh`/network)**

This proves the import graph + pure path resolve. Create a throwaway fixture, point the script at a missing repo so it exits before any `gh` call only if env is unset — instead we assert the pure import chain via a one-liner:

Run:
```bash
node --input-type=module -e "import('./scripts/deps-watch.mjs').then(m => { console.log(typeof m.renderSticky === 'function' && typeof m.computeBehind === 'function'); })"
```
Expected: prints `true`.

- [ ] **Step 4: Commit**

```bash
git add scripts/deps-watch-run.mjs
git commit -m "feat(scripts): ops-17 deps-watch IO orchestrator (gh sticky + summary)"
```

---

### Task 5: Scheduled workflow `app-deps-watch.yml`

**Files:**
- Create: `.github/workflows/app-deps-watch.yml`

**Interfaces:**
- Consumes: `scripts/deps-watch-run.mjs` (Task 4).
- Produces: a monthly + on-demand workflow. No code interface; validated by a real `workflow_dispatch` run in Task 7's acceptance.

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/app-deps-watch.yml
name: app-deps-watch

# ops-17 / #790 — monthly pub-dependency watch for the Flutter companion.
# A1: red when any DIRECT/DEV apps/android dep is behind `latest` (catch-up nudge).
# A2: a dedicated KGP-migration channel — a ⚠️ banner + a one-off @mention on #790
# when audio_session / flutter_foreground_task / mobile_scanner first show a newer
# version (the rare event ops-17 exists to catch), so it is never buried under A1.
# All logic is the unit-tested scripts/deps-watch.mjs; this just runs it.
on:
  workflow_dispatch:
  schedule:
    # 1st of the month, 03:00 UTC — off-peak, mirrors cross-os.yml. Monthly
    # (not weekly): these plugins move on a multi-month cadence.
    - cron: '0 3 1 * *'

permissions:
  contents: read
  issues: write

# Serialize a manual fire that overlaps the cron so the sticky comment is never
# double-created. cancel-in-progress:false => queue, never cancel mid-PATCH.
concurrency:
  group: app-deps-watch
  cancel-in-progress: false

jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
          # KEEP IN LOCKSTEP with app.yml — app.yml's Trip-B step asserts equality.
          flutter-version: 3.44.1
          cache: true
      - name: Resolve deps
        working-directory: apps/android
        run: flutter pub get
      - name: Deps watch (A1 nudge + A2 KGP channel)
        working-directory: apps/android
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
        run: |
          set -uo pipefail
          # Capture pub-outdated's own exit deliberately: 65/69 = tooling fault,
          # which must surface as exit 2, NOT be conflated with A1's "behind" (1).
          if ! flutter pub outdated --json --show-all > outdated.json; then
            echo "::error::flutter pub outdated failed (tooling fault, not a deps signal)"
            exit 2
          fi
          node ../../scripts/deps-watch-run.mjs outdated.json
```

- [ ] **Step 2: Validate the YAML parses**

Run:
```bash
node --input-type=module -e "import('node:fs').then(async fs => { const t = fs.readFileSync('.github/workflows/app-deps-watch.yml','utf8'); console.log(t.includes('app-deps-watch') && t.includes('cancel-in-progress: false') && t.includes('flutter-version: 3.44.1')); })"
```
Expected: prints `true`. (If `actionlint` is installed locally, also run `actionlint .github/workflows/app-deps-watch.yml` — optional; CI has no actionlint gate.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/app-deps-watch.yml
git commit -m "feat(ci): ops-17 app-deps-watch monthly workflow (#790)"
```

---

### Task 6: Trip B — escape-hatch + Flutter-pin assertions in `app.yml`

**Files:**
- Modify: `.github/workflows/app.yml` (add two guard steps to the `android` job, after the `flutter build appbundle --release` step / alongside the 16 KB guard)
- Modify: `apps/android/android/gradle.properties` (enrich the two flag comments)

**Interfaces:**
- Consumes: the `app-deps-watch.yml` file from Task 5 (the pin-lockstep step greps it).
- Produces: PR-time red on flag deletion or pin drift. No code interface.

- [ ] **Step 1: Enrich the `gradle.properties` comments**

Replace the two existing template comment lines so the flags are self-documenting. Find:

```
# This newDsl flag was added by the Flutter template
android.newDsl=false
# This builtInKotlin flag was added by the Flutter template
android.builtInKotlin=false
```

Replace with:

```
# KGP escape hatch (ops-17 / #790): these two flags keep Flutter's built-in
# Kotlin OFF so the still-unmigrated KGP plugins (audio_session,
# flutter_foreground_task, mobile_scanner) keep building under AGP 9. Do NOT
# delete until those plugins ship built-in-Kotlin releases — app.yml asserts
# both are present and that the Flutter pin stays in lockstep with app-deps-watch.yml.
android.newDsl=false
android.builtInKotlin=false
```

- [ ] **Step 2: Add the two guard steps to `app.yml`**

In the `android:` job, immediately after the `- run: flutter build appbundle --release` step, add:

```yaml
      # ops-17 / #790 — Trip B. The KGP escape-hatch flags must stay present:
      # deleting them silently re-breaks the build under AGP 9 (the unmigrated
      # audio_session / flutter_foreground_task / mobile_scanner plugins).
      - name: Guard KGP escape-hatch flags (ops-17 / #790)
        run: |
          set -euo pipefail
          props=android/gradle.properties
          for flag in 'android.builtInKotlin=false' 'android.newDsl=false'; do
            grep -qF "$flag" "$props" || {
              echo "::error::missing '$flag' in $props — KGP escape hatch (ops-17/#790)"; exit 1; }
          done
          echo "ok: KGP escape-hatch flags present"
      # ops-17 / #790 — Trip B. The whole "escape-hatch removal can't surprise
      # us" guarantee rests on the Flutter pin holding. Assert EVERY flutter-version
      # in app.yml (it pins two jobs: android + ios-compile) AND app-deps-watch.yml
      # is the SAME version, so neither drifts silently.
      - name: Guard Flutter-pin lockstep (ops-17 / #790)
        working-directory: ${{ github.workspace }}
        run: |
          set -uo pipefail
          # `sort -u` over ALL pins from both files; `head` is LAST in each pipe
          # so nothing writes to a closed pipe (avoids a SIGPIPE false-red under
          # pipefail). One unique value across both files == lockstep.
          pins=$(grep -hE 'flutter-version:' \
                   .github/workflows/app.yml \
                   .github/workflows/app-deps-watch.yml \
                 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -u)
          count=$(printf '%s\n' "$pins" | grep -c .)
          if [ "$count" -ne 1 ]; then
            echo "::error::Flutter pin drift across app.yml / app-deps-watch.yml (ops-17/#790):"
            printf '%s\n' "$pins"
            exit 1
          fi
          echo "ok: Flutter pin lockstep at $pins"
```

(`app.yml`'s job uses `defaults.run.working-directory: apps/android`, so the flag guard's `android/gradle.properties` resolves correctly; the pin guard overrides `working-directory` to the repo root to read both workflow files. `grep -h` suppresses filename prefixes so only version tokens reach `sort -u`.)

- [ ] **Step 3: Verify the guards locally (both pass on the real tree)**

Run from the repo root:
```bash
bash -c 'set -uo pipefail; props=apps/android/android/gradle.properties; for f in "android.builtInKotlin=false" "android.newDsl=false"; do grep -qF "$f" "$props" && echo "ok: $f"; done; pins=$(grep -hE "flutter-version:" .github/workflows/app.yml .github/workflows/app-deps-watch.yml | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | sort -u); [ "$(printf "%s\n" "$pins" | grep -c .)" -eq 1 ] && echo "ok: pin lockstep $pins"'
```
Expected: `ok: android.builtInKotlin=false`, `ok: android.newDsl=false`, `ok: pin lockstep 3.44.1`.

- [ ] **Step 4: Verify the guard fails when a flag is removed (negative check)**

Run:
```bash
bash -c 'tmp=$(mktemp); grep -v "android.newDsl=false" apps/android/android/gradle.properties > "$tmp"; if grep -qF "android.newDsl=false" "$tmp"; then echo "UNEXPECTED pass"; else echo "ok: guard would fire (flag absent)"; fi; rm -f "$tmp"'
```
Expected: `ok: guard would fire (flag absent)`. (No file is modified — this checks a temp copy.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/app.yml apps/android/android/gradle.properties
git commit -m "feat(ci): ops-17 Trip B — guard KGP escape-hatch flags + Flutter-pin lockstep (#790)"
```

---

### Task 7: Housekeeping, docs, and final verify

**Files:**
- Modify: `docs/BACKLOG.md` (the `ops-17` row)
- Modify: `docs/superpowers/specs/2026-06-19-ops-17-kgp-guardrail-design.md` (status → active/landed)
- (Manual, documented) re-date #790 body via `gh`

**Interfaces:** none (docs + issue housekeeping).

- [ ] **Step 1: Update the `ops-17` row in `docs/BACKLOG.md`**

Find the `_What:_` line of the `ops-17` row (currently ends "…re-check `flutter pub outdated` periodically and bump when upstream ships support.") and append, in the same paragraph:

```
 **Guardrail landed 2026-06-19** (`feat/app-ops-17-kgp-guardrail`): `app-deps-watch.yml` runs a monthly `flutter pub outdated` watch — A1 reds on any direct/dev drift (catch-up nudge), A2 posts a dedicated ⚠️ banner + one-off @mention on #790 when one of the three KGP plugins first shows a newer version — and `app.yml` now asserts the escape-hatch flags + Flutter-pin lockstep (Trip B). The item **stays open** (still blocked upstream; the guardrail is the interim watch, not the migration). Plan: `docs/superpowers/plans/2026-06-19-ops-17-kgp-guardrail.md`.
```

- [ ] **Step 2: Mark the spec landed**

In `docs/superpowers/specs/2026-06-19-ops-17-kgp-guardrail-design.md`, change the `- **Status:**` line to:

```
- **Status:** implemented on `feat/app-ops-17-kgp-guardrail`; #790 stays open (blocked upstream)
```

- [ ] **Step 3: Run the full helper suite + confirm no regressions**

Run: `npm run test:hooks`
Expected: PASS, including every `deps-watch` case from Tasks 1-3.

- [ ] **Step 4: Commit the housekeeping**

```bash
git add docs/BACKLOG.md docs/superpowers/specs/2026-06-19-ops-17-kgp-guardrail-design.md
git commit -m "docs(app): ops-17 guardrail — backlog + spec status (Refs #790)"
```

- [ ] **Step 5: Re-date the #790 body (manual one-liner — run once, after merge)**

This is the one-time body re-date (the monthly sticky comment handles ongoing status). Run locally with the repo's `gh` auth:

```bash
gh issue view 790 --json body --jq .body > /tmp/790.md
printf '> _Re-confirmed blocked upstream 2026-06-19; interim guardrail landed (app-deps-watch.yml + app.yml Trip B). See the auto-updated status comment below._\n\n' | cat - /tmp/790.md > /tmp/790.new.md
gh issue edit 790 --body-file /tmp/790.new.md
```
Expected: `gh` prints the issue URL. (Skip if you'd rather let the first `workflow_dispatch` sticky comment stand as the status of record — note the choice in the PR.)

- [ ] **Step 6: Post-merge acceptance (manual, documented in the PR)**

After merge to `main`, from the Actions tab (or `gh workflow run app-deps-watch.yml`):
1. Fire `app-deps-watch` once. Confirm: job summary shows the `--show-all` table; a single `<!-- ops-17-deps-watch -->` comment is **created** on #790; A2 shows "still at pin" (green today); the run's red/green reflects A1 (red iff a direct/dev dep is behind — expected, the catch-up nudge).
2. Fire it a **second** time. Confirm the same sticky comment is **edited** (no duplicate), proving the find-then-PATCH path + `--paginate`.
3. (Optional, proves exit-2 disjointness) Temporarily break the input — e.g. dispatch with a deleted `apps/android/.dart_tool/package_config.json`, or point the env `OPS17_ISSUE` at a non-existent issue so the `gh` fetch 404s — and confirm the run fails with the `::error::deps-watch tooling fault` / `flutter pub outdated failed` message and **exit 2**, distinct from a plain A1 red (exit 1).

---

## Self-Review

**Spec coverage:**
- Trip A1 (all-deps red) → Tasks 2 (`computeBehind`/`exitCodeFor`) + 4 + 5. ✓
- Trip A2 (dedicated KGP channel: banner + transition @mention, `latest` vs pin, honest wording) → Tasks 2 (`computePluginStatus`/`computeTransitions`) + 3 (`renderSticky`/`renderTransitionComment`) + 4. ✓
- Sticky comment (marker + state block, `gh api` PATCH on numeric id, `--paginate`, create-once) → Tasks 2-3 (state) + 4 (IO). ✓
- `concurrency` / `GH_TOKEN` / `issues: write` / `--show-all` / capture-exit-deliberately → Task 5. ✓
- Trip B (flag assertion + Flutter-pin lockstep + comment enrichment) → Task 6. ✓
- `kind` not `isDirect`; `latest` not `resolvable`; absent=at-pin → Tasks 1-2 (+ tests). ✓
- Housekeeping (#790 body, BACKLOG, spec status) → Task 7. ✓
- Deferred (build.gradle grep) → called out in Global Constraints + A2 wording is the honest fallback. ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every test step shows the assertions. ✓

**Type consistency:** `pluginStatus` objects carry `{name, pin, latest, ahead}` consistently across `computePluginStatus` (Task 2) → `buildState`/`renderBody`/`renderSticky`/`renderTransitionComment` (Task 3) → orchestrator (Task 4). `behind` objects carry `{name, kind, current, latest}` consistently. State shape `{name:{latest,ahead}}` matches between `buildState`, `extractState`, and `computeTransitions`. ✓

**Note on regression doc:** per CLAUDE.md, this localized CI-tooling change skips a `docs/features/` regression plan — the spec + this plan + the paired `node --test` suite (`scripts/tests/deps-watch.test.mjs`, the explicit regression record) are the record. `docs/features/INDEX.md` is therefore not touched.

## Revised after plan review (two adversarial passes)

Both blockers were test-layer; all fixes folded in above:

- **Tooling-fault vs A1 conflation (both reviews, BLOCKER):** orchestrator IO is now wrapped in try/catch → **exit 2** (disjoint from A1's exit 1) on any `gh`/IO/parse fault; exit contract documented inline + in Task 4 Interfaces; acceptance Step 6.3 exercises it.
- **Create-vs-edit seam "untestable" (BLOCKER):** extracted pure `findSticky` + `stickyRequest` (Task 2) with unit tests (marker found behind a later human comment; PATCH-on-id vs POST) — the decision is now proven, not just manually checked.
- **Transition-fires-once (BLOCKER):** added the `ahead→ahead → []` test (Task 2) — the core A2 no-re-spam guarantee.
- **Missing edge tests (SHOULD-FIX):** added empty-payload baseline, absent-direct-dep, major-bump-past-caret (the headline A2 case), malformed-state-JSON, and ahead/at-pin-mixed `buildState` cases.
- **`parsePins` RegExp injection (SHOULD-FIX):** plugin name is now regex-escaped.
- **Pin-lockstep `grep|head` SIGPIPE + dual-pin blind spot (SHOULD-FIX):** rewritten to `grep -h … | sort -u` over **all** pins in both files (`head` removed), asserting a single unique version — closes the ios-compile-pin blind spot and the false-red.
- **`compareSemver` prerelease collapse (SHOULD-FIX):** documented as a known limitation in the helper's doc-comment (safe for today's all-stable pins).
- **`-f` vs `-F` (technical reviewer, with gh-docs evidence):** plan's inline `-f body=` via `execFileSync` is **correct** (passes literal bytes, won't misread the `@mention` body); kept, with a comment forbidding a switch to `-F`. This overrode the spec's `-f body=@file` suggestion.
