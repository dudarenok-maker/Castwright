# Visual-diff sensitivity — contiguity gate

**Date:** 2026-06-20
**Issue:** [#925](https://github.com/dudarenok-maker/Castwright/issues/925) — _Visual-diff threshold (5%) too loose to catch top-bar/branding-scale changes_
**Area:** `area:ops` / `type:chore`
**Status:** design (approved in brainstorming; pending spec review)

## Problem

`e2e/responsive/visual.spec.ts` compares 15 full-page screenshots (7 light +
stats + 7 dark) with a single `maxDiffPixelRatio: 0.05` (5%). That ratio is
large enough that a whole-top-bar / branding-scale change is **under 5% of
total page pixels** and passes against an outdated baseline. This is exactly how
the baselines silently drifted to the pre-rename "audiobook." UI without any
visual spec failing (#922 fixed the staleness mechanism; this is the remaining
detection gap).

### Why a single full-page pixel-count threshold cannot fix this

Approximate arithmetic on a desktop chromium full-page capture
(~1800×1280 ≈ 2.3M px):

- The top-bar is ~64px tall ≈ **3.6%** of the page.
- A wordmark/logo swap repaints roughly half of it → **~1.8% of total pixels**.
- The documented Windows chromium font-hinting noise floor is **~1–2%**
  (scattered sub-pixel drift along anti-aliased text edges).

So the **signal (~1.8%) overlaps the noise (~1–2%)** on the total-changed-pixel
metric. This is not a tuning problem: any threshold on total changed-pixel count
— ratio *or* absolute (`maxDiffPixels`) — is trying to separate a signal that is
the same size as the noise. Lowering the ratio re-introduces font-hinting flakes
before it reliably catches a top-bar change.

### The metric that does separate them: contiguity

Font-hinting noise is thousands of **tiny, scattered, 1–2px-wide specks** along
text edges. A branding-scale change is **one large contiguous block**. Measured
as *"size of the largest connected region of changed pixels,"* the two are
orders of magnitude apart, not a thin margin. The fix replaces (layers over) the
total-pixel ratio with a **largest-contiguous-cluster** gate.

## Goals / non-goals

**Goals**

1. Catch _any_ large contiguous visual change — top-bar, footer, `/about`
   wordmark, an added/removed section — regardless of page height, on the 15
   existing surfaces.
2. Introduce **no new font-hinting flakes** across chromium / mobile-chrome /
   tablet-chrome on Windows + Ubuntu.
3. Decide the threshold mechanism from **measured data**, not assertion.
4. Make a near-threshold diff **reviewable** (failure artifact), not silently
   pass/fail.
5. Lock the new sensitivity with a **permanent** regression test (not the
   issue's throwaway-and-revert).

**Non-goals**

- Replacing Playwright's baseline lifecycle. We piggyback on
  `toHaveScreenshot` for create / bless / `--update-snapshots` / per-platform
  per-project paths.
- Region-scoping to the top-bar only (issue option 4). The approved scope is
  _any_ large-region change anywhere on the page; contiguity covers that
  generally, so a dedicated chrome capture is unnecessary.
- Perceptual/structural-similarity (SSIM) diffing. Contiguity is sufficient and
  far simpler to reason about and calibrate.

## Approach (two phases)

### Phase 0 — measurement (gates the mechanism choice)

A harness quantifies, per surface × project × OS, the separation between noise
and a branding-scale signal under both candidate metrics, so the mechanism is
chosen on data.

- **Form:** a Playwright spec gated behind `MEASURE_VISUAL=1` (reuses the
  navigation helpers, dev server, and the three projects) — _not_ part of any
  gating battery. (A standalone `scripts/measure-visual-noise.mjs` was
  considered but would duplicate navigation/settle logic already in the spec
  helpers.)
- **Noise floor:** capture each surface **N=10×** back-to-back with the same
  settle as the gating capture (`animations: 'disabled'`, `waitForTimeout`).
  For each capture vs. the first, `pixelmatch` → mask → record
  **`totalDiffRatio`** (today's metric) and **`maxClusterPx`** (proposed).
  Aggregate the **max observed** of each = the noise floor under each metric.
- **Signal footprint:** inject a synthetic branding-scale change via
  `page.addStyleTag` at a few magnitudes (logo +30%, wordmark font-size 1.4×,
  top-bar background swap), diff against the **unmodified** baseline, record the
  same two metrics = the signal footprint.
- **Output:** a per-surface table (noise floor vs. signal footprint under both
  metrics) committed to `docs/testing/visual-noise-measurement.md` (mirrors the
  existing `docs/testing/flake-evidence.md` convention).

**Downgrade gate (decision rule applied to the numbers):**

- If `maxClusterPx`: `min signal cluster / max noise cluster ≥ ~5×` →
  **proceed with the contiguity comparator (Phase 1)**; set the per-project
  `maxClusterPx` budget at `noise_max × 3`, verified still `≪ min signal
  cluster`.
- If, unexpectedly, `totalDiffRatio` shows a clean ≥3× gap →
  **downgrade to issue option 1**: per-page calibrated `maxDiffPixelRatio`,
  skip the comparator. (Recorded for completeness; the arithmetic above makes
  this outcome unlikely.)

### Phase 1 — the contiguity comparator

Keep `toHaveScreenshot` as a **loose** catastrophe-net + baseline-manager; layer
a contiguity gate that reads the same baseline and fails on any large connected
changed region.

**Per-capture test body** (all 15 captures gain one line):

```ts
await expect(page).toHaveScreenshot('library.png', LOOSE_OPTS); // baseline mgmt + total-meltdown net
await expectNoLargeRegionDrift(page, 'library.png');            // the real signal: largest contiguous change
```

`LOOSE_OPTS` retains `maxDiffPixelRatio: 0.05` (or looser) — its only remaining
job is catching a total-page meltdown; the contiguity gate carries precision.

**New module `e2e/visual-diff.ts`:**

```ts
export interface RegionDriftOpts {
  maxClusterPx?: number;        // budget; default from the calibration constant
  pixelmatchThreshold?: number; // per-pixel YIQ sensitivity; default ~0.1
}

// Pure, unit-tested core — no I/O, no Playwright.
export function largestChangedCluster(
  changed: Uint8Array, w: number, h: number,
): { size: number; bbox: [number, number, number, number] };

// Assertion. Called from within a test (uses test.info()).
export async function expectNoLargeRegionDrift(
  page: Page, name: string, opts?: RegionDriftOpts,
): Promise<void>;
```

**`expectNoLargeRegionDrift` flow:**

1. `test.info().snapshotPath(name)` resolves the committed baseline path,
   honoring the custom `snapshotPathTemplate` — **no path-template
   duplication**. _(De-risk: if `snapshotPath` is found not to honor the custom
   template, fall back to formatting the template from a shared constant. Verify
   during implementation.)_
2. If the baseline is **missing** (un-blessed platform), return — the
   `toHaveScreenshot` that ran on the prior line will have blessed it, and there
   is nothing to compare against this run.
3. Decode baseline (`pngjs`) and a fresh `page.screenshot()`.
4. **Dimension mismatch** (page width/height changed) → throw immediately with a
   clear message; a changed page size _is_ a large structural change.
5. `pixelmatch(base, actual, diffBuf, w, h, { threshold })` → build a
   `Uint8Array` "changed?" mask from the diff buffer.
6. `largestChangedCluster(mask, w, h)` → if `size > maxClusterPx`, attach the
   failure artifact (below) and throw with the cluster size, the budget, and the
   bounding box.

**Connected-component core:** iterative flood-fill (explicit stack,
**8-connectivity** so diagonal glyph strokes don't fragment the noise into a
misleadingly large blob _or_ split a real change), single pass with a visited
bitset, O(w·h). ~2.3M px runs well under 100 ms.

**Under `--update-snapshots`:** `toHaveScreenshot` rewrites the baseline on the
prior line before the comparator reads it, so the gate naturally passes — no
need to detect update-mode in-worker (which `visual.spec.ts` notes is
unreliable; the CLI flag is not in worker `process.argv`).

**Third-capture noise checkpoint (known risk):** `page.screenshot()` is a third
capture after `toHaveScreenshot`'s two-frame stabilization, so it carries its
own font-hinting noise. That is exactly what the cluster budget tolerates and
what Phase 0 measures directly. If Phase 0 shows third-capture noise produces an
unexpectedly large _contiguous_ cluster (it should not — hinting noise is
thin/scattered), add a two-frame settle before the screenshot. Flagged as a
checkpoint, not a surprise.

### Failure artifact (issue option 3)

On a gate trip, render a PNG: the baseline dimmed, the offending cluster's
pixels in magenta, a bounding-box outline. `testInfo.attach('<name>-cluster-diff',
{ contentType: 'image/png', body })` surfaces it in the Playwright HTML report
and CI artifacts — a near-threshold diff becomes reviewable rather than silently
passing/failing.

### Permanent proof (upgrades the issue's "throwaway")

A standing negative spec replaces the issue's add-a-throwaway-then-revert
acceptance step:

```ts
test('contiguity gate catches a branding-scale change', async ({ page }) => {
  await page.goto('/');
  await page.addStyleTag({ content: '/* scale top-bar wordmark ~1.4× */ …' });
  await expect(expectNoLargeRegionDrift(page, 'library.png')).rejects.toThrow(/contiguous/i);
});
```

This locks the sensitivity on every run: if a future refactor loosens the budget
enough that a top-bar-scale change slips through, this test goes red.

## Where it runs

- **chromium:** `npm run test:e2e:visual` (chromium-only, `--workers=1`), which
  runs in the pre-push `verify` battery. So the chromium contiguity gate is in
  the standard gate.
- **mobile-chrome / tablet-chrome:** their visual baselines run **only** in the
  opt-in `npm run test:e2e:all` (`test:e2e:mobile` excludes them via
  `--grep-invert="visual baselines"`). The contiguity gate rides along there.
  Phase 0 still measures per-project budgets so those gates are calibrated when
  they do run.
- **Linux:** `regen-visual-baselines.yml` blesses Linux baselines; the
  comparator reads whatever baseline exists for the running platform, so it is
  platform-agnostic.

## Testing (CLAUDE.md-compliant)

- **Vitest unit** — `largestChangedCluster`: one large blob; scattered specks
  (must stay below any real budget); a diagonal-connectivity chain (8-conn);
  empty mask; single pixel; a blob touching an edge; the bbox is correct.
- **E2E negative** — the injected-branding proof above (must throw).
- **E2E positive** — the 15 existing captures now also run the gate green on
  committed baselines (the "no new flakes" half of acceptance), validated on
  chromium locally + Ubuntu via the regen workflow.
- **Phase 0 harness** — produces the committed evidence doc; not gating.

## Dependencies

- Add `pixelmatch` + `pngjs` to **devDependencies** (`pixelmatch` is what
  Playwright uses internally; both are small, widely-used, zero-native-build).

## Docs & process

- New plan `docs/features/227-visual-diff-sensitivity.md` (from `TEMPLATE.md`,
  `status: active`) + `docs/features/INDEX.md` entry.
- `docs/testing/visual-noise-measurement.md` — the Phase 0 numbers.
- Update the `visual.spec.ts` header comment and the 5%-rationale comment in
  `.github/workflows/regen-visual-baselines.yml` to describe the two-layer gate.
- PR body: `Closes #925`. The issue's four options are addressed: (1)/(2)
  evaluated and superseded by contiguity per the arithmetic; (3) failure
  artifact shipped; (4) generalized — contiguity covers any region, not just
  chrome.

## Rollout

One branch, `chore/ops-visual-diff-contiguity`:

1. Phase 0 harness + commit `visual-noise-measurement.md`.
2. Apply the downgrade gate to the measured numbers (expected: proceed).
3. Build the comparator + `largestChangedCluster` unit tests.
4. Wire the gate into the 15 captures + add the negative proof.
5. Docs (plan 227, INDEX, header/workflow comments).
6. `npm run verify`.

## Risks & open questions

- **`snapshotPath` template fidelity** — verify it honors the custom
  `snapshotPathTemplate`; fall back to a shared template constant if not.
- **Third-capture noise** — see the checkpoint above; mitigation is a two-frame
  settle if Phase 0 demands it.
- **Per-project budgets** — mobile/tablet pages are narrower/taller; Phase 0
  may yield different `maxClusterPx` per project. A small per-project map covers
  this; default to one global budget if the numbers are close.
- **`page.screenshot()` full-page vs. viewport** — must capture the same region
  `toHaveScreenshot` baselines (full page). Confirm `fullPage` parity during
  implementation so dimensions match the baseline.
