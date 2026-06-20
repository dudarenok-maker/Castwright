# Visual-diff sensitivity — top-bar clip gate

**Date:** 2026-06-20 (rev 3 — pivoted after two adversarial rounds)
**Issue:** [#925](https://github.com/dudarenok-maker/Castwright/issues/925) — _Visual-diff threshold (5%) too loose to catch top-bar/branding-scale changes_
**Area:** `area:ops` / `type:chore`
**Status:** design — ready for review

## TL;DR

Close the documented gap with **issue option 4**: a dedicated, tightly-toleranced
screenshot of the **top-bar element only**, on top of the existing loose
full-viewport captures. A branding/logo change is a *small* fraction of a 720px
viewport (which is why it slips the 5% ratio) but a *large* fraction of a ~64px
top-bar clip — so even a 1% tolerance catches it, with no new code, no devDeps,
and no custom comparator. The broader "catch any large-region change anywhere"
ambition is **deferred to a separate backlog item** (see Follow-up).

## How we got here (design history)

Two prior revisions and two adversarial reviews are preserved in git
(`379c9b3a`, `6db95b3f`):

- **Rev 1** proposed a connected-component "contiguity gate" on full-page
  captures, justified by arithmetic claiming a branding change (~1.8%) overlaps
  font-hinting noise (~1–2%).
- **Round 1 review** proved the arithmetic was wrong: the baselines are
  **1280×720 viewport, not ~1800×1280 full-page** (`fullPage` is never set).
- **Rev 2** reframed as a measured A-vs-B bake-off (tightened ratio vs.
  contiguity comparator).
- **Round 2 review** showed the bake-off over-built around a chore and that
  **issue option 4 (a top-bar clip) was demoted without justification** — it
  closes the documented gap while eliminating the comparator, the synthetic-
  signal calibration, the capture-parity problem, and the new devDep. It also
  caught a *vacuous* negative-proof selector (verified below).

This rev adopts the round-2 recommendation.

## Why the clip works (the core insight)

The signal "drowns" **only because rev 1/2 measured a top-bar change against the
whole 720px viewport.** Real chromium baseline = 1280×720 = 921,600 px; the
top-bar (`<header>`, `src/components/top-bar.tsx:267`) is ~64px tall ≈ **8.9%**
of the viewport, and a wordmark/logo rename touches only the *inked* pixels
within it — ~1–2% of the viewport, under the 5% ratio. Clip the capture to the
header and that *same* change is now a large fraction of the **clipped** pixels,
caught by a 1% tolerance. Clipping removes the dilution; nothing exotic is
needed.

## Design

### The capture

In `e2e/responsive/visual.spec.ts`, add a top-bar capture, light + dark, using a
**role-based locator** (no app change required — `<header>` carries the implicit
`banner` role; verified `[data-topbar]` does **not** exist in `src/`):

```ts
test('top-bar (branding)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300); // settle staggered mount, matching siblings
  await expect(page.getByRole('banner')).toHaveScreenshot('topbar.png', {
    maxDiffPixelRatio: TOPBAR_DIFF_RATIO, // 0.01, calibrated below
  });
});
```

- **Element screenshot, not a computed `clip` rect** — `expect(locator).toHaveScreenshot`
  captures exactly the element's box and tracks layout automatically.
- **Route:** the library route (`/`), which renders the canonical top-bar with
  the brand wordmark/logo. One representative route suffices to catch a
  branding/scale change; we are not trying to baseline every view's header.
- **Light + dark** mirror the existing suite's two-theme pattern (the dark
  capture reuses the `persist:ui` seed `beforeEach` already in the dark
  `describe`).
- Rides the existing project matrix (chromium / mobile-chrome / tablet-chrome),
  so per-project baselines are written automatically. On mobile the nav
  collapses to a hamburger but the `<header>` + wordmark still render, so the
  clip still guards branding there.

### Tolerance & calibration (addresses round-2 C3 honestly)

`TOPBAR_DIFF_RATIO = 0.01` (the suite's pre-widening default). The clip is small
and mostly solid chrome (`bg-canvas/85 backdrop-blur-md`), so font-hinting noise
is a far smaller share than on a text-dense full viewport — 1% should be ample.

Calibration is a **build-time sanity check**, not a measurement harness:

1. Bless `topbar.png`, then run `test:e2e:visual` **3× back-to-back** on the dev
   box; confirm zero diff (or ≪1%). Record the observed self-noise in the PR
   description (lightweight evidence, no separate doc).
2. The gating platform for chromium is Ubuntu (`regen-visual-baselines.yml`).
   We **do not** assume Windows noise ≥ Linux noise — the Linux baseline is
   blessed by that workflow and the first labeled CI run confirms the clip is
   flake-free there before merge. If Linux clip-noise exceeds 1%, bump
   `TOPBAR_DIFF_RATIO` to `noise_max × 2` and note it. (This is the one residual
   empirical risk; the clip's small, solid area makes it low.)

### Permanent negative proof (addresses round-2 C1 — real selector this time)

```ts
test('top-bar clip catches a branding repaint', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  // Fixed-size repaint on the REAL header (top-bar.tsx:267) — no reflow.
  await page.addStyleTag({ content: 'header.sticky { background: #f0f !important; }' });
  await expect(
    expect(page.getByRole('banner')).toHaveScreenshot('topbar.png', {
      maxDiffPixelRatio: TOPBAR_DIFF_RATIO,
    }),
  ).rejects.toThrow();
});
```

- Targets `header.sticky` — a selector that **exists** (`top-bar.tsx:267`),
  unlike rev 2's imaginary `[data-topbar]`.
- A full-header background swap changes ~100% of the clipped pixels → far above
  1% on every project, so the proof can't pass-without-throwing for a
  geometry/budget reason (round-2 M2).
- A `background` swap does not reflow, so it can't trip via a dimension change
  (round-1 M4).
- Locks Goal: if a future change loosens `TOPBAR_DIFF_RATIO` enough to miss a
  top-bar change, this test goes red.

### Regen count guard (addresses round-2 M3 — now in-scope)

Adding `topbar` + `topbar-dark` is **+2 captures/project → +6 PNGs**, taking the
tree from 45 to **51**. `.github/workflows/regen-visual-baselines.yml:125`
currently asserts `[ "$count" -lt 42 ]` (already stale: it says "14/42", reality
was 15/45). Update to an **exact** check `[ "$count" -ne 51 ]` and fix the
"14/42" comments to "17/51" so the guard catches both over- and under-generation.

### Failure artifact (issue option 3 — free)

Stock `toHaveScreenshot` already writes the `expected`/`actual`/`diff` triple to
`test-results/` and surfaces it in the Playwright HTML report and CI artifacts on
failure. No custom artifact renderer needed.

## What we are NOT building (YAGNI, per round 2)

Explicitly dropped from rev 1/2: the `e2e/visual-diff.ts` comparator module, the
connected-component flood-fill, `pixelmatch`/`pngjs` devDeps, the
`MEASURE_VISUAL` Phase-0 harness, `docs/testing/visual-noise-measurement.md`, the
A-vs-B-vs-D bake-off, and the `docs/features/227` plan doc (this is a
small/localized change — the issue + paired tests are the spec, per CLAUDE.md).

## Follow-up (the deferred broad scope)

File a Backlog-item issue: _"Catch any large-region visual change (not just the
top-bar)."_ It would need full-page (`fullPage: true`) re-blessed baselines **and**
a contiguity gate whose text-line-chaining risk under 4-/8-connectivity both
review rounds flagged — a much larger effort, justified only if a real
non-top-bar branding regression is ever observed. Link this spec's git history
(`379c9b3a` → `6db95b3f` → this rev) as the starting analysis. Add the thin row
to `docs/BACKLOG.md`.

## Testing (CLAUDE.md-compliant)

- **E2E positive** — the new `top-bar (branding)` light + dark captures pass on
  blessed baselines (chromium in pre-push `verify`; mobile/tablet in opt-in
  `test:e2e:all`).
- **E2E negative** — the branding-repaint proof above (throws).
- No unit tests (no pure logic added — it's stock Playwright).

## Where it runs

- **chromium** top-bar clip runs in `test:e2e:visual` → pre-push `verify`. **The
  verified gate.**
- **mobile-chrome / tablet-chrome** clips run only in opt-in `test:e2e:all`
  (calibrated-but-unverified, same as the rest of the visual suite).

## Rollout

One branch, `chore/ops-visual-diff-contiguity` (already cut):

1. Add the two top-bar captures + the negative proof to `visual.spec.ts`.
2. Bless `topbar.png` / `topbar-dark.png` across the three projects
   (`test:e2e:visual -- --update-snapshots`, then mobile/tablet via
   `--project=...`); record the 3×-rerun self-noise in the PR.
3. Update `regen-visual-baselines.yml` count guard to `-ne 51` + comment fixes.
4. Update the stale `visual.spec.ts` header comment (viewport not full-page; 17
   captures).
5. File the deferred follow-up issue + `docs/BACKLOG.md` row.
6. `npm run verify`; request a `run-ci` label so the Linux clip noise is
   confirmed before merge.
7. PR body: `Closes #925`, with the self-noise evidence and a link to this spec.

## Risks

- **Linux clip-noise > 1%** — the one residual empirical unknown; mitigation is a
  ratio bump after the first CI run (step 6). Low risk given the clip's small,
  solid area.
- **Top-bar varies by route** — we baseline only `/`; a header that renders
  differently elsewhere isn't guarded. Accepted: branding/logo is route-stable,
  and route-specific header chrome is out of scope for #925.
