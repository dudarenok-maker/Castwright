# Design — Troubleshooting IA reorganization + curated wiki deep-links

- **Date:** 2026-07-14
- **Status:** approved (brainstorming)
- **Area:** frontend (Help view, Admin view)
- **Related plan:** `docs/features/209-help-troubleshooting-view.md` (active — this view's plan of record)
- **Key files:** `src/views/help.tsx`, `src/data/help-failures.ts`, `src/data/help-topics.ts`,
  `src/views/admin.tsx`, `src/components/lan-access-card.tsx`, `src/lib/brand.ts` (or new `src/lib/wiki-links.ts`)

## Problem

The in-app Troubleshooting section (`#/help`, from the top-bar "?" and Account) renders **43 items in
one flat scroll** — 19 named failures (the fs-19 taxonomy, `help-failures.ts`) followed by 24 hand-written
common questions (`help-topics.ts`) — under just two `<h3>` subheadings. There is no grouping, search, or
collapse, so finding the right entry means scrolling a wall of cards. Separately, the app never links out
to the published GitHub wiki, even though the wiki has ~30 topic pages that map cleanly onto app areas.

## Goals

1. Make Troubleshooting **browsable and searchable** — grouped into a handful of sensible categories with
   a filter box — without losing the deep-link-to-a-failure flow that failed-chapter rows depend on.
2. Add **curated, content-appropriate "Read more on the wiki →" links** from Help and Admin, deep-linked to
   the right page/section, with a guard against link drift.

## Non-goals

- No server-rendered or remotely-fetched help content — all Help copy stays static and bundled (plan 209
  invariant 2: the Help view makes **zero network calls** and renders with the server down).
- No wiki links across the broader workflow views (Upload / Cast / Design / Generate / Listen) in this pass —
  deferred; the `wiki-links.ts` map is the extension point when we want them.
- No rewrite of the failure taxonomy copy or the shared `failure-remediations.ts` module.

---

## Part A — Reorganized Troubleshooting

### A.1 Category taxonomy

Failures and questions are **merged by topic** into 8 topical categories plus a tiny `other` bucket for the
`unknown` failure. Each category renders as a collapsible group with a count; the `other` group is rendered
as a plain always-visible footer note rather than an accordion.

| id | Label | Failures | Questions |
|---|---|---|---|
| `setup` | Setup & getting started | — | app-wont-start, setup-not-ready |
| `engines` | Voice engines & models | recycle-storm, sidecar-unreachable, model-not-loaded, synth-timeout, xtts-speaker-desync | models-missing, engine-needs-repair |
| `analysis` | Analysis | analyzer-rate-limit, analyzer-daily-quota, analyzer-truncated, analyzer-unreachable, analyzer-content-blocked, attribution-incomplete, auth | ollama-model-not-in-list, picked-local-but-ran-on-gemini, analysis-reloads-or-gpu-busy |
| `voices` | Voices & languages | voice-not-designed | languages-supported, voices-hidden-wrong-language, design-without-cloud-key |
| `quality` | Quality & directing | — | higher-quality-tier, vocalizations, line-direction, voice-consistency-flag |
| `cast` | Cast & attribution | — | script-review-fixes, cast-carried-across-books |
| `performance` | Performance & GPU | vram-spill, oom, cuda-poisoned, gpu-acceleration-unavailable | generation-slow, amd-gpu, multi-gpu-placement |
| `files` | Files, export & devices | disk-full | where-files-live, audiobookshelf-export, caption-export, phone-cant-reach, lan-token-pairing |
| `other` | Something else | unknown | — |

Counts (item totals): setup 2 · engines 7 · analysis 10 · voices 4 · quality 4 · cast 2 · performance 7 ·
files 6 · other 1 = **43**. Assignment is data (§A.2), so re-bucketing is a one-line data edit, not a code change.

### A.2 Data model

Category assignment is **data, pinned by the type system** — no logic branches on titles or ids:

- New `type CategoryId` (string-literal union) and an ordered `HELP_CATEGORIES: { id: CategoryId; label: string }[]`
  that drives group render order. Lives with the other Help data (new `src/data/help-categories.ts`, or exported
  from an existing data file).
- `help-failures.ts` gains a `CATEGORIES` record `satisfies Record<FailureCode, CategoryId>` — same guard shape as
  the existing `TITLES` pin, so a new `FailureCode` with no category fails `npm run typecheck`.
- `HelpTopic` gains a required `category: CategoryId` field.
- `HELP_FAILURE_ENTRIES` entries carry their resolved `category`; the view groups all entries (failures + topics)
  by `category` in `HELP_CATEGORIES` order.

### A.3 Behavior

- **Accordion** — each category is a `<button aria-expanded aria-controls>` toggling a labelled region,
  collapsed by default, ≥44px touch target (`coarse-pointer` rule), keyboard-operable. Header shows label + count.
  The `other`/`unknown` entry renders as a plain footer, not a toggle.
- **Search** — one controlled text input above the groups; case-insensitive substring match over each item's
  title **and** body (`userMessage` + `remediation` + `helpDetail` for failures; `body` for topics). While a
  query is present: matching groups auto-expand and show only matching items, non-matching groups are hidden,
  and a live "N of 43" count + a clear button show. All client-side over the static bundle — **zero network
  calls preserved**.
- **Deep-link (`?code=`) — user-facing behavior unchanged.** `focusCode` resolves the entry's `category`,
  auto-expands that one group, then the existing scroll-into-view + magenta-ring highlight fires
  (`data-focused`, `focusedRef`). Unknown/missing codes remain a no-op. This is the only new wiring the merge
  requires, and it keeps the failed-chapter-row "More help →" flow intact.
- **Empty search** — all topical groups collapsed; if a `focusCode` is present, only its group starts expanded.

---

## Part B — Curated wiki links (Help + Admin)

### B.1 Plumbing

- New `src/lib/wiki-links.ts`:
  - `WIKI_BASE = 'https://github.com/dudarenok-maker/Castwright/wiki'` (repo remote of record).
  - `type WikiPage` — string-literal union of the real wiki filenames (e.g. `'Troubleshooting'`,
    `'Model-Manager'`, `'Advanced-Settings'`, `'Admin'`, `'Mobile-Tablet-and-Companion-App'`, `'Getting-Started'`).
  - `wikiUrl(page: WikiPage, anchor?: string): string` — builds `${WIKI_BASE}/${page}#${anchor}`.
- New `WikiLink` component (promoted from the `ExternalLink` pattern already in `about.tsx`): renders an
  external `<a target="_blank" rel="noopener noreferrer">` with an external-link icon and the label
  "Read more on the wiki →", ≥44px touch target, brand link styling (`text-magenta`).

### B.2 Placement

**Help view:**
- Section-level `WikiLink` under each section intro: Getting started → `Getting-Started`;
  Troubleshooting → `Troubleshooting`. (Keyboard shortcuts: skip — no strong wiki counterpart.)
- **Per-category** `WikiLink` in each accordion (page/anchor per category, e.g. Performance & GPU →
  `Advanced-Settings` / `Troubleshooting` GPU section).
- **Per-item** links only for a **curated high-value subset** with a stable anchor — not all 43 (a full 43-anchor
  map is fragile and high-maintenance). The map holds only the items we deliberately deep-link.

**Admin view** — a compact "wiki →" link in each panel header:
- Model Manager card → `Model-Manager`
- Advanced configuration card → `Advanced-Settings`
- LAN access card (`lan-access-card.tsx`) → `Mobile-Tablet-and-Companion-App`
- Health / Generation throughput / Resource trends → `Admin` (with per-panel anchors where the wiki page has them)
- About Castwright card → no wiki link (it already opens the in-app `/about`).

### B.3 Drift guard

`src/lib/wiki-links.test.ts` asserts every referenced `{ page, anchor }` resolves against the committed wiki
source in `docs/wiki/`:
- `docs/wiki/<page>.md` exists.
- For an `anchor`, some Markdown heading in that file **slugifies to the anchor** using GitHub's wiki slug
  algorithm (lowercase, spaces→`-`, strip punctuation). Renaming a wiki heading then breaks a test instead of
  shipping a dead link.

Rendering the links stays offline-safe: an `<a href>` is inert until clicked — no network call at render, so
plan 209 invariant 2 holds. Only a user click leaves the app (external, needs internet), which is expected for a
"read more on the wiki" affordance.

---

## Part C — Testing

**Unit (Vitest + RTL):**
- `help.test.tsx` — categories render in order with counts; accordion expand/collapse; search filters items +
  auto-expands matching groups + hides empty groups + shows the count; deep-link `?code=` auto-expands the
  containing group and highlights the entry; unknown code is a no-op; section/category `WikiLink` hrefs are correct.
- Category completeness — every `FailureCode` and every `HelpTopic` maps to a valid `CategoryId`; every
  `CategoryId` appears in `HELP_CATEGORIES` (satisfies-pin + a guard test).
- `wiki-links.test.ts` — referenced pages exist under `docs/wiki/`; referenced anchors slugify to a real heading.

**E2E (Playwright):**
- Update `e2e/help.spec.ts`: the `?code=vram-spill` deep-link test asserts the containing group is expanded and
  the entry is focused/in-viewport; add a search interaction (type → matching card visible, others hidden); assert
  one `WikiLink` `href` (assert the attribute — do **not** navigate out).
- `e2e/responsive/coverage.spec.ts` Help case is unaffected (still renders at all viewports).

## Rollout / docs

- Update the active plan `docs/features/209-help-troubleshooting-view.md` with the new IA, the category data
  model, and the wiki-link surface (invariants + test plan).
- Release notes: append to `docs/release-notes-next.md` and the in-progress `RELEASE_NOTES.md` section
  (user-visible: Troubleshooting is now grouped + searchable, with wiki links).
- Issues (PR-issue-link gate): file a `fe-*` UX item for the Troubleshooting reorg and a feature item for the
  wiki-link surface; link both from the delivering PR.

## Reversibility

- Troubleshooting reorg: the category data + accordion/search render replace the flat map in `help.tsx`; reverting
  restores the two flat lists. No persisted state, no router change.
- Wiki links: additive — remove `wiki-links.ts`, the `WikiLink` component, and its call sites. No other state touched.
