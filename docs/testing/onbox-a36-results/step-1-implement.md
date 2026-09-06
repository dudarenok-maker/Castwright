# A36 step 1 — synthetic-only pool severity band (implement + test)

Parent: #2934 (A36 audition-band chain). Register row A36 ([#1969](https://github.com/dudarenok-maker/Castwright/issues/1969),
PR #2402, [#2700](https://github.com/dudarenok-maker/Castwright/issues/2700)) — discharged 2026-09-05. Owner ruling 2026-09-05.

## What changed

The 2026-08-29 real on-box finding: a correctly-cast voice, re-rendered
against fresh text, was false-flagged `voice-mismatch`/`severe` because its
audition reference was a small (N=6), synthetic-only Option-B ("Phase B")
rebuild — same engine, same voice, same controlled acoustic conditions —
which clusters far tighter (observed 0.9629±0.02) than the natural variance
of a real render (observed correct-voice cosines 0.928/0.934). The existing
percentile cutoffs (`CUTOFFS.severeEdgePctl`/`bandUpperPctl` in `score.ts`)
are calibrated for real-anchor render-to-render variance; applied to a
same-conditions synthetic cluster they sit at (or near) the sample minimum —
above a real render's cosine — producing the false positive.

Three files changed, no persisted-schema migration:

- **`server/src/audio/render-integrity/audition-centroid.ts`** —
  `auditionCentroid`'s return type gained a `syntheticOnly: boolean` field:
  true iff the returned pool contains **no real in-book anchors**, computed
  per return path (`existingAnchors.length === 0` for Phase A; always `true`
  for the Phase B branch, which explicitly drops the anchors). This is the
  real, structural marker the task asked for — not a heuristic guess — and
  it is independent of which phase produced the pool, since a Phase-A pool
  built from zero anchors has exactly the same tight-cluster problem as a
  Phase-B pool.
- **`server/src/audio/render-integrity/score.ts`** — new
  `SYNTHETIC_ONLY_CUTOFFS` (sigma multipliers) and `syntheticOnlySpread()`
  (mean/std-dev-based spread, replacing percentile-of-pool for this case
  only). `scoreSegment()` itself is **unchanged** — it already took a generic
  `{ pSevere, pBand }` spread, so the calibration choice lives entirely in
  which spread the caller computes.
- **`server/src/audio/render-integrity/aggregate.ts`** —
  `resolveCharacterReference`'s audition branch now picks
  `syntheticOnlySpread(cosines)` when `audition.syntheticOnly`, else the
  original `percentile(cosines, CUTOFFS.severeEdgePctl/bandUpperPctl)`. The
  in-book (real-anchor) branch above it is untouched — it never reaches this
  code path at all.

## Calibration reasoning

Percentile-of-pool is not a meaningful statistic at N=6: `percentile()`'s own
interpolation at `severeEdgePctl=6`/`bandUpperPctl=10` lands within the first
one or two sorted elements of a 6-to-10-element array — i.e. effectively "the
sample minimum," which is exactly the tight-cluster problem, not a fix for
it. Mean/std-dev sigma bands were chosen instead because they scale with the
pool's own observed spread rather than its rank order.

Sigma widths, derived directly from the register's own numbers (pool mean
0.9629, population std-dev of the pinned 6-value pool ≈0.0173):

| Constant | Value | Resulting edge | Effect on the observed false positive |
|---|---|---|---|
| `severeSigma` | 3 | 0.9629 − 3×0.0173 ≈ 0.9107 | Both 0.928 and 0.934 clear this by a wide margin — never `severe`. |
| `bandSigma` | 1.5 | 0.9629 − 1.5×0.0173 ≈ 0.9369 | Both 0.928 and 0.934 fall just under this — `inconclusive`, not `voice-match`. Landing in the safer, non-committal tier (rather than forcing an exact `voice-match`) is deliberate: this is a synthetic-only, thin-pool reference, so a soft "not confidently mismatched" call is more honest than a hard "confidently correct" one. |

A clearly-drifted render (e.g. cosine 0.10, or a genuinely wrong voice) is
still flagged `voice-mismatch`/`severe` under this band — the fix widens the
tolerance for real-render variance around a tight synthetic cluster, it does
not disable mismatch detection. See the "genuinely mismatched" regression
test below.

The normal (real-anchor, in-book) path is completely unaffected: it is a
separate branch in `resolveCharacterReference` that never calls
`auditionCentroid` and never reaches `syntheticOnlySpread`.

## Tests

- **`score.test.ts`** — `SYNTHETIC_ONLY_CUTOFFS` pin; `syntheticOnlySpread()`
  reproduces the calibrated edges for the pinned pool; confirms the OLD
  percentile-of-pool cutoff over-flags the same pool at ≥0.928 (documents the
  bug being replaced); `scoreSegment()`-level checks that 0.928 and 0.934
  against the synthetic-only band are no longer `severe`, and that the same
  0.928 cosine against a normal percentile spread is untouched.
- **`audition-centroid.test.ts`** — `syntheticOnly` discriminator: `false`
  when real anchors alone meet target or are blended with new top-up
  renders; `true` for a zero-anchor Phase A pool (success or too-short); and
  `true` after a Phase B bimodal blend drops the real anchors (the
  register's own A36 shape).
- **`aggregate-audition-synthetic-band.test.ts`** (new file) — end-to-end
  through `scoreBook`, with `auditionCentroid` mocked to return the
  register's pinned pool shape (`syntheticOnly: true`):
  - reproduces the exact 2026-08-29 false-positive shape and confirms the
    fix (cosine 0.928 → not `voice-mismatch`/`severe`);
  - the paired 0.934 case, also no longer `severe`;
  - a clearly-matching render (0.995) still resolves `voice-match` — the
    band is wider, not disabled;
  - a genuinely mismatched render (0.10) is still flagged
    `voice-mismatch`/`severe` — mismatch detection still works;
  - the normal in-book path (≥10 real anchors, `auditionCentroid` never
    called) still flags a clearly-drifted segment `voice-mismatch`/`severe` —
    proving the new band is scoped to the synthetic-only path only.

## Test output

```
$ npm --prefix server run test -- src/audio/render-integrity

 Test Files  13 passed (13)
      Tests  118 passed (118)

$ npm --prefix server run typecheck
(clean, no errors)
```

## Not in scope (per parent #2934)

Running against real hardware (step 2, separate issue). Any register edit
(step 3, separate issue).
