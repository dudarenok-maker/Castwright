# Demo-mode marketing screenshot capture — design

**Status:** built (pending final `verify` + review)
**Date:** 2026-06-12
**Author:** Castwright
**Branch:** `feat/frontend-demo-marketing-capture`

## As-built (2026-06-12)

Implemented via subagent-driven execution against the plan
`docs/superpowers/plans/2026-06-12-demo-marketing-capture.md`. Delivered:

- **Wave A** name scrub (`Mike Dudarenok → Marin Vale`, default `displayName →
  "Castwright"`) across mocks + 12 specs; plus a gap found in flight — the
  hardcoded name in `src/views/preview-listener.tsx` (now "Marin Vale").
- **Wave B** additive Hollow Tide fixtures behind `VITE_DEMO_CAPTURE`,
  `.env.marketing`, `playwright.marketing.config.ts`, scene registry + capture
  runner + `npm run capture:marketing`. Determinism beyond the plan: the
  generating freeze works via the mock; the **runner also warms the library
  first** (several views read `s.library.books` for the cover) and **waits for
  images** (covers are large).
- **Wave C** covers wired (+ top-biased `coverFraming` so shelf titles aren't
  cropped), and scenes for account, profile-drawer, voice-library. The
  **voice-library** was additionally put behind the flag (a Hollow Tide voices
  fixture) so it shows on-brand voices.

**9 marketing scenes** capture clean at desktop (+ phone/tablet for the core six):
library-shelf, confirm-cast, cast-reuse, generating, listen, account,
profile-drawer, voice-library. **Deferred:** the `analysing` scene — the
AnalysingView's content is local-state-driven and doesn't auto-start on a cold
deep-link; the mock freeze + runner are ready, the view just needs to start
analysis under the flag. Tracked in `e2e/marketing/README.md` + a commented row
in `scenes.ts`.

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
- **Renaming the existing mock books/series or their slugs** — see F1 below; we
  keep them and add Hollow Tide alongside.
- The codebase-wide third-party copyrighted-character fixture scrub — **piece #2**.
- The codebase-wide real-name scrub across legal/docs prose — **piece #3**.
- Committing the rendered PNGs to git (they are regenerable; only the harness +
  fixtures are committed).

## The fictional series — "The Hollow Tide"

A coastal-gothic **mystery** series by the fictional author **Marin Vale** —
deliberately a different genre from Coalfall's dark fantasy so the marketing set
shows the product's range. Three books, posed to cover the pipeline stages, plus
the real **The Coalfall Commission** sample as the standalone "real, finished"
anchor:

| Book | Slug | Stage posed | Notes |
|---|---|---|---|
| *The Drowning Bell* | `hollow-tide-1` | **finished** | Origin of recurring cast voices. |
| *Saltgrave* | `hollow-tide-2` | **generating** (~62%, 7/11 ch) | Progress-bar scene. |
| *The Tidewatcher's Oath* | `hollow-tide-3` | **analysing** (ch 3/8, phase 2) | Live-analysis scene. |
| *The Coalfall Commission* | (existing) | finished (real sample) | Standalone anchor. |

New slugs are namespaced (`hollow-tide-*`) so they cannot collide with the
existing prototype slugs (`sb`/`ns`/`cc`/`ts`).

**Cast & reuse story.** An ensemble of ~10, with **3–4 recurring** characters
(e.g. Narrator, Insp. Cray, Dr. Wren) carrying `voiceState: 'reused'` +
`matchedFrom` provenance so the cast view renders both "reused from *The Drowning
Bell*" and "new this book" badges. All cast/reuse data is **fixture-only** — it
just needs to *look* right, not be a real cross-book computation. Names, titles,
covers are all fixture data and trivially editable later.

## Dataset strategy (revised after adversarial review — F1)

**Original spec proposed replacing the Northern Coast Trilogy outright. Rejected.**
The old titles (`Solway Bay`, `The Northern Star`, `Carrick's Compass`,
`Twilight Stations`, `Northern Coast Trilogy`) appear **319 times across 94
files** — ~50 e2e specs, dozens of unit tests, the analysis fixtures, the mock
manuscript, even parser fixtures. A rename is a 94-file blast radius, not a side
note.

**Adopted approach — additive, capture-only Hollow Tide set:**

- The **default mock dataset keeps its titles and slugs** (`sb/ns/cc/ts`)
  untouched, so all 319 references stay valid and the e2e/unit suites stay green.
- The **name scrub on the default dataset is narrow**: author `Mike Dudarenok →
  Marin Vale` in `src/mocks/library.ts`, `src/mocks/canned-data.ts`,
  `src/data/books.ts`, `src/mocks/manuscripts/*.md`, and the **12 test files**
  that assert the name (`top-bar.test.tsx`, `account.test.tsx`,
  `account.backups.test.tsx`, `upload.test.tsx`, `a11y.test.tsx`,
  `listen.test.tsx`, `listen-responsive.test.tsx`, `edit-book-meta.test.tsx`,
  `book-meta-slice.test.ts`, `persistence-middleware.test.ts`,
  `cross-book-duplicates.test.ts`, `server/.../user-settings.test.ts`).
- **Default display name** — `src/lib/account-defaults.ts` `displayName` + its
  server mirror `server/src/workspace/user-settings.ts` `DEFAULT_USER_SETTINGS`
  — change from the maintainer's real name to a neutral placeholder
  **"Castwright"** (what a brand-new real workspace shows before the user
  sets their own name; must not be a specific persona).
- **The Hollow Tide series is a separate fixture module**, served by the mock
  layer **only under the capture flag** (`VITE_DEMO_CAPTURE=1`). It is *additive*
  — it does not alter the default dataset, so it carries **zero test blast
  radius**. Under the flag the mock layer serves the Hollow Tide library, book
  states, casts, and the marketing account name.
- **F9 (open, minor):** the legacy dataset author also becomes "Marin Vale",
  i.e. one fictional author spans both datasets. Acceptable; flip to a distinct
  legacy author if a cleaner separation is wanted.

## Capture harness

Built on the existing Playwright mock-mode spine (`playwright.config.ts` runs
Vite in mock mode and defines desktop / Pixel 7 / iPad Pro 11 projects with
`animations: 'disabled'`).

- **Selecting the demo fixtures deterministically.** A new Vite mode
  `--mode marketing` loads a new `.env.marketing` setting `VITE_USE_MOCKS=true` +
  `VITE_DEMO_CAPTURE=1`. The mock layer reads the flag to (a) serve the posed
  Hollow Tide states + marketing account name and (b) enable the determinism
  shim (below). The default `--mode e2e` / `--mode development` paths are
  unaffected.
- **Dedicated Playwright config (F4).** `playwright.config.ts` hardcodes
  `--mode e2e` in its `webServer.command`, so capture needs its **own**
  `playwright.marketing.config.ts` that extends the base: override `webServer` to
  `vite --mode marketing`, point `testDir` at `e2e/marketing/`, and reuse the
  three viewport projects + `animations: 'disabled'`.
- **Scene registry (dedicated file, committed)** — `e2e/marketing/scenes.ts`.
  Hashes follow the verified `router.ts` grammar (F3): `#/` (library),
  `#/books/:bookId/analysing`, `#/books/:bookId/confirm`,
  `#/books/:bookId/:view` (e.g. `cast`, `generate`, `listen`), `#/account`,
  `#/voices`. Each scene:
  ```ts
  {
    id: 'cast-reuse',
    hash: '#/books/hollow-tide-1/cast',
    viewports: ['desktop', 'phone', 'tablet'],   // default: ['desktop']
    actions?: (page) => Promise<void>,            // e.g. open profile drawer
    waitFor?: string,                             // selector to await before shot
  }
  ```
- **Capture runner (committed).** A Playwright spec under `e2e/marketing/` that
  iterates the registry × requested viewports, navigates, runs `actions`, and
  writes `mockups/marketing-screens/<scene-id>.<viewport>.png` (+ `.<lang>.png`
  for language variants). It `mkdir -p`s the output dir first — `mockups/` is
  git-ignored and may be absent on a fresh checkout (F8).
- **Commands (dedicated)** —
  - `npm run capture:marketing` — full set (all scenes, default viewports).
  - `npm run capture:marketing -- --scene=<id>` — one scene.
  - `npm run capture:marketing -- --viewport=phone,tablet` — viewport subset.
  - A short **README** in `e2e/marketing/` documents the commands, the output
    location, and how to add a scene/variant — the "canonical screenshot recipe."

## Determinism (revised — F2)

Pixel-stable, re-runnable captures require freezing everything time- or
animation-dependent. Disabling CSS animations is necessary but **not
sufficient**: the mock layer advances state via real timers —
`src/lib/api.ts:1152` (analysis phase progress, `Date.now()`-based),
`src/lib/api.ts:1329` (`setInterval(tick, 1200)`, generation progress), and
`src/lib/api.ts:4967` (export-job ticks). Under `VITE_DEMO_CAPTURE=1` the mock
layer must **short-circuit these tickers to the fixture's static posed values**
(analysing phase/chapter, generating %/chapter count) instead of running the
live progression. Plus:

- **Animations/transitions disabled** (`toHaveScreenshot` `animations: 'disabled'`
  + a capture-mode CSS reset for app-driven CSS animations — waveforms, progress
  fills, spinners).
- **Relative timestamps** — library `lastWorkedOn` values are already static
  fixture strings; any *computed* relative time in a posed view is pinned.
- **Fonts** already self-hosted (#698), removing font-CDN/hinting flakiness.

The determinism shim lives behind the capture flag so normal dev mock mode keeps
its "live-feeling" animated mocks.

## Cover art (new — F6)

The app renders a book cover at **three** aspect ratios from one stored JPEG with
CSS pan/zoom framing: **1:1** in the Listen `CoverArt` (`listen-header.tsx:78`),
**16:10** in the library grid card (`library-grid.tsx:192`), **2:3** in the
library-table thumb. Marketing covers must therefore be **square masters with the
title/author safe inside the central 16:10 band** so every crop reads.

- **Format/size:** square `1:1`, 2048×2048 (or 1536×1536 if the generator caps
  there; upscale to 2400×2400 for Audible/ACX parity if needed), JPEG, sRGB.
- **Files (local-only, not committed):** drop into a git-ignored
  `public/marketing-covers/<slug>.jpg` so Vite serves them at
  `/marketing-covers/<slug>.jpg` during capture; the Hollow Tide fixtures point
  each book's cover URL there. (Add `public/marketing-covers/` to `.gitignore`.)
- **Three Hollow Tide covers are generated** from image prompts produced
  alongside this spec. **Coalfall already has cover art** at
  `brand/test-book/the-coalfall-commission-cover-final.png` (git-ignored,
  local-only) — copy it into `public/marketing-covers/coalfall-commission.jpg`;
  no generation needed.

## Scene set (v1)

Desktop is the default viewport; phone + tablet variants are captured for the
core scenes.

1. **Library shelf** (hero) — Hollow Tide + Coalfall, cards at mixed states.
2. **Analysing** — *The Tidewatcher's Oath* mid-analysis (cast forming, phases, ETA).
3. **Confirm / Meet-the-cast** — cast-card grid.
4. **Cast view** — full table, voices + tone controls, **series-reuse badges**.
5. **Generating** — *Saltgrave* chapter queue + progress + model picker.
6. **Listen** — *The Drowning Bell* finished: playback, loudness card, downloads.
7. **Account tab** — settings, posed with fictional account data (F7: confirm the
   sub-cards — backups, model inventory, updates, apiKeyStatus — all mock-served).
8. **Profile drawer** — one character's deep profile (tone sliders, evidence).
9. **Voice library / A-B compare** — global voice library + compare modal.

## Extensibility

- **Multilingual** (fs-2): a scene gains a `langs: ['en', 'ru', …]` field; the
  runner emits `<scene-id>.<lang>.png`.
- **Responsive**: per-scene `viewports` reuse the existing device projects.
- **Future features**: new surface ⇒ one registry row (+ any fixture state it
  needs). The README documents the pattern.

## Testing

- A **smoke test** in the e2e tier: the registry resolves, and the runner
  produces the expected file set for one viewport (no pixel baseline — this is a
  marketing tool, not a regression gate). Kept **out of** the blocking `verify`
  battery; run on demand.
- The narrow name-scrub touches 12 asserting specs — updated in lockstep and
  kept green. The additive Hollow Tide module touches no existing spec.

## v1 Definition of Done

- [ ] Default mock dataset: author name scrubbed to "Marin Vale"; default display
      name → "Castwright"; all 12 asserting specs updated and green.
- [ ] Hollow Tide capture-only fixture module (library + per-book posed state +
      cast/reuse + analysing-in-progress fixture), served under `VITE_DEMO_CAPTURE=1`.
- [ ] Square cover JPEGs generated + placed in git-ignored
      `public/marketing-covers/`; fixtures reference them.
- [ ] `.env.marketing`, `playwright.marketing.config.ts`, `e2e/marketing/scenes.ts`,
      capture runner, `npm run capture:marketing` commands.
- [ ] Determinism shim behind `VITE_DEMO_CAPTURE=1` (short-circuits the three
      timer sites + CSS animations).
- [ ] All v1 scenes capture cleanly at desktop; core scenes at phone + tablet.
- [ ] `e2e/marketing/README.md` documents the recipe.
- [ ] Output lands in git-ignored `mockups/marketing-screens/`.
- [ ] `npm run verify` green (capture harness not in the gate; the name scrub +
      additive module must not break it).

## Delivery roadmap

- **Wave A — name scrub.** Default dataset author → Marin Vale; default display
  name → "Castwright"; update the 12 asserting specs. *Gate:* `npm run
  verify` green.
- **Wave B — Hollow Tide fixtures + capture plumbing.** `.env.marketing`,
  `playwright.marketing.config.ts`, the additive fixture module + determinism
  shim, scene registry + runner + commands + README. *Gate:* full set captures
  cleanly; smoke test passes.
- **Wave C — scene coverage & polish.** Cover art wired; Account tab (F7),
  profile drawer, voice-library scenes; phone/tablet variants; review the actual
  PNGs for marketing quality. *Gate:* visual review of the output set.

## Separate follow-up pieces (out of scope here, tracked for later)

- **Piece #1b — companion-app marketing capture (sibling, shares content).** The
  Flutter Android companion (`apps/android`) also needs marketing screenshots
  (library cover-grid, per-book download, offline player with chapters/speed). It
  is a **different toolchain** (Flutter/Dart/emulator — Playwright can't drive
  it) with **no existing demo/screenshot tooling**, so it warrants its own spec.
  Recommended approach (from exploration): a local **demo-seed builder**
  (`lib/src/data/demo_data.dart`) hydrating the Drift DB + a fake `PairingStore`
  (skip the pair/sync flow), gated by `--dart-define DEMO_MODE=true`, captured on
  an emulator via `adb screencap` (or `integration_test`). It **reuses the same
  fictional content** — the Hollow Tide series + the three generated covers
  (downscaled to the companion's 250×250 thumbs) + the existing Coalfall art — so
  the two surfaces stay visually consistent. Treat the Hollow Tide content
  (metadata + cast + covers) as a **shared content pack** both pieces consume.
- **Piece #2 — copyrighted-character fixture scrub.** Rename the third-party
  copyrighted character names baked into ~122 test-fixture files to the owned
  Castwright cast, and re-point the canonical regression-manuscript reference
  (`CLAUDE.md`, plan docs) away from the legacy copyrighted manuscript to the
  owned Coalfall book. Large, mechanical, risky — its own spec.
- **Piece #3 — real-name scrub across legal/docs.** Per the user's call:
  **copyright + licence (`LICENSE`, `NOTICE`) keep the real name** (the actual
  legal holder); everywhere else non-legal — `User-Agent` strings in
  `server/src/cover/sources/`, doc/plan prose, the personal writing-style-guide
  doc — substitute the brand entity **"Castwright."** Its own spec.

## Adversarial review log (2026-06-12)

Verified against code; corrections folded in above.

- **F1 🔴** Full mock-library replacement under-scoped (319 hits / 94 files) →
  flipped to additive capture-only Hollow Tide set + narrow 12-file name scrub.
- **F2 🔴** Mock progress is live timer-driven (`api.ts:1152/1329/4967`) →
  determinism shim must short-circuit tickers, not just CSS.
- **F3 🟠** Hash grammar corrected to `#/books/:bookId/...` (plural; chapter=3
  omitted).
- **F4 🟠** `webServer` hardcodes `--mode e2e` → dedicated
  `playwright.marketing.config.ts`.
- **F5 🟠** Analysing scene coupled to `ns` fixtures → Hollow Tide needs its own
  analysing-in-progress fixture.
- **F6 🟠** Covers render at 1:1 / 16:10 / 2:3 → square masters, title in central
  16:10-safe band; new Cover-art section.
- **F7 🟡** Account-tab sub-card mock coverage to confirm at plan time.
- **F8 🟡** Runner must `mkdir -p` the git-ignored output dir.
- **F9 🟡** One fictional author spans both datasets — acceptable; flip if
  cleaner separation wanted.

## Open questions

- None blocking. F7 (account sub-card mock coverage) and F9 (single vs distinct
  fictional author) are confirm-at-plan-time, not blockers.
