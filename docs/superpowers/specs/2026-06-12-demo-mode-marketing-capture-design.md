# Demo-mode marketing screenshot capture — design

**Status:** draft
**Date:** 2026-06-12
**Author:** Castwright
**Branch:** `feat/frontend-demo-marketing-capture`

## Problem

We need to produce marketing imagery (and UX reference shots) of the Castwright
app showing the product mid-flow: the cast display, a book being analysed, a
book generating, a finished book, the library shelf, the account tab, etc. Today
there is no repeatable way to pose the app and capture a consistent, on-brand
set of screenshots — and the current mock data is neither on-brand (it carries
the maintainer's real name) nor designed to be screenshotted.

This is **piece #1** of a larger, decomposed initiative (see *Separate
follow-up pieces* below). It delivers the fictional content + the capture
harness; it deliberately does **not** boil the ocean on the codebase-wide
name/character scrub.

## Goals

1. A small, **fictional, on-brand series** ("The Hollow Tide") posed across the
   pipeline stages, usable as marketing fixtures — **display-only**, no
   manuscripts, no real audio, no live pipeline.
2. An **automated, repeatable screenshot capture harness** built on the existing
   Playwright + mock-mode infrastructure, driven by a **dedicated scene-registry
   file** and **dedicated npm commands**, writing a PNG set to a git-ignored
   `mockups/` folder.
3. Remove the maintainer's real name from **mock/fixture data and the
   app-visible default account name**, so no captured screenshot ever shows it.
4. The harness is **extensible**: adding a scene is one registry row; future
   surfaces (e.g. multilingual examples, new features) drop in as scene
   variants.

## Non-goals (for this piece)

- A runtime/production "demo mode" toggle. The user chose mock-mode capture; the
  app's production bundle gains no new demo surface.
- Real manuscripts, real audio, or live generation for the fictional series.
- The codebase-wide copyrighted-character ("Keefe") fixture rename — **piece #2**.
- The codebase-wide real-name scrub across legal/docs prose — **piece #3**.
- Committing the rendered PNGs to git (they are regenerable; only the harness +
  fixtures are committed).

## The fictional series — "The Hollow Tide"

A coastal-gothic **mystery** series by the fictional author **Marin Vale** —
deliberately a different genre from Coalfall's dark fantasy so the marketing set
shows the product's range. Three books, posed to cover the pipeline stages, plus
the real **The Coalfall Commission** sample as the standalone "real, finished"
anchor:

| Book | Stage posed | Notes |
|---|---|---|
| *The Drowning Bell* | **finished** | Origin of the recurring cast voices. |
| *Saltgrave* | **generating** (~62%, 7/11 ch) | Progress bar scene. |
| *The Tidewatcher's Oath* | **analysing** (ch 3/8, phase 2) | Live-analysis scene. |
| *The Coalfall Commission* | finished (real sample) | Standalone anchor, already bundled. |

**Cast & reuse story.** An ensemble of ~10, with **3–4 recurring** characters
(e.g. Narrator, Insp. Cray, Dr. Wren) carrying `voiceState: 'reused'` +
`matchedFrom` provenance so the cast view renders both "reused from *The Drowning
Bell*" and "new this book" badges. All cast/reuse data is **fixture-only** — it
just needs to *look* right, not be a real cross-book computation. Names, titles,
covers are all fixture data and trivially editable later.

## Fixture dataset & how it replaces today's mock library

Today's mock library (`src/mocks/library.ts`) is a "Northern Coast Trilogy" by
**"Mike Dudarenok"** with four books already spread across
`complete / generating / cast_pending / analysing` (and one Russian book seeding
the language filter). The real name is also the default account `displayName`
(`src/lib/account-defaults.ts`).

**Decision (recommended): "The Hollow Tide" becomes the single canonical
fictional mock dataset**, replacing the Northern Coast Trilogy in the default
mock library — so dev mock mode, the e2e suite, and marketing capture all share
one fictional universe and the maintainer's name leaves the mock data entirely.
The handful of e2e/unit specs that assert old titles/author are updated in the
same change.

*Lighter alternative (noted, not recommended):* keep the existing books and only
swap the author string to a fictional name; author Hollow Tide as a *separate*
marketing-only fixture set. Rejected because it leaves two fictional universes
and more long-term drift.

**Name scrub in scope for this piece:**
- `src/mocks/library.ts`, `src/mocks/canned-data.ts`, `src/data/books.ts`,
  `src/mocks/manuscripts/*.md` — author → **Marin Vale** (and the rebranded
  series/titles where the dataset is replaced).
- **Shipped default display name** — `src/lib/account-defaults.ts` `displayName`
  + its server mirror `server/src/workspace/user-settings.ts`
  `DEFAULT_USER_SETTINGS` — change from the maintainer's real name to a neutral
  placeholder **"Castwright User"** (this is what a brand-new real workspace
  shows before the user sets their own name, so it must not be a specific persona
  or book author).
- **Marketing-capture account name** — the demo fixtures override the account
  display name to **"Marin Vale"** under `VITE_DEMO_CAPTURE=1`, giving the
  Account-tab and top-bar screenshots a coherent persona (the author of *The
  Hollow Tide* using Castwright to produce their own series). This override is
  capture-only and never the shipped default.
- All unit/e2e specs asserting the above (`top-bar.test.tsx`,
  `account*.test.tsx`, `book-library.test.tsx`, `book-meta-slice.test.ts`,
  `cross-book-duplicates.test.ts`, etc.) updated in lockstep.

## Capture harness

Built on the existing Playwright mock-mode spine (`playwright.config.ts` already
runs Vite in mock mode and defines desktop/Pixel 7/iPad Pro 11 projects with
`animations: 'disabled'`).

- **Selecting the demo fixtures deterministically.** A new Vite mode
  `--mode marketing` loads `.env.marketing` setting `VITE_USE_MOCKS=true` plus a
  `VITE_DEMO_CAPTURE=1` flag. The mock layer reads the flag to (a) serve the
  posed/frozen Hollow Tide states and (b) enable the determinism shim. The
  default `--mode e2e` path is unaffected, so the existing e2e battery is
  untouched by capture-only behaviour.
- **Scene registry (dedicated file, committed)** — e.g. `e2e/marketing/scenes.ts`.
  Each scene:
  ```ts
  {
    id: 'cast-reuse',
    hash: '#/book/drowning-bell/cast',
    viewports: ['desktop', 'phone', 'tablet'],   // default: ['desktop']
    setup?: (page) => Promise<void>,             // seed/select book state
    actions?: (page) => Promise<void>,           // e.g. open profile drawer
    waitFor?: string,                            // selector to await before shot
  }
  ```
- **Capture runner (committed)** — a Playwright spec/script that iterates the
  registry × requested viewports, navigates, runs `actions`, and writes
  `mockups/marketing-screens/<scene-id>.<viewport>.png` (and `.<lang>.png` for
  language variants). Reuses the config's viewport projects so the phone/tablet
  device metrics match the responsive suite.
- **Commands (dedicated)** —
  - `npm run capture:marketing` — capture the full set (all scenes, default
    viewports).
  - `npm run capture:marketing -- --scene=<id>` — one scene.
  - `npm run capture:marketing -- --viewport=phone,tablet` — viewport subset.
  - A short **README** in `e2e/marketing/` documents the commands, the output
    location, and how to add a scene/variant (the "canonical screenshot recipe"
    the user asked for).

## Determinism (the hard part)

Pixel-stable, re-runnable captures require freezing everything time- or
animation-dependent. Under `VITE_DEMO_CAPTURE=1`:

- **Animations/transitions disabled** (reuse `toHaveScreenshot`'s
  `animations: 'disabled'` + a capture-mode CSS reset for CSS animations the
  app drives itself — waveforms, progress fills, spinners).
- **Progress/ETA pinned** to the fixture's exact numbers (analysing phase/chapter,
  generating %/chapter count) rather than any live-advancing mock timer.
- **Relative timestamps frozen** ("2 min ago", "Just now") to fixed strings.
- **Fonts** already self-hosted (#698), removing font-CDN/hinting flakiness.

Determinism lives behind the capture flag so normal dev mock mode keeps its
"live-feeling" animated mocks.

## Scene set (v1)

Desktop is the default viewport; phone + tablet variants are captured for the
core scenes.

1. **Library shelf** (hero) — Hollow Tide + Coalfall, cards at mixed states.
2. **Analysing** — *The Tidewatcher's Oath* mid-analysis (cast forming, phases, ETA).
3. **Confirm / Meet-the-cast** — cast-card grid.
4. **Cast view** — full table, voices + tone controls, **series-reuse badges**.
5. **Generating** — *Saltgrave* chapter queue + progress + model picker.
6. **Listen** — *The Drowning Bell* finished: playback, loudness card, downloads.
7. **Account tab** — settings, posed with fictional account data.
8. **Profile drawer** — one character's deep profile (tone sliders, evidence).
9. **Voice library / A-B compare** — global voice library + compare modal.

## Extensibility

- **Multilingual** (fs-2): a scene gains a `langs: ['en', 'ru', …]` field; the
  runner emits `<scene-id>.<lang>.png`. The mock layer already seeds a non-English
  book, so the language filter renders under mocks.
- **Responsive**: per-scene `viewports` reuse the existing device projects; new
  viewports are a config addition.
- **Future features**: new surface ⇒ one registry row (+ any fixture state it
  needs). The README documents the pattern.

## Testing

- A **smoke test** in the e2e tier: the registry resolves, and the runner
  produces the expected file set for one viewport (no pixel baseline — this is a
  marketing tool, not a regression gate). Kept **out of** the blocking `verify`
  battery; run on demand.
- Existing e2e/unit specs touched by the mock-library replacement + name scrub
  stay green (updated in lockstep).

## v1 Definition of Done

- [ ] Hollow Tide fixture dataset (library + per-book posed state + cast/reuse),
      replacing the Northern Coast Trilogy in the default mock library.
- [ ] Maintainer's real name gone from mock/fixture data and the default account
      display name; all asserting specs updated and green.
- [ ] Account-tab fixture data present and screenshot-able.
- [ ] Scene registry + capture runner + `.env.marketing` + `npm run
      capture:marketing` commands.
- [ ] Determinism shim behind `VITE_DEMO_CAPTURE=1`.
- [ ] All v1 scenes capture cleanly at desktop; core scenes at phone + tablet.
- [ ] `e2e/marketing/README.md` documents the recipe (commands, output, adding a
      scene/variant).
- [ ] Output lands in git-ignored `mockups/marketing-screens/`.
- [ ] `npm run verify` green (the capture harness is not in the gate, but the
      mock/name changes must not break it).

## Delivery roadmap

- **Wave A — fixtures & name scrub.** Author the Hollow Tide dataset; replace the
  mock library; scrub the name from mocks + account defaults; update asserting
  specs. *Gate:* `npm run verify` green.
- **Wave B — capture harness.** `.env.marketing` + determinism shim + scene
  registry + runner + commands + README. *Gate:* full set captures cleanly;
  smoke test passes.
- **Wave C — scene coverage & polish.** Account tab, profile drawer, voice-library
  scenes; phone/tablet variants; review the actual PNGs for marketing quality.
  *Gate:* visual review of the output set.

## Separate follow-up pieces (out of scope here, tracked for later)

- **Piece #2 — copyrighted-character fixture scrub.** Rename the "Keefe"-family
  copyrighted character names baked into ~122 test-fixture files to the owned
  Castwright cast, and re-point the canonical regression-manuscript reference
  (`CLAUDE.md`, plan docs) away from the copyrighted "Bonus Keefe Story.txt" to
  an owned book. Large, mechanical, risky — its own spec.
- **Piece #3 — real-name scrub across legal/docs.** Per the user's call:
  **copyright + licence (`LICENSE`, `NOTICE`) keep the real name** (it is the
  actual legal holder); everywhere else non-legal — `User-Agent` strings in
  `server/src/cover/sources/`, doc/plan prose, the personal writing-style-guide
  doc — substitute the brand entity **"Castwright."** Its own spec.

## Open questions

- None blocking. The canonical-mock-replacement decision (vs. the lighter
  author-only swap) is the one judgement call flagged inline above; recommended
  path is full replacement.
