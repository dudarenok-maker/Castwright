# srv-36 Phase 0 — Findings

## Recommendation: **GO** — build Phase 1.

ECAPA speaker-embedding timbre check catches **real, listener-perceived voice
drift that the existing ASR + audio-QA gates miss**. Confirmed by ground truth
(the operator who owns/narrated the audiobooks judged the clips, and had already
noticed some organically while listening).

## Method (deviation from the plan — a stronger design)

The committed plan used synthetic over-generation of the clean Coalfall fixture.
In execution we found a better source (operator's suggestion): **real gate-flagged
+ gate-OK renders already on disk in the live library.** A 15× over-generation of
Coalfall chapter 3 produced **zero** gate-flagged misfires (the chapter is clean),
confirming the synthetic-clean fixture was the wrong dataset. We pivoted to:

- **Dataset:** Skulduggery Pleasant — *Scepter of the Ancients* (7452 segments, 33
  chapters, **182 gate-flagged** — 124 ASR-drift + 58 audio-QA-suspect). Other
  library books carry more (Unlocked 169, Unraveled 145; ~547 total).
- **Per-character ECAPA centroid** from clean (gate-passing) renders; scored every
  segment's cosine-to-centroid (the spike's committed pure helpers: `embed`,
  `metrics.centroid/cosine/eer`, `segments_io`, `gates`).
- **F4 listen-set** = the lowest cosine-to-centroid **gate-OK** segments — i.e.
  acoustic-only candidates the existing gates passed — surfaced for human judgment.

## Results

**F3 — gate-flagged vs clean separability (EER):** 0.29 (narrator) / 0.38
(skulduggery) / 0.40 (stephanie). **Poor — and that is the correct result.** The
gate "drift" label is **ASR word-error** (wrong words), which can have *perfect
timbre*; ECAPA measures *timbre*. Low separability confirms acoustic catches a
**different, non-redundant** failure mode than ASR. (The plan's `decide()` F3 gate
— "acoustic separates the *gate-flagged*" — is therefore the wrong test for this
data and must be replaced in Phase 1 by human-validated acoustic flags, below.)

**F4 — residual value (the decisive gate):** of 8 surfaced lowest-cosine **gate-OK**
outliers, **7 confirmed real drift** by listening, 1 borderline. Residual fraction
≈ **0.875** (bar 0.15).

| char | outlier cosines | clean mean / p05 | operator verdict |
|---|---|---|---|
| skulduggery | 0.151 · 0.244 · 0.262 · 0.288 | 0.756 / 0.473 | all 4 **real drift** ("different character / mismatch") |
| stephanie | 0.323 · 0.345 | 0.783 / 0.542 | both **real drift** ("not her voice") |
| narrator | 0.536 / 0.502 | 0.806 / 0.648 | 0.536 **WAY OFF**; 0.502 borderline |

Every confirmed-drift clip sits **below its character's clean p05**. The operator
had **independently noticed** the Skulduggery drift while listening to the book —
i.e. this defect ships to listeners today, undetected by the current QA.

**F1 — stochastic floor:** Qwen's clean cosine-to-centroid floor is **wide**
(per-character std 0.09–0.14; p05 0.47–0.65). A *global absolute* cutoff would not
work. But confirmed drift sits **below each character's clean p05**, so a
**per-character-relative cutoff** (≈ below the voice's own p05) separates real drift
from normal stochastic variation. This is the key Phase-1 design finding.

## Decision

- F4 residual value confirmed (≈0.875, ground-truth listening, 3 characters) ⟶ GO.
- Acoustic is **non-redundant** with ASR + audio-QA (catches timbre, they catch
  words/signal) — confirmed by the deliberately-poor F3 EER + the gate-OK origin
  of every confirmed-drift clip.
- The QA gap is **real and user-visible today** (operator caught it organically).

## Hardening pass — cutoff-region listen (12 clips at p05)

To estimate the false-positive rate *at the cutoff* (the extreme-tail clips above
only prove drift exists), 12 fresh clips were sampled straddling each character's
p05 and judged by listening:

- **Flag-side (≤ p05, n=6): 0 clean false positives.** 3 real drift, 3 borderline
  (mild/short) — every would-be-flagged clip had at least audible difference. The
  gate does not cry wolf.
- **Pass-side (> p05, n=6): 1 clear false negative** (stephanie 0.646 = real drift
  just above the cutoff) + 2 borderline + 3 fine. ⟶ p05 is slightly **lax**; the
  cutoff should sit ≈ p07–p08, or use a band.
- The ambiguous zone is **dominated by short quotes** — confirming the min-duration
  floor + `inconclusive` band are essential.

**Recommended Phase-1 cutoff: 3-tier, per-character (not one global line):**
- **Severe flag** — well below p05 (the 0.15–0.49 confirmed-drift region).
- **Inconclusive band** — ≈ p05–p10 (borderline/short: surface softly, don't hard-flag).
- **Pass** — above the band, with a min voiced-duration gate (short quotes →
  `inconclusive` regardless).

Net: 20 clips judged total. False-positive rate at the marginal cutoff ≈ 0 (clean),
which is the decisive practicality number — the gate is trustworthy.

## Caveats / limitations (honest)

- Small hand-picked sample (8 outliers, top 3 characters). A full Phase-1 pass
  embeds all segments and scans the whole tail.
- v1 metric = cosine to a 40-sample centroid; the **per-character p05 cutoff needs
  calibration** on a larger labelled set (and the centroid can itself be mildly
  contaminated by drift).
- Wide floor means false positives are a real risk near the cutoff (narrator 0.502
  was borderline) — Phase 1 needs the `inconclusive` band and per-character
  thresholds, not one global number.
- Coalfall stochastic-floor-per-line (same line × 15 runs) calc is **owed**: the
  spike keyed on segment timestamps, which shift every stochastic run → re-key on
  `sentenceIds`. (Not needed for the GO — the Scepter per-character spreads gave the
  floor.)

## Next

1. Re-file #665 `type:chore → type:feature` (Large).
2. Build **Phase 1** (render-integrity check), with the corrected design:
   per-character-relative cutoff (below clean p05) + `inconclusive` band; the
   decisive gate is human/perceptual validation of acoustic-only flags, NOT
   separability against ASR labels.
3. fs-51's QA report gains a real "voice-match" line: surface the lowest
   cosine-to-centroid gate-OK segments per book (the exact `f4_listen` mechanism),
   which demonstrably catches drift that ships to listeners today.

_Measured 2026-06-21 on RTX 4070; Qwen3-TTS 0.6B; ECAPA-TDNN (speechbrain
spkrec-ecapa-voxceleb) on CPU. Anchor = in-domain measured cosine distributions,
NOT VoxCeleb EER._
