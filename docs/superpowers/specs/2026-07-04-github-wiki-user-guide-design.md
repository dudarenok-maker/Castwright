# GitHub wiki user guide — design

Status: draft
Date: 2026-07-04

## Problem

`README.md` and `INSTALL.md` thoroughly cover installing, configuring, and
listing features, but nothing walks a user through actually *using* the app —
upload a book, review cast, assign or design voices, generate, listen,
export — with screenshots. There is no visual, task-oriented guide, and no
single documentation home: a new user has to piece the picture together from
a features bullet list.

## Goal

Build a comprehensive GitHub wiki that becomes the **primary documentation
home** for Castwright: every pipeline stage and every feature area, each
illustrated with real screenshots from the running app. `README.md` shrinks
to a pitch + links. `INSTALL.md` stays intact (see "INSTALL.md relationship"
below) — its content is *duplicated*, not migrated, into the wiki.

## Non-goals

- No product changes. This is documentation-only work; nothing in `src/`,
  `server/`, or the sidecar changes.
- Not a visual redesign of the app (out of scope per project conventions
  regardless).
- Not a translation effort — the wiki ships in English only for v1.

## Architecture: authoring model

GitHub wikis are their own separate git repo (`Castwright.wiki.git`) with **no
PR review, no CI, no branch protection** — editing it directly (web UI or
`git push`) bypasses this repo's entire commit-gate/review discipline
(pre-commit hooks, the mandatory `code-review` PR gate, etc).

To preserve that discipline, the wiki's **source of truth lives in this
repo**:

- `docs/wiki/*.md` — one Markdown file per page.
- `docs/wiki/images/<page-slug>/NN-caption.png` — screenshots, referenced by
  page-relative path.
- `docs/wiki/_Sidebar.md` / `docs/wiki/_Footer.md` — wiki-wide nav chrome
  (GitHub's wiki convention for a persistent sidebar/footer).

Pages are authored on normal feature branches and reviewed via PR. **Only
the pure-content waves (1–4, all under `docs/**`/root `*.md`) get the
`docs-only` CI fast-path and code-review exemption.** Wave 0 adds an
executable script (`scripts/sync-wiki.mjs`), its test, and a `package.json`
entry — that's a `chore`/`build`-shaped change outside the doc-only glob, so
it does **not** qualify for the exemption and gets a real (`low`-effort)
`code-review` pass like any other non-doc PR.

A new script, `scripts/sync-wiki.mjs`, mirrors `docs/wiki/*` into
`Castwright.wiki.git`:

1. Attempt `git clone https://github.com/dudarenok-maker/Castwright.wiki.git`
   into a scratch/cache location. **A GitHub wiki's git repo does not exist
   until at least one page exists** — enabling the `has_wiki` setting alone
   doesn't create it, so this clone fails on a never-touched wiki. On clone
   failure, fall back to `git init` + `git remote add origin <url>` +
   `git push -u origin HEAD:master` to create the wiki repo from scratch
   (this is the actual bootstrap mechanism, exercised once in the Wave 0
   spike below — not a hypothetical).
2. Copy `docs/wiki/*` over the clone's (or freshly-initialized) working tree
   (excluding `.git/`).
3. Commit (message references the source commit SHA in the main repo) and
   push.
4. Exposed as `npm run wiki:sync`, run manually by the operator after a merge
   to `main` touches `docs/wiki/**`, using the operator's own `gh`/git
   credentials. This is intentionally a manual, human-run step with no CI
   identity behind it — the wiki repo sits outside `main`'s branch protection
   by design (GitHub wikis have no PR mechanism to gate on), so there is
   nothing for automation to gate against; a human running it locally is the
   actual safeguard, not an accident of scope.

**Repo setting change required:** the repo currently has `hasWikiEnabled:
false`. Enabling it (`gh api -X PATCH repos/dudarenok-maker/Castwright
-f has_wiki=true`, needs admin) is a Wave 0 task — call this out to the user
before running it, since it's a repo-visibility-adjacent setting change.

### Wave 0 spike: prove the authoring model before building content

The dual-render premise — a page + subdirectory image under `docs/wiki/`
rendering correctly both as a main-repo blob (for PR review) and after
`sync-wiki.mjs` flattens `docs/wiki/*` to the wiki repo's root (for the
published wiki) — is unverified and load-bearing for all 21 pages. Before
any content wave starts, Wave 0 includes a spike:

1. Enable the wiki, run the bootstrap path above once for real.
2. Commit one throwaway page (`docs/wiki/_Spike.md`) with one image at
   `docs/wiki/images/_spike/01-test.png`, referenced as
   `![](images/_spike/01-test.png)`.
3. Sync it, then check the **live wiki page** in a browser: does the image
   render?
4. **If yes:** the page-relative convention in "Screenshot workflow" below
   stands as written.
5. **If no:** fall back to absolute `raw.githubusercontent.com/<owner>/<repo>/main/docs/wiki/images/...`
   URLs. This trades the "self-contained mirror" property for a working
   render (the wiki page's images point back at `main` in the source repo)
   — an explicit, accepted tradeoff if the relative-path approach fails,
   not a silent one.
6. Delete the spike page/image once the answer is confirmed, before Wave 1
   starts.

## Screenshot workflow

- Drive the real running app (`npm start` — real analyzer, real sidecar, no
  mocks) via Chrome browser automation.
- Use the built-in **"try a sample book"** demo — *The Coalfall Commission*
  (13-character cast, already a committed fixture) — as the consistent,
  real-content source for every screenshot. No fabricated/mocked UI states.
- Desktop-viewport screenshots by default; capture phone/tablet viewports
  additionally only for pages where the mobile-testing protocol's layout
  rules produce a genuinely different screenshot worth showing (e.g.
  Listening & Revising's bottom-sheet player, the hamburger nav).
- File convention: `docs/wiki/images/<page-slug>/NN-caption.png`, numbered in
  the order they appear on the page.

## Page structure (21 pages)

Grouped in the wiki sidebar under three headings.

**Core journey**

1. Home (wiki landing page)
2. Getting Started (condensed quickstart; links to page 3 for full detail)
3. Installing Castwright (migrated from `INSTALL.md`: per-OS steps, Pinokio,
   prerequisites, configuration reference)
4. Uploading a Book (`upload.tsx`, `manuscript.tsx`, `restructure.tsx`,
   `confirm-metadata.tsx`)
5. Analysis & the Analyzer (`analysing.tsx`; choosing Ollama / Gemini /
   pipelined two-model)
6. Reviewing Low-Confidence Speaker Tags (script-review QA pass,
   `low-confidence-nav.tsx`)
7. Generating Audio (`generation.tsx`, resource trends)
8. The Quality Gate (acoustic check, transcript verification, drift check,
   automatic re-recording)
9. Listening & Revising (`listen.tsx`, revision timeline, drift detection,
   A/B audition)
10. Exporting (M4B/AAC/MP3/Opus, LAN download + QR)

**Cast & Voices** *(grouped together, sequenced last — see Wave 3 below)*

11. Reviewing Cast & Assigning Voices (`cast.tsx`, `voices.tsx`,
    `confirm-cast.tsx`, catalog/preset assignment, drag-and-drop, A/B compare)
12. Designing a Voice (Qwen VoiceDesign: persona → generated voice, emotion
    variants, design progress, design-scope picker)

**Full breadth**

13. Voice Engines (Kokoro / Coqui / Qwen / Gemini — install and switch)
14. The Model Control Pill (`ModelControlPill.tsx` — load/unload, VRAM
    arbitration)
15. Library Management (covers, tags, series grouping, book bundles)
16. Mobile, Tablet & Companion App (LAN HTTPS, pairing, Android app)
17. Admin & Model Manager (`admin.tsx`, `model-manager.tsx`)
18. Advanced Settings (`advanced.tsx` — accelerator profile, etc.)
19. Account & Settings (`account.tsx`)
20. Multi-language Support
21. Troubleshooting (migrated from `INSTALL.md`'s Troubleshooting section,
    plus `help.tsx` FAQ content)

(About / Release Notes was folded out as a standalone page — it links to
`RELEASE_NOTES.md` directly from Home's footer instead of duplicating that
file's content.)

## fe-46 interaction (flagged risk)

`fe-46` (Cast-first landing + pre-flight voice-readiness gate, issue #1262,
plan `docs/features/240-cast-first-landing-and-voice-readiness-gate.md`) is
**in progress in parallel** with this wiki work. It touches **three** pages,
not two:

- Pages 11–12 (Reviewing Cast & Assigning Voices, Designing a Voice) — the
  `confirmCast` → Cast → Manuscript → Generate re-sequencing and the
  "Design full cast" / "Proceed anyway" affordances live here.
- **Page 7 (Generating Audio)** — fe-46's pre-flight voice-readiness gate
  modal fires at generation start, so it lands squarely on this page too.
  This page sits in Wave 1 (core journey), captured well before Wave 3.

Mitigation:

- Pages 11–12 are captured **last**, in Wave 3, with an explicit check of
  `fe-46`'s merge status immediately before capture — same as before.
- Page 7, captured earlier in Wave 1, gets the **same flag**: at Wave 1
  capture time, check `fe-46`'s status; if it hasn't landed yet (the likely
  case, since Wave 1 runs first), page 7 documents the current
  generation-start flow and picks up an explicit follow-up note (and, once
  `fe-46` ships, a re-shoot issue) rather than being silently left stale —
  the same "flagged, not silent" treatment pages 11–12 get, applied to the
  one Wave-1 page fe-46 actually reaches.

## INSTALL.md relationship

`INSTALL.md` ships inside the offline release zip
(`castwright-vX.Y.Z.zip`) and is the install contract for a deployer who has
extracted that zip and may not have a browser open on GitHub yet. It **stays
fully intact, unchanged** — not stubbed, not retired. The wiki's "Installing
Castwright" page (page 3) is a **parallel, screenshot-illustrated duplicate**
for online readers, not a migration target. This means install steps have
two places to update going forward — a deliberate, scoped exception to the
"migrate, don't duplicate" decision for `README.md`, made specifically
because `INSTALL.md` has an offline audience `README.md` doesn't.

`README.md` still shrinks to a pitch + links (to both the wiki and
`INSTALL.md`) — it isn't shipped as a deployer's only install reference the
way `INSTALL.md` is, so migrating it away carries no equivalent offline-gap
risk.

## Delivery: waves

One integration branch, `docs/docs-github-wiki`, off of which every PR below
branches — each is its own small, independently-reviewable PR (not one
all-at-once PR, and not one PR per wave — a 9-page wave is too large for a
single reviewable diff):

- **Wave 0 — infra + spike.** One PR: `docs/wiki/` scaffold,
  `scripts/sync-wiki.mjs` + `npm run wiki:sync` + its test
  (`scripts/tests/sync-wiki.test.mjs`, Vitest — matching the actual
  precedent for `.mjs` scripts, not the PowerShell/Pester convention used
  for `scripts/lib/`), enabling the GitHub wiki setting, `_Sidebar.md` /
  `_Footer.md`, the render-model spike (above), empty Home page. **This PR
  is a `chore`/`build` change, not docs-only — it gets the mandatory
  `low`-effort `code-review` pass**, unlike every other wave below.
- **Wave 1 — core journey**, split into ~4 small PRs of 2–3 pages each
  rather than one 9-page PR, e.g.: (a) Getting Started + Installing
  Castwright; (b) Uploading a Book + Analysis & the Analyzer + Reviewing
  Low-Confidence Speaker Tags; (c) Generating Audio (with the fe-46 flag
  above) + The Quality Gate; (d) Listening & Revising + Exporting.
- **Wave 2 — full breadth**, similarly split into ~3–4 small PRs of 2–3
  pages each (e.g. engines + pill; library + mobile/companion; admin +
  advanced + account; multi-language + troubleshooting).
- **Wave 3 — cast & voices.** One PR, pages 11–12, captured last per the
  fe-46 mitigation above.
- **Wave 4 — migration.** One PR: shrink `README.md` to a pitch + links;
  add the "Installing Castwright" wiki page as `INSTALL.md`'s duplicate per
  the section above (`INSTALL.md` itself is untouched).

Waves 1–4's PRs are pure `docs/**`/root `*.md` and qualify for the
docs-only CI fast-path and code-review exemption; Wave 0 does not (above).
Each PR runs `npm run wiki:sync` after merge to publish its pages live.

## Testing / verification

This is documentation content, not app behavior — the project's automated
test suites don't apply. Verification is manual per page:

- Every screenshot is captured against the real running app (not staged
  mockups) — verified by the person merging each wave's PR actually loading
  the described view and comparing.
- `scripts/sync-wiki.mjs` gets a small unit test (it's a script under
  `scripts/`, so it follows the existing convention of testing
  `scripts/lib/` helpers) covering its copy/diff logic — not the actual git
  push, which isn't unit-testable.
- Each wave's PR description includes a manual acceptance checklist: every
  linked page loads, every image renders, internal cross-links resolve.

## Open questions / follow-ups

- The wiki's search/discoverability (GitHub wikis have basic built-in
  search) is not otherwise tuned — acceptable for v1.
- No i18n for the wiki itself in v1 (matches "Multi-language Support" being
  a *documentation topic*, not the wiki being translated).
