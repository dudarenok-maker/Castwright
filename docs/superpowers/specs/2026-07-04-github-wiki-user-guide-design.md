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
illustrated with real screenshots from the running app. `README.md` and
`INSTALL.md`'s content migrates into the wiki rather than being duplicated.

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

Pages are authored on normal feature branches, reviewed via PR (the
`docs-only` CI fast-path and code-review exemption apply per the existing
convention — this is a docs-only change-type), and merged to `main` like any
other change.

A new script, `scripts/sync-wiki.mjs`, mirrors `docs/wiki/*` into
`Castwright.wiki.git`:

1. Clone (or `git -C` pull, if cached) `https://github.com/dudarenok-maker/Castwright.wiki.git`
   into a scratch/cache location.
2. Copy `docs/wiki/*` over the clone's working tree (excluding the clone's own
   `.git/`).
3. Commit (message references the source commit SHA in the main repo) and
   push.
4. Exposed as `npm run wiki:sync`, run manually after a merge to `main`
   touches `docs/wiki/**`. Not wired into any automated hook — a deliberate
   manual step, since it pushes to a repo outside the normal branch-protection
   perimeter.

**Repo setting change required:** the repo currently has `hasWikiEnabled:
false`. Enabling it (`gh api -X PATCH repos/dudarenok-maker/Castwright
-f has_wiki=true`, needs admin) is a Wave 0 task — call this out to the user
before running it, since it's a repo-visibility-adjacent setting change.

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
**in progress in parallel** with this wiki work and changes exactly the flow
pages 11–12 document (confirm → Cast → Manuscript → Generate re-sequencing,
the pre-flight voice-readiness gate before generation, the "Design full
cast" / "Proceed anyway" affordances).

Mitigation: pages 11 and 12 are captured **last**, in Wave 3, with an
explicit check of `fe-46`'s merge status immediately before capture. If
`fe-46` has landed by then, pages 11–12 document the new flow; if not, they
document the current flow and get a follow-up issue filed for a re-shoot
once `fe-46` ships (same pattern as any other doc-drift follow-up).

## Delivery: waves

One integration branch, `docs/docs-github-wiki`, with each wave landing as
its own PR (normal branch → PR → review → merge flow) rather than one
all-at-once PR:

- **Wave 0 — infra.** `docs/wiki/` scaffold, `scripts/sync-wiki.mjs` +
  `npm run wiki:sync`, enable the GitHub wiki setting, `_Sidebar.md` /
  `_Footer.md`, empty Home page.
- **Wave 1 — core journey.** Pages 2–10, screenshotted and written.
- **Wave 2 — full breadth.** Pages 13–21.
- **Wave 3 — cast & voices.** Pages 11–12, captured last per the fe-46
  mitigation above.
- **Wave 4 — migration.** Shrink `README.md` to a pitch + wiki link;
  retire `INSTALL.md`'s content into page 3, leaving a short redirect stub
  (`INSTALL.md` becomes "moved to the wiki, see <link>") rather than deleting
  the file outright (external links to it stay resolvable).

Each wave PR runs `npm run wiki:sync` after merge to publish that wave's
pages live.

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
