---
status: draft
date: 2026-07-07
topic: srv-36 audition centroid — replace the 12x-same-short-quote backup reference
---

# srv-36 — audition centroid: a better backup reference sample

_Design spec · 2026-07-07_

Issue: #1386 · Backlog: `srv-36` (follow-up chore)

This spec is **design/plan only** — implementation is a separate handover.

## Problem

The Option-B audition centroid (`server/src/audio/render-integrity/audition-centroid.ts`,
srv-36 Task 10) is the backup voice-consistency reference used when a character's real
in-book anchor vectors are unusable — either **too-thin** (fewer than `CENTROID_MIN_N`=10
anchor-eligible embeddings, `centroid.ts:19`) or **bimodal** (≥10 anchors, but they split
into two untrustworthy clusters, `centroid.ts:102`). In both cases it renders the character's
sample text (`buildSampleText` — the single longest evidence quote, or a canned fallback line)
**K=12 times** under the character's configured voice, ECAPA-embeds each render, and builds
the centroid from those 12 embeddings.

Two problems, not one:

1. **Cost.** 12 full TTS synths purely to obtain embeddings, for what's meant to be a minor
   fallback path.
2. **Signal quality.** All 12 renders speak the *same* short text (often very short — a
   character's longest evidence quote can be a single sentence, or shorter). The only
   variation across the 12 embeddings comes from the TTS engine's own sampling noise, not
   from genuine phonetic/prosodic diversity. Since this centroid's spread (`cleanMean`/
   `pSevere`/`pBand` in `aggregate.ts`) becomes the per-character drift-tolerance band used
   later to score real, varied chapter renders, a band calibrated on near-identical short
   audio is likely tighter than the natural variation in real book content — a source of
   false-positive drift flags.

A hidden coupling explains why K is 12 specifically: `buildCentroid()` (`centroid.ts`)
treats any pool under `CENTROID_MIN_N`=10 as degenerate (`kind: 'too-thin'`), and
`auditionCentroid` currently maps that straight to `kind: 'too-short'` — i.e. "no usable
reference, everything scores inconclusive" (`audition-centroid.ts:163-165`). K=12 is padding
past that floor with margin for occasional under-duration renders. Reducing K without also
addressing this coupling would silently break the fallback path for most characters.

## Approaches considered

- **A (rejected as sole fix): longer text, same K.** Concatenate available evidence quotes
  into one longer, more phonetically-varied sample and keep K≈12. Fixes signal quality with
  minimal blast radius, but leaves the cost problem essentially untouched.
- **B (rejected as sole fix): reduce K, vary text, no anchor reuse.** Cuts cost and fixes
  diversity, but ignores that many too-thin characters already have *some* real (better than
  synthetic) anchor embeddings sitting unused.
- **C (chosen): reduce K, richer text, AND reuse existing anchors where trustworthy.**
  Combines A+B and additionally blends a too-thin character's existing anchor embeddings into
  the pool before topping up with new audition renders — real in-book renders are strictly
  better signal than synthetic ones, and every anchor reused is one fewer render needed.
  Bimodal characters are excluded from anchor reuse (see Design) since their anchors are
  exactly the untrustworthy data causing the split.

## Design

### 1. Evidence plumbing, and a per-render text pool (not one shared long text)

**Corrections from adversarial review, round 1 (2026-07-07):** the first draft assumed
`hint?.evidence` was available wherever `auditionCentroid` runs, and that concatenating those
quotes into one longer *shared* text (rendered N times) would fix Problem #2. Both were wrong,
found by tracing the actual production call site rather than trusting the surrounding code
comments:

**(a) No evidence reaches the audition site today — this needs real plumbing, not a read.**
`aggregate.ts`'s `scoreBook` builds `voiceInfoByChar` (`aggregate.ts:296-304`) from
`SegmentsFileView.characterSnapshots` alone — `voiceEngine`/`resolvedVoiceName`/`modelKey`/
`attributes`, no `hint`. `scoreBook` never reads `cast.json`, the only place
`CastCharacter.evidence` lives. So `hint` is `undefined` on every real invocation today, and
*any* evidence-based text logic — including the existing per-render duration-floor retry,
which already reads `hint.evidence` — silently no-ops to the canned line in production. The
first draft's claim that this was "a small, local change, not new plumbing" was wrong; it
only checked the too-thin/bimodal *branching* wiring (genuinely small), not the *evidence*
wiring (genuinely new).

**Fix:** `scoreBook` also loads `cast.json` once per call (`castJsonPath(bookDir)`, already
exported from `workspace/paths.ts`), builds a `Map<string, CastCharacter>` by `id`, and
threads `buildHintFromCast(castChar)` — already used for this exact purpose at render time,
`character-snapshots.ts:39` — onto `voiceInfoByChar`'s new `hint` field when a matching cast
entry exists. One extra file read plus a lookup, reusing an existing reader/builder pair
rather than inventing a new one. Corollary: this also makes the pre-existing but previously
dead duration-floor retry path functional for the first time.

**Correction from adversarial review, round 2:** the read must be best-effort, mirroring the
existing `readSegmentsFile` idiom in this same file (`aggregate.ts:173-181` — swallows ENOENT
*and* any parse error, returns `null`). Three existing `aggregate-audition-tier.test.ts` cases
write `segments.json` fixtures with no `cast.json` on disk at all; an unhandled ENOENT here
would break all three. `readCastJson(bookDir)` returns `CastCharacter[] | null` using that
same try/catch-swallow-all pattern; a `null` (missing or unparseable file) yields an empty
lookup map, every character's `hint` stays `undefined`, and the canned-line fallback applies
— **identical to this change's behavior before cast.json existed for a given book**, not a
new failure mode.

**(b) One shared longer text doesn't widen the variance the tolerance band is built from.**
`pSevere`/`pBand`/`cleanMean` are the spread of the N embeddings' cosines to their own
centroid. If all N renders still speak one identical text — even a longer, concatenated one —
the only source of cross-sample variance is still the TTS engine's own sampling noise for a
fixed utterance, not genuine content diversity. A longer *shared* text makes each individual
embedding more phonetically complete/representative, but that's a different axis from what
Problem #2 is actually about.

**Fix:** build a pool of up to N *distinct* texts — the character's evidence quotes
(stripped, deduped, longest-first, each capped at a reasonable length), cycling through them
to fill N slots when there are fewer than N distinct quotes, falling back to the canned line
(unchanged) only when there's no evidence at all. Each render in the pool now speaks
genuinely different content when evidence supports it — the axis Problem #2 needs moved, not
just a longer version of the same one-utterance problem.

```ts
const AUDITION_QUOTE_MAX_CHARS = 320; // matches voice-sample-cache.ts's MAX_CHARS

function buildAuditionTexts(
  voice: VoiceLike,
  hint: CharacterHint | undefined,
  count: number,
): string[] {
  const cleaned = (hint?.evidence ?? [])
    .map(stripQuoteMarks)
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((s) => s.slice(0, AUDITION_QUOTE_MAX_CHARS));

  if (cleaned.length === 0) {
    const canned = buildSampleText(voice, hint); // unchanged fallback
    return Array(count).fill(canned);
  }
  return Array.from({ length: count }, (_, i) => cleaned[i % cleaned.length]);
}
```

This still shares zero code/constants with the voice-preview `buildSampleText`/`MAX_CHARS`
path (untouched — see Out of scope).

### 2. Pool composition splits by *why* the fallback is needed

`aggregate.ts`'s `resolveCharacterReference` already computes `anchorVecs` and `result =
buildCentroid(anchorVecs)` before branching into the too-thin/bimodal path — `result.kind`
and `result.bimodal` are already in scope there, so distinguishing the two cases is a small,
local change, not new plumbing:

- **Too-thin** (`result.kind === 'too-thin'`, i.e. `anchorVecs.length < 10`): pass
  `anchorVecs` into `auditionCentroid`. The pool starts with those real anchors; new audition
  renders top it up only as far as needed to reach the target pool size (below, §3). A
  character with 4 anchors needs 2 new renders to reach a target of 6; a character with 0
  anchors renders the full target count; a character already at or above the target (e.g. 8
  anchors, still "too-thin" by the in-book threshold of 10) needs zero new renders — the
  existing zero-anchor behavior is just the low end of the same formula.
- **Bimodal** (`result.kind === 'in-book' && result.bimodal`): do **not** pass anchors in —
  they're the unreliable data causing the split. Falls back to a pure audition-only pool,
  same shape as today, just with the smaller pool size and per-render text pool from §1.
  See §3 for the second, new way a character can end up in this same "no anchors" treatment.

### 3. Target pool size — with real margin, and a safety check on the blended pool

**Correction from adversarial review, round 1:** the first draft rendered exactly `max(0,
target − anchors.length)` new samples — zero margin above the bare deficit. But the Problem
section's own reasoning credits K=12 with deliberate margin for occasional under-duration
renders; rendering the bare deficit throws that margin away and would tip more too-thin
characters into `too-short` than today, the opposite of the intended robustness. The first
draft also never said what happens if the *blended* pool itself comes back bimodal — a new
failure mode this redesign introduces (anchors and synthetic renders had never been mixed
into one `buildCentroid` call before).

Introduce two new constants in `audition-centroid.ts`, independent of `centroid.ts`'s
`CENTROID_MIN_N`=10 (which stays exactly as-is — it continues to gate the *in-book* path
only):

```ts
/** Target combined pool size (anchors + new audition renders) for the
 *  Option-B fallback. Decoupled from CENTROID_MIN_N (10), which governs the
 *  in-book path — this pool is deliberately smaller since it's a synthetic
 *  backup, not a statistically rigorous sample. */
export const AUDITION_POOL_TARGET_N = 6;
/** Extra render attempts allowed above the bare deficit, to absorb
 *  duration-floor failures — restores the margin K=12 used to provide. */
const AUDITION_POOL_MARGIN = 2;
```

Pool-filling: draw up to `deficit + AUDITION_POOL_MARGIN` texts from
`buildAuditionTexts(..., deficit + AUDITION_POOL_MARGIN)` (§1), rendering/embedding each with
the existing per-render duration-floor retry (now functional per §1a), and stop as soon as
`existingAnchors.length + newEmbeddings.length` reaches `AUDITION_POOL_TARGET_N`. If the pool
still falls short after exhausting the margin, the existing "too-short → inconclusive"
behavior applies exactly as today — the same outcome as when every render already failed the
duration floor.

Then call `buildCentroid([...existingAnchors, ...newEmbeddings], { minN:
AUDITION_POOL_TARGET_N })` — using `buildCentroid`'s existing `minN` override (exercised today
only by `centroid.test.ts`'s own unit tests, unused by either production caller) so that once
the pool reaches target size it gets the full trim/bimodal-check treatment (`kind: 'in-book'`
internally, relabeled `'audition'` by the caller) instead of the degenerate `'too-thin'` path.

**Bimodal safety check on the blended pool (new) — corrected in round 2 to stay cost-bounded:**
the first revision discarded anchors and re-rendered a *full fresh* `AUDITION_POOL_TARGET_N +
AUDITION_POOL_MARGIN` pool from scratch on top of the renders already spent reaching the
blended pool — for a character with `K` anchors that's `(6−K) + 8 = 14−K` total renders, e.g.
**14 at K=2, worse than today's K=12** — inverting the whole "anchors save renders" premise
and silently contradicting the very "worst case = 8" claim this section made three paragraphs
later. Fixed by **reusing, not discarding, the synthetic renders already obtained**: if
`result.bimodal` is `true` on the anchors+synthetics blend, drop only the anchors and top up
the *already-rendered* synthetic set to `AUDITION_POOL_TARGET_N` using more distinct texts
from the same cycle, capping **total synthetic renders for this character, across both the
initial attempt and this top-up, at `AUDITION_POOL_TARGET_N + AUDITION_POOL_MARGIN`** — the
same hard ceiling as every other path, never a second independent budget stacked on top of
the first. This makes the "worst case = 8" line below a real invariant rather than a
best-path example.

The resulting synthetic-only pool is **not** itself re-checked for bimodality. This is a
known, pre-existing limitation, not a new gap this redesign introduces: today's
`auditionCentroid` already never inspects `result.bimodal` for its (already pure-synthetic)
pool (`audition-centroid.ts:159-167`), and the bimodal-*origin* branch in §2 has never had a
"combined pool" to check in the first place. This safety check exists specifically for the
one new failure mode this redesign creates — mixing real anchors with synthetic renders — not
as general bimodal-proofing for every path. Recursing further (re-checking the fallback, and
falling back again if that's also bimodal) is explicitly out of scope: it would reopen the
unbounded-cost problem this correction just closed, for a failure mode (synthetic-only
renders splitting into two clusters) this chore doesn't newly introduce and isn't trying to
fix.

**Net effect:** worst case (0 anchors, no evidence, or the bimodal-fallback path) is capped at
`AUDITION_POOL_TARGET_N + AUDITION_POOL_MARGIN` = 8 total renders for any character, by
construction — down from 12 today. Typical too-thin characters with some anchors need fewer
still, down to zero new renders when anchors alone already meet target and the blend isn't
bimodal. This is a **directional** improvement, not a measured one — no before/after
false-positive rate is available for this chore to compare against (see Accepted limitation
below and Out of scope). What's concretely fixed without needing a measurement to know it was
wrong: same-text-only cross-sample variance, and burning full-model renders on characters that
already have usable real anchors sitting unused.

### Accepted limitation: percentile estimates at N=6 are coarser than at N=12

Halving the typical pool size makes `percentile()` (used for `pSevere`/`pBand`) noisier than
today — a real cost of the smaller pool, not a benefit, and this spec doesn't attempt to
quantify by how much. Accepted because (a) this reference is explicitly a best-effort backup
for characters the in-book path already can't trust, not a rigorously-sampled statistic, and
(b) for the common too-thin case the pool isn't purely synthetic at N=6 — it's real anchors
topped up, higher-fidelity input than 12 synthetic repeats regardless of raw count. If on-box
dogfood shows this producing materially more false positives/negatives than today, raising
`AUDITION_POOL_TARGET_N` is a one-constant change, not a redesign.

### 4. Signature change

**Correction from adversarial review, round 2:** the first two drafts never said what happens
to `CENTROID_K` and `AuditionCentroidOpts.k` (the existing override, still asserted by
`audition-centroid.test.ts`'s "respects k override" case) once a fixed render count is
replaced by the target/margin/anchor-count formula — leaving an implementer unable to tell if
that test should stay, change, or go.

**Resolved:** `CENTROID_K` is removed (superseded by `AUDITION_POOL_TARGET_N` +
`AUDITION_POOL_MARGIN`). `AuditionCentroidOpts.k` is removed and replaced by optional
`targetN`/`margin` overrides on the same options object (defaulting to
`AUDITION_POOL_TARGET_N`/`AUDITION_POOL_MARGIN`), so tests can still exercise small pool sizes
directly instead of via a render-count override that no longer maps onto a single loop
variable. The "respects k override" test is rewritten against `targetN`, not deleted.
`AuditionCharacter` already declares `hint?: CharacterHint` (`audition-centroid.ts:37`) — §1's
plumbing fix populates it at the call site for the first time; it needs no type change. The
function itself gains one new parameter, `existingAnchors: Float32Array[]` (defaulting to
`[]`), so the bimodal call site and every other existing unit test that doesn't pass it keep
working unchanged.

## Testing

- `audition-centroid.test.ts`: replace the `CENTROID_K`-based call-count assertions (and the
  "respects k override" case) with `targetN`/`margin`-based top-up math; add cases for (a)
  anchors alone already meeting target → zero new renders, (b) partial anchors → partial
  top-up, (c) zero anchors → full target+margin renders (today's shape, smaller pool), (d)
  `buildAuditionTexts` cycling through fewer-than-N distinct quotes vs. the no-evidence canned
  fallback, (e) the pool-filling loop stopping early once target is reached vs. exhausting the
  margin and falling to `too-short`, (f) a blended pool that comes back `bimodal: true` →
  anchors discarded and the *already-rendered* synthetic embeddings topped up to target (assert
  the total render count across both the initial attempt and the top-up never exceeds `targetN
  + margin` — the regression test for the round-2 cost-blowup fix), (g) a resulting
  synthetic-only pool is used as-is with no second bimodal check (documents the accepted
  pre-existing limitation, doesn't newly assert incorrect behavior as correct).
- `aggregate.test.ts` / `aggregate-audition-tier.test.ts`: assert too-thin characters' anchors
  are passed into `auditionCentroid` and bimodal characters' are not; assert `scoreBook` loads
  `cast.json` via the new best-effort `readCastJson` and threads `buildHintFromCast` onto
  `voiceInfoByChar`, covering **both** failure states — no matching cast entry (character
  present, `hint` stays `undefined`) **and** `cast.json` entirely missing/unparseable (the
  state the three existing fixtures in `aggregate-audition-tier.test.ts` are already in —
  confirms this change doesn't red them); assert the combined pool (not just fresh renders)
  drives the resulting `cleanMean`/`pSevere`/`pBand`.
- No e2e coverage needed — this is a backend scoring-pipeline change with no new UI surface;
  existing srv-36 render-integrity coverage (Phase 1) is the relevant regression net.

## Out of scope

- Measuring the current or post-change false-positive/negative rate of the drift-tolerance
  band. This spec fixes two mechanisms known to be wrong without measurement (same-text-only
  variance; discarding usable real anchors) — it does not attempt a before/after study. If
  on-box dogfood surfaces a regression, see the Accepted limitation note above.
- Any change to the shared `buildSampleText`/`MAX_CHARS` used by the voice-preview routes —
  untouched by this spec.
- Re-tuning `CENTROID_MIN_N`, `BIMODAL_GAP_THRESHOLD`, or other in-book-path constants in
  `centroid.ts` — this spec only adds a new, separate constant for the audition/too-thin pool.
- srv-36 Phase 2 (cross-book/per-emotion/temporal voice consistency) — a separate, larger
  in-flight design; unrelated to this backup-reference chore.
