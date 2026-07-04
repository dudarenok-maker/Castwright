# GitHub Wiki User Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 21-page, screenshot-illustrated GitHub wiki for Castwright, authored in this repo under normal PR review and mirrored to the GitHub wiki repo by a new sync script — giving users a task-oriented "how to actually use this" guide that `README.md`/`INSTALL.md` don't provide today.

**Architecture:** Wiki content lives at `docs/wiki/*.md` + `docs/wiki/images/<slug>/NN-caption.png` in this repo (reviewable via normal PR). `scripts/sync-wiki.mjs` mirrors that directory into the separate `Castwright.wiki.git` repo (clone-or-bootstrap, copy, commit, push), run manually post-merge via `npm run wiki:sync`. Screenshots are captured from the real running app (`npm start`, no mocks) via Chrome browser automation, using the committed Coalfall Commission demo book as the consistent content source.

**Tech Stack:** Plain ESM `.mjs` script (`node:fs`/`node:child_process`, matches `scripts/render-brand-pngs.mjs` conventions) + `node:test` for its unit test (matches `scripts/tests/build-companion-apk.test.mjs`, auto-discovered by `npm run test:hooks` via `scripts/tests/*.test.mjs` glob — no Vitest, no manual test-runner wiring needed). Markdown content, no build tooling. Chrome browser automation (`mcp__claude-in-chrome__*`) for screenshot capture.

## Global Constraints

- Documentation-only content; **no changes to `src/`, `server/`, or the sidecar** (spec Non-goals).
- English only for v1 — no wiki i18n (spec Non-goals / Open questions).
- **`INSTALL.md` stays fully intact, unchanged** — the wiki's "Installing Castwright" page is a parallel duplicate, not a migration (spec "INSTALL.md relationship").
- Every screenshot is captured against the **real running app** (`npm start`, real analyzer/sidecar, no mocks), using **The Coalfall Commission** demo book as the content source — never fabricated/mocked UI states (spec "Screenshot workflow").
- File convention: `docs/wiki/images/<page-slug>/NN-caption.png`, numbered in on-page order (spec "Screenshot workflow").
- Desktop-viewport screenshots by default; add phone/tablet only where the mobile layout genuinely differs (spec "Screenshot workflow").
- Waves 1–4 are pure `docs/**`/root `*.md` changes and get the **docs-only CI fast-path and code-review exemption**. **Wave 0 ships `scripts/sync-wiki.mjs`, a `chore`/`build`-shaped change** — it does NOT qualify for the exemption and gets a real (`low`-effort) `code-review` pass per CLAUDE.md's model-routing table.
- One integration branch, `docs/docs-github-wiki`, off `main`. Every task below branches off that integration branch (not off `main` directly) and merges back into it via its own small PR. Rebase onto the latest `docs/docs-github-wiki` before opening each PR.
- `fe-46` (issue #1262) is landing in parallel and touches pages 7, 11, and 12 — each of those tasks includes an explicit fe-46-status check immediately before screenshot capture (spec "fe-46 interaction").
- Repo currently has `hasWikiEnabled: false` — enabling it is an admin-scoped repo-setting change; flag it to the user before running, per spec.

---

## File Structure

```
docs/wiki/
  Home.md                              — wiki landing page
  _Sidebar.md                          — persistent nav (3 grouped headings)
  _Footer.md                           — persistent footer
  Getting-Started.md
  Installing-Castwright.md
  Uploading-a-Book.md
  Analysis-and-the-Analyzer.md
  Reviewing-Low-Confidence-Speaker-Tags.md
  Generating-Audio.md
  The-Quality-Gate.md
  Listening-and-Revising.md
  Exporting.md
  Reviewing-Cast-and-Assigning-Voices.md
  Designing-a-Voice.md
  Voice-Engines.md
  The-Model-Control-Pill.md
  Library-Management.md
  Mobile-Tablet-and-Companion-App.md
  Admin-and-Model-Manager.md
  Advanced-Settings.md
  Account-and-Settings.md
  Multi-language-Support.md
  Troubleshooting.md
  images/
    getting-started/NN-caption.png
    installing-castwright/NN-caption.png
    uploading-a-book/NN-caption.png
    analysis-and-the-analyzer/NN-caption.png
    reviewing-low-confidence-speaker-tags/NN-caption.png
    generating-audio/NN-caption.png
    the-quality-gate/NN-caption.png
    listening-and-revising/NN-caption.png
    exporting/NN-caption.png
    reviewing-cast-and-assigning-voices/NN-caption.png
    designing-a-voice/NN-caption.png
    voice-engines/NN-caption.png
    the-model-control-pill/NN-caption.png
    library-management/NN-caption.png
    mobile-tablet-and-companion-app/NN-caption.png
    admin-and-model-manager/NN-caption.png
    advanced-settings/NN-caption.png
    account-and-settings/NN-caption.png
    multi-language-support/NN-caption.png
    troubleshooting/NN-caption.png

scripts/sync-wiki.mjs                  — mirrors docs/wiki/* to Castwright.wiki.git
scripts/tests/sync-wiki.test.mjs       — node:test coverage for its pure copy/commit-message logic
package.json                           — + "wiki:sync" script entry

README.md                              — shrunk to pitch + links (Wave 4)
INSTALL.md                             — UNCHANGED (duplicated into wiki page 3, not migrated)
```

Page-file → spec-page-number mapping (for cross-reference while reading the spec):
2=Getting-Started, 3=Installing-Castwright, 4=Uploading-a-Book, 5=Analysis-and-the-Analyzer,
6=Reviewing-Low-Confidence-Speaker-Tags, 7=Generating-Audio, 8=The-Quality-Gate,
9=Listening-and-Revising, 10=Exporting, 11=Reviewing-Cast-and-Assigning-Voices,
12=Designing-a-Voice, 13=Voice-Engines, 14=The-Model-Control-Pill, 15=Library-Management,
16=Mobile-Tablet-and-Companion-App, 17=Admin-and-Model-Manager, 18=Advanced-Settings,
19=Account-and-Settings, 20=Multi-language-Support, 21=Troubleshooting. Page 1 = Home.

---

## Task 1: Wave 0 — scaffold, sync script, wiki enablement, dual-render spike

**Files:**
- Create: `scripts/sync-wiki.mjs`
- Create: `scripts/tests/sync-wiki.test.mjs`
- Modify: `package.json` (add `wiki:sync` script)
- Create: `docs/wiki/Home.md`, `docs/wiki/_Sidebar.md`, `docs/wiki/_Footer.md`
- Create (spike, deleted by end of this task): `docs/wiki/_Spike.md`, `docs/wiki/images/_spike/01-test.png`

**Interfaces:**
- Produces: `copyWikiTree(srcDir, destDir)` and `buildCommitMessage(sourceSha)` (exported pure functions from `scripts/sync-wiki.mjs`), the `npm run wiki:sync` command, `docs/wiki/_Sidebar.md`'s 3-heading skeleton (Core journey / Cast & Voices / Full breadth) that every later task appends a page link into, and the confirmed image-path convention (relative `images/<slug>/NN-caption.png` OR `raw.githubusercontent.com` fallback — whichever the spike proves) that every content task (2–11) uses verbatim.
- Consumes: nothing (first task).

- [ ] **Step 1: Cut the integration branch and this task's branch**

```bash
git switch main
git pull
git switch -c docs/docs-github-wiki
git switch -c docs/docs-github-wiki-wave0-infra
```

- [ ] **Step 2: Write the failing test for `copyWikiTree`**

Create `scripts/tests/sync-wiki.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { copyWikiTree, buildCommitMessage } from '../sync-wiki.mjs';

test('copyWikiTree copies markdown and images, excluding .git', () => {
  const src = mkdtempSync(path.join(tmpdir(), 'wiki-src-'));
  const dest = mkdtempSync(path.join(tmpdir(), 'wiki-dest-'));
  try {
    writeFileSync(path.join(src, 'Home.md'), '# Home');
    mkdirSync(path.join(src, 'images', 'home'), { recursive: true });
    writeFileSync(path.join(src, 'images', 'home', '01-test.png'), 'fake-png');
    mkdirSync(path.join(src, '.git'), { recursive: true });
    writeFileSync(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/master');

    copyWikiTree(src, dest);

    assert.equal(readFileSync(path.join(dest, 'Home.md'), 'utf8'), '# Home');
    assert.equal(
      readFileSync(path.join(dest, 'images', 'home', '01-test.png'), 'utf8'),
      'fake-png',
    );
    assert.equal(existsSync(path.join(dest, '.git')), false);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('copyWikiTree throws when the source directory is missing', () => {
  const dest = mkdtempSync(path.join(tmpdir(), 'wiki-dest-'));
  try {
    assert.throws(
      () => copyWikiTree(path.join(dest, 'does-not-exist'), dest),
      /source directory not found/,
    );
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('buildCommitMessage embeds the short source SHA', () => {
  assert.equal(buildCommitMessage('abc1234'), 'sync wiki from Castwright@abc1234');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test scripts/tests/sync-wiki.test.mjs`
Expected: FAIL — `Cannot find module '../sync-wiki.mjs'`

- [ ] **Step 4: Implement `scripts/sync-wiki.mjs`**

```js
// Mirrors docs/wiki/* into the separate Castwright.wiki.git repo. GitHub
// wikis have no PR review/CI/branch protection, so the source of truth
// lives here and this script is the one-way publish step.
//
//   npm run wiki:sync
//
// Run manually after a merge to main touches docs/wiki/**.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WIKI_REMOTE = 'https://github.com/dudarenok-maker/Castwright.wiki.git';

export function copyWikiTree(srcDir, destDir) {
  if (!existsSync(srcDir)) {
    throw new Error(`sync-wiki: source directory not found: ${srcDir}`);
  }
  cpSync(srcDir, destDir, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.git',
  });
}

export function buildCommitMessage(sourceSha) {
  return `sync wiki from Castwright@${sourceSha}`;
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`sync-wiki: ${cmd} ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function getSourceSha() {
  return run('git', ['rev-parse', '--short', 'HEAD'], REPO_ROOT).trim();
}

// A GitHub wiki's git repo does not exist until at least one page exists —
// enabling has_wiki alone doesn't create it, so clone fails on a
// never-touched wiki and we bootstrap it instead.
function cloneOrInitWikiRepo(cacheDir) {
  rmSync(cacheDir, { recursive: true, force: true });
  const clone = spawnSync('git', ['clone', WIKI_REMOTE, cacheDir], { encoding: 'utf8' });
  if (clone.status === 0) return { fresh: false };

  mkdirSync(cacheDir, { recursive: true });
  run('git', ['init'], cacheDir);
  run('git', ['remote', 'add', 'origin', WIKI_REMOTE], cacheDir);
  return { fresh: true };
}

async function main() {
  const cacheDir = path.join(REPO_ROOT, '.wiki-sync-cache');
  const srcDir = path.join(REPO_ROOT, 'docs', 'wiki');

  const { fresh } = cloneOrInitWikiRepo(cacheDir);
  copyWikiTree(srcDir, cacheDir);

  run('git', ['add', '-A'], cacheDir);
  const sha = getSourceSha();
  run('git', ['commit', '-m', buildCommitMessage(sha), '--allow-empty'], cacheDir);
  run('git', fresh ? ['push', '-u', 'origin', 'HEAD:master'] : ['push'], cacheDir);

  process.stdout.write(`sync-wiki: pushed docs/wiki -> ${WIKI_REMOTE}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test scripts/tests/sync-wiki.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Confirm `npm run test:hooks` auto-discovers the new test**

Run: `npm run test:hooks`
Expected: includes `scripts/tests/sync-wiki.test.mjs` in its glob output (it globs `scripts/tests/*.test.mjs` in `scripts/run-hooks-tests.mjs` — no wiring needed beyond the file existing at that path) and PASSes.

- [ ] **Step 7: Add the `wiki:sync` npm script**

In `package.json`, add alongside the other `scripts` entries (near `apk:companion`):

```json
    "wiki:sync": "node scripts/sync-wiki.mjs",
```

- [ ] **Step 8: Commit the script + test + package.json change**

```bash
git add scripts/sync-wiki.mjs scripts/tests/sync-wiki.test.mjs package.json
git commit -m "chore(scripts): add sync-wiki.mjs to mirror docs/wiki into the GitHub wiki repo"
```

- [ ] **Step 9: Flag and enable the wiki repo setting (admin action)**

Tell the user explicitly before running (repo-visibility-adjacent setting change per Global Constraints):

```bash
gh api -X PATCH repos/dudarenok-maker/Castwright -f has_wiki=true
```

- [ ] **Step 10: Scaffold the empty wiki nav pages**

Create `docs/wiki/Home.md`:

```markdown
# Castwright

Any book, performed by a full cast — effortlessly.

This wiki is the user guide: install, upload a book, cast it, generate
audio, listen, export. See the sidebar for every page.

- Release notes: see [RELEASE_NOTES.md](https://github.com/dudarenok-maker/Castwright/blob/main/RELEASE_NOTES.md)
```

Create `docs/wiki/_Sidebar.md`:

```markdown
### Core journey
- [Home](Home)
- [Getting Started](Getting-Started)
- [Installing Castwright](Installing-Castwright)
- [Uploading a Book](Uploading-a-Book)
- [Analysis & the Analyzer](Analysis-and-the-Analyzer)
- [Reviewing Low-Confidence Speaker Tags](Reviewing-Low-Confidence-Speaker-Tags)
- [Generating Audio](Generating-Audio)
- [The Quality Gate](The-Quality-Gate)
- [Listening & Revising](Listening-and-Revising)
- [Exporting](Exporting)

### Cast & Voices
- [Reviewing Cast & Assigning Voices](Reviewing-Cast-and-Assigning-Voices)
- [Designing a Voice](Designing-a-Voice)

### Full breadth
- [Voice Engines](Voice-Engines)
- [The Model Control Pill](The-Model-Control-Pill)
- [Library Management](Library-Management)
- [Mobile, Tablet & Companion App](Mobile-Tablet-and-Companion-App)
- [Admin & Model Manager](Admin-and-Model-Manager)
- [Advanced Settings](Advanced-Settings)
- [Account & Settings](Account-and-Settings)
- [Multi-language Support](Multi-language-Support)
- [Troubleshooting](Troubleshooting)
```

Create `docs/wiki/_Footer.md`:

```markdown
---
[Castwright](https://castwright.ai) · [GitHub](https://github.com/dudarenok-maker/Castwright) · [Release Notes](https://github.com/dudarenok-maker/Castwright/blob/main/RELEASE_NOTES.md)
```

- [ ] **Step 11: First real sync**

```bash
npm run wiki:sync
```

Expected: `sync-wiki: pushed docs/wiki -> https://github.com/dudarenok-maker/Castwright.wiki.git`. Confirm the wiki now shows Home/sidebar/footer at `https://github.com/dudarenok-maker/Castwright/wiki`.

- [ ] **Step 12: Run the dual-render spike**

Create `docs/wiki/_Spike.md`:

```markdown
# Spike (throwaway — delete before Wave 1)

![test](images/_spike/01-test.png)
```

Drop any small PNG at `docs/wiki/images/_spike/01-test.png`, then:

```bash
npm run wiki:sync
```

Load the live spike page in a browser (via claude-in-chrome or manually) and check whether the image renders.

- [ ] **Step 13: Record the spike result**

If the image rendered: relative `images/<slug>/NN-caption.png` paths stand as written in every later task — no action needed.

If it did NOT render: every content task (2–11) below must instead use absolute
`https://raw.githubusercontent.com/dudarenok-maker/Castwright/main/docs/wiki/images/<slug>/NN-caption.png`
URLs in place of the relative path. **Stop here and update this plan's Tasks 2–11 image-path instructions accordingly before proceeding** — this is a load-bearing convention for all 21 pages.

- [ ] **Step 14: Delete the spike and re-sync**

```bash
rm docs/wiki/_Spike.md
rm -rf docs/wiki/images/_spike
npm run wiki:sync
```

- [ ] **Step 15: Commit the nav scaffold, open the PR**

```bash
git add docs/wiki/Home.md docs/wiki/_Sidebar.md docs/wiki/_Footer.md
git commit -m "docs(docs): scaffold wiki Home/Sidebar/Footer"
git push -u origin docs/docs-github-wiki-wave0-infra
gh pr create --base docs/docs-github-wiki --title "chore(scripts): wiki sync script + scaffold (Wave 0)" --body "$(cat <<'EOF'
## Summary
- Adds scripts/sync-wiki.mjs + test, mirroring docs/wiki/* to the GitHub wiki repo.
- Enables the repo wiki setting and scaffolds Home/_Sidebar/_Footer.
- Runs the dual-render spike; relative image paths confirmed working (or: falls back to raw.githubusercontent.com — see plan Step 13).

Refs #1276

## Test plan
- [x] node --test scripts/tests/sync-wiki.test.mjs passes
- [x] npm run wiki:sync pushes and the live wiki shows Home/Sidebar/Footer
- [x] Spike page confirmed image render behavior; spike deleted before merge
EOF
)"
```

This PR is `chore`/`build`-shaped, NOT docs-only — run the mandatory `low`-effort `code-review` pass on it before merge (Global Constraints).

---

## Task 2: Wave 1a — Getting Started + Installing Castwright

**Files:**
- Create: `docs/wiki/Getting-Started.md`, `docs/wiki/images/getting-started/*.png`
- Create: `docs/wiki/Installing-Castwright.md`, `docs/wiki/images/installing-castwright/*.png`
- Modify: `docs/wiki/_Sidebar.md` (no change needed — both links already scaffolded in Task 1)

**Interfaces:**
- Consumes: image-path convention confirmed in Task 1 Step 13; `_Sidebar.md` skeleton from Task 1.
- Produces: nothing further tasks depend on (Wave 1 pages are leaves in the nav graph aside from cross-links).

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki
git pull
git switch -c docs/docs-github-wiki-wave1a-getting-started
```

- [ ] **Step 2: Capture Getting Started screenshots**

Run `npm start` (real app, no mocks). Drive the app via Chrome browser automation and capture, in this order:

1. `01-books-view.png` — the initial Books/library view on first launch (empty or with the demo book tile).
2. `02-try-sample-book.png` — the "try a sample book" demo entry point.
3. `03-quickstart-flow.png` — the app mid-upload-to-generate flow (whichever single screen best represents "you're now in the pipeline").

- [ ] **Step 3: Write `docs/wiki/Getting-Started.md`**

```markdown
# Getting Started

A condensed quickstart. For full per-OS install steps, see
[Installing Castwright](Installing-Castwright).

## 1. Install and launch

Follow [Installing Castwright](Installing-Castwright), then run the app.

![Books view](images/getting-started/01-books-view.png)

## 2. Try the built-in sample book

Castwright ships with a demo book — *The Coalfall Commission* — so you can
see the full pipeline without uploading anything of your own.

![Try a sample book](images/getting-started/02-try-sample-book.png)

## 3. Upload → Analyze → Cast → Generate → Listen

That's the whole pipeline. Each stage gets its own wiki page — see the
sidebar's "Core journey" section for [Uploading a Book](Uploading-a-Book)
onward.

![Mid-pipeline](images/getting-started/03-quickstart-flow.png)
```

- [ ] **Step 4: Capture Installing Castwright screenshots**

Continue driving the app / OS file browser and capture:

1. `01-prerequisites.png` — whatever prerequisite check/screen the app or installer shows (or a terminal screenshot of the prerequisite command if there's no UI screen).
2. `02-install-windows.png` — the Windows install/launch step.
3. `03-configuration.png` — the settings/config screen relevant to first-run configuration.

- [ ] **Step 5: Write `docs/wiki/Installing-Castwright.md`**

Duplicate (not link) `INSTALL.md`'s content, illustrated. Mirror `INSTALL.md`'s existing heading structure so nothing is missed: Prerequisites, Install — Pinokio, Install — Windows/macOS/Linux, Try the demo book, Troubleshooting (short version; full version stays on the [Troubleshooting](Troubleshooting) wiki page), Configuration, Setting up the analyzer, Voice engines: standard vs optional, Installing Qwen3-TTS weights, Adding Coqui XTTS v2, Using Gemini for TTS, Picking a chapter audio format, Mobile + tablet access over LAN HTTPS, Android companion app, Updating. Under each heading, copy `INSTALL.md`'s prose and add the relevant screenshot(s) captured in Step 4 where a screenshot exists for that step; headings with no corresponding screenshot (e.g. "Updating") keep prose-only, copied verbatim from `INSTALL.md`.

Start the file:

```markdown
# Installing Castwright

This page duplicates [INSTALL.md](https://github.com/dudarenok-maker/Castwright/blob/main/INSTALL.md)
with screenshots. INSTALL.md remains the authoritative offline reference
shipped inside the release zip — if the two ever disagree, INSTALL.md wins.

## Prerequisites

![Prerequisites](images/installing-castwright/01-prerequisites.png)

...
```

- [ ] **Step 6: Verify and commit**

Manually confirm: both pages read cleanly top to bottom, every `![...]` image path matches a file that exists under `docs/wiki/images/`, and `Getting-Started.md`'s links to `Installing-Castwright` and vice versa resolve (same-repo wiki links use the bare page name, no `.md`).

```bash
git add docs/wiki/Getting-Started.md docs/wiki/Installing-Castwright.md docs/wiki/images/getting-started docs/wiki/images/installing-castwright
git commit -m "docs(docs): add Getting Started + Installing Castwright wiki pages"
git push -u origin docs/docs-github-wiki-wave1a-getting-started
gh pr create --base docs/docs-github-wiki --title "docs(docs): Getting Started + Installing Castwright wiki pages" --body "Refs #1276"
```

Pure `docs/**` change — docs-only CI fast-path and code-review exemption apply (Global Constraints).

---

## Task 3: Wave 1b — Uploading a Book + Analysis & the Analyzer + Reviewing Low-Confidence Speaker Tags

**Files:**
- Create: `docs/wiki/Uploading-a-Book.md`, `docs/wiki/images/uploading-a-book/*.png`
- Create: `docs/wiki/Analysis-and-the-Analyzer.md`, `docs/wiki/images/analysis-and-the-analyzer/*.png`
- Create: `docs/wiki/Reviewing-Low-Confidence-Speaker-Tags.md`, `docs/wiki/images/reviewing-low-confidence-speaker-tags/*.png`

**Interfaces:**
- Consumes: image-path convention from Task 1; views `src/views/upload.tsx`, `src/views/manuscript.tsx`, `src/views/restructure.tsx`, `src/views/confirm-metadata.tsx`, `src/views/analysing.tsx`, `src/views/low-confidence-nav.tsx` (all confirmed to exist).

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave1b-upload-analyze-review
```

- [ ] **Step 2: Capture Uploading a Book screenshots**

Using the demo book (or a fresh upload of it) drive `upload.tsx` → `manuscript.tsx` → `restructure.tsx` → `confirm-metadata.tsx` and capture:

1. `01-upload.png` — the upload view (drag-drop / file picker state).
2. `02-manuscript-paragraphs.png` — the manuscript paragraph-boundary editing view.
3. `03-restructure.png` — the chapter restructure view.
4. `04-confirm-metadata.png` — the confirm-metadata step (title/author/cover confirmation).

- [ ] **Step 3: Write `docs/wiki/Uploading-a-Book.md`**

```markdown
# Uploading a Book

## 1. Upload your manuscript

![Upload](images/uploading-a-book/01-upload.png)

## 2. Review paragraph boundaries

Castwright shows the manuscript broken into paragraphs; adjust boundaries
where the automatic split got it wrong (drag on desktop, tap on touch).

![Manuscript paragraphs](images/uploading-a-book/02-manuscript-paragraphs.png)

## 3. Restructure into chapters

![Restructure](images/uploading-a-book/03-restructure.png)

## 4. Confirm title, author, and cover

![Confirm metadata](images/uploading-a-book/04-confirm-metadata.png)

Next: [Analysis & the Analyzer](Analysis-and-the-Analyzer).
```

- [ ] **Step 4: Capture Analysis & the Analyzer screenshots**

Drive `analysing.tsx` through an analyzer run and capture:

1. `01-analysing-progress.png` — the in-progress analysis screen.
2. `02-analyzer-choice.png` — wherever the app exposes the Ollama / Gemini / pipelined two-model choice (settings or a picker on this screen).

- [ ] **Step 5: Write `docs/wiki/Analysis-and-the-Analyzer.md`**

```markdown
# Analysis & the Analyzer

Castwright reads your manuscript and tags who's speaking each line.

![Analysing](images/analysis-and-the-analyzer/01-analysing-progress.png)

## Choosing an analyzer

Local Ollama (default, free, private) or Gemini (free-tier API, faster on
low-VRAM machines) — see [Installing Castwright](Installing-Castwright) for
setup.

![Analyzer choice](images/analysis-and-the-analyzer/02-analyzer-choice.png)

Next: [Reviewing Low-Confidence Speaker Tags](Reviewing-Low-Confidence-Speaker-Tags).
```

- [ ] **Step 6: Capture Reviewing Low-Confidence Speaker Tags screenshots**

Drive `low-confidence-nav.tsx` (find a manuscript with at least one low-confidence tag, or the demo book if it has one) and capture:

1. `01-low-confidence-nav.png` — the low-confidence review navigator.
2. `02-resolve-tag.png` — resolving one flagged line.

- [ ] **Step 7: Write `docs/wiki/Reviewing-Low-Confidence-Speaker-Tags.md`**

```markdown
# Reviewing Low-Confidence Speaker Tags

Before generating audio, Castwright surfaces any line it wasn't confident
about attributing to a speaker, so you can confirm or correct it.

![Low-confidence navigator](images/reviewing-low-confidence-speaker-tags/01-low-confidence-nav.png)

![Resolve a tag](images/reviewing-low-confidence-speaker-tags/02-resolve-tag.png)

Next: [Generating Audio](Generating-Audio).
```

- [ ] **Step 8: Verify and commit**

Confirm every image path resolves and every next-page link is correct.

```bash
git add docs/wiki/Uploading-a-Book.md docs/wiki/Analysis-and-the-Analyzer.md docs/wiki/Reviewing-Low-Confidence-Speaker-Tags.md docs/wiki/images/uploading-a-book docs/wiki/images/analysis-and-the-analyzer docs/wiki/images/reviewing-low-confidence-speaker-tags
git commit -m "docs(docs): add Uploading, Analysis, and Low-Confidence Review wiki pages"
git push -u origin docs/docs-github-wiki-wave1b-upload-analyze-review
gh pr create --base docs/docs-github-wiki --title "docs(docs): Uploading a Book + Analysis + Low-Confidence Review wiki pages" --body "Refs #1276"
```

---

## Task 4: Wave 1c — Generating Audio (fe-46 flag) + The Quality Gate

**Files:**
- Create: `docs/wiki/Generating-Audio.md`, `docs/wiki/images/generating-audio/*.png`
- Create: `docs/wiki/The-Quality-Gate.md`, `docs/wiki/images/the-quality-gate/*.png`

**Interfaces:**
- Consumes: `src/views/generation.tsx`; fe-46 (#1262) merge status.

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave1c-generation-quality
```

- [ ] **Step 2: Check fe-46 status before capture**

```bash
gh pr list --search "1262 in:body" --state all
```

If fe-46 has merged: capture its pre-flight voice-readiness gate modal as part of the generation-start flow below. If it has NOT merged (the likely case — Wave 1 runs before Wave 3): capture the current generation-start flow as-is and add a note to this page (Step 4 below) plus a follow-up marker; do not block this task on fe-46.

- [ ] **Step 3: Capture Generating Audio screenshots**

Drive `generation.tsx` through a real generation run and capture:

1. `01-generation-start.png` — the generation-start screen/modal (include fe-46's readiness gate if merged, per Step 2).
2. `02-generation-progress.png` — in-progress generation with resource trends visible.
3. `03-generation-complete.png` — completion state.

- [ ] **Step 4: Write `docs/wiki/Generating-Audio.md`**

```markdown
# Generating Audio

![Start generation](images/generating-audio/01-generation-start.png)

<!-- fe-46 (#1262) flag: if not yet merged when this page was captured, the
     pre-flight voice-readiness gate shown here reflects the pre-fe-46 flow.
     Re-shoot 01-generation-start.png once fe-46 ships. -->

## Progress

![Generation progress](images/generating-audio/02-generation-progress.png)

## Done

![Generation complete](images/generating-audio/03-generation-complete.png)

Next: [The Quality Gate](The-Quality-Gate).
```

- [ ] **Step 5: Capture The Quality Gate screenshots**

Capture whatever the app surfaces for the acoustic check / transcript verification / drift check / automatic re-recording flow:

1. `01-quality-gate-flag.png` — a flagged line/chapter.
2. `02-quality-gate-rerecord.png` — the automatic re-recording in progress or its result.

- [ ] **Step 6: Write `docs/wiki/The-Quality-Gate.md`**

```markdown
# The Quality Gate

Every generated line passes an automatic acoustic + transcript check before
it's considered done. Lines that fail get automatically re-recorded.

![Flagged line](images/the-quality-gate/01-quality-gate-flag.png)

![Automatic re-record](images/the-quality-gate/02-quality-gate-rerecord.png)

Next: [Listening & Revising](Listening-and-Revising).
```

- [ ] **Step 7: Verify, commit, note the fe-46 follow-up**

If fe-46 was not merged at capture time, open a follow-up issue: `gh issue create --title "docs: re-shoot Generating Audio page 01 screenshot after fe-46 ships" --body "Refs #1276, #1262" --label documentation`.

```bash
git add docs/wiki/Generating-Audio.md docs/wiki/The-Quality-Gate.md docs/wiki/images/generating-audio docs/wiki/images/the-quality-gate
git commit -m "docs(docs): add Generating Audio and The Quality Gate wiki pages"
git push -u origin docs/docs-github-wiki-wave1c-generation-quality
gh pr create --base docs/docs-github-wiki --title "docs(docs): Generating Audio + Quality Gate wiki pages" --body "Refs #1276"
```

---

## Task 5: Wave 1d — Listening & Revising + Exporting

**Files:**
- Create: `docs/wiki/Listening-and-Revising.md`, `docs/wiki/images/listening-and-revising/*.png`
- Create: `docs/wiki/Exporting.md`, `docs/wiki/images/exporting/*.png`

**Interfaces:**
- Consumes: `src/views/listen.tsx` + `src/components/listen/listen-header.tsx`, `listen-player-region.tsx`, `listen-download-section.tsx`.

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave1d-listen-export
```

- [ ] **Step 2: Capture Listening & Revising screenshots**

Drive `listen.tsx` and capture:

1. `01-listen-header.png` — cover + title + book-meta + Notes card (`listen-header.tsx`).
2. `02-listen-player.png` — markers + chapter list (`listen-player-region.tsx`).
3. `03-revision-timeline.png` — the revision timeline / A/B audition affordance.
4. `04-share-clip.png` — the Share-clip button flow.

- [ ] **Step 3: Write `docs/wiki/Listening-and-Revising.md`**

```markdown
# Listening & Revising

![Book header](images/listening-and-revising/01-listen-header.png)

## Player and chapters

![Player](images/listening-and-revising/02-listen-player.png)

## Revision timeline and A/B audition

If a line doesn't sound right, regenerate it and compare old vs. new.

![Revision timeline](images/listening-and-revising/03-revision-timeline.png)

## Sharing a clip

![Share clip](images/listening-and-revising/04-share-clip.png)

Next: [Exporting](Exporting).
```

- [ ] **Step 4: Capture Exporting screenshots**

Drive `listen-download-section.tsx` and capture:

1. `01-download-tiles.png` — the format tiles (M4B/AAC/MP3/Opus).
2. `02-export-queue.png` — an in-progress export queue entry.
3. `03-lan-qr.png` — the LAN download + QR code flow.

- [ ] **Step 5: Write `docs/wiki/Exporting.md`**

```markdown
# Exporting

## Choose a format

M4B, AAC, MP3, or Opus.

![Download tiles](images/exporting/01-download-tiles.png)

## Export queue

![Export queue](images/exporting/02-export-queue.png)

## Download over LAN

Scan the QR code from your phone or tablet to download without a cable.

![LAN QR](images/exporting/03-lan-qr.png)
```

- [ ] **Step 6: Verify and commit**

```bash
git add docs/wiki/Listening-and-Revising.md docs/wiki/Exporting.md docs/wiki/images/listening-and-revising docs/wiki/images/exporting
git commit -m "docs(docs): add Listening & Revising and Exporting wiki pages"
git push -u origin docs/docs-github-wiki-wave1d-listen-export
gh pr create --base docs/docs-github-wiki --title "docs(docs): Listening & Revising + Exporting wiki pages" --body "Refs #1276"
```

---

## Task 6: Wave 2a — Voice Engines + The Model Control Pill

**Files:**
- Create: `docs/wiki/Voice-Engines.md`, `docs/wiki/images/voice-engines/*.png`
- Create: `docs/wiki/The-Model-Control-Pill.md`, `docs/wiki/images/the-model-control-pill/*.png`

**Interfaces:**
- Consumes: `src/components/ModelControlPill.tsx`.

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave2a-engines-pill
```

- [ ] **Step 2: Capture Voice Engines screenshots**

Capture one shot per engine's presence in the UI:

1. `01-kokoro.png`, `02-coqui.png`, `03-qwen.png`, `04-gemini.png` — wherever each engine surfaces (voice catalog filter, engine picker, or per-character override picker).

- [ ] **Step 3: Write `docs/wiki/Voice-Engines.md`**

```markdown
# Voice Engines

Castwright supports four TTS engines. See [Installing Castwright](Installing-Castwright)
for setup steps for each.

## Kokoro (always-available fallback)

![Kokoro](images/voice-engines/01-kokoro.png)

## Coqui XTTS v2

![Coqui](images/voice-engines/02-coqui.png)

## Qwen (default generation engine)

![Qwen](images/voice-engines/03-qwen.png)

## Gemini

![Gemini](images/voice-engines/04-gemini.png)

Next: [The Model Control Pill](The-Model-Control-Pill).
```

- [ ] **Step 4: Capture The Model Control Pill screenshots**

Drive `ModelControlPill.tsx` and capture:

1. `01-pill-unloaded.png`, `02-pill-loading.png`, `03-pill-loaded.png` — its load/unload states.

- [ ] **Step 5: Write `docs/wiki/The-Model-Control-Pill.md`**

```markdown
# The Model Control Pill

Load and unload button-driven engines (Coqui, Qwen Base) directly from the
UI — the pill shows current VRAM state and arbitrates conflicts between
engines.

![Unloaded](images/the-model-control-pill/01-pill-unloaded.png)
![Loading](images/the-model-control-pill/02-pill-loading.png)
![Loaded](images/the-model-control-pill/03-pill-loaded.png)
```

- [ ] **Step 6: Verify and commit**

```bash
git add docs/wiki/Voice-Engines.md docs/wiki/The-Model-Control-Pill.md docs/wiki/images/voice-engines docs/wiki/images/the-model-control-pill
git commit -m "docs(docs): add Voice Engines and The Model Control Pill wiki pages"
git push -u origin docs/docs-github-wiki-wave2a-engines-pill
gh pr create --base docs/docs-github-wiki --title "docs(docs): Voice Engines + Model Control Pill wiki pages" --body "Refs #1276"
```

---

## Task 7: Wave 2b — Library Management + Mobile, Tablet & Companion App

**Files:**
- Create: `docs/wiki/Library-Management.md`, `docs/wiki/images/library-management/*.png`
- Create: `docs/wiki/Mobile-Tablet-and-Companion-App.md`, `docs/wiki/images/mobile-tablet-and-companion-app/*.png`

**Interfaces:**
- Consumes: the Books/library view; LAN HTTPS pairing flow; Android companion app.

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave2b-library-mobile
```

- [ ] **Step 2: Capture Library Management screenshots**

1. `01-library-covers.png` — the library grid with covers/tags.
2. `02-series-grouping.png` — series grouping.
3. `03-book-bundle.png` — a book bundle, if one exists in the demo data.

- [ ] **Step 3: Write `docs/wiki/Library-Management.md`**

```markdown
# Library Management

![Covers and tags](images/library-management/01-library-covers.png)

## Series grouping

![Series](images/library-management/02-series-grouping.png)

## Book bundles

![Bundle](images/library-management/03-book-bundle.png)
```

- [ ] **Step 4: Capture Mobile, Tablet & Companion App screenshots**

1. `01-lan-pairing-qr.png` — LAN HTTPS QR pairing (per `npm run install:cert-mobile`).
2. `02-phone-viewport.png` — a phone-viewport screenshot of the app (per the mobile testing protocol).
3. `03-companion-app.png` — the Android companion app.

- [ ] **Step 5: Write `docs/wiki/Mobile-Tablet-and-Companion-App.md`**

```markdown
# Mobile, Tablet & Companion App

## LAN access

![LAN pairing](images/mobile-tablet-and-companion-app/01-lan-pairing-qr.png)

## Phone layout

![Phone](images/mobile-tablet-and-companion-app/02-phone-viewport.png)

## Android companion app

Deep-link pairing, offline-finished shelf, cross-device sync.

![Companion app](images/mobile-tablet-and-companion-app/03-companion-app.png)
```

- [ ] **Step 6: Verify and commit**

```bash
git add docs/wiki/Library-Management.md docs/wiki/Mobile-Tablet-and-Companion-App.md docs/wiki/images/library-management docs/wiki/images/mobile-tablet-and-companion-app
git commit -m "docs(docs): add Library Management and Mobile/Tablet/Companion wiki pages"
git push -u origin docs/docs-github-wiki-wave2b-library-mobile
gh pr create --base docs/docs-github-wiki --title "docs(docs): Library Management + Mobile/Tablet/Companion wiki pages" --body "Refs #1276"
```

---

## Task 8: Wave 2c — Admin & Model Manager + Advanced Settings + Account & Settings

**Files:**
- Create: `docs/wiki/Admin-and-Model-Manager.md`, `docs/wiki/images/admin-and-model-manager/*.png`
- Create: `docs/wiki/Advanced-Settings.md`, `docs/wiki/images/advanced-settings/*.png`
- Create: `docs/wiki/Account-and-Settings.md`, `docs/wiki/images/account-and-settings/*.png`

**Interfaces:**
- Consumes: `src/views/admin.tsx`, `src/views/model-manager.tsx`, `src/views/advanced.tsx`, `src/views/account.tsx`.

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave2c-admin-advanced-account
```

- [ ] **Step 2: Capture and write Admin & Model Manager**

Drive `admin.tsx` + `model-manager.tsx`; capture `01-admin-overview.png`, `02-model-manager.png`.

```markdown
# Admin & Model Manager

![Admin overview](images/admin-and-model-manager/01-admin-overview.png)

![Model manager](images/admin-and-model-manager/02-model-manager.png)
```

- [ ] **Step 3: Capture and write Advanced Settings**

Drive `advanced.tsx`; capture `01-accelerator-profile.png`.

```markdown
# Advanced Settings

## Accelerator profile

![Accelerator profile](images/advanced-settings/01-accelerator-profile.png)
```

- [ ] **Step 4: Capture and write Account & Settings**

Drive `account.tsx`; capture `01-account.png`.

```markdown
# Account & Settings

![Account](images/account-and-settings/01-account.png)
```

- [ ] **Step 5: Verify and commit**

```bash
git add docs/wiki/Admin-and-Model-Manager.md docs/wiki/Advanced-Settings.md docs/wiki/Account-and-Settings.md docs/wiki/images/admin-and-model-manager docs/wiki/images/advanced-settings docs/wiki/images/account-and-settings
git commit -m "docs(docs): add Admin/Model Manager, Advanced Settings, Account & Settings wiki pages"
git push -u origin docs/docs-github-wiki-wave2c-admin-advanced-account
gh pr create --base docs/docs-github-wiki --title "docs(docs): Admin/Model Manager + Advanced Settings + Account wiki pages" --body "Refs #1276"
```

---

## Task 9: Wave 2d — Multi-language Support + Troubleshooting

**Files:**
- Create: `docs/wiki/Multi-language-Support.md`, `docs/wiki/images/multi-language-support/*.png`
- Create: `docs/wiki/Troubleshooting.md`, `docs/wiki/images/troubleshooting/*.png`

**Interfaces:**
- Consumes: `INSTALL.md`'s Troubleshooting section; `src/views/help.tsx`.

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave2d-language-troubleshooting
```

- [ ] **Step 2: Capture and write Multi-language Support**

Upload/analyze the Russian Coalfall variant (`server/src/__fixtures__/the-coalfall-commission.ru.md`) and capture `01-language-detection.png`, `02-non-english-cast.png`.

```markdown
# Multi-language Support

English, Spanish, Russian are fully supported; French/German are dormant.
Language is auto-detected from the manuscript.

![Language detection](images/multi-language-support/01-language-detection.png)

![Non-English cast](images/multi-language-support/02-non-english-cast.png)
```

- [ ] **Step 3: Write Troubleshooting**

Migrate `INSTALL.md`'s Troubleshooting section content, plus `help.tsx`'s FAQ content, verbatim (copied prose, not paraphrased) into `docs/wiki/Troubleshooting.md`. No new screenshots required — this page is content-migration, not a new capture.

- [ ] **Step 4: Verify and commit**

```bash
git add docs/wiki/Multi-language-Support.md docs/wiki/Troubleshooting.md docs/wiki/images/multi-language-support
git commit -m "docs(docs): add Multi-language Support and Troubleshooting wiki pages"
git push -u origin docs/docs-github-wiki-wave2d-language-troubleshooting
gh pr create --base docs/docs-github-wiki --title "docs(docs): Multi-language Support + Troubleshooting wiki pages" --body "Refs #1276"
```

---

## Task 10: Wave 3 — Reviewing Cast & Assigning Voices + Designing a Voice

**Files:**
- Create: `docs/wiki/Reviewing-Cast-and-Assigning-Voices.md`, `docs/wiki/images/reviewing-cast-and-assigning-voices/*.png`
- Create: `docs/wiki/Designing-a-Voice.md`, `docs/wiki/images/designing-a-voice/*.png`

**Interfaces:**
- Consumes: `src/views/cast.tsx`, `src/views/voices.tsx`, `src/views/confirm-cast.tsx`; fe-46 (#1262) merge status (this task is sequenced LAST specifically to wait on it).

- [ ] **Step 1: Check fe-46 merge status — this is why this task runs last**

```bash
gh pr list --search "1262 in:body" --state all
```

If fe-46 has NOT merged yet, wait for it before starting this task (per spec — do not capture pages 11–12 against the pre-fe-46 flow).

- [ ] **Step 2: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave3-cast-voices
```

- [ ] **Step 3: Capture Reviewing Cast & Assigning Voices screenshots**

Drive `cast.tsx` / `voices.tsx` / `confirm-cast.tsx` (post-fe-46 confirmCast → Cast → Manuscript → Generate sequencing) and capture:

1. `01-cast-review.png`, `02-voice-library-dnd.png`, `03-assign-pill.png`, `04-ab-compare.png`, `05-confirm-cast.png`.

- [ ] **Step 4: Write `docs/wiki/Reviewing-Cast-and-Assigning-Voices.md`**

```markdown
# Reviewing Cast & Assigning Voices

![Cast review](images/reviewing-cast-and-assigning-voices/01-cast-review.png)

## Assigning a voice

Drag a voice card onto a cast row on desktop, or tap "Assign" then tap the
row on touch.

![Drag and drop](images/reviewing-cast-and-assigning-voices/02-voice-library-dnd.png)
![Assign pill](images/reviewing-cast-and-assigning-voices/03-assign-pill.png)

## A/B compare

![A/B compare](images/reviewing-cast-and-assigning-voices/04-ab-compare.png)

## Confirming the cast

![Confirm cast](images/reviewing-cast-and-assigning-voices/05-confirm-cast.png)

Next: [Designing a Voice](Designing-a-Voice).
```

- [ ] **Step 5: Capture Designing a Voice screenshots**

Drive the Qwen VoiceDesign flow and capture:

1. `01-persona-input.png`, `02-design-progress.png`, `03-emotion-variants.png`, `04-design-scope-picker.png`.

- [ ] **Step 6: Write `docs/wiki/Designing-a-Voice.md`**

```markdown
# Designing a Voice

Describe a persona and Qwen VoiceDesign generates a matching voice.

![Persona input](images/designing-a-voice/01-persona-input.png)

![Design progress](images/designing-a-voice/02-design-progress.png)

## Emotion variants

![Emotion variants](images/designing-a-voice/03-emotion-variants.png)

## Designing for one character vs. the full cast

![Design-scope picker](images/designing-a-voice/04-design-scope-picker.png)
```

- [ ] **Step 7: Verify and commit**

```bash
git add docs/wiki/Reviewing-Cast-and-Assigning-Voices.md docs/wiki/Designing-a-Voice.md docs/wiki/images/reviewing-cast-and-assigning-voices docs/wiki/images/designing-a-voice
git commit -m "docs(docs): add Reviewing Cast & Assigning Voices and Designing a Voice wiki pages"
git push -u origin docs/docs-github-wiki-wave3-cast-voices
gh pr create --base docs/docs-github-wiki --title "docs(docs): Cast Review + Voice Design wiki pages (Wave 3)" --body "Refs #1276"
```

---

## Task 11: Wave 4 — README.md / INSTALL.md migration

**Files:**
- Modify: `README.md` (shrink to pitch + links)
- `INSTALL.md` — **unchanged**, per Global Constraints

**Interfaces:**
- Consumes: every page from Tasks 1–10 (links to them); the confirmed final wiki sidebar structure.

- [ ] **Step 1: Branch**

```bash
git switch docs/docs-github-wiki && git pull
git switch -c docs/docs-github-wiki-wave4-readme-migration
```

- [ ] **Step 2: Rewrite `README.md`**

Keep `## What you get` (the pitch) and `## License` as-is. Replace `## Features`, `## Quickstart`, `## GPU & VRAM`, `## Companion app (Android)`, `## Releases`, `## How it's built`, `## Documentation` with a single condensed section:

```markdown
## Documentation

The full user guide — installing, uploading a book, casting, generating
audio, listening, exporting, and every feature area — lives on the
[wiki](https://github.com/dudarenok-maker/Castwright/wiki), illustrated
with real screenshots.

- New here? Start at [Getting Started](https://github.com/dudarenok-maker/Castwright/wiki/Getting-Started).
- Installing from the release zip? See [INSTALL.md](./INSTALL.md).
- Release history: [RELEASE_NOTES.md](./RELEASE_NOTES.md).
```

- [ ] **Step 3: Verify and commit**

Confirm `README.md` still renders sensibly top to bottom and every link resolves.

```bash
git add README.md
git commit -m "docs(docs): shrink README to a pitch + wiki/INSTALL links (Wave 4)"
git push -u origin docs/docs-github-wiki-wave4-readme-migration
gh pr create --base docs/docs-github-wiki --title "docs(docs): shrink README to pitch + links (Wave 4)" --body "Closes #1276"
```

- [ ] **Step 4: After all wave PRs are merged into `docs/docs-github-wiki`, open the final integration PR into `main`**

```bash
git switch docs/docs-github-wiki && git pull
gh pr create --base main --title "docs(docs): GitHub wiki user guide (all waves)" --body "Closes #1276, closes #1277"
```

Run `npm run wiki:sync` one final time after this merges to `main`, to publish the final README-linked state.

---

## Self-Review Notes

- **Spec coverage:** Every spec section maps to a task — Architecture/authoring model → Task 1; Wave 0 spike → Task 1 Steps 12–14; all 21 pages → Tasks 2–10; fe-46 interaction (pages 7, 11, 12) → Tasks 4 and 10; INSTALL.md relationship → Tasks 2 and 11; delivery waves → Tasks 1–11 branch/PR structure; testing/verification → each task's manual-verify step + Task 1's real unit test.
- **Correction from spec draft:** the spec's Testing/verification section says `scripts/sync-wiki.mjs` "follows the existing convention of testing `scripts/lib/` helpers" (implying Vitest); the actual convention for `.mjs` scripts under `scripts/tests/*.test.mjs` is **`node:test`**, auto-discovered by `npm run test:hooks` (see `scripts/run-hooks-tests.mjs`), not Vitest. Task 1 uses `node:test` — this is what the repo actually does, confirmed against `scripts/tests/build-companion-apk.test.mjs`.
- **Type/interface consistency:** `copyWikiTree(srcDir, destDir)` and `buildCommitMessage(sourceSha)` are the only two exported functions from `scripts/sync-wiki.mjs`, used identically in both the test (Task 1 Step 2) and no other task references them directly.
