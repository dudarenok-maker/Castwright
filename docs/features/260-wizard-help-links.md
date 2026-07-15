---
status: active
shipped: null
owner: null
---

# fe-52 / fe-53 — Wizard "Need help?" footer + per-step wiki deep-links

> Status: active
> Key files: `src/lib/wiki-links.ts` (`WIZARD_STEP_WIKI`, `HELP_FOOTER_WIKI`, `stepLearnMorePage`,
> `SUPPORT_LINKS`), `src/components/external-link.tsx` (`ExternalLink`), `src/components/wiki-link.tsx`
> (`WikiLink`), `src/components/setup/help-resources.tsx` (`HelpResources`),
> `src/components/setup/setup-wizard.tsx` (mounts both)
> URL surface: `#/setup` — every wizard surface (guided steps, re-entry summary board, re-entry
> drilled-in step)
> OpenAPI ops: none — pure client-side links out to the published GitHub wiki + repo

Closes #1615 (fe-52, "Need help?" footer), #1616 (fe-53, per-step "Learn more"). Spec:
`docs/superpowers/specs/2026-07-15-wizard-help-wiki-links-design.md`. Plan:
`docs/superpowers/plans/2026-07-15-wizard-help-wiki-links.md`.

## Benefit / Rationale

- **User:** Nobody gets stuck mid-setup with no way out. Every wizard surface — guided step,
  re-entry summary board, re-entry drilled-in step — carries a persistent "Need help?" bar
  (getting started, install guide, troubleshooting, report a problem, ask a question), plus a
  contextual "Learn more" link that follows whichever step is currently on screen.
- **Technical:** The footer's 3 wiki links and the per-step wiki map share one source of truth
  (`HELP_FOOTER_WIKI`), so the per-step "Learn more" suppression rule can never drift out of
  sync with what the footer actually shows — it's derived, not a second hand-maintained list.
- **Architectural:** The `ExternalLink` extraction is a pure refactor — `WikiLink`'s public API
  and rendered output are unchanged, it's just implemented as a thin wrapper now, so a second
  outbound-link surface (the footer) can reuse the same safe-`rel`/new-tab/44px-target primitive
  without duplicating it.

## Architectural impact

- **New seams / extension points:**
  - `src/lib/wiki-links.ts`: `SUPPORT_LINKS` (repo issues/discussions), `WIZARD_STEP_WIKI`
    (`Record<StepId, WikiPage>`, lines 80-88), `HELP_FOOTER_WIKI` (the 3 wiki pages shown in the
    footer, lines 92-96), and `stepLearnMorePage(step)` (lines 101-104) — returns the step's
    mapped page, or `null` when that page is already one of `HELP_FOOTER_WIKI`.
  - `src/components/external-link.tsx`: new `ExternalLink` primitive (href/label/className) —
    new tab, `rel="noopener noreferrer"`, 44px touch target, external-link icon.
  - `src/components/setup/help-resources.tsx`: new `HelpResources` component — the 5-link
    footer, built entirely from `wiki-links.ts` constants (no hardcoded URLs in the component).
- **Invariants preserved:**
  - `WikiLink`'s public API (`page`/`label`/`className` props) and rendered output are
    byte-identical after the `ExternalLink` extraction — it's a delegation, not a rewrite.
  - The wizard's existing step machinery (`STEPS`, `StepId`, guided/re-entry mode split) is
    untouched; the footer and contextual link are additive renders layered on top.
- **Migration story:** none — no persisted data shape changes.
- **Reversibility:** all four commits (`581f9cb4`, `04e6c4d8`, `2e4572ce`, `4244e943`) are pure
  additions/one clean extraction; reverting them drops the footer and contextual link with no
  cleanup required.

## Invariants to preserve

1. **The Help & resources footer renders on every wizard surface** — guided steps, the re-entry
   summary board, and the re-entry drilled-in step — because `<HelpResources />` is mounted once
   in `SetupWizard` (`setup-wizard.tsx:100`), unconditionally after the `mode === 'guided' ?
   <GuidedWizard/> : <ReEntryFlow/>` branch. `ReEntryFlow` (`setup-wizard.tsx:197-234`) renders
   either `SetupSummary` (summary board) or `GuidedWizard` (drilled-in step) as its own child, so
   both re-entry sub-surfaces sit *under* the same `SetupWizard` wrapper and inherit the footer
   with no per-surface wiring. It always renders **exactly 5 links**, every one
   `target="_blank" rel="noopener noreferrer"`.
   - `src/components/setup/help-resources.test.tsx` — asserts exactly 5 links, each with the
     safe `target`/`rel` pair, and the 5 expected hrefs (Getting-Started, Installing-Castwright,
     Troubleshooting, issues, discussions).
   - `src/components/setup/setup-wizard.test.tsx:395-411` — asserts the footer renders in guided
     mode AND on the re-entry summary board (`setup-summary-board` testid present alongside
     "Need help?").
   - `e2e/setup-help-links.spec.ts` — drives a real browser: the footer is visible on wizard
     entry, "Report a problem" points at the real GitHub issues URL, and it stays visible at a
     375px phone viewport.
2. **The contextual "Learn more" link targets the current step's mapped page, retargets on step
   change, and is suppressed on steps whose page is already a footer link** (Environment, ffmpeg
   → both map to `Installing-Castwright`, which `HELP_FOOTER_WIKI` already lists as "Install &
   setup" — showing it twice on the same screen would be redundant). `GuidedWizard` derives
   `learnMorePage = stepLearnMorePage(step.id)` (`setup-wizard.tsx:126`) and only renders the
   `<WikiLink page={learnMorePage} label="Learn more" />` block (`setup-wizard.tsx:161-165`) when
   it's non-null.
   - `src/components/setup/setup-wizard.test.tsx:413-430` — Step 1 (Environment) and Step 2
     (ffmpeg) both suppress "Learn more" (page already in the footer); Step 3 (Analysis) shows it
     targeting `Analysis-and-the-Analyzer`.
   - `src/lib/wiki-links.test.ts:54-62` (`stepLearnMorePage`) — direct unit coverage of the
     suppression rule for all 7 `StepId` values, independent of any rendering.
   - `e2e/setup-help-links.spec.ts` — real browser: zero "Learn more" links on the (suppressed)
     first step, then the link appears targeting `Analysis-and-the-Analyzer` after advancing to
     the Analysis step.
3. **Every `WIZARD_STEP_WIKI` value and every `HELP_FOOTER_WIKI` entry exists as a
   `docs/wiki/*.md` file** (a dead-link guard) — `src/lib/wiki-links.test.ts:29-52` resolves each
   referenced page against `docs/wiki/<page>.md` (both the general link-registry test and a
   dedicated per-`StepId` sweep) and asserts the file exists and is non-empty. **Note: this guard
   is a local-file proxy for "the wiki page exists," not a live HTTP check** — the actual
   published GitHub wiki page's live status was confirmed HTTP 200 for all 8 target pages at ship
   time (Getting-Started, Installing-Castwright, Troubleshooting, Analysis-and-the-Analyzer,
   Voice-Engines, Account-and-Settings, Mobile-Tablet-and-Companion-App, Generating-Audio), but
   nothing in the automated suite re-verifies that on every run.
   - **Arrival-lead editorial pass (Task 7):** of the 8 target pages, 7 already opened with a
     clear orienting sentence for a reader arriving mid-setup and needed no change; only
     `Account-and-Settings.md` got an added lead sentence. The narrow 1-of-8 edit is the intended
     conservative outcome of that pass, not an incomplete sweep.
4. **`WikiLink`'s public API and rendered output are unchanged after the `ExternalLink`
   extraction** — same props (`page`/`label`/`className`), same href (`wikiUrl(page)`), same
   `target="_blank" rel="noopener noreferrer"`, same default label ("Read more on the wiki").
   Locked by `src/components/wiki-link.test.tsx` (both the default-label + safe-rel case and the
   custom-label case), unchanged from before the extraction.

## Test plan

### Automated coverage

- Vitest unit (`src/components/setup/help-resources.test.tsx`) — 5 links, all safe `target`/
  `rel`, correct hrefs for all 5 (getting-started/install/troubleshooting/issues/discussions).
- Vitest unit (`src/components/wiki-link.test.tsx`) — `WikiLink` behavior unchanged post-refactor.
- Vitest unit (`src/lib/wiki-links.test.ts`) — `wikiUrl` no-anchor page-level URLs; every
  `WIZARD_STEP_WIKI`/`HELP_FOOTER_WIKI`/`CATEGORY_WIKI`/`ADMIN_WIKI`/`HELP_SECTION_WIKI` page
  resolves to an existing `docs/wiki/*.md` file (dead-link guard); `stepLearnMorePage`
  suppression for all 7 steps; `SUPPORT_LINKS` point at the real repo issues/discussions URLs.
- Vitest unit (`src/components/setup/setup-wizard.test.tsx`, describe block "SetupWizard — help
  & wiki links (fe-52/fe-53)") — footer present in guided mode and on the re-entry summary
  board; "Learn more" suppressed on Environment/ffmpeg, shown targeting
  `Analysis-and-the-Analyzer` on the Analysis step.
- Playwright e2e (`e2e/setup-help-links.spec.ts`) — footer + per-step "Learn more" through a
  real browser (mock mode): footer visible + correctly linked on wizard entry, "Learn more"
  suppressed on the first (Environment) step, appears targeting the right page after advancing
  to Analysis, and the footer stays visible at a 375px phone viewport.

**Not separately e2e-covered:** the re-entry drilled-in step's footer presence is exercised only
by the Vitest unit test's architectural guarantee (one `<HelpResources/>` mount point shared by
every `SetupWizard` render path) rather than a dedicated Playwright assertion — flagged here so a
future refactor of `SetupWizard`'s render tree doesn't silently break that guarantee unnoticed.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`).

1. **Cold boot at `#/?setup=notready`, guided mode, step 1 (Environment).** Expected: "Set up
   Castwright" heading, "Need help?" footer with 5 links visible, no "Learn more" link (its
   page, Installing-Castwright, is already the footer's "Install & setup" link).
2. **Advance to step 2 (ffmpeg) via Next.** Expected: footer unchanged, "Learn more" still
   suppressed (same mapped page).
3. **Advance to step 3 (Analysis) via Next.** Expected: "Learn more" now appears, linking to
   `https://github.com/dudarenok-maker/Castwright/wiki/Analysis-and-the-Analyzer` in a new tab.
4. **Re-entry mode (`mode="checklist"`), summary board.** Expected: "Need help?" footer renders
   alongside the summary rows.
5. **Re-entry mode, click a summary row to drill into a step.** Expected: the guided single-step
   view opens with a "‹ Setup overview" link back to the summary, and the "Need help?" footer is
   still present.

## Out of scope

- **Live HTTP verification of the 8 wiki pages** — the automated guard checks local
  `docs/wiki/*.md` files only (invariant 3 above). A CI job that fetches the live GitHub wiki
  URLs would be a separate follow-up, not part of this plan.
- **Anchored (`#section`) wiki links** — `wiki-links.ts` is deliberately page-level only
  (GitHub wiki slug generation is fragile to replicate); this plan doesn't add fragment support.
- **A dedicated e2e assertion for the re-entry drilled-in step's footer** — see "Not separately
  e2e-covered" above; the existing Vitest + architectural guarantee covers it today.

## Ship notes

(Filled in when status flips to `stable`.)
