# Pinokio One-Click Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Pinokio install script that one-click installs, builds-from-latest-release, launches, and lifecycle-manages Castwright in a fully self-contained runtime, handing off to the existing fs-21 first-run wizard.

**Architecture:** A root `pinokio.js` menu entry-point + `pinokio/{install,start,stop,update,reset}.js` declarative Pinokio scripts. All genuinely-testable logic lives in three **Node CLI helpers** under `pinokio/lib/` (`resolve-release`, `write-env`, `menu`) — invoked by the declarative scripts via `shell.run`/`require`, and unit-tested with `node:test`. The scripts reuse the existing shared bootstrap chain (`bootstrap-venv.mjs`, `launch.mjs`, `stop:prod`) and never duplicate install logic; GPU/overlay selection stays in `accelerator-profile.mjs`.

**Tech Stack:** Pinokio script API (declarative `module.exports = { run: [...] }`), Node 20+ (CommonJS island via `pinokio/package.json`), `node:test`, conda (Pinokio-bundled) for Python 3.12 + ffmpeg.

**Source spec:** `docs/superpowers/specs/2026-06-15-pinokio-installer-design.md`

---

## Pre-flight (read before Task 1)

- **Worktree:** This plan should execute in an isolated git worktree off `main` (per CLAUDE.md + superpowers:using-git-worktrees). The current `feat/scripts-pinokio-installer` branch is polluted with two unrelated AMD-docs commits from a concurrent session. **First execution step:** create a worktree off `main`, then `git cherry-pick 15b374d2 d73538ec` (the two clean spec commits) into it, and continue on a fresh branch (e.g. `feat/scripts-pinokio-installer-clean`). Leave the polluted branch alone.
- **Plan number:** This regression plan is **218**. If `docs/features/218-*.md` already exists at execution time (concurrent-session collision), bump to the next free number and update Task 9 accordingly.
- **GitHub repo constant:** `dudarenok-maker/Castwright`. Releases API: `https://api.github.com/repos/dudarenok-maker/Castwright/releases/latest`.
- **Open verifications (resolve during on-box acceptance, Task 10):** (1) **[highest risk]** `start.js` foreground launch — `node server/dist/index.js` from the app root autostarts the sidecar, loads `server/.env`/`WORKSPACE_DIR`, and Pinokio's native Stop reaps the sidecar (server SIGTERM handler, `index.ts:494`); (2) Pinokio's bundled Node ≥ 20.19 — else add `conda install -c conda-forge nodejs`; (3) `python -m venv` from a conda interpreter on all 3 OSes. **Closed by review:** Pinokio supports local `require()` (was open item 2) — confirmed via shipping apps.
- **Round-4 review-prep fold (R1–R7):** the declarative Pinokio scripts were updated to match shipping-app idiom (validated against TRELLIS/comfy/facefusion/roop): R1 foreground server + `daemon: true` + `info.running` (revises round-3 P2's pid-file); R2 `info.local(script)` function form; R3 path-keyed `conda: { path:'env', python }`; R4 menu items carry `icon` + `default` (no `target`); R5 native `fs.rm` in reset (reverts P4's `node -e rmSync`); R6 sibling-relative `script.start` uri; R7 drop unconfirmed `{{cwd}}` (helpers use `process.cwd()`). Plus code cleanups: dropped the no-op IIFE in `resolve-release.js` and the unused `join` in `write-env.js`.
- **Honesty note on the declarative Pinokio scripts (Tasks 5–8):** there is no headless Pinokio runtime, so these files are validated by **on-box manual acceptance**, not unit tests. The content below is concrete and best-effort against the Pinokio script API, but **the exact method/param spelling (`conda`, `venv`, `on`, `info`/`kernel` accessors) MUST be confirmed against current Pinokio docs during acceptance** and adjusted if needed. This is a known, scoped caveat — not a placeholder.

---

## File Structure

**Created:**
- `pinokio.js` — root menu entry-point (thin; delegates to `pinokio/lib/menu.js`).
- `pinokio/package.json` — `{"type":"commonjs"}` island so `pinokio/**/*.js` are CommonJS under the root `"type":"module"` package.
- `pinokio/install.js` — declarative provisioning steps.
- `pinokio/start.js` — launch step (daemon) with `on:` ready-URL regex.
- `pinokio/stop.js` — `npm run stop:prod`.
- `pinokio/update.js` — fetch tags → checkout newest published → rebuild.
- `pinokio/reset.js` — remove `.venv` + `node_modules` + `dist`, reinstall.
- `pinokio/lib/resolve-release.js` — Node CLI + exported `latestReleaseTag()` / `highestSemverTag()`.
- `pinokio/lib/write-env.js` — Node CLI + exported `buildEnvContents()`.
- `pinokio/lib/menu.js` — exported `buildMenu(state)`.
- `pinokio/lib/resolve-release.test.js`, `pinokio/lib/write-env.test.js`, `pinokio/lib/menu.test.js` — `node:test`.
- `scripts/run-pinokio-tests.mjs` — `node:test` runner (mirrors `run-hooks-tests.mjs`).
- `docs/features/218-pinokio-installer.md` — regression plan.

**Modified:**
- `package.json` — add `test:pinokio` script; chain it into `test:all`.
- `scripts/verify-cache.mjs` — add a `test:pinokio` STEP (scope `pinokio/**`).
- `eslint.config.*` — add `pinokio.js` + `pinokio/**` to the CommonJS/espree override.
- `INSTALL.md`, `README.md` — new "Install — Pinokio (one click)" section.
- `docs/features/INDEX.md` — new entry for plan 218.
- `docs/BACKLOG.md` — remove the ops-16 row.

**Explicitly NOT changed:** `release.yml`, `build-release-zip.mjs` MANIFEST (allowlist already excludes `pinokio/`), `fs-21`/`accelerator-profile.mjs`/`bootstrap-venv.mjs`/`launch.mjs` internals.

---

## Task 1: Scaffold the `pinokio/` CommonJS island + test harness

**Files:**
- Create: `pinokio/package.json`
- Create: `scripts/run-pinokio-tests.mjs`
- Modify: `package.json` (scripts)
- Modify: `scripts/verify-cache.mjs` (STEPS)
- Modify: `eslint.config.*`

- [ ] **Step 1: Create the CommonJS island marker**

Create `pinokio/package.json`:

```json
{
  "type": "commonjs",
  "private": true
}
```

- [ ] **Step 2: Create the test runner** (mirrors `scripts/run-hooks-tests.mjs`, but tolerates zero files so the gate stays green before Task 2 adds the first test)

Create `scripts/run-pinokio-tests.mjs`:

```js
#!/usr/bin/env node
// Run node:test against pinokio/lib/*.test.js (the CommonJS island). Mirrors
// scripts/run-hooks-tests.mjs; globs in JS (fast-glob) for cross-platform.
import { spawnSync } from 'node:child_process';
import fg from 'fast-glob';

const files = await fg('pinokio/lib/*.test.js', { onlyFiles: true });
if (files.length === 0) {
  process.stdout.write('[test:pinokio] no test files yet — skipping\n');
  process.exit(0);
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`run-pinokio-tests: failed to spawn node: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
```

- [ ] **Step 3: Wire the npm script + chain into `test:all`**

In `package.json` `scripts`, add `test:pinokio` and append it to the `test:all` chain:

```json
"test:pinokio": "node scripts/run-pinokio-tests.mjs",
"test:all": "npm run test:hooks && npm run test && npm run test:server && npm run test:server-slow && npm run test:scripts && npm run test:sidecar && npm run test:pinokio"
```

- [ ] **Step 4: Add the `test:pinokio` STEP to `verify-cache.mjs`**

In `scripts/verify-cache.mjs`, add a STEP entry mirroring the `test:hooks` entry (around line 60). Place it after the `test:hooks` step:

```js
{
  name: 'test:pinokio',
  inputs: {
    globs: ['pinokio/**'],
    extraFiles: ['scripts/run-pinokio-tests.mjs'],
    includeLockfiles: [],
  },
},
```

(Confirmed: `verify-cache.mjs` runs each step via `npm run <step.name>` — `scripts/verify-cache.mjs:626` — so the `test:pinokio` npm script from Step 3 is what executes. Every STEP carries `includeLockfiles`, so include it.)

- [ ] **Step 5: Add the ESLint CommonJS override for `pinokio/`**

In `eslint.config.js`, extend the existing `scripts` CommonJS/espree override's `files` glob (override[3] at **`eslint.config.js:210–218`** — `['scripts/**/*.mjs','scripts/**/*.cjs','scripts/**/*.js']`, `globals: {...globals.node}`, relaxes `@typescript-eslint/no-require-imports`) to also match `'pinokio.js'` and `'pinokio/**/*.js'`. If a single override can't cleanly cover both, add a sibling override object with the same `languageOptions` targeting `['pinokio.js', 'pinokio/**/*.js']`.

**P5 (confirmed no-op by review):** the override uses `globals.node`, which already provides `fetch` and `URL`, so `resolve-release.js` lints clean — no explicit globals needed. Left here only as a watch-point if the globals set changes.

- [ ] **Step 6: Run the harness to verify it's green (and a no-op so far)**

Run: `npm run test:pinokio`
Expected: `[test:pinokio] no test files yet — skipping` and exit 0.

Run: `npm run lint`
Expected: PASS (no errors from the new files).

- [ ] **Step 7: Commit**

```bash
git add pinokio/package.json scripts/run-pinokio-tests.mjs package.json scripts/verify-cache.mjs eslint.config.*
git commit -m "build(scripts): scaffold pinokio CommonJS island + node:test harness (ops-16)"
```

---

## Task 2: `resolve-release.js` — latest published release resolution

**Files:**
- Create: `pinokio/lib/resolve-release.js`
- Test: `pinokio/lib/resolve-release.test.js`

- [ ] **Step 1: Write the failing test**

Create `pinokio/lib/resolve-release.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestReleaseTag, highestSemverTag } = require('./resolve-release.js');

test('200 with tag_name → resolves that tag', () => {
  const out = latestReleaseTag({ status: 200, body: { tag_name: 'v1.7.0' } });
  assert.deepEqual(out, { kind: 'tag', tag: 'v1.7.0' });
});

test('404 → "none" (no published release), never main', () => {
  const out = latestReleaseTag({ status: 404, body: null });
  assert.deepEqual(out, { kind: 'none' });
});

test('network/other error → fallback signal', () => {
  assert.deepEqual(latestReleaseTag({ status: 0, body: null }), { kind: 'fallback' });
  assert.deepEqual(latestReleaseTag({ status: 500, body: null }), { kind: 'fallback' });
});

test('200 but malformed body → fallback (defensive)', () => {
  assert.deepEqual(latestReleaseTag({ status: 200, body: {} }), { kind: 'fallback' });
});

test('highestSemverTag picks the max vX.Y.Z, ignores non-semver', () => {
  assert.equal(highestSemverTag(['v1.2.0', 'v1.10.1', 'nightly', 'v1.9.9']), 'v1.10.1');
});

test('highestSemverTag returns null when no semver tags', () => {
  assert.equal(highestSemverTag(['main', 'latest']), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test pinokio/lib/resolve-release.test.js`
Expected: FAIL with `Cannot find module './resolve-release.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `pinokio/lib/resolve-release.js`:

```js
// Resolve AND checkout the latest PUBLISHED Castwright release tag.
// Pure functions (unit-tested) + a CLI (acceptance-tested) at the bottom.
//
// CLI (invoked by pinokio/install.js + pinokio/update.js as a SINGLE shell.run
// step — `node pinokio/lib/resolve-release.js`): git-fetches tags, resolves the
// latest published release, `git checkout`s it, and guards that the checked-out
// tree actually contains the pinokio scripts. Doing fetch+checkout INSIDE the
// node process avoids fragile cross-step Pinokio variable capture and
// cross-shell `$(...)` substitution (P1). Exits non-zero with a clear message
// when no release is published yet (P3) or when the resolved release predates
// Pinokio support.

const REPO = 'dudarenok-maker/Castwright';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Map a fetch outcome to a resolution decision. Pure.
 * @param {{status:number, body:any}} outcome
 * @returns {{kind:'tag', tag:string} | {kind:'none'} | {kind:'fallback'}}
 */
function latestReleaseTag(outcome) {
  if (outcome.status === 200 && outcome.body && typeof outcome.body.tag_name === 'string') {
    return { kind: 'tag', tag: outcome.body.tag_name };
  }
  if (outcome.status === 404) return { kind: 'none' };
  return { kind: 'fallback' };
}

/**
 * Highest vX.Y.Z tag from a list, or null. Pure.
 * @param {string[]} tagNames
 * @returns {string|null}
 */
function highestSemverTag(tagNames) {
  const parsed = tagNames
    .map((name) => {
      const m = SEMVER_TAG.exec(name);
      return m ? { name, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
    })
    .filter(Boolean);
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  return parsed[0].name;
}

module.exports = { latestReleaseTag, highestSemverTag };

// ---- CLI (acceptance-tested, not unit-tested) ----
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');

/** Resolve the tag to check out: API → published tag, 404 → exit, error → local fallback. */
async function resolveTag() {
  let outcome = { status: 0, body: null };
  try {
    const res = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'castwright-pinokio' },
    });
    outcome = { status: res.status, body: res.status === 200 ? await res.json() : null };
  } catch {
    outcome = { status: 0, body: null };
  }
  const decision = latestReleaseTag(outcome);
  if (decision.kind === 'tag') return decision.tag;
  if (decision.kind === 'none') {
    process.stderr.write(
      'No published Castwright release found yet. A Pinokio install requires at least ' +
        'one published GitHub release. Please try again once a release is available.\n',
    );
    process.exit(2);
  }
  // fallback: highest local git tag
  const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' })
    .split('\n').map((t) => t.trim()).filter(Boolean);
  const best = highestSemverTag(tags);
  if (!best) {
    process.stderr.write('GitHub Releases API unreachable and no local vX.Y.Z tag to fall back to.\n');
    process.exit(3);
  }
  process.stderr.write(`[resolve-release] API unreachable; falling back to local tag ${best}\n`);
  return best;
}

async function main() {
  execFileSync('git', ['fetch', '--tags', '--force'], { stdio: 'inherit' });
  const tag = await resolveTag();
  process.stderr.write(`[resolve-release] checking out ${tag}\n`);
  execFileSync('git', ['checkout', tag], { stdio: 'inherit' });
  // P3 — guard against a release that predates Pinokio support: git checkout to
  // such a tag would DELETE pinokio/ from the tree, breaking Start/Stop/Update.
  if (!existsSync('pinokio/start.js')) {
    process.stderr.write(
      `[resolve-release] release ${tag} predates Pinokio support (pinokio/ scripts absent ` +
        `after checkout). Update Pinokio or wait for the next release that includes them.\n`,
    );
    process.exit(4);
  }
  process.stdout.write(tag);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[resolve-release] ${e.message}\n`);
    process.exit(1);
  });
}
```

> **P3 release-sequencing note:** the Pinokio install path must only be announced from the release that first contains `pinokio/` onward. Between merging this work and cutting that release, `main` has `pinokio/` but the latest *published* release does not — the guard above turns that window into a clear error instead of a broken install.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test pinokio/lib/resolve-release.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add pinokio/lib/resolve-release.js pinokio/lib/resolve-release.test.js
git commit -m "feat(scripts): resolve latest published release for pinokio installer (ops-16)"
```

---

## Task 3: `write-env.js` — idempotent `server/.env` generation

**Files:**
- Create: `pinokio/lib/write-env.js`
- Test: `pinokio/lib/write-env.test.js`

- [ ] **Step 1: Write the failing test**

Create `pinokio/lib/write-env.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildEnvContents } = require('./write-env.js');

const EXAMPLE = [
  '# comment',
  'PORT=8080',
  'WORKSPACE_DIR=../audiobook-workspace',
  'OTHER=keep-me',
].join('\n');

test('returns null when .env already exists (idempotent)', () => {
  const out = buildEnvContents({ exampleText: EXAMPLE, appDir: '/app', envExists: true });
  assert.equal(out, null);
});

test('rewrites only the WORKSPACE_DIR line, preserves the rest', () => {
  const out = buildEnvContents({ exampleText: EXAMPLE, appDir: '/app', envExists: false });
  assert.match(out, /^WORKSPACE_DIR=\/app\/workspace$/m);
  assert.match(out, /^PORT=8080$/m);
  assert.match(out, /^OTHER=keep-me$/m);
  // exactly one WORKSPACE_DIR line
  assert.equal((out.match(/^WORKSPACE_DIR=/gm) || []).length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test pinokio/lib/write-env.test.js`
Expected: FAIL with `Cannot find module './write-env.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `pinokio/lib/write-env.js`:

```js
// Generate server/.env from server/.env.example with WORKSPACE_DIR pointed at
// <appDir>/workspace — but only if server/.env does not already exist
// (idempotent, so update/re-install preserve a user's edits).
//
// CLI: `node pinokio/lib/write-env.js <appDir>` — invoked by pinokio/install.js.

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

/**
 * Produce the .env contents, or null when .env already exists. Pure.
 * @param {{exampleText:string, appDir:string, envExists:boolean}} a
 * @returns {string|null}
 */
function buildEnvContents({ exampleText, appDir, envExists }) {
  if (envExists) return null;
  const workspace = `${appDir}/workspace`;
  return exampleText.replace(/^WORKSPACE_DIR=.*$/m, `WORKSPACE_DIR=${workspace}`);
}

module.exports = { buildEnvContents };

// ---- CLI (acceptance-tested) ----
if (require.main === module) {
  // appDir defaults to the app root (cwd) — install.js runs this from the repo
  // root, so no {{cwd}} template is needed (R7).
  const appDir = process.argv[2] || process.cwd();
  const examplePath = resolve('server', '.env.example');
  const envPath = resolve('server', '.env');
  const out = buildEnvContents({
    exampleText: readFileSync(examplePath, 'utf8'),
    appDir,
    envExists: existsSync(envPath),
  });
  if (out === null) {
    process.stdout.write('[write-env] server/.env already exists — left untouched\n');
  } else {
    writeFileSync(envPath, out, 'utf8');
    process.stdout.write(`[write-env] wrote server/.env (WORKSPACE_DIR=${appDir}/workspace)\n`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test pinokio/lib/write-env.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add pinokio/lib/write-env.js pinokio/lib/write-env.test.js
git commit -m "feat(scripts): idempotent server/.env writer for pinokio installer (ops-16)"
```

---

## Task 4: `menu.js` — state → menu items

**Files:**
- Create: `pinokio/lib/menu.js`
- Test: `pinokio/lib/menu.test.js`

- [ ] **Step 1: Write the failing test**

Create `pinokio/lib/menu.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const buildMenu = require('./menu.js');

const hrefs = (items) => items.map((i) => i.href);
const texts = (items) => items.map((i) => i.text);

test('not installed → only Install (primary, with icon)', () => {
  const items = buildMenu({ installed: false, running: false, url: null });
  assert.deepEqual(hrefs(items), ['pinokio/install.js']);
  assert.equal(items[0].text, 'Install');
  assert.equal(items[0].default, true);
  assert.match(items[0].icon, /^fa-/);
});

test('installed + stopped → Start (primary), Update, Reset (in order)', () => {
  const items = buildMenu({ installed: true, running: false, url: null });
  assert.deepEqual(texts(items), ['Start', 'Update', 'Reset']);
  assert.deepEqual(hrefs(items), ['pinokio/start.js', 'pinokio/update.js', 'pinokio/reset.js']);
  assert.equal(items[0].default, true);
});

test('installed + running → Open Web UI (primary, url), Stop, Update, Reset', () => {
  const items = buildMenu({ installed: true, running: true, url: 'http://localhost:8080' });
  assert.deepEqual(texts(items), ['Open Web UI', 'Stop', 'Update', 'Reset']);
  assert.equal(items[0].href, 'http://localhost:8080');
  assert.equal(items[0].default, true);
  assert.equal(items[1].href, 'pinokio/stop.js');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test pinokio/lib/menu.test.js`
Expected: FAIL with `Cannot find module './menu.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `pinokio/lib/menu.js`:

```js
// buildMenu(state) → ordered Pinokio menu items. Pure; unit-tested.
// `state` is derived in pinokio.js from Pinokio's runtime accessors.
// NOTE: the item SHAPE here (text/href/target) is our logic; the exact keys
// Pinokio renders are confirmed during on-box acceptance.
//
// @param {{installed:boolean, running:boolean, url:string|null}} state
// @returns {Array<{text:string, href:string, target?:string}>}
function buildMenu(state) {
  if (!state.installed) {
    return [{ default: true, icon: 'fa-solid fa-download', text: 'Install', href: 'pinokio/install.js' }];
  }
  const items = [];
  if (state.running) {
    // Font Awesome `icon` + `default` match the shipping-app menu-item shape
    // (no `target` — Pinokio opens the web UI itself). state.url is the captured URL.
    items.push({ default: true, icon: 'fa-solid fa-rocket', text: 'Open Web UI', href: state.url });
    items.push({ icon: 'fa-solid fa-stop', text: 'Stop', href: 'pinokio/stop.js' });
  } else {
    items.push({ default: true, icon: 'fa-solid fa-play', text: 'Start', href: 'pinokio/start.js' });
  }
  items.push({ icon: 'fa-solid fa-rotate', text: 'Update', href: 'pinokio/update.js' });
  items.push({ icon: 'fa-solid fa-trash', text: 'Reset', href: 'pinokio/reset.js' });
  return items;
}

module.exports = buildMenu;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test pinokio/lib/menu.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add pinokio/lib/menu.js pinokio/lib/menu.test.js
git commit -m "feat(scripts): pinokio menu state-mapping (ops-16)"
```

---

## Task 5: `pinokio.js` — menu entry-point

**Files:**
- Create: `pinokio.js`

> **No unit test** — this file runs only inside Pinokio's runtime; `buildMenu` (Task 4) holds the tested logic. Validated in Task 10 acceptance. **Open verification 2 is now CLOSED (confirmed by review):** Pinokio scripts routinely `require()` local modules (e.g. FaceFusion's `menu: require(__dirname + '/menu.js')`), so `require('./pinokio/lib/menu.js')` is supported — no inlining needed.

- [ ] **Step 1: Write the file**

Create `pinokio.js`:

```js
// Castwright — Pinokio entry-point. Thin: derives state from Pinokio's runtime
// accessors and delegates ordering to the unit-tested pinokio/lib/menu.js.
// Accessor shapes below match shipping Pinokio apps (TRELLIS/comfy/facefusion);
// confirmed on-box in Task 10.
const buildMenu = require(__dirname + '/pinokio/lib/menu.js');

module.exports = {
  version: '1.0',
  title: 'Castwright',
  description: 'Any book, performed by a full cast — effortlessly.',
  icon: 'icon.png',
  menu: async (kernel, info) => {
    const installed = info.exists('node_modules') && info.exists('server/.env');
    // R1 — start.js runs the server in the FOREGROUND under Pinokio with
    // `daemon: true`, so Pinokio tracks it: info.running() is the idiomatic
    // running-check (no pid-file polling).
    const running = info.running('pinokio/start.js');
    // R2 — info.local is a FUNCTION keyed by the script that set the local,
    // not a property. start.js does local.set({ url }).
    const local = info.local('pinokio/start.js');
    const url = (local && local.url) || null;
    return buildMenu({ installed, running, url });
  },
};
```

> **R1 lifecycle (revises round-3 P2):** the server runs in the **foreground** under Pinokio (`daemon: true`), so Pinokio tracks it natively — `info.running()` reflects reality and Pinokio's own Stop sends `SIGTERM`, which the server's handler (`server/src/index.ts:494`) uses to tear down the sidecar. No `.run/server.pid` polling, no stale-pid edge. `stop.js` remains as a defensive `stop:prod` sweep. **#1 on-box verification:** confirm the foreground command (`node server/dist/index.js`) autostarts the sidecar and loads `server/.env`/`WORKSPACE_DIR` when launched from the app root; if not, set `WORKSPACE_DIR` explicitly in the `start.js` step env.

- [ ] **Step 2: Pick the icon**

Run: `ls public/*.png`
Reference an existing brand PNG by relative path in the `icon` field (e.g. `public/<name>.png`), OR if Pinokio requires the icon adjacent to `pinokio.js`, copy one to `pinokio/icon.png` and set `icon: 'pinokio/icon.png'`. Update the `icon` field accordingly.

- [ ] **Step 3: Lint check**

Run: `npm run lint`
Expected: PASS (the Task 1 ESLint override covers `pinokio.js`).

- [ ] **Step 4: Commit**

```bash
git add pinokio.js pinokio/icon.png 2>/dev/null; git add pinokio.js
git commit -m "feat(scripts): pinokio menu entry-point (ops-16)"
```

---

## Task 6: `pinokio/install.js` — provisioning steps

**Files:**
- Create: `pinokio/install.js`

> **No unit test** (declarative config — acceptance-tested in Task 10). **Confirm the Pinokio `conda`/`venv`/`shell.run` param spelling against current Pinokio docs during acceptance.** The ordered intent is fixed (spec §Provisioning); the API surface is what acceptance validates.

- [ ] **Step 1: Write the file**

Create `pinokio/install.js`:

```js
// Castwright — Pinokio install. Fully self-contained: conda provides Python 3.12
// + ffmpeg; Pinokio's bundled node provides npm. Builds from the latest PUBLISHED
// release, bootstraps the venv via the SHARED bootstrap-venv.mjs, writes .env.
// Kokoro weights are deferred to the in-app fs-21 wizard at first run.
//
// conda is path-keyed (matches shipping apps); steps default to the app-root cwd
// (Pinokio runs from the cloned repo root, where package.json lives), so no `path:`
// override is needed for git/npm/build. Confirmed on-box in Task 10.
const CONDA = { path: 'env', python: '3.12' }; // conda env created at <app>/env

module.exports = {
  run: [
    // 1. conda env: Python 3.12 + ffmpeg. (If Pinokio's bundled node < 20.19,
    //    add `conda install -y -c conda-forge nodejs` to this message — open item 1.)
    {
      method: 'shell.run',
      params: { conda: CONDA, message: 'conda install -y -c conda-forge ffmpeg' },
    },
    // 2. Fetch + resolve + checkout the latest published release (detached HEAD),
    //    all inside resolve-release.js — no fragile cross-step variable capture (P1).
    //    The script also guards against a pre-Pinokio release (P3).
    {
      method: 'shell.run',
      params: { conda: CONDA, message: 'node pinokio/lib/resolve-release.js' },
    },
    // 3. Node deps — --include=dev so Vite (a devDependency) installs for the build.
    {
      method: 'shell.run',
      params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm ci --include=dev' },
    },
    {
      method: 'shell.run',
      params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm --prefix server ci --include=dev' },
    },
    // 4. Build dist/ + server/dist/.
    {
      method: 'shell.run',
      params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm run build' },
    },
    // 5. Venv bootstrap via the SHARED chain — accelerator-profile resolver picks
    //    the overlay (nvidia-cuda/cpu/amd-rocm) + installs torch. ~2.5 GB.
    //    `python` here is the conda interpreter; bootstrap-venv creates a nested .venv.
    {
      method: 'shell.run',
      params: { conda: CONDA, message: 'node server/tts-sidecar/scripts/bootstrap-venv.mjs python' },
    },
    // 6. Write server/.env (idempotent) with WORKSPACE_DIR=<app>/workspace.
    //    write-env.js defaults appDir to process.cwd() (the app root) — no {{cwd}}
    //    template needed (R7: {{cwd}} is unconfirmed in shipping apps).
    {
      method: 'shell.run',
      params: { conda: CONDA, message: 'node pinokio/lib/write-env.js' },
    },
  ],
};
```

- [ ] **Step 2: Lint check**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pinokio/install.js
git commit -m "feat(scripts): pinokio install/provisioning script (ops-16)"
```

---

## Task 7: `pinokio/start.js` + `pinokio/stop.js` — launch & teardown

**Files:**
- Create: `pinokio/start.js`
- Create: `pinokio/stop.js`

> **No unit test** (declarative). The detached-server lifecycle (spec §Launch/M2) drives this: start captures the ready URL via an `on:` regex; stop uses `npm run stop:prod` (NOT a shell kill, which would orphan the sidecar).

- [ ] **Step 1: Write `pinokio/start.js`**

```js
// Castwright — Pinokio start (R1, revises round-3 P2). Runs the built server in
// the FOREGROUND under Pinokio's shell with `daemon: true`, so Pinokio tracks it
// as a running daemon (powers info.running() + native Stop). The server autostarts
// the sidecar (plan 43) and, on SIGTERM from Pinokio's Stop, tears it down
// (server/src/index.ts:494). The `on:` matcher captures the ready URL — the server
// prints `[server] listening on http://localhost:8080` (index.ts:320) — and
// `done: true` advances to local.set while keeping the daemon alive.
const CONDA = { path: 'env', python: '3.12' }; // path-keyed conda env at <app>/env

module.exports = {
  daemon: true,
  run: [
    {
      method: 'shell.run',
      params: {
        conda: CONDA,
        message: 'node server/dist/index.js',
        on: [{ event: '/http:\\/\\/localhost:8080/', done: true }],
      },
    },
    { method: 'local.set', params: { url: 'http://localhost:8080' } },
  ],
};
```

> **R1 on-box checks for start.js (the plan's highest-risk surface):** (1) `node server/dist/index.js` from the app root autostarts the sidecar and reads `server/.env` (incl. `WORKSPACE_DIR`); if it doesn't pick up `server/.env`, add `env: { WORKSPACE_DIR: '<resolved>/workspace' }` to the step. (2) Pinokio's native Stop SIGTERMs the daemon and the sidecar is reaped (no orphan on :9000). (3) `daemon: true` + `on:[{done:true}]` coexist (they do in every shipping app).

- [ ] **Step 2: Write `pinokio/stop.js`**

```js
// Castwright — Pinokio stop. Pinokio's NATIVE Stop (SIGTERM to the daemon) is the
// primary path and the server reaps the sidecar on SIGTERM. This explicit stop.js
// is a defensive sweep: stop:prod reads the pid files, tree-kills any survivors,
// and sweeps :8080/:9000 — covering the case where a child outlived the signal.
const CONDA = { path: 'env', python: '3.12' };

module.exports = {
  run: [
    { method: 'shell.run', params: { conda: CONDA, message: 'npm run stop:prod' } },
    { method: 'local.set', params: { url: null } },
  ],
};
```

- [ ] **Step 3: Lint check**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add pinokio/start.js pinokio/stop.js
git commit -m "feat(scripts): pinokio start/stop lifecycle scripts (ops-16)"
```

---

## Task 8: `pinokio/update.js` + `pinokio/reset.js`

**Files:**
- Create: `pinokio/update.js`
- Create: `pinokio/reset.js`

> **No unit test** (declarative). Update owns the detached-HEAD checkout (we do NOT use Pinokio's built-in git-pull). Reset removes derived dirs and reinstalls.

- [ ] **Step 1: Write `pinokio/update.js`**

```js
// Castwright — Pinokio update. Fetch tags, checkout the newest PUBLISHED release,
// rebuild, re-bootstrap the venv. We own the detached-HEAD checkout explicitly
// rather than using Pinokio's built-in git update.
const CONDA = { path: 'env', python: '3.12' };

module.exports = {
  run: [
    // Single resolve+checkout step (fetch + API + checkout + guard live inside
    // resolve-release.js) — same P1 fix as install.js, no {{input.event}} capture.
    { method: 'shell.run', params: { conda: CONDA, message: 'node pinokio/lib/resolve-release.js' } },
    { method: 'shell.run', params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm ci --include=dev' } },
    { method: 'shell.run', params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm --prefix server ci --include=dev' } },
    { method: 'shell.run', params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm run build' } },
    { method: 'shell.run', params: { conda: CONDA, message: 'node server/tts-sidecar/scripts/bootstrap-venv.mjs python' } },
  ],
};
```

- [ ] **Step 2: Write `pinokio/reset.js`**

```js
// Castwright — Pinokio reset. Remove derived runtime (venv, node_modules, dist),
// then reinstall from scratch. Does NOT touch server/.env or workspace/ (user data).
// R5 — native `fs.rm` is the idiomatic, cross-platform reset primitive in every
// shipping app (no node -e quoting hazard). R6 — script.start uri is sibling-
// relative to this script's dir (pinokio/), so 'install.js', not 'pinokio/install.js'.
module.exports = {
  run: [
    { method: 'fs.rm', params: { path: 'server/tts-sidecar/.venv' } },
    { method: 'fs.rm', params: { path: 'node_modules' } },
    { method: 'fs.rm', params: { path: 'server/node_modules' } },
    { method: 'fs.rm', params: { path: 'dist' } },
    { method: 'fs.rm', params: { path: 'server/dist' } },
    { method: 'script.start', params: { uri: 'install.js' } },
  ],
};
```

- [ ] **Step 3: Lint check**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add pinokio/update.js pinokio/reset.js
git commit -m "feat(scripts): pinokio update/reset lifecycle scripts (ops-16)"
```

---

## Task 9: Docs — install guide, regression plan, INDEX, backlog

**Files:**
- Modify: `INSTALL.md`, `README.md`
- Create: `docs/features/218-pinokio-installer.md`
- Modify: `docs/features/INDEX.md`
- Modify: `docs/BACKLOG.md`

- [ ] **Step 1: Add the Pinokio section to `INSTALL.md`**

Add a new top-level section (after the prerequisites / before or alongside the per-OS sections) titled **"Install — Pinokio (one click)"**:

```markdown
## Install — Pinokio (one click)

If you use [Pinokio](https://pinokio.computer), Castwright installs with no terminal
and no system prerequisites — Pinokio provisions its own Python 3.12 + ffmpeg + Node.

1. Open the Pinokio browser and paste the Castwright repo URL:
   `https://github.com/dudarenok-maker/Castwright`.
2. Click **Install**. Pinokio builds the latest published release, provisions the
   Python voice engine (~2.5 GB PyTorch), and configures the app — one click, ~10–20 min.
3. Click **Start**, then **Open Web UI**. The first launch runs the in-app setup wizard
   (GPU detect + one-time Kokoro voice-model download) — identical to the native installers.

Update anytime via the **Update** menu (rebuilds from the newest published release).
**Stop** cleanly tears down the server + voice engine; **Reset** rebuilds from scratch
(your books and designed voices in the workspace are preserved).
```

- [ ] **Step 2: Add a one-line pointer to `README.md`**

In the install/getting-started area of `README.md`, add Pinokio as a third install path alongside the `.exe`/`.dmg`/zip, linking to the new INSTALL.md section. Match the surrounding prose style.

- [ ] **Step 3: Write the regression plan**

Create `docs/features/218-pinokio-installer.md` from `docs/features/TEMPLATE.md` with frontmatter `status: active`. It MUST cover:
- **Invariants:** build-from-latest-PUBLISHED-release (never `main`, never an un-published tag); self-contained provisioning (zero system prereqs); reuse of `bootstrap-venv.mjs`/`launch.mjs`/`stop:prod` (no duplicated install logic); idempotent `.env`; stop via `stop:prod` (no orphaned sidecar).
- **Automated coverage:** `pinokio/lib/*.test.js` (resolve-release / write-env / menu) via `npm run test:pinokio`.
- **On-box manual acceptance matrix (Windows + macOS):** clean-machine Pinokio install → Start → Open Web UI → fs-21 wizard runs → Kokoro installs → generate a chapter; then Update, Stop (confirm no orphaned sidecar on :9000 — P2), Reset. Record the three open verifications (bundled-Node version, local-`require` support, conda `python -m venv`) and the AMD-Windows DirectML→CPU degrade.
- **Release-sequencing (P3):** announce the Pinokio install path only from the release that first contains `pinokio/` onward; `resolve-release.js`'s post-checkout guard turns an earlier-release install into a clear error rather than a broken app.
- **Link** the spec `docs/superpowers/specs/2026-06-15-pinokio-installer-design.md`.

- [ ] **Step 4: Add the INDEX entry**

In `docs/features/INDEX.md`, add an entry for plan 218 under the appropriate area (ops / distribution), following the existing format.

- [ ] **Step 5: Remove the ops-16 backlog row**

In `docs/BACKLOG.md`, remove the `ops-16` row (the work is delivered; the issue auto-closes via the PR).

- [ ] **Step 6: Commit**

```bash
git add INSTALL.md README.md docs/features/218-pinokio-installer.md docs/features/INDEX.md docs/BACKLOG.md
git commit -m "docs(docs): document pinokio installer + regression plan 218 (ops-16)"
```

---

## Task 10: Verify, on-box acceptance, and ship

**Files:** none (verification + PR).

- [ ] **Step 1: Run the full local battery**

Run: `npm run verify`
Expected: PASS — typecheck + lint + all tests (incl. `test:pinokio`) + e2e + build. `pinokio/` is outside `src`, so typecheck/build/Vitest are unaffected; the new helpers run under `test:pinokio`.

- [ ] **Step 2: On-box Pinokio acceptance (Windows + macOS)**

Follow the acceptance matrix in `docs/features/218-pinokio-installer.md`. **Resolve the three open verifications** and adjust the declarative scripts' Pinokio API spelling if acceptance surfaces a mismatch (conda/venv/on params, `info.exists`/`info.local` accessors, `script.start` for reset). Re-commit any adjustments with `fix(scripts): …`.

- [ ] **Step 3: Open the PR**

Push the clean branch and open a PR titled `feat(scripts): Pinokio one-click installer (ops-16)`. Body: `## Summary` + `## Test plan`, link plan 218 and the spec, and include `Closes #738`.

- [ ] **Step 4: Update memory + tidy**

Mark plan 218 `status:` appropriately (`active` until on-box acceptance lands; `stable` + archive once accepted). Confirm `docs/BACKLOG.md` no longer lists ops-16.

---

## Self-Review (completed during planning)

**Spec coverage:** acquisition/public-repo (Task 5 menu + INSTALL §) ✓; self-contained conda provisioning (Task 6) ✓; build-from-latest-published-release w/ 404 vs network (Task 2 + Task 6) ✓; reuse bootstrap-venv/launch/stop:prod (Tasks 6–8) ✓; idempotent .env (Task 3) ✓; detached-server stop lifecycle (Task 7) ✓; menu/state (Task 4) ✓; no-release.yml-job (honored — no task touches it) ✓; testing via node:test island (Task 1) ✓; docs + regression plan (Task 9) ✓; two-layer venv / arm64 conda / icon notes (Tasks 6, 5; acceptance §) ✓.

**Placeholder scan:** the declarative Pinokio scripts carry an explicit, scoped "confirm API spelling on-box" caveat (not a TODO — concrete content is provided). After round 4 the scripts match shipping-app idiom (path-keyed conda, `info.running`/`info.local(script)`, native `fs.rm`, `daemon: true` + foreground); the unconfirmed `{{cwd}}` token and the fragile `{{input.event[0]}}` cross-step capture were both removed (helpers use `process.cwd()`; fetch+checkout live inside `resolve-release.js`).

**Type consistency:** `latestReleaseTag`/`highestSemverTag` (Task 2), `buildEnvContents` (Task 3), `buildMenu` (Task 4) signatures match their call sites in the CLIs and `pinokio.js`. Menu `href` values (`pinokio/install.js`, `pinokio/start.js`, `pinokio/stop.js`, `pinokio/update.js`, `pinokio/reset.js`) match the files created in Tasks 6–8.

**Adversarial round 3 folded (P1–P6):** P1 fetch+checkout inside `resolve-release.js` (no `{{input.event}}` capture) — Tasks 2, 6, 8; P2 detached-server lifecycle: `running` from `.run/server.pid`, `daemon: true` dropped — Tasks 5, 7; P3 release-sequencing guard + note — Tasks 2, 9; P4 `reset.js` deletion via `node -e rmSync` — Task 8; P5 ESLint `fetch`/`URL` globals — Task 1; P6 `verify-cache` step `includeLockfiles` (+ confirmed `npm run <name>` execution) — Task 1.
