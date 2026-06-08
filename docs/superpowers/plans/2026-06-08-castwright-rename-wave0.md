# Castwright Rename (Wave 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the product from `audiobook-generator` to `castwright` across npm package names, the release artifact + self-upgrade flow, the default data directories, the GitHub repo, and all user/maintainer-facing strings — and make the startup console show "Castwright" instead of the npm package echo.

**Architecture:** Mechanical rename with a few testable seams. The self-upgrade flow's zip-prefix validator (`zip-validate.ts`) and the launcher banner get TDD coverage; the data-dir default changes get unit coverage; a one-time dev-box transition script moves OUR existing workspace/settings to the new names (no shipped user migration — alpha users reinstall fresh). The 1.6.0→castwright self-upgrade break is accepted and documented.

**Tech Stack:** Node/ESM scripts (vitest), TypeScript server (vitest), PowerShell launcher, `.bat` wrappers, GitHub Actions YAML, `gh` CLI.

**Worktree:** This plan MUST be executed in an isolated git worktree (the main checkout is shared with a concurrent session). Branch off `docs/docs-brand-full-pass` (which carries the spec). See the "Worktree setup" preamble below.

---

## Worktree setup (do this first, once)

- [ ] **Create the worktree off the spec branch with a junctioned `node_modules`**

```bash
# From the main checkout (C:\Claude\Projects\Audiobook-Generator):
git worktree add -b chore/castwright-rename ../Audiobook-Generator-wt-rename docs/docs-brand-full-pass
```

Then, in PowerShell, junction the dependency trees so tests run without a reinstall (Windows; the worktree shares the main checkout's installs):

```powershell
cmd /c mklink /J "C:\Claude\Projects\Audiobook-Generator-wt-rename\node_modules" "C:\Claude\Projects\Audiobook-Generator\node_modules"
cmd /c mklink /J "C:\Claude\Projects\Audiobook-Generator-wt-rename\server\node_modules" "C:\Claude\Projects\Audiobook-Generator\server\node_modules"
```

All subsequent paths in this plan are relative to the worktree root
`C:\Claude\Projects\Audiobook-Generator-wt-rename`.

---

## File Structure

- `package.json`, `server/package.json` — npm `name` fields → `castwright` / `castwright-server`.
- `scripts/start-app-prod.mjs` — add `bannerLine(version)` export + `printBanner()`; print at launch.
- `start-prod.bat`, `stop-prod.bat` — `npm run --silent …` to suppress npm's package echo.
- `scripts/start-app.ps1` — matching banner line for the `npm start` dev path.
- `scripts/build-release-zip.mjs` — zip filename + internal dir prefix → `castwright-`.
- `server/src/upgrade/zip-validate.ts` — `TOP_DIR_RE` + reason string → `castwright-`.
- `server/src/upgrade/apply.ts` — `topDir` doc comment.
- `.github/workflows/release.yml` — asset names + title.
- `scripts/bump-version.mjs` — tag message.
- `server/src/workspace/paths.ts` — default workspace dir → `../castwright-workspace`.
- `server/src/workspace/user-settings.ts` — settings dir → `~/.castwright`.
- `scripts/transition-local-to-castwright.mjs` — NEW dev-only one-time transition.
- `server/src/cover/openlibrary.ts` — User-Agent string + URL.
- `README.md`, `INSTALL.md`, `apps/android/README.md`, `.claude/skills/run-app/SKILL.md`, `CLAUDE.md`, `docs/BACKLOG.md` — strings/rows.
- Test files updated alongside each task.

---

## Task 1: npm package names

**Files:**
- Modify: `package.json:2`
- Modify: `server/package.json:2`

- [ ] **Step 1: Rename root package**

In `package.json` change line 2:
```json
  "name": "castwright",
```
(from `"name": "audiobook-generator"`).

- [ ] **Step 2: Rename server package**

In `server/package.json` change line 2:
```json
  "name": "castwright-server",
```
(from `"name": "audiobook-generator-server"`).

- [ ] **Step 3: Regenerate lockfiles**

Run (worktree root, then server):
```bash
npm install --package-lock-only
cd server && npm install --package-lock-only && cd ..
```
Expected: `package-lock.json` + `server/package-lock.json` `name` fields update; no dependency changes.

- [ ] **Step 4: Commit**

```bash
git add package.json server/package.json package-lock.json server/package-lock.json
git commit -m "chore(repo): rename npm packages to castwright / castwright-server"
```

---

## Task 2: Startup banner + silence npm echo

**Files:**
- Modify: `scripts/start-app-prod.mjs` (imports + new `bannerLine`/`printBanner` + call site)
- Test: `scripts/tests/start-app-prod.test.mjs`
- Modify: `start-prod.bat`, `stop-prod.bat`, `scripts/start-app.ps1`

- [ ] **Step 1: Write the failing test for `bannerLine`**

Append to `scripts/tests/start-app-prod.test.mjs`:
```js
import { bannerLine } from '../start-app-prod.mjs';

describe('bannerLine', () => {
  it('renders the Castwright banner with the version', () => {
    expect(bannerLine('1.6.0')).toBe(
      'Castwright v1.6.0 — Any book, performed by a full cast.',
    );
  });
});
```
(Reuse the file's existing `describe`/`it`/`expect` imports — vitest globals or the existing import line; match the file's current style.)

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run scripts/tests/start-app-prod.test.mjs`
Expected: FAIL — `bannerLine is not a function` / not exported.

- [ ] **Step 3: Implement `bannerLine` + `printBanner` + read version**

In `scripts/start-app-prod.mjs`, add `readFileSync` to the `node:fs` import:
```js
import { existsSync, mkdirSync, openSync, writeFileSync, readFileSync } from 'node:fs';
```
Add, after `const distIndex = …` (top-level consts, ~line 33):
```js
const pkgVersion = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
).version;

/** The one-line Castwright startup banner. Exported for unit testing. */
export function bannerLine(version) {
  return `Castwright v${version} — Any book, performed by a full cast.`;
}

function printBanner() {
  info(`\n${bannerLine(pkgVersion)}\n`);
}
```
Then call `printBanner();` as the FIRST statement of the launch sequence — immediately before the port-availability check that emits `[SKIP] something already listening` (~line 121). (If `info` is defined below this point, hoist the `printBanner` call to just after `info` is defined, or convert `info` to a function declaration so it hoists.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run scripts/tests/start-app-prod.test.mjs`
Expected: PASS (all cases, including the existing `resolveLaunchTarget` ones).

- [ ] **Step 5: Silence npm's echo in the `.bat` launchers**

In `start-prod.bat`, change:
```bat
call npm run start:prod
```
to:
```bat
call npm run --silent start:prod
```
In `stop-prod.bat`, change `call npm run stop:prod` → `call npm run --silent stop:prod` (match the actual current line).

- [ ] **Step 6: Add the banner to the PowerShell dev path**

In `scripts/start-app.ps1`, after the layout/`Set-Location` block (~after line 21), add:
```powershell
# Brand banner (the npm package echo can't be suppressed from inside the script
# on the `npm start` path, so lead with Castwright).
$pkgVersion = (Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json).version
Write-Status "`nCastwright v$pkgVersion — Any book, performed by a full cast.`n"
```

- [ ] **Step 7: Commit**

```bash
git add scripts/start-app-prod.mjs scripts/tests/start-app-prod.test.mjs start-prod.bat stop-prod.bat scripts/start-app.ps1
git commit -m "feat(repo): Castwright startup banner + silence npm package echo"
```

---

## Task 3: Release zip name + internal prefix

**Files:**
- Modify: `scripts/build-release-zip.mjs:279,334`
- Test: `scripts/tests/archiver-zip.test.mjs` and/or `scripts/tests/release-manifest.test.mjs` (whichever asserts the prefix/name)

- [ ] **Step 1: Find the existing prefix assertions**

Run: `grep -n "audiobook-generator" scripts/tests/archiver-zip.test.mjs scripts/tests/release-manifest.test.mjs`
Note each expected-name string that must flip to `castwright-`.

- [ ] **Step 2: Update the test expectations to `castwright-`**

Replace each `audiobook-generator-` literal found in Step 1 with `castwright-` (e.g. an expected zip name `audiobook-generator-1.2.3.zip` → `castwright-1.2.3.zip`, an expected top-dir `audiobook-generator-1.2.3/` → `castwright-1.2.3/`).

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npx vitest run scripts/tests/archiver-zip.test.mjs scripts/tests/release-manifest.test.mjs`
Expected: FAIL — produced name still `audiobook-generator-…`.

- [ ] **Step 4: Update the builder**

In `scripts/build-release-zip.mjs`:
- Line 279: `args.out ?? \`release/castwright-${args.version}.zip\`,`
- Line 334: `archive.file(abs, { name: posix.join(\`castwright-${args.version}\`, toPosix(rel)) });`

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx vitest run scripts/tests/archiver-zip.test.mjs scripts/tests/release-manifest.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-release-zip.mjs scripts/tests/archiver-zip.test.mjs scripts/tests/release-manifest.test.mjs
git commit -m "chore(repo): release zip + internal prefix → castwright-"
```

---

## Task 4: Self-upgrade zip-validate prefix (breaking, intended)

**Files:**
- Modify: `server/src/upgrade/zip-validate.ts:26,57`
- Modify: `server/src/upgrade/apply.ts:21` (doc comment only)
- Test: `server/src/upgrade/zip-validate.test.ts`

- [ ] **Step 1: Write/extend the failing tests**

In `server/src/upgrade/zip-validate.test.ts`, update the existing happy-path cases to use a `castwright-vX.Y.Z` top dir, AND add a regression case:
```ts
it('rejects a legacy audiobook-generator-* top dir as bad-structure', () => {
  const res = validateZipStructure({
    entryNames: ['audiobook-generator-v1.6.0/package.json'],
    packageJsonVersion: '1.7.0',
    runningVersion: '1.6.0',
    allowDowngrade: false,
  });
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.code).toBe('bad-structure');
});
```
Update any existing case whose `entryNames` use the `audiobook-generator-` prefix to `castwright-`, and the required-entry assertions accordingly.

- [ ] **Step 2: Run the tests, verify failure**

Run: `npx vitest run server/src/upgrade/zip-validate.test.ts` (from `server/`, or `cd server && npx vitest run src/upgrade/zip-validate.test.ts`)
Expected: FAIL — the regex still accepts `audiobook-generator-`.

- [ ] **Step 3: Update the validator**

In `server/src/upgrade/zip-validate.ts`:
- Line 26: `const TOP_DIR_RE = /^castwright-v\d+\.\d+\.\d+$/;`
- Line 57 reason string: `…is not castwright-vX.Y.Z`.
- Line 3 doc comment: `A release zip is \`castwright-vX.Y.Z/\` with the repo tree under it.`

In `server/src/upgrade/apply.ts:21`, update the comment: `topDir: string; // castwright-vX.Y.Z (zip prefix to strip)`.

- [ ] **Step 4: Run the tests, verify pass**

Run: `npx vitest run server/src/upgrade/zip-validate.test.ts`
Expected: PASS (including the new legacy-rejection case).

- [ ] **Step 5: Commit**

```bash
git add server/src/upgrade/zip-validate.ts server/src/upgrade/apply.ts server/src/upgrade/zip-validate.test.ts
git commit -m "chore(server): upgrade validator expects castwright- prefix (1.6.0 self-upgrade intentionally breaks)"
```

---

## Task 5: CI release workflow + bump tag message

**Files:**
- Modify: `.github/workflows/release.yml:157-159`
- Modify: `scripts/bump-version.mjs:487`
- Test: `scripts/tests/release-manifest.test.mjs` (only if it asserts the tag message; otherwise none — config-only)

- [ ] **Step 1: Update the release asset names + title**

In `.github/workflows/release.yml`, the `gh release create` block:
```yaml
          gh release create "${{ github.ref_name }}" \
            "release/castwright-${{ github.ref_name }}.zip" \
            "release/castwright-${{ github.ref_name }}.zip.sha256" \
            --title "Castwright ${{ github.ref_name }}" \
            --notes-file release/tag-notes.md
```

- [ ] **Step 2: Update the bump tag message**

In `scripts/bump-version.mjs:487`:
```js
    git(['tag', '--cleanup=verbatim', '-a', newTag, '-m', `Castwright ${newTag}`]);
```

- [ ] **Step 3: Verify nothing else references the old asset name**

Run: `grep -rn "audiobook-generator-" .github scripts/bump-version.mjs`
Expected: no remaining release-asset references (matches are only in archived docs/changelog, which stay).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml scripts/bump-version.mjs
git commit -m "chore(ci): release assets + tag message → Castwright"
```

---

## Task 6: Default workspace directory

**Files:**
- Modify: `server/src/workspace/paths.ts:30` (+ doc lines 3-4, 15-16)
- Test: `server/src/workspace/paths.*.test.ts` (locate; may be `paths.test.ts` or a pure test)

- [ ] **Step 1: Locate the default-workspace test**

Run: `grep -rln "audiobook-workspace\|WORKSPACE_SOURCE\|RESOLVED_DIR" server/src/workspace`
If a test asserts the default `../audiobook-workspace`, update it to `../castwright-workspace`. If no such test exists, add one:
```ts
// server/src/workspace/paths-default.test.ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
describe('default workspace dir', () => {
  it('defaults to ../castwright-workspace when WORKSPACE_DIR unset', () => {
    // WORKSPACE_ROOT is resolved at module load; assert on the default token.
    delete process.env.WORKSPACE_DIR;
    delete process.env.USER_SETTINGS_FILE;
    // resolve mirrors paths.ts: SERVER_ROOT/../castwright-workspace
    expect(resolve(__dirname, '..', '..', '..', 'castwright-workspace')).toMatch(
      /castwright-workspace$/,
    );
  });
});
```
(If `paths.ts` already has a test that pins the default literal, prefer updating it over adding this one — avoid duplicate coverage.)

- [ ] **Step 2: Run, verify failure (if updating an existing literal test)**

Run: `cd server && npx vitest run src/workspace/` and confirm the default-dir assertion fails on `castwright-workspace`.

- [ ] **Step 3: Update the default**

In `server/src/workspace/paths.ts:30`, change the fallback literal:
```ts
  OVERRIDE_DIR ?? (ENV_DIR && ENV_DIR.length > 0 ? ENV_DIR : '../castwright-workspace');
```
Update the doc comments at lines 3-4 and 15-16 (`../audiobook-workspace` → `../castwright-workspace`).

- [ ] **Step 4: Run, verify pass**

Run: `cd server && npx vitest run src/workspace/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/paths.ts server/src/workspace/*default*.test.ts
git commit -m "chore(server): default workspace dir → castwright-workspace"
```

---

## Task 7: Global settings directory

**Files:**
- Modify: `server/src/workspace/user-settings.ts:39` (+ comments lines 29, 46)
- Test: `server/src/workspace/user-settings.test.ts` (locate the path assertion)

- [ ] **Step 1: Update the path test**

Run: `grep -n "audiobook-generator" server/src/workspace/user-settings.test.ts server/src/test-setup.ts`
Update the asserted path in `user-settings.test.ts` (if any) from `~/.audiobook-generator/user-settings.json` to `~/.castwright/user-settings.json`. If `resolveUserSettingsPath` is tested via `USER_SETTINGS_FILE` override only, add a default-path case:
```ts
it('defaults to ~/.castwright/user-settings.json', () => {
  const p = resolveUserSettingsPath({});
  expect(p.replace(/\\/g, '/')).toMatch(/\/\.castwright\/user-settings\.json$/);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts`
Expected: FAIL — path still `.audiobook-generator`.

- [ ] **Step 3: Update the path**

In `server/src/workspace/user-settings.ts:39`:
```ts
  return join(homedir(), '.castwright', 'user-settings.json');
```
Update the comment at line 29 (`~/.audiobook-generator/` → `~/.castwright/`) and the `test-setup.ts:5` note.

- [ ] **Step 4: Run, verify pass**

Run: `cd server && npx vitest run src/workspace/user-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/user-settings.ts server/src/test-setup.ts server/src/workspace/user-settings.test.ts
git commit -m "chore(server): global settings dir → ~/.castwright"
```

---

## Task 8: Dev-box transition script (one-time, dev-only)

**Files:**
- Create: `scripts/transition-local-to-castwright.mjs`
- Test: `scripts/tests/transition-local-to-castwright.test.mjs`

This renames THIS machine's existing data dirs to the new names so our real
books + settings carry over. NOT shipped/wired into the app. Dry-run by default.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/transition-local-to-castwright.test.mjs`:
```js
import { describe, it, expect } from 'vitest';
import { planTransition } from '../transition-local-to-castwright.mjs';

describe('planTransition', () => {
  it('plans a move when the old dir exists and the new one does not', () => {
    const exists = (p) => p.endsWith('audiobook-workspace') || p.endsWith('.audiobook-generator');
    const plan = planTransition({
      home: '/home/u',
      repoRoot: '/repo',
      exists,
    });
    expect(plan).toEqual([
      { from: '/repo/../audiobook-workspace', to: '/repo/../castwright-workspace' },
      { from: '/home/u/.audiobook-generator', to: '/home/u/.castwright' },
    ]);
  });

  it('skips a move when the old dir is missing', () => {
    const plan = planTransition({ home: '/home/u', repoRoot: '/repo', exists: () => false });
    expect(plan).toEqual([]);
  });

  it('skips a move when the new dir already exists (no clobber)', () => {
    const exists = (p) => p.includes('audiobook') || p.endsWith('castwright-workspace') || p.endsWith('.castwright');
    const plan = planTransition({ home: '/home/u', repoRoot: '/repo', exists });
    expect(plan).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run scripts/tests/transition-local-to-castwright.test.mjs`
Expected: FAIL — module/`planTransition` not found.

- [ ] **Step 3: Implement the script**

Create `scripts/transition-local-to-castwright.mjs`:
```js
#!/usr/bin/env node
/* DEV-ONLY one-time transition: rename this machine's existing data dirs to the
   Castwright names so our real books + settings carry over after the rename.
   NOT shipped, NOT wired into the app — alpha users get fresh dirs.
   Usage: node scripts/transition-local-to-castwright.mjs [--apply]  (dry-run default). */
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAIRS = [
  { oldRel: '../audiobook-workspace', newRel: '../castwright-workspace', base: 'repo' },
  { old: '.audiobook-generator', new: '.castwright', base: 'home' },
];

/** Pure: which moves are needed. Each entry { from, to } is an absolute pair. */
export function planTransition({ home, repoRoot, exists }) {
  const out = [];
  for (const p of PAIRS) {
    const from = p.base === 'home' ? join(home, p.old) : join(repoRoot, p.oldRel);
    const to = p.base === 'home' ? join(home, p.new) : join(repoRoot, p.newRel);
    if (exists(from) && !exists(to)) out.push({ from, to });
  }
  return out;
}

function main() {
  const apply = process.argv.includes('--apply');
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = planTransition({ home: homedir(), repoRoot, exists: existsSync });
  if (plan.length === 0) {
    console.log('[transition] nothing to do (old dirs missing or new dirs already present).');
    return;
  }
  for (const { from, to } of plan) {
    if (apply) {
      renameSync(from, to);
      console.log(`[transition] moved ${from} -> ${to}`);
    } else {
      console.log(`[transition] would move ${from} -> ${to}  (run with --apply)`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('transition-local-to-castwright.mjs')) {
  main();
}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run scripts/tests/transition-local-to-castwright.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/transition-local-to-castwright.mjs scripts/tests/transition-local-to-castwright.test.mjs
git commit -m "chore(repo): dev-only transition script for local data dirs"
```

---

## Task 9: Source + docs strings + CLAUDE.md + BACKLOG

**Files:**
- Modify: `server/src/cover/openlibrary.ts:78,140`
- Modify: `README.md`, `INSTALL.md:1`, `apps/android/README.md`, `.claude/skills/run-app/SKILL.md`
- Modify: `CLAUDE.md` (brand note ~lines 8-13)
- Modify: `docs/BACKLOG.md` (remove the fs-39 row)

- [ ] **Step 1: Update the OpenLibrary User-Agent**

In `server/src/cover/openlibrary.ts` lines 78 and 140, change both occurrences:
```ts
'castwright/1.0 (https://github.com/dudarenok-maker/Castwright)',
```
(from `'audiobook-generator/1.0 (https://github.com/dudarenok-maker/audiobook-generator)'`).

- [ ] **Step 2: Update docs titles/strings**

- `INSTALL.md:1`: `# Installing Castwright` (keep any internal-zip-name note that now reads `castwright-vX.Y.Z.zip`).
- `README.md`: title already `# Castwright`; update line ~4 (the "internal package / repo name stays `audiobook-generator`" note) to state the package + repo are now `castwright` / `Castwright`; update the `audiobook-generator-vX.Y.Z.zip` reference (~line 304) to `castwright-vX.Y.Z.zip`; update the clone URL if the repo is renamed (Task 10).
- `apps/android/README.md:4`: "Audiobook Generator" → "Castwright".
- `.claude/skills/run-app/SKILL.md`: description + H1 "Audiobook Generator app" → "Castwright app".

- [ ] **Step 3: Update CLAUDE.md brand note**

In `CLAUDE.md` (~lines 8-13), remove the constraint that the internal package/repo name stays `audiobook-generator`. Replace with: the package is `castwright` / `castwright-server`, the repo is `Castwright`, the release artifact is `castwright-vX.Y.Z.zip`, and **note that 1.6.0 cannot self-upgrade across the rename — alpha installs reinstall fresh**.

- [ ] **Step 4: Remove the fs-39 backlog row**

In `docs/BACKLOG.md`, delete the `### \`fs-39\` …` block (the rename is being delivered here; the PR closes #631).

- [ ] **Step 5: Verify no stray user-facing references remain**

Run: `grep -rniE "audiobook generator|audiobook-generator" --include=*.md --include=*.ts --include=*.tsx --include=*.mjs src server/src scripts README.md INSTALL.md CLAUDE.md | grep -viE "archive/|changelog|release notes|\.audiobook/|audiobook-workspace|node_modules"`
Expected: only intentional keeps (the per-book `.audiobook/` folder, `WORKSPACE_DIR` doc, historical archive docs). Investigate anything else.

- [ ] **Step 6: Commit**

```bash
git add server/src/cover/openlibrary.ts README.md INSTALL.md apps/android/README.md .claude/skills/run-app/SKILL.md CLAUDE.md docs/BACKLOG.md
git commit -m "docs(repo): rename user/maintainer strings to Castwright; lift package-name constraint; close fs-39"
```

---

## Task 10: GitHub repo rename (outward-facing — confirm before running)

**Files:** none in-tree beyond remote URLs already handled in Task 9.

- [ ] **Step 1: Confirm with the user, then rename the repo**

This is outward-facing — get explicit go-ahead. Then:
```bash
gh repo rename Castwright -R dudarenok-maker/AudioBook-Generator
```
GitHub auto-redirects old URLs (clone/PR links keep working).

- [ ] **Step 2: Update the local remote in BOTH the worktree and main checkout**

```bash
git remote set-url origin https://github.com/dudarenok-maker/Castwright.git
git remote -v   # verify
```

- [ ] **Step 3: Confirm CI/release references**

Verify `.github/workflows/*.yml` use `${{ github.repository }}` / relative refs (no hardcoded `AudioBook-Generator`). Run: `grep -rn "AudioBook-Generator\|audiobook-generator" .github`. Update any hardcoded repo path. (No commit if clean.)

---

## Task 11: Full verify + PR

- [ ] **Step 1: Run the full battery in the worktree**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build all green. If husky can't spawn in the worktree, run `npm run verify` directly (it's the same battery) and note it in the PR.

- [ ] **Step 2: Manual startup check**

Build + launch via `start-prod.bat`. Expected: console leads with `Castwright v1.6.0 — Any book, performed by a full cast.` then `[READY]`, with NO `> audiobook-generator@…` lines.

- [ ] **Step 3: Dev-box transition (real data)**

Run `node scripts/transition-local-to-castwright.mjs` (dry-run) then `--apply`. Confirm `audiobook-workspace` → `castwright-workspace` and `~/.audiobook-generator` → `~/.castwright`; relaunch and confirm books + settings load.

- [ ] **Step 4: Open the draft PR**

```bash
git push -u origin chore/castwright-rename
gh pr create --draft --title "chore(repo): rename product to Castwright (package + repo + release + data dirs)" --body "$(cat <<'EOF'
## Summary
Wave 0 of the Castwright brand pass: full rename from audiobook-generator → castwright across npm packages, release artifact + self-upgrade validator, default data dirs, GitHub repo, and user/maintainer strings. Adds a Castwright startup banner and silences npm's package echo. 1.6.0 self-upgrade across the rename intentionally breaks (alpha reinstalls fresh); a dev-only transition script carries our local data over.

Spec: docs/superpowers/specs/2026-06-08-castwright-brand-full-pass-design.md
Plan: docs/superpowers/plans/2026-06-08-castwright-rename-wave0.md

Closes #631

## Test plan
- npm run verify green
- start-prod.bat shows the Castwright banner, no audiobook-generator echo
- upgrade validator rejects legacy audiobook-generator-* prefix (new regression test)
- transition script dry-run + --apply verified on the dev box
EOF
)"
```

---

## Self-Review notes (completed)

- **Spec coverage:** Wave 0 §A→npm names + banner (T1,T2); §B→zip + upgrade + CI (T3,T4,T5); §C→data dirs + transition (T6,T7,T8); §D→repo rename (T10); §E→CLAUDE.md/docs/fs-39 (T9). All covered.
- **Kept exception:** per-book `.audiobook/` not renamed — Task 9 Step 5 grep explicitly excludes it.
- **Type/name consistency:** `bannerLine(version)` used identically in test + launcher; `castwright-` prefix consistent across builder (T3), validator (T4), CI (T5); `planTransition({home,repoRoot,exists})` signature matches test + script.
- **Breaking change documented:** T4 + T9 Step 3 record the 1.6.0 no-self-upgrade caveat.
