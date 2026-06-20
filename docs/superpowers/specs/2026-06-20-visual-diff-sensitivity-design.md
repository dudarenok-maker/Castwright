# Visual-diff sensitivity — measure, then gate

**Date:** 2026-06-20 (rev 2 — incorporates adversarial review)
**Issue:** [#925](https://github.com/dudarenok-maker/Castwright/issues/925) — _Visual-diff threshold (5%) too loose to catch top-bar/branding-scale changes_
**Area:** `area:ops` / `type:chore`
**Status:** design (approved direction in brainstorming; spec revised after adversarial review)

## Problem

`e2e/responsive/visual.spec.ts` compares 15 screenshots per project (7 light +
stats + 7 dark) with a single `maxDiffPixelRatio: 0.05` (5%). That ratio is large
enough that a top-bar / branding-scale change can fall **under 5% of total
pixels** and pass against an outdated baseline — exactly how the baselines
silently drifted to the pre-rename "audiobook." UI without any visual spec
failing (#922 fixed the staleness mechanism; this is the remaining detection
gap).

### What the captures actually are (corrected)

The captures are **viewport screenshots, not full-page** — `toHaveScreenshot`
defaults `fullPage: false` and `visual.spec.ts` never overrides it. Verified
baseline dimensions:

| Project | Dimensions | Total px |
|---|---|---|
| chromium | 1280×720 | 921,600 |
| mobile-chrome | 412×839 | 345,668 |
| tablet-chrome | 834×1194 | 995,796 |

(The `visual.spec.ts` header comment and `regen-visual-baselines.yml` that call
these "full-page" / "14 specs" are stale; there are 15 captures and they are
viewport. Pre-existing; out of scope to fix here beyond a note.)

### Why this is genuinely hard (and why option 1 is a real contender)

On the real chromium capture (921,600 px), the top-bar (~64px) is **~8.9%** of
pixels. But a *branding rename* (#922's case) changes only the **inked glyph /
logo pixels**, which are sparse — plausibly **~1–3% of total**, overlapping the
documented Windows chromium font-hinting noise floor of **~1–2%** (scattered
sub-pixel drift along anti-aliased text edges; see `visual.spec.ts:78–89`). A
heavier restyle (background, height) could reach ~9%.

So the changed-pixel fraction of the regression we care about is **not known a
priori** — it depends on how much ink moves — and may or may not separate cleanly
from noise on a tightened ratio. **The previous revision of this spec asserted
"signal ~1.8% overlaps noise" as settled fact and dismissed a tighter ratio.
That was wrong: the number was derived from phantom full-page dimensions.** This
revision makes the mechanism choice a **measured bake-off**, not an assertion.

### The two candidate mechanisms

- **Mechanism A — tightened / per-page ratio** (issue option 1): lower
  `maxDiffPixelRatio` (globally or per-surface) to sit just above the measured
  noise floor. Simplest; zero new code/deps. Wins iff the branding signal sits a
  safe multiple above noise on the total-pixel metric.
- **Mechanism B — contiguity gate**: run connected-component labeling on the
  diff mask and fail on the largest *contiguous* changed cluster. Font noise is
  scattered specks; a branding change is one block — *if* that holds under a
  real connectivity rule and real text density, B separates signal from noise
  even when A cannot. More code + one new devDep.

**Default to A.** B must *earn* its complexity by beating A on the Phase-0
numbers. The arithmetic no longer pre-judges which wins.

## Goals / non-goals

**Goals**

1. Reliably catch a top-bar / branding-scale change on the chromium surfaces
   (the gate that runs in pre-push `verify`).
2. Introduce **no new font-hinting flakes**.
3. Choose the mechanism (A vs B) from **measured data on real dimensions**.
4. Make a near-threshold diff **reviewable** (failure artifact).
5. Lock the chosen sensitivity with a **permanent** regression test (not the
   issue's throwaway-and-revert).

**Non-goals**

- Re-blessing baselines as full-page. Catching below-the-fold (footer/`/about`)
  changes would need `fullPage: true` baselines — a much larger change, deferred
  unless Phase 0 shows it's necessary. The honest scope is **what's in the
  viewport** of the 15 existing surfaces.
- Replacing Playwright's baseline lifecycle (`--update-snapshots`, per-platform
  per-project paths).
- SSIM / perceptual diffing.

## Phase 0 — measurement (decides A vs B, on real dimensions)

A harness, gated behind `MEASURE_VISUAL=1` (reuses the spec's navigation
helpers, dev server, and three projects; **not** in any gating battery),
produces a committed evidence table at `docs/testing/visual-noise-measurement.md`
(mirrors `docs/testing/flake-evidence.md`).

It must measure the things the previous revision asserted, and avoid the
circularity the review flagged:

1. **Noise floor.** Capture each surface **N=10×** back-to-back with the *exact
   gating capture settings* (see "capture parity" below). For each capture vs.
   the first, compute the diff and record, per surface × project:
   - `totalDiffRatio` (Mechanism A's metric), and
   - `maxClusterPx` under **both 4- and 8-connectivity** (Mechanism B's metric).
2. **Threshold sweep (breaks C3 circularity).** Report both metrics as a
   function of `pixelmatchThreshold` (e.g. 0.05 / 0.1 / 0.2). This separates
   "the per-pixel YIQ threshold suppressed noise" from "contiguity suppressed
   noise" — B only earns its keep if it adds separation *beyond* what the
   per-pixel threshold alone buys.
3. **Text-density stress.** Include the text-heaviest surfaces — `ready
   (manuscript)`, `stats`, `confirm` — in **both themes**, because the central
   risk to Mechanism B is collinear glyph-edge specks **chaining** into one
   large cluster along a text line (worse under 8-connectivity, which bridges
   inter-glyph gaps diagonally). If even 4-connectivity chains text-line noise
   into a large cluster, B's premise ("noise = small clusters") fails for dense
   text and B needs a morphological erosion / min-component-dimension filter —
   or we fall back to A.
4. **Signal footprint.** Inject a synthetic branding-scale change via
   `page.addStyleTag` at a few magnitudes (logo +30%; wordmark color/background
   swap that does **not** reflow; a top-bar background change), diff against the
   unmodified baseline, record both metrics. Magnitudes are expressed as **% of
   the real per-project dimensions**, not the phantom 2.3M-px page.

**Decision rule (applied to the table):**

- Let `gapA = min(signal totalDiffRatio) / max(noise totalDiffRatio)` and
  `gapB = min(signal maxClusterPx) / max(noise maxClusterPx)` at the best
  `pixelmatchThreshold`.
- **If `gapA ≥ 3×`** (clean headroom on the simple metric) → **ship Mechanism A**:
  per-surface calibrated `maxDiffPixelRatio` set at `noise_max × √(gapA)` (geometric
  midpoint), no comparator, no new deps. Stop here.
- **Else if `gapB ≥ 3×`** under the connectivity that keeps text-line noise small
  → **ship Mechanism B** (Phase 1), `maxClusterPx` budget at the geometric midpoint
  between noise and signal, per-project.
- **Else** (neither separates) → escalate: full-page re-bless, region-scoping the
  top-bar (issue option 4), or erosion. Re-spec before building.

The single `3×` bar (not the previous, unjustified asymmetric 5×/3×) is the
headroom we require for either mechanism to be flake-safe; it is the same bar for
both so the comparison is apples-to-apples.

## Phase 1 — the contiguity gate (only if Phase 0 selects Mechanism B)

Keep `toHaveScreenshot` as a **loose** catastrophe-net + baseline-manager; layer
a contiguity gate that reads the same baseline.

**New module `e2e/visual-diff.ts`:**

```ts
export interface RegionDriftOpts {
  maxClusterPx?: number;        // per-project budget from Phase 0
  connectivity?: 4 | 8;         // from Phase 0 (default 4 unless 8 measured safe)
  pixelmatchThreshold?: number; // from Phase 0
}
export function largestChangedCluster(            // pure, unit-tested
  changed: Uint8Array, w: number, h: number, connectivity: 4 | 8,
): { size: number; bbox: [number, number, number, number] };
export async function expectNoLargeRegionDrift(
  page: Page, name: string, opts?: RegionDriftOpts,
): Promise<void>;
```

**Capture parity (was M1 — load-bearing, now in the body not a footnote).** The
comparator's screenshot MUST replicate every `toHaveScreenshot` option that
affects pixels, or the pixelmatch is garbage:

```ts
await page.screenshot({
  animations: 'disabled', // else mid-transition frames vs frozen baseline
  caret: 'hide',          // else a focused input's caret blinks (e.g. upload)
  scale: 'css',           // CRITICAL: page.screenshot defaults 'device' → on
                          //   mobile/tablet (dSF>1) the capture is 2× the
                          //   baseline's dimensions → guaranteed dimension
                          //   mismatch on two of three projects
  fullPage: false,        // match the viewport baselines
});
```

**Composition / ordering (was M2).** The comparator is **independent of
`toHaveScreenshot`'s pass/fail** — it reads the baseline file directly:

1. Resolve the baseline path. Use `test.info().snapshotPath(name)` **only after
   a one-line spike confirms** it honors the `{snapshotDir}/{platform}/{testFilePath}/{projectName}/{arg}{ext}`
   template without double-appending `{ext}` to a `'library.png'` arg (was M3).
   If it mis-resolves, format the template from a single shared constant
   (re-introduces minor duplication — acceptable, documented).
2. If the baseline file is **absent**, return (the describe is already
   `test.skip`-ped when the platform's `BASELINE_DIR` is missing; an
   individual-file absence is a first-bless that `toHaveScreenshot` reports
   loudly on its own line).
3. Decode baseline (`pngjs`) + the parity screenshot above.
4. **Dimension mismatch → throw** a *distinct, dimension-specific* error
   (separate message from the cluster-size error — see the negative proof).
5. `pixelmatch(..., { threshold })` → "changed?" `Uint8Array` → `largestChangedCluster`.
6. If `size > maxClusterPx`, attach the artifact and throw a *cluster-size-specific*
   error naming size, budget, bbox.

Compose semantics, stated explicitly: the loose `toHaveScreenshot` catches
total-meltdown (>5%); the contiguity gate catches the **sub-5% contiguous**
changes that pass the loose net — which is the branding case (sparse ink, passes
5%, fails contiguity). When `toHaveScreenshot` itself fails (>5%), it throws
first and the test is already loudly red; the contiguity artifact isn't produced
in that case **by design** (a >5% change needs no extra precision). Under
`--update-snapshots`, `toHaveScreenshot` rewrites the baseline on its line before
the comparator reads it.

**Connected-component core.** Iterative flood-fill, explicit stack, visited
bitset, O(w·h) — at 0.92M px, sub-50ms. Connectivity is a **parameter** set by
Phase 0, defaulting to **4** (8-connectivity is opt-in only if Phase 0 proves it
keeps text-line noise small).

**Failure artifact (issue option 3).** Render the baseline dimmed + the offending
cluster in magenta + bbox outline; `testInfo.attach('<name>-cluster-diff', …)`
surfaces it in the HTML report and CI artifacts.

**Permanent proof (was M4 — must test the gate, not reflow).** Inject a change
that is **guaranteed not to alter dimensions** (a `background`/`color` swap on a
fixed-size top-bar region — *no* font-size scaling, which reflows and would trip
the dimension path), and assert it throws the **cluster-size-specific** error
(match on that message, not a generic `/contiguous/i`):

```ts
test('contiguity gate rejects a fixed-size branding repaint', async ({ page }) => {
  await page.goto('/');
  await page.addStyleTag({ content: '[data-topbar] { background: #f0f !important; }' });
  await expect(expectNoLargeRegionDrift(page, 'library.png'))
    .rejects.toThrow(/largest contiguous .* exceeds .* budget/i);
});
```

## Where it runs (was M5 — stated honestly)

- **chromium** visual specs run in `npm run test:e2e:visual` → in the pre-push
  `verify` battery. **This is the verified gate.**
- **mobile-chrome / tablet-chrome** visual specs run **only** in opt-in
  `npm run test:e2e:all` (`test:e2e:visual` is chromium-only; `test:e2e:mobile`
  excludes "visual baselines" via `--grep-invert`). Their budgets are
  Phase-0-calibrated but **not exercised in any routine battery**.
- **Goal 2 is therefore scoped honestly: "no new flakes on chromium (verified);
  mobile/tablet calibrated-but-unverified."** The capture-parity `scale:'css'`
  fix is mandatory regardless, so that `test:e2e:all` doesn't fail outright the
  first time someone runs it.

## Dependencies

- Mechanism A: **none**.
- Mechanism B: add **`pixelmatch`** to devDependencies. `pngjs` resolves
  transitively via Playwright, but **declare it explicitly** if used (don't rely
  on a transitive dep).

## Testing (CLAUDE.md-compliant)

- **Vitest unit** — `largestChangedCluster`: large blob; scattered specks (stay
  below budget) under **both 4- and 8-conn**; a diagonal chain (asserts the
  4-vs-8 difference is real); empty; single pixel; edge-touching blob; bbox
  correctness.
- **E2E negative** — the fixed-size repaint proof above (throws the cluster
  error specifically).
- **E2E positive** — the 15 chromium captures run the chosen gate green on
  committed baselines (the "no new flakes" half), locally + Ubuntu via the regen
  workflow.
- **Phase 0 harness** — produces the evidence doc; not gating.

(All of the above for Mechanism B. For Mechanism A: the test is simply the
tightened per-surface ratio + a permanent proof that injects the same fixed-size
repaint and asserts the ratio assertion fails.)

## Docs & process

- New plan `docs/features/227-visual-diff-sensitivity.md` (from `TEMPLATE.md`,
  `status: active`) + `docs/features/INDEX.md` entry.
- `docs/testing/visual-noise-measurement.md` — Phase 0 numbers + the A-vs-B
  decision.
- Update the stale `visual.spec.ts` header comment (viewport not full-page; 15
  not 14) and the chosen gate's rationale; note the `regen-visual-baselines.yml`
  "14/42" staleness (optionally fix in a separate trivial commit — it doesn't
  block).
- PR body: `Closes #925`. Issue options mapped: (1)=Mechanism A; (2) rejected
  (absolute count couples to page height); (3) failure artifact (Mechanism B) or
  N/A (A); (4) deferred fallback only.

## Rollout

One branch, `chore/ops-visual-diff-contiguity`:

1. Spike `test.info().snapshotPath('x.png')` vs the custom template (de-risk M3).
2. Phase 0 harness → commit `visual-noise-measurement.md` with real-dimension
   numbers, both connectivities, the threshold sweep.
3. Apply the decision rule → pick Mechanism A or B (document the choice).
4. Build the chosen mechanism + unit tests + permanent proof + (B only) artifact.
5. Wire into the 15 chromium captures; fix `scale:'css'` so mobile/tablet don't
   false-fail.
6. Docs (plan 227, INDEX, header/workflow comments).
7. `npm run verify`.

## Risks & open questions

- **A might win.** If Phase 0 shows `gapA ≥ 3×`, we ship a one-line per-surface
  ratio change and **none** of Phase 1 — the cheapest possible fix. The spec is
  structured so that's a clean, expected outcome, not a failure.
- **Text-line chaining could sink B** even at 4-connectivity on dense dark-mode
  text. Phase 0's text-density stress is the go/no-go; the fallback is erosion or
  region-scoping, which forces a re-spec.
- **`snapshotPath` template fidelity** — spike first (step 1).
- **Mobile/tablet are calibrated-but-unverified** — accepted scope; the
  `scale:'css'` fix prevents an outright break when `test:e2e:all` runs.
