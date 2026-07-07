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

### 1. Dedicated sample text for audition renders

`buildSampleText`/`MAX_CHARS`=320 (`server/src/tts/voice-sample-cache.ts`) is shared with the
voice-preview routes (`routes/voice-sample.ts`, `routes/qwen-voice.ts`) — a user-facing "hear
this voice" clip, where a short sample is correct and this spec does not touch it.

`audition-centroid.ts` gains its own text builder, used only by this module:

```ts
/** Longer, richer sample text for audition renders — concatenates as many
 *  evidence quotes as fit (longest-first) instead of picking just one, so a
 *  single render carries more phonetic/prosodic variety. Falls back to the
 *  existing canned line, unchanged, when there's no evidence. */
const AUDITION_MAX_CHARS = 900;

function buildAuditionSampleText(voice: VoiceLike, hint?: CharacterHint): string {
  const cleaned = (hint?.evidence ?? [])
    .map(stripQuoteMarks)
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);

  if (cleaned.length === 0) {
    return buildSampleText(voice, hint); // canned fallback line, unchanged
  }

  let text = '';
  for (const quote of cleaned) {
    const next = text ? `${text} ${quote}` : quote;
    if (next.length > AUDITION_MAX_CHARS) break;
    text = next;
  }
  return text || cleaned[0].slice(0, AUDITION_MAX_CHARS);
}
```

`AUDITION_MAX_CHARS`=900 is a starting point (roughly 3x the preview cap, still bounded) —
calibration-tunable like the existing `BIMODAL_GAP_THRESHOLD`, not a hard requirement.

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
  same shape as today, just with the smaller K and richer text from §1.

### 3. New, decoupled target pool size

Introduce a new constant in `audition-centroid.ts`, independent of `centroid.ts`'s
`CENTROID_MIN_N`=10 (which stays exactly as-is — it continues to gate the *in-book* path
only):

```ts
/** Target combined pool size (anchors + new audition renders) for the
 *  Option-B fallback. Decoupled from CENTROID_MIN_N (10), which governs the
 *  in-book path — this pool is deliberately smaller since it's a synthetic
 *  backup, not a statistically rigorous sample. */
export const AUDITION_POOL_TARGET_N = 6;
```

`auditionCentroid` renders `max(0, AUDITION_POOL_TARGET_N - existingAnchors.length)` new
samples, embeds each, and calls `buildCentroid([...existingAnchors, ...newEmbeddings], {
minN: AUDITION_POOL_TARGET_N })` — using `buildCentroid`'s existing (currently-unused) `minN`
override so that once the pool reaches target size it gets the full trim/bimodal-check
treatment (`kind: 'in-book'` internally, relabeled `'audition'` by the caller), rather than
the degenerate `'too-thin'` path. If duration-floor failures (per-render retry logic,
unchanged) leave the pool short of target, the existing "too-short → inconclusive" behavior
applies exactly as today.

**Net effect:** worst case (0 anchors, no evidence) drops from 12 renders to 6 — a 2x cut;
typical too-thin characters with some anchors already need noticeably fewer than that.
Diversity improves because the rendered text is richer (§1), and the too-thin pool now
contains genuine in-book acoustic samples rather than only synthetic repeats.

### 4. Signature change

`auditionCentroid`'s `AuditionCharacter`/`AuditionCentroidOpts` types stay as-is; the function
gains an optional `existingAnchors: Float32Array[]` parameter (defaulting to `[]`, so the
bimodal call site and all existing unit tests that don't pass it keep working unchanged
except for the K/pool-size assertions called out below).

## Testing

- `audition-centroid.test.ts`: update the hardcoded `CENTROID_K`-based call-count assertions
  to the new `AUDITION_POOL_TARGET_N`-based top-up math; add cases for (a) anchors alone
  already meeting target → zero new renders, (b) partial anchors → partial top-up, (c) zero
  anchors → full target-count renders (today's shape, smaller K), (d) the richer
  `buildAuditionSampleText` concatenation (multiple quotes fit vs. overflow truncation vs.
  no-evidence fallback).
- `aggregate.test.ts` / `aggregate-audition-tier.test.ts`: assert too-thin characters' anchors
  are passed into `auditionCentroid` and bimodal characters' are not; assert the combined pool
  (not just fresh renders) drives the resulting `cleanMean`/`pSevere`/`pBand`.
- No e2e coverage needed — this is a backend scoring-pipeline change with no new UI surface;
  existing srv-36 render-integrity coverage (Phase 1) is the relevant regression net.

## Out of scope

- Any change to the shared `buildSampleText`/`MAX_CHARS` used by the voice-preview routes —
  untouched by this spec.
- Re-tuning `CENTROID_MIN_N`, `BIMODAL_GAP_THRESHOLD`, or other in-book-path constants in
  `centroid.ts` — this spec only adds a new, separate constant for the audition/too-thin pool.
- srv-36 Phase 2 (cross-book/per-emotion/temporal voice consistency) — a separate, larger
  in-flight design; unrelated to this backup-reference chore.
