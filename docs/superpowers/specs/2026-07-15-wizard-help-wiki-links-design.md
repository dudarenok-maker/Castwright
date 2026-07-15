# First-run wizard: help & resources + per-step wiki deep-links

**Date:** 2026-07-15
**Issues:** fe-52 (#1615), fe-53 (#1616) — delivered together as one PR
**Epic:** fs-75 (#1613) — harden the first-run setup wizard + healthcheck (1.14)
**Status:** draft

## Problem

Beta feedback (2026-07-14) surfaced that the first-run setup wizard strands a
stuck user: there is **no path out to help until setup is finalized**, at exactly
the moment a confused user is most likely to abandon. Two gaps:

1. **No persistent escape hatch.** A user hitting trouble on any wizard step has
   nowhere to go for help, troubleshooting, or the wiki. (The top-bar "?" *is*
   rendered during the wizard, but it is generic app chrome pointing at the
   internal offline-help view — not setup-contextual, and not linked to the
   wiki / troubleshooting / support surfaces.)
2. **No contextual help.** Even a user who finds the wiki must hunt its index for
   the page relevant to the step they're on.

## Goals

- Every wizard step exposes a **persistent "Help & resources"** affordance with
  working outbound links (new tab, `rel="noopener noreferrer"`). *(fe-52)*
- Each wizard step also exposes a **contextual "Learn more"** deep-link to the
  specific wiki page for that step's topic. *(fe-53)*
- All outbound URLs live in **one constants module**, commented as
  externally-owned, so a link move is a one-line edit.
- **No dead links** — every wiki target exists (or the target page is improved so
  a first-run arrival flows).

## Non-goals

- No change to the top-bar "?" HelpMenu (that is app-wide chrome; touching it is
  scope creep beyond the wizard).
- No new wiki pages. Every step already has a real home on disk; the content work
  is a light editorial "arrival" pass, not authoring.
- No `#anchor` deep-linking. The links module deliberately links **page-level
  only** — GitHub wiki slug generation is not README-markdown slugging and is
  fragile to replicate. A step lands at the top of its page, where the relevant
  section already leads.

## Current state (what already exists)

- **`src/lib/wiki-links.ts`** — the shared links-constants module fe-50 created.
  Already exports `WIKI_BASE`, `wikiUrl(page)`, the `WikiPage` union, and the
  `GEMINI_KEY_WIKI` / `CATEGORY_WIKI` / `ADMIN_WIKI` / `HELP_SECTION_WIKI` maps.
  A guard test (`wiki-links.test.ts`) asserts every referenced `WikiPage` exists
  under `docs/wiki/`.
- **`src/components/wiki-link.tsx`** — `<WikiLink page label className>` renders an
  external, page-level wiki link: magenta, external-link icon, `target="_blank"`,
  `rel="noopener noreferrer"`, 44px touch target. Used across Help / Admin views
  and `lan-cert-status.tsx`.
- **`src/components/setup/setup-wizard.tsx`** — the wizard shell. Composes 7 step
  components (`step-*.tsx`) into two modes: `guided` (linear, Back/Next, "Step N
  of 7") and `re-entry` (summary board → drill into the same guided frame). The
  7 steps: **environment, ffmpeg, analysis, voice, defaults, lanCert, finish**.
- The wizard mounts under `Layout`, which renders `<TopBar>` on every stage
  including `setup` — so the top-bar "?" is present but, per the Problem, not
  fit for setup-contextual help.
- **`docs/wiki/`** — the published wiki source. Contains more pages than the
  `WikiPage` union exposes; notably **`Installing-Castwright.md`** (a full install
  guide whose top **Prerequisites** section covers OS/GPU/accelerator *and*
  per-OS ffmpeg install) is on disk but **not yet in the union**.

## Design

### 1. Data model — extend `src/lib/wiki-links.ts` (no new module)

Add the repo's support surfaces and the per-step map. Expose
`Installing-Castwright` in the `WikiPage` union.

```ts
// Add to the WikiPage union:
//   | 'Installing-Castwright'

// Support surfaces (fe-52). Repo-owner hardcoded like WIKI_BASE — update on transfer.
export const REPO_BASE = 'https://github.com/dudarenok-maker/Castwright';
export const SUPPORT_LINKS = {
  issues: `${REPO_BASE}/issues`, // "Report a problem"
  discussions: `${REPO_BASE}/discussions`, // "Ask a question"
} as const;

// Per-step contextual deep-link map (fe-53). Keyed by the wizard's StepId.
export const WIZARD_STEP_WIKI = {
  environment: 'Installing-Castwright',
  ffmpeg: 'Installing-Castwright',
  analysis: 'Analysis-and-the-Analyzer',
  voice: 'Voice-Engines',
  defaults: 'Account-and-Settings',
  lanCert: 'Mobile-Tablet-and-Companion-App',
  finish: 'Getting-Started',
} satisfies Record<StepId, WikiPage>;
```

`StepId` is the union currently declared inside `setup-wizard.tsx`. Export it (or
lift the `StepId` + `STEPS` declaration into a tiny shared module) so the map can
be keyed by it and stay exhaustive at compile time via `satisfies`.

Both `GET`s are verified live: `has_issues` and `has_discussions` are both true
on the repo (checked 2026-07-15), so Issues and Discussions are safe targets.

### 2. The fe-52 footer set (derived, not a new constant)

Four links, in order:

| Label | Target |
|---|---|
| Getting started | `wikiUrl('Getting-Started')` (wiki home / install guide) |
| Troubleshooting | `wikiUrl('Troubleshooting')` |
| Report a problem | `SUPPORT_LINKS.issues` |
| Ask a question | `SUPPORT_LINKS.discussions` |

### 3. The step → wiki-page map (fe-53)

| Step | "Learn more" → | Rationale |
|---|---|---|
| Environment | `Installing-Castwright` | Prerequisites section (OS/GPU/accelerator) leads the page |
| ffmpeg | `Installing-Castwright` | same Prerequisites section covers per-OS ffmpeg install |
| Analysis | `Analysis-and-the-Analyzer` | direct topic match |
| Voice | `Voice-Engines` | direct topic match |
| Defaults | `Account-and-Settings` | step sets 4 persisted prefs — this is the settings page |
| LAN access | `Mobile-Tablet-and-Companion-App` | positive "how LAN access works" (Troubleshooting is in the footer for when it breaks) |
| Finish | `Getting-Started` | its "Upload → Analyze → Cast → Generate → Listen" overview is the "what now?" next step |

Environment and ffmpeg intentionally share `Installing-Castwright`: both *are*
install prerequisites and the page leads with exactly that content. Page-level
linking makes the shared target land at the top where Prerequisites lives.

### 4. Components & placement

- **Extract `<ExternalLink>`** (`src/components/external-link.tsx`) from the
  current `<WikiLink>`: same visual treatment (magenta, external-link icon,
  `target="_blank"`, `rel="noopener noreferrer"`, 44px touch target), keyed on
  `href` + `label` + `className`. Refactor `<WikiLink>` to be `ExternalLink` with
  `href={wikiUrl(page)}`. Justification: fe-52's footer needs the two GitHub
  links styled *identically* to the wiki links; one primitive prevents drift.
  Existing `WikiLink` call-sites and tests are untouched (same rendered output).

- **`<HelpResources>`** (`src/components/setup/help-resources.tsx`) — the fe-52
  "Need help?" footer row: a label + the four `ExternalLink`s. `flex-wrap` so it
  reflows on phones.

- **Wizard shell** (`setup-wizard.tsx`): render `<HelpResources>` **once** in the
  outer `SetupWizard` shell, below the mode switch, so it is persistent on every
  step in **both** guided and re-entry modes.

- **Contextual "Learn more" (fe-53):** rendered **centrally** in the guided step
  frame, keyed by the current `stepId`:
  `<WikiLink page={WIZARD_STEP_WIKI[id]} label="Learn more" />`, positioned in the
  step-frame header. Rendering once (keyed by `stepId`) rather than editing all 7
  `step-*.tsx` files gives identical UX with one test instead of seven and a far
  smaller surface area. The re-entry flow reuses the same guided step frame when
  drilling into a step, so it is covered too.

### 5. Wiki content work ("update pages so it flows")

- **Expose `Installing-Castwright`** in the `WikiPage` union (1-line type
  addition). The existing guard test then covers it automatically (file exists).
- **Light editorial "arrival" pass** on the 7 target pages: confirm each page's
  *opening* speaks to a first-run user arriving from that step; tighten the lead
  where it does not. This is copy-editing existing pages, not authoring new ones.
  Most are expected to need nothing; the verification is the deliverable.
- **No new pages.** Every step has a real home already.

## Responsive (mobile protocol)

- Footer "Need help?" row: `flex-wrap` so links stack on `<640px`; single row on
  `sm:`+. 44px touch targets come from `ExternalLink` (`min-h-[44px]
  fine-pointer:min-h-0`).
- Contextual "Learn more": inherits `WikiLink`'s 44px target; sits in the step
  frame header, wrapping under the heading on narrow widths.
- Verified at phone / tablet / desktop per the mobile-testing protocol.

## Testing

- **`wiki-links.test.ts`** — extend the page-existence guard to `WIZARD_STEP_WIKI`
  values; assert every `StepId` is mapped (runtime exhaustiveness alongside the
  compile-time `satisfies`).
- **`external-link.test.tsx`** — renders `href`, `target="_blank"`,
  `rel="noopener noreferrer"`, label, icon.
- **`help-resources.test.tsx`** — renders exactly the 4 links with the correct
  hrefs; all `target="_blank" rel="noopener noreferrer"`.
- **`setup-wizard.test.tsx`** — `HelpResources` present on every step (guided) and
  in re-entry; the contextual "Learn more" link shows the right page per step.
- **e2e** (`e2e/`) — one Playwright spec: walk the wizard, assert the footer links
  on ≥2 steps + the per-step "Learn more" target, at phone/tablet/desktop.

## Shipping

- Regression plan under `docs/features/` (or folded into the fs-75 epic doc) +
  `docs/features/INDEX.md` entry.
- Release notes in **both** `docs/release-notes-next.md` and `RELEASE_NOTES.md`.
- PR body: `Closes #1615`, `Closes #1616`.
- Code-review gate: `low` effort (single-scope frontend chore/feat).

## Acceptance criteria (mapping to both issues)

fe-52:
- [ ] Every wizard step exposes a Help & resources affordance with working links
      (new tab, `noopener`).
- [ ] Links include wiki home (Getting-Started), Troubleshooting, and a
      support/community route (Issues + Discussions).
- [ ] URLs centralized in `wiki-links.ts` with the "externally owned" comment.
- [ ] Renders across phone / tablet / desktop breakpoints.

fe-53:
- [ ] Each wizard step renders a contextual link to its specific wiki page (new
      tab, `noopener`).
- [ ] The step → page mapping lives in the shared constants module.
- [ ] Every mapped wiki page exists — no dead links (guard test enforces).
- [ ] Renders across breakpoints.
