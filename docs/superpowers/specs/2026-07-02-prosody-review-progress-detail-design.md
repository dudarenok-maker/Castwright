# Prosody + script-review progress detail — chapter counts and ETA

_Design spec — 2026-07-02. Revised after adversarial review (see "Adversarial review outcomes")._

## Problem

The **Detect emotions** (prosody, two-pass) and **Review Script** (fs-58 script review) passes both report progress as a bare percentage. That's hard to act on: a user watching "42%" has no idea whether that means "30 seconds left" or "10 more minutes," and no sense of how many chapters remain. Worse, the **Review Script** button today shows *no* progress feedback at all — just a static "Reviewing…" label — even though the underlying SSE stream already carries per-chapter phase events.

This spec adds chapter counts ("chapter 3 of 12") and a pace-based ETA ("~2m left") to both passes, surfaced everywhere their progress is currently shown.

## Current state (verified against the codebase)

- Both passes share one mechanism: bookId-keyed `activeStreams: Record<bookId, SubstageEntry>` maps in `prosody-slice.ts` and `script-review-slice.ts`, where `SubstageEntry = { progress: number /* 0..100 */; label: string }`. `selectAnalysisSubstage` (`analysis-substage-selectors.ts`) **constructs** (not passes through) `{ kind, label, percent }` from whichever map has an entry, for the Status-pill popover (`status-popover.tsx`'s "Analysis" section, `substage-row`).
- **"Detect emotions" is not one pass — it's two full back-to-back passes over the same chapters.** `prosody-thunk.ts` runs `api.detectEmotions` (route `annotate-emotion.ts`) then `api.detectInstruct` (route `instruct-annotation.ts`), stitching their independent 0–1 progress into a combined 0–50% / 50–100% scale. Both routes filter the same `excludedChapterIds` off the same `byChapter.keys()`, so both process the identical `chapterIds` list.
- Server side, all three relevant routes — `annotate-emotion.ts`, `instruct-annotation.ts`, `script-review.ts` — already loop `for (let i = 0; i < chapterIds.length; i++)` and emit an SSE `phase` event per chapter: `{ kind: 'phase', progress: i / chapterIds.length, label: "<Verb> — chapter <chapterId>", chapterId }`. `chapterId` is the raw manuscript chapter id (can skip numbers when earlier chapters are excluded from narration) — not a sequential position.
- `detect-emotions-button.tsx` maintains its **own local React state** (`phase`, `progress`, `status`, `error`), fed from the thunk's `onProgress`/`onStatus` callbacks, in parallel with the Redux entry it also dispatches to. That local state is not just a progress mirror — it also drives the "Starting…" bridge, the throttle notice ("Waiting on the analyzer rate limit…"), the inter-pass label ("Adding natural reactions…"), and — critically — the **terminal** states: the `Tagged N lines across M chapters` success summary and the error text, both rendered *after* `phase` leaves `'running'`. The Redux `activeStreams` entry has no equivalent fields and is deleted in `finally` the moment the pass ends, so nothing in Redux can reproduce those terminal renders.
- `script-review-thunk.ts`'s `onPhase` callback destructures only `{ progress }` and discards `label`/`chapterId` entirely — so the popover's review row has never shown anything but the static label "Reviewing".
- `manuscript.tsx`'s "Review Script" button has no inline progress UI of any kind, and (unlike the emotions button) no local per-chapter state to preserve — `handleReviewScript` just awaits `runReviewScript` and flips a `reviewLoading` boolean.
- The selector's output is **narrowed twice more** on the way to the popover: `layout.tsx` (~line 1422/1439) maps `selectAnalysisSubstage`'s result into two different reshaped objects (`{ kind, percent }` for `StatusInput`, `{ label, percent }` for `StatusDetail`), and `top-bar.tsx` independently re-declares both of those same narrow shapes on `StatusInput.analysisSubstage` / `StatusDetail.analysisSubstage`. All three sites need widening, not just the selector.
- The compact top-bar Status pill (`top-bar.tsx`, `summarizeStatus`) shows only `Analysing · N%` and deliberately stays terse — it's a single dominant-state chip shared across many unrelated states (halted/generating/designing/etc). Out of scope for this change.
- `broadcast-middleware.ts`'s `sync:substage` message forwards the **whole** `SubstageEntry` object cross-tab — adding fields to the shape requires no middleware changes.
- The main analysing view (`server/src/routes/analysis.ts`, `phase-card.tsx`) already has a heavier precedent for pace-based ETAs: a per-chapter fixed-overhead baseline plus an observed chars/ms rate, a `Math.max(floor, …)` clamp, engine/device-split fallback rates, and cross-resume rate caching. This spec reuses the same *idea* (observed rate → linear extrapolation over remaining chars) at a much lighter weight — no fixed-overhead baseline, no floor, no cross-resume persistence (these three passes aren't resumable across a page reload). This is a deliberately coarser estimate, not a re-implementation of the heavier system; see Decision 2.
- The **mock** API layer (`mockDetectEmotions`, `mockDetectInstruct`, `mockReviewScript` in `src/lib/api.ts`) currently emits only `progress`/`label`/`chapterId` on its scripted `onPhase` ticks. `VITE_USE_MOCKS` mode (dev + all e2e specs) exercises only these mocks — the real routes are never hit. Any e2e assertion on the new fields is unreachable until the mocks are also updated.

## Decisions

1. **Scope of surfaces**: inline running chips (Detect-emotions button + a new chip on Review Script) and the Status-pill popover's Analysis section. **Not** the compact top-bar pill (stays terse by design).
2. **ETA method**: server-side pace-based estimate (observed ms/char rate from completed chapters, extrapolated over the remaining chapters' char counts) — same *idea* as the existing analysing-view pattern, deliberately lighter for these three routes (no fixed-overhead baseline, no floor, no persisted rate cache). Accepted trade-off: coarser accuracy, especially early in a pass or on books with few/uneven chapters, and text-input-length is a weaker proxy for `script-review.ts` (whose cost is dominated by variable LLM *output* — a clean chapter emits 0 ops, a messy one many). No fix is prescribed for this; it's an accepted limitation of "lighter," called out explicitly here rather than silently.
3. **ETA refresh cadence**: refreshes only when the server reports the next completed chapter (no client-side ticking countdown).
4. **Chapter numerator**: `chapterIndex` is the **1-based sequential position** among the chapters this pass is processing (1, 2, 3…), not the raw manuscript `chapterId`.
5. **Two-pass reconciliation for "Detect emotions" (new — added after adversarial review).** The per-route `chapterIndex`/`totalChapters` stay **per-pass** (each of the emotion and instruct routes independently counts `1..N` over the same N chapters) — NOT inflated to a fake `1..2N`, because the book only has N chapters and "chapter 14 of 24" would be more confusing than illuminating. The reset from "12 of 12" back to "1 of 12" is disambiguated by the **label**, which already differs per pass ("Detecting emotions" vs "Detecting instruct") and is rendered on the same line/block as the counter. The **ETA**, however, is combined across both passes by `prosody-thunk.ts` (the one place that already knows it's running two passes) rather than left as each route's independent (and, for the ETA, misleading) number:
   - While pass 1 (emotion) is running: combined ETA = pass 1's own `estRemainingMs` **plus** pass 1's own total-so-far (`elapsed so far in pass 1 + estRemainingMs`), used as a proxy for pass 2's projected total duration, since pass 2 hasn't run a single chapter yet and has no observed rate of its own. This is a heuristic ("assume pass 2 costs about what pass 1 does"), not a measurement — acceptable given the existing "~" framing everywhere else in this feature.
   - While pass 2 (instruct) is running: combined ETA = pass 2's own `estRemainingMs` only (pass 1 is complete and fully accounted for).
   - The chapter counter (`chapterIndex`/`totalChapters`) is passed through **unmodified per-pass**; only `estRemainingMs` is recombined by the thunk.
6. **Local state — retract "drop it" (revised after adversarial review).** `detect-emotions-button.tsx` keeps its existing local state (`phase`/`progress`/`status`/`error`) — it is NOT migrated to read from Redux, because that state also drives the throttle/inter-pass/terminal-summary/error renders that have no Redux equivalent and would regress if removed. Instead, the **same** `onProgress` callback that already updates local state and dispatches to Redux is simply widened to carry `chapterIndex`/`totalChapters`/`estRemainingMs`, and **both** consumers (local state and the Redux dispatch) pick up the extra fields from that one call — no new indirection, no dropped functionality.
   For the **new** Review Script inline chip, there is no pre-existing local per-chapter state to preserve (today it's just a `reviewLoading` boolean), so the simplest approach applies there: the new chip reads directly off `useAppSelector` on `scriptReview.activeStreams[bookId]`.

## Design

### 1. Data model

`SubstageEntry` (identical shape in both slices) gains three optional fields:

```ts
export interface SubstageEntry {
  progress: number;          // unchanged: 0..100 integer
  label: string;             // unchanged, e.g. "Detecting emotions"
  chapterIndex?: number;     // 1-based sequential position among chapters THIS PASS processes
  totalChapters?: number;    // count of chapters this pass processes
  estRemainingMs?: number;   // pace-based ETA for the rest of the operation; absent until the 2nd chapter starts
                              // (for prosody, this is the thunk's COMBINED cross-pass estimate — Decision 5)
}
```

`setActive` and `updateProgress` (both slices) accept the new fields as optional payload members and store whatever's present — a field simply doesn't update if the event didn't carry it (last-known-value semantics). `applyExternalSet`/`applyExternalClear` and the broadcast middleware need no changes (they already forward/receive the whole entry object).

### 2. Server-side pacing (three routes: `annotate-emotion.ts`, `instruct-annotation.ts`, `script-review.ts`)

Each route already has `chapterIds` (the ordered list this pass processes) and the per-chapter `sentences` (from which a char count is trivially summed — same unit the existing chunk-budget logic uses). Add, per route:

- Track `actualMsTotal` / `actualCharsTotal`, accumulated as each chapter finishes. Record `chapterStartedAt = Date.now()` immediately before that chapter's chunk-processing loop begins (right after emitting its `phase` event), and compute `chDurationMs = Date.now() - chapterStartedAt` once that chapter's loop exits — **whether it exits via normal completion or the `chapter-failed` catch** — before advancing to `i + 1`. This ensures a failed chapter (which can fail mid-chunk) still contributes its real wall-clock cost to the pacing rate, not zero.
- Chapter chars = summed `sentence.text.length` for that chapter's `sentences`.
- Before dispatching chapter `i`'s `phase` event, include `chapterIndex: i + 1` and `totalChapters: chapterIds.length` always; include `estRemainingMs` only once at least one chapter has completed (`observedRate = actualMsTotal / actualCharsTotal`; `estRemainingMs = Math.round(observedRate * <sum of char counts for chapters i..end>)`).
- Drop the `" — chapter {chapterId}"` suffix from the `label` string (now redundant with the structured fields) — label becomes just the verb phase, e.g. `"Detecting emotions"` / `"Detecting instruct"` / `"Reviewing script"`.

For a single-chapter script review (`chapterId` supplied in the request body → `chapterIds.length === 1`), `totalChapters` is always 1 and there's never a "remaining chapters" pool, so `estRemainingMs` is never emitted for that case.

**Each route's `estRemainingMs` describes only its own remaining chapters** — for `annotate-emotion.ts` and `instruct-annotation.ts` that's an intentionally partial number; the cross-pass combination happens client-side (Section 3, Decision 5), not in the routes themselves.

### 3. Client plumbing

- **`api.ts`**: extend the `onPhase` callback types for `detectEmotions`, `detectInstruct`, and `reviewScript` to parse and forward `chapterIndex`, `totalChapters`, `estRemainingMs` from the SSE `phase` payload (same pattern as today's `chapterId`/`label` parsing). **Also extend the three mock implementations** (`mockDetectEmotions`, `mockDetectInstruct`, `mockReviewScript`) to emit plausible values for the same fields across their scripted `onPhase` ticks — without this, the feature is invisible under `VITE_USE_MOCKS` (dev mode and every e2e spec).
- **`prosody-thunk.ts`**: owns the two-pass reconciliation (Decision 5). `onProgress` widens from `(fraction) => void` to `(fraction, detail?: { chapterIndex, totalChapters, estRemainingMs }) => void`; the thunk tracks which pass is active and applies the combining rule from Decision 5 before calling `onProgress`, so callers (the button, and via it Redux) only ever see one already-reconciled `estRemainingMs`.
- **`script-review-thunk.ts`**: today `onPhase: ({ progress }) => dispatch(updateProgress({bookId, progress}))` discards everything else — widen to forward `label`/`chapterIndex`/`totalChapters`/`estRemainingMs` into `updateProgress` too (single pass, no reconciliation needed).
- **`prosody-slice.ts` / `script-review-slice.ts`**: reducers store the new optional fields (Section 1).
- **`analysis-substage-selectors.ts`**: `selectAnalysisSubstage` must be **edited** (it constructs `{ kind, label, percent }` today) to also include `chapterIndex`/`totalChapters`/`estRemainingMs` in its returned object.
- **`layout.tsx`**: both reshaping sites (the `StatusInput.analysisSubstage` mapping and the `StatusDetail.analysisSubstage` mapping) widen to pass the new fields through instead of dropping them.
- **`top-bar.tsx`**: `StatusInput.analysisSubstage` and `StatusDetail.analysisSubstage` type declarations widen to match.
- **`detect-emotions-button.tsx`**: local state stays (Decision 6) — the existing `onProgress` call site widens to also capture and store the new fields locally, alongside dispatching them to Redux.

### 4. UI rendering

A small shared presentational piece (e.g. a `SubstageProgress` component/helper) renders the enriched line, used in two places:

1. **Status-popover substage row** (`status-popover.tsx`) — today: label + `percent%` on one line. New: label + percent as today, plus a second line when available: `Chapter 3 of 12 · ~2m left`. Missing fields simply omit their clause (no chapter line for a 1-chapter review; no "· ~X left" clause until an estimate exists).
2. **Inline running chips** — the existing "Detect emotions" chip gains the same second line, sourced from its (widened, still-local) state. A **new** chip appears next to "Review Script" (`manuscript.tsx`), sourced from `scriptReview.activeStreams[bookId]` directly, showing the same info — replacing the current bare "Reviewing…" label with something actionable.

Copy examples:
- Mid-pass, multi-chapter, rate not yet known: `Chapter 1 of 12`
- Mid-pass, rate known: `Chapter 3 of 12 · ~2m left`
- Near the end of the *whole* two-pass operation (instruct pass, its own last chapter): `Chapter 11 of 12 · less than a minute left`
- Emotion pass finishing (12 of 12) with the instruct pass still fully ahead: label already reads "Detecting emotions" (about to flip to "Detecting instruct"); ETA reflects the full projected pass-2 duration per Decision 5, not "almost done."
- Single-chapter review: no chapter/ETA clause at all — just the label + percent.

### 5. Edge cases

- **Chapter-failed mid-pass**: still advances `chapterIndex`/elapsed time correctly per the bracketing in Section 2; doesn't block the counter or the ETA.
- **Very short books** (1–2 chapters): counter still renders; ETA stays coarse (inherent to pace-based estimation with few samples, and to the lighter model accepted in Decision 2) — not specially handled.
- **Cross-tab**: enriched entry rides the existing `sync:substage` broadcast unchanged.
- **Reload mid-pass**: unchanged from today — these passes aren't resumable across a reload, so there's no stale-estimate-after-reload case.
- **Pass-2 has zero observed rate at its own start**: its first chapter's `phase` event carries no `estRemainingMs` from the route (same "no estimate until one chapter completes" rule as pass 1) — the thunk's combined estimate for that instant falls back to whatever it last held from pass 1's projection until pass 2 produces its own first sample.

## Testing

- `prosody-slice.test.ts` / `script-review-slice.test.ts`: `setActive`/`updateProgress` accept and store the new optional fields; an update that omits a field doesn't clobber a previously-set value.
- `analysis-substage-selectors.test.ts`: the new fields are present in the selector's output.
- `prosody-thunk.test.ts`: the two-pass combining rule (Decision 5) — during pass 1, combined `estRemainingMs` reflects pass-1-remaining + pass-1-total-as-pass-2-proxy; during pass 2, combined `estRemainingMs` reflects only pass 2's own remaining.
- Server route tests (`annotate-emotion.test.ts` and equivalents for the other two routes): phase events carry `chapterIndex`/`totalChapters` from chapter 1 on; `estRemainingMs` is absent on the first chapter and present (and consistent with observed pacing) from the second chapter onward; a chapter that fails still contributes its wall-clock duration to the next chapter's rate; a single-chapter review never emits `estRemainingMs`.
- `detect-emotions-button.test.ts`: chip renders the new line once fields are present; renders label-only when they're not; existing throttle/terminal-summary/error rendering is unaffected (regression coverage for Decision 6).
- New test coverage for the Review Script inline chip (doesn't exist today).
- `e2e/detect-emotions-pill-progress.spec.ts`: extend to assert the chapter-count text appears during a run, against the **inline chip or popover** (not the top-bar pill, which is out of scope) — requires the mock-layer updates from Section 3 to be in place first.

## Out of scope

- The compact top-bar Status pill (stays terse — see Decision 1).
- Any change to the ASR content-QA "Verifying speech…" line in the Generation view (a separate, per-chapter system, not the pass this spec targets).
- Live-ticking countdown UI (Decision 3 — refresh-on-server-tick only).
- Fixing the ETA's char-count-as-proxy weakness for `script-review.ts` (Decision 2) — accepted limitation, not addressed here.

## Adversarial review outcomes

An `assumption-checker` pass (Opus tier) against this spec and the actual source files found:

1. **(Critical, fixed)** The original spec computed `chapterIndex`/`totalChapters`/`estRemainingMs` independently per-route with no cross-pass reconciliation for the two-pass "Detect emotions" flow — the counter would reset "12 of 12" → "1 of 12" and the ETA would under-report by roughly half across the entire first pass. Fixed via Decision 5.
2. **(Significant, fixed)** The mock API layer was never in scope, making the promised e2e coverage unreachable under `VITE_USE_MOCKS`. Fixed — mocks are now explicit scope in Section 3 and a precondition on the e2e test in Testing.
3. **(Significant, fixed)** "Migrate `detect-emotions-button.tsx` off local state" would have regressed the throttle notice, inter-pass label, and terminal success/error summary, none of which have a Redux home. Retracted via Decision 6; the Review Script chip (which has no such legacy state) still reads from Redux directly.
4. **(Minor, fixed)** `layout.tsx` and `top-bar.tsx` each re-narrow the substage shape on the way to the popover and were missing from the original file list; the selector's "passes through unchanged" claim was wrong (it constructs the object). Both corrected in Section 3.
5. **(Minor, fixed)** Chapter-failed timing needed to explicitly bracket the whole per-chapter chunk loop (not a single chunk) so a mid-chunk failure still contributes real elapsed time to the pacing rate. Made explicit in Section 2.
6. **(Accepted, not fixed)** Char-count is a weaker pacing proxy for `script-review.ts` than for the two prosody routes, since review's LLM cost is dominated by variable output (op count), not input length. No mitigation is proposed — flagged as an accepted limitation of the "lighter than analysis.ts" ETA (Decision 2).
