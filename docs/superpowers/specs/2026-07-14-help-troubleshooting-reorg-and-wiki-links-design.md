# Design — Troubleshooting IA reorganization + curated wiki deep-links

- **Date:** 2026-07-14
- **Status:** approved (brainstorming) · adversarial review folded 2026-07-14
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

Failures and questions are **merged by topic** into 8 topical categories plus a small `other` category
("Something else") for the `unknown` failure. **Every category — including `other` — is a normal collapsible
group** with a count; there is no bespoke footer treatment (the earlier footer idea was dropped in review to
avoid a three-way special-case between the accordion, search, and count logic).

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
files 6 · other 1 = **43** (19 failures + 24 questions; confirmed against `help-failures.ts` /
`help-topics.ts`). Assignment is data (§A.2), so re-bucketing is a one-line data edit, not a code change.

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
  ≥44px touch target (`coarse-pointer` rule), keyboard-operable. Header shows label + count. Collapsed groups
  **unmount** their items (keeps the DOM light and the a11y tree clean).
- **Default expanded state (no `code`, no search): the first group (`setup`) is open; the rest closed.** So the
  page never reads as a wall of shut drawers, and the top of the list shows real content immediately.
- **Deep-link mounting (Critical wiring — see review).** The initial expanded set is computed *before first
  render* as `{ setup } ∪ { the category of focusCode, if any }`. Because the focused card is therefore mounted
  on the first commit, its `focusedRef` is populated and the existing scroll-into-view + magenta-ring highlight
  effect (`help.tsx:122-126`) fires correctly. Deriving expansion from `focusCode` at render time — **not** in a
  post-mount effect — is what keeps the failed-chapter "More help →" flow (`?code=…`) working. Unknown/missing
  codes remain a no-op (fall back to just `setup` open).
- **Search** — one controlled text input above the groups; case-insensitive substring match over each item's
  title **and** body (`userMessage` + `remediation` + `helpDetail` for failures; `body` for topics), the `other`
  entry included. While a query is present it overrides the default/deep-link expansion: matching groups expand
  and show only matching items, non-matching groups hide, and a live "N of 43" count + a clear button show. All
  client-side over the static bundle — **zero network calls preserved**.
- **Invariant 3 (plan 209) restated.** "Every `FailureCode` has a Help anchor `id={code}`" becomes "…present
  whenever its group is open." This is safe because the app's *only* deep-link path is `focusCode`, which
  auto-expands the containing group (no code path does a raw DOM-fragment lookup — the hash router owns the
  fragment, per the `JumpLink` note in `help.tsx`).

---

## Part B — Curated wiki links (Help + Admin)

### B.1 Plumbing

**Links are page-level only — no `#anchor` fragments** (decided in review). GitHub *wiki* (gollum) anchor slugs
are not the same as README-markdown anchors and have edge cases (punctuation, `&`, duplicate-heading suffixes);
replicating that algorithm in a guard test carries real risk of false confidence. Page-level links are robust,
land on the right (already section-organized) wiki page, and need only a "does the page exist" guard. The live
wiki was confirmed public and resolving at build-review time (`…/wiki/Troubleshooting` renders, not a 404).

- New `src/lib/wiki-links.ts`:
  - `WIKI_BASE = 'https://github.com/dudarenok-maker/Castwright/wiki'` — repo remote of record. **One-line
    comment notes the hardcoded owner (`dudarenok-maker`) couples to the current repo; a transfer to an org
    would require updating this constant.**
  - `type WikiPage` — string-literal union of the real wiki filenames (e.g. `'Troubleshooting'`,
    `'Model-Manager'`, `'Advanced-Settings'`, `'Admin'`, `'Mobile-Tablet-and-Companion-App'`, `'Getting-Started'`,
    `'Account-and-Settings'`).
  - `wikiUrl(page: WikiPage): string` — builds `${WIKI_BASE}/${page}`.
- New `WikiLink` component (promoted from the `ExternalLink` pattern already in `about.tsx`): renders an
  external `<a target="_blank" rel="noopener noreferrer">` with an external-link icon and the label
  "Read more on the wiki →", ≥44px touch target, brand link styling (`text-magenta`).

### B.2 Placement

**Help view:**
- Section-level `WikiLink` under each section intro: Getting started → `Getting-Started`;
  Keyboard shortcuts → `Account-and-Settings` (the section already routes users to Account for rebinding);
  Troubleshooting → `Troubleshooting`.
- **Per-category** `WikiLink` in each accordion, mapping the category to its best-fit wiki page (e.g.
  Performance & GPU → `Advanced-Settings`, Voice engines & models → `Model-Manager`, Analysis →
  `Analysis-and-the-Analyzer`). Category→page is one entry in the `wiki-links.ts` map.
- No per-item links in this pass — page-level category links carry the "learn more" affordance without a
  43-entry map. (Per-item links remain a later extension of the same map.)

**Admin view** — a compact "wiki →" link in each panel header (all page-level):
- Model Manager card → `Model-Manager`
- Advanced configuration card → `Advanced-Settings`
- LAN access card (`lan-access-card.tsx`) → `Mobile-Tablet-and-Companion-App`
- Health / Generation throughput / Resource trends → `Admin`
- About Castwright card → no wiki link (it already opens the in-app `/about`).

### B.3 Drift guard

`src/lib/wiki-links.test.ts` asserts every referenced `page` resolves against the committed wiki source:
`docs/wiki/<page>.md` exists. Renaming or removing a wiki page then breaks a test instead of shipping a dead
link. (No anchor validation — links are page-level, so there is no slug algorithm to get wrong.)

Rendering the links stays offline-safe: an `<a href>` is inert until clicked — no network call at render, so
plan 209 invariant 2 holds. Only a user click leaves the app (external, needs internet), which is expected for a
"read more on the wiki" affordance.

---

## Part C — Testing

**Unit (Vitest + RTL):**
- `help.test.tsx` — categories render in order with counts; the `setup` group is open by default and the rest
  closed; accordion expand/collapse toggles item mount; search filters items + auto-expands matching groups +
  hides empty groups + shows the count; deep-link `?code=` **mounts and highlights** the entry in its
  auto-expanded group; unknown code falls back to `setup`-only open (no-op highlight); section/category
  `WikiLink` hrefs are correct. **The existing test at `help.test.tsx:42` ("marks the focused entry") must be
  updated to assert its group is expanded** (the entry is only in the DOM once its group opens).
- Category completeness — every `FailureCode` and every `HelpTopic` maps to a valid `CategoryId`; every
  `CategoryId` appears in `HELP_CATEGORIES` (satisfies-pin + a guard test).
- `wiki-links.test.ts` — every referenced `WikiPage` exists as `docs/wiki/<page>.md`.

**E2E (Playwright) — two existing assertions must change (review finding):**
- `e2e/help.spec.ts` test #1 (`top-bar ? opens Help`) currently asserts `getByText('GPU out of memory (VRAM)')`
  is visible on a plain `#/help` with no deep-link. With `performance` collapsed by default this fails — update
  it to open the group first (or assert on the always-open `setup` group's content instead).
- `e2e/help.spec.ts` deep-link test (`?code=vram-spill`) must still pass: assert `#vram-spill` has
  `data-focused='true'` and `toBeInViewport()` — which now depends on the group auto-expanding on load. Add a
  search interaction (type → matching card visible, others hidden) and assert one `WikiLink` `href` (assert the
  attribute — do **not** navigate out).
- `e2e/responsive/coverage.spec.ts` Help case is unaffected (still renders at all viewports).

## Rollout / docs

- Update the active plan `docs/features/209-help-troubleshooting-view.md` with the new IA, the category data
  model, and the wiki-link surface (invariants + test plan).
- Release notes: append to `docs/release-notes-next.md` and the in-progress `RELEASE_NOTES.md` section
  (user-visible: Troubleshooting is now grouped + searchable, with wiki links).
- Issues (PR-issue-link gate): file a `fe-*` UX item for the Troubleshooting reorg and a feature item for the
  wiki-link surface; link both from the delivering PR.

## Review notes (assumption-checker, 2026-07-14)

Adversarial pass folded before plan-writing. Resolutions:

1. **Deep-link into a collapsed accordion (Critical).** Confirmed `e2e/help.spec.ts` and the focus effect
   (`help.tsx:122-126`) would break if collapsed groups unmount their items. Resolved: initial expanded set is
   derived from `focusCode` at render time (§A.3), so the focused card mounts on first commit.
2. **Collapse-by-default breaks existing render assumptions (Critical).** Confirmed test #1 asserts a
   `performance`-group card visible on plain `#/help`. Resolved: `setup` open by default (§A.3); test plan now
   updates *both* existing e2e assertions (§C).
3. **GitHub wiki slug replication is fragile (Significant).** Resolved: links are **page-level only**; the guard
   just checks page existence (§B.1, §B.3).
4. **Published wiki may not resolve (Significant).** Retired: fetched `…/wiki/Troubleshooting` — public, renders,
   already section-organized.
5. **`other`/`unknown` footer special-case under-specified (gap).** Resolved: `other` is a normal collapsible
   category, no footer (§A.1).
6. **`WIKI_BASE` owner coupling (Minor).** Noted with an inline comment (§B.1).

## Reversibility

- Troubleshooting reorg: the category data + accordion/search render replace the flat map in `help.tsx`; reverting
  restores the two flat lists. No persisted state, no router change.
- Wiki links: additive — remove `wiki-links.ts`, the `WikiLink` component, and its call sites. No other state touched.
