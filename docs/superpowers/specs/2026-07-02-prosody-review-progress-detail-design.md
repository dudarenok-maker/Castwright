# Prosody + script-review progress detail — chapter counts and ETA

_Design spec — 2026-07-02_

## Problem

The **Detect emotions** (prosody, two-pass) and **Review Script** (fs-58 script review) passes both report progress as a bare percentage. That's hard to act on: a user watching "42%" has no idea whether that means "30 seconds left" or "10 more minutes," and no sense of how many chapters remain. Worse, the **Review Script** button today shows *no* progress feedback at all — just a static "Reviewing…" label — even though the underlying SSE stream already carries per-chapter phase events.

This spec adds chapter counts ("chapter 3 of 12") and a pace-based ETA ("~2m left") to both passes, surfaced everywhere their progress is currently shown.

## Current state (verified against the codebase)

- Both passes share one mechanism: bookId-keyed `activeStreams: Record<bookId, SubstageEntry>` maps in `prosody-slice.ts` and `script-review-slice.ts`, where `SubstageEntry = { progress: number /* 0..100 */; label: string }`. `selectAnalysisSubstage` (`analysis-substage-selectors.ts`) surfaces one deterministically (prosody before review, lowest bookId) for the Status-pill popover (`status-popover.tsx`'s "Analysis" section, `substage-row`).
- Server side, all three relevant routes — `annotate-emotion.ts`, `instruct-annotation.ts`, `script-review.ts` — already loop `for (let i = 0; i < chapterIds.length; i++)` and emit an SSE `phase` event per chapter: `{ kind: 'phase', progress: i / chapterIds.length, label: "<Verb> — chapter <chapterId>", chapterId }`. `chapterId` is the raw manuscript chapter id (can skip numbers when earlier chapters are excluded from narration) — not a sequential position.
- `detect-emotions-button.tsx` maintains its **own parallel local React state** (`progress`, `status`) fed from the thunk's `onProgress`/`onStatus` callbacks, separate from the Redux entry it also dispatches to (`prosodyActions.setActive`/`updateProgress`). Its inline running chip renders from local state; the Redux-backed popover row renders from the (less current) Redux entry.
- `script-review-thunk.ts`'s `onPhase` callback destructures only `{ progress }` and discards `label`/`chapterId` entirely — so the popover's review row has never shown anything but the static label "Reviewing".
- `manuscript.tsx`'s "Review Script" button has no inline progress UI of any kind.
- The compact top-bar Status pill (`top-bar.tsx`, `summarizeStatus`) shows only `Analysing · N%` and deliberately stays terse — it's a single dominant-state chip shared across many unrelated states (halted/generating/designing/etc). Out of scope for this change.
- `broadcast-middleware.ts`'s `sync:substage` message forwards the **whole** `SubstageEntry` object cross-tab — adding fields to the shape requires no middleware changes.
- The main analysing view (`server/src/routes/analysis.ts`, `phase-card.tsx`) already has a heavier precedent for pace-based ETAs (observed chars/ms rate, extrapolated over remaining chapter char counts, with cross-resume rate caching). This spec reuses the same *idea* (observed rate → linear extrapolation) at a much lighter weight — no cross-resume persistence, since these three passes aren't resumable across a page reload (the fetch simply aborts).

## Decisions

1. **Scope of surfaces**: inline running chips (Detect-emotions button + a new chip on Review Script) and the Status-pill popover's Analysis section. **Not** the compact top-bar pill (stays terse by design).
2. **ETA method**: server-side pace-based estimate (observed ms/char rate from completed chapters, extrapolated over the remaining chapters' char counts) — same *idea* as the existing analysing-view pattern, implemented fresh and lighter for these three routes (no persisted rate cache).
3. **ETA refresh cadence**: refreshes only when the server reports the next completed chapter (no client-side ticking countdown). Simpler, and consistent with how ETAs are already surfaced as periodic log-line re-estimates elsewhere in the app.
4. **Chapter numerator**: `chapterIndex` is the **1-based sequential position** among the chapters this pass is processing (1, 2, 3…), not the raw manuscript `chapterId` — the current `"chapter {chapterId}"` label text can jump (e.g. straight to "chapter 4") when earlier chapters are excluded, which reads as confusing in a progress readout.
5. **Dedup existing local state**: `detect-emotions-button.tsx` migrates its inline chip to read from the Redux `activeStreams` entry (via the same selector the popover uses) instead of maintaining parallel local state — one source of truth, and the natural place to introduce a shared rendering component.

## Design

### 1. Data model

`SubstageEntry` (identical shape in both slices) gains three optional fields:

```ts
export interface SubstageEntry {
  progress: number;          // unchanged: 0..100 integer
  label: string;             // unchanged, e.g. "Detecting emotions"
  chapterIndex?: number;     // 1-based sequential position among chapters this pass processes
  totalChapters?: number;    // count of chapters this pass processes
  estRemainingMs?: number;   // pace-based ETA for the rest of the pass; absent until the 2nd chapter starts
}
```

`setActive` and `updateProgress` (both slices) accept the new fields as optional payload members and store whatever's present — a field simply doesn't update if the event didn't carry it (last-known-value semantics). `applyExternalSet`/`applyExternalClear` and the broadcast middleware need no changes (they already forward/receive the whole entry object).

### 2. Server-side pacing (three routes: `annotate-emotion.ts`, `instruct-annotation.ts`, `script-review.ts`)

Each route already has `chapterIds` (the ordered list this pass processes) and the per-chapter `sentences` (from which a char count is trivially summed — same unit the existing chunk-budget logic uses). Add, per route:

- Track `actualMsTotal` / `actualCharsTotal`, accumulated as each chapter finishes (chapter duration = wall-clock time for that chapter's processing; chapter chars = summed `sentence.text.length` for that chapter).
- Before dispatching chapter `i`'s `phase` event, include `chapterIndex: i + 1` and `totalChapters: chapterIds.length` always; include `estRemainingMs` only once at least one chapter has completed (`observedRate = actualMsTotal / actualCharsTotal`; `estRemainingMs = Math.round(observedRate * <sum of char counts for chapters i..end>)`).
- A chapter that fails (`chapter-failed`) still counts toward elapsed time and `chapterIndex` advancing — it took real wall-clock time even though it produced no annotations/ops.
- Drop the `" — chapter {chapterId}"` suffix from the `label` string (now redundant with the structured fields) — label becomes just the verb phase, e.g. `"Detecting emotions"` / `"Detecting instruct"` / `"Reviewing script"`.

For a single-chapter script review (`chapterId` supplied in the request body → `chapterIds.length === 1`), `totalChapters` is always 1 and there's never a "remaining chapters" pool, so `estRemainingMs` is never emitted for that case.

### 3. Client plumbing

- **`api.ts`**: extend the `onPhase` callback types for `detectEmotions`, `detectInstruct`, and `reviewScript` to parse and forward `chapterIndex`, `totalChapters`, `estRemainingMs` from the SSE `phase` payload (same pattern as today's `chapterId`/`label` parsing).
- **`prosody-thunk.ts`**: `onProgress` widens from `(fraction) => void` to also forward the new fields (progress-fraction math for the 0–50/50–100 split is unchanged).
- **`script-review-thunk.ts`**: today `onPhase: ({ progress }) => dispatch(updateProgress({bookId, progress}))` discards everything else — widen to forward `label`/`chapterIndex`/`totalChapters`/`estRemainingMs` into `updateProgress` too.
- **`prosody-slice.ts` / `script-review-slice.ts`**: reducers store the new optional fields (section 1).
- **`analysis-substage-selectors.ts`**: `selectAnalysisSubstage` passes the new fields through unchanged.
- **`detect-emotions-button.tsx`**: drop the parallel local `progress`/`status` state; read the running entry via `useAppSelector` off `prosody.activeStreams[bookId]` (the same data already dispatched to Redux), so the button, the popover, and any other consumer render from one source.

### 4. UI rendering

A small shared presentational piece (e.g. a `SubstageProgress` component/helper) renders the enriched line, used in two places:

1. **Status-popover substage row** (`status-popover.tsx`) — today: label + `percent%` on one line. New: label + percent as today, plus a second line when available: `Chapter 3 of 12 · ~2m left`. Missing fields simply omit their clause (no chapter line for a 1-chapter review; no "· ~X left" clause until the server has an estimate).
2. **Inline running chips** — the existing "Detect emotions" chip (now Redux-sourced, section 3) gains the same second line. A **new** chip appears next to "Review Script" (`manuscript.tsx`) showing the same info — replacing the current bare "Reviewing…" label with something actionable.

Copy examples:
- Mid-pass, multi-chapter, rate not yet known: `Chapter 1 of 12`
- Mid-pass, rate known: `Chapter 3 of 12 · ~2m left`
- Near the end: `Chapter 11 of 12 · less than a minute left`
- Single-chapter review: no chapter/ETA clause at all — just the label + percent.

### 5. Edge cases

- **Chapter-failed mid-pass**: still advances `chapterIndex`/elapsed time (section 2); doesn't block the counter or the ETA.
- **Very short books** (1–2 chapters): counter still renders; ETA stays coarse (inherent to pace-based estimation with few samples) — not specially handled.
- **Cross-tab**: enriched entry rides the existing `sync:substage` broadcast unchanged.
- **Reload mid-pass**: unchanged from today — these passes aren't resumable across a reload, so there's no stale-estimate-after-reload case.

## Testing

- `prosody-slice.test.ts` / `script-review-slice.test.ts`: `setActive`/`updateProgress` accept and store the new optional fields; an update that omits a field doesn't clobber a previously-set value.
- `analysis-substage-selectors.test.ts`: passthrough of the new fields.
- Server route tests (`annotate-emotion.test.ts` and equivalents for the other two routes): phase events carry `chapterIndex`/`totalChapters` from chapter 1 on; `estRemainingMs` is absent on the first chapter and present (and consistent with observed pacing) from the second chapter onward; a single-chapter review never emits `estRemainingMs`.
- `detect-emotions-button.test.ts`: chip renders the new line once fields are present; renders label-only when they're not (matches the single-chapter-equivalent case).
- New test coverage for the Review Script inline chip (doesn't exist today).
- `e2e/detect-emotions-pill-progress.spec.ts`: extend to assert the chapter-count text appears during a run.

## Out of scope

- The compact top-bar Status pill (stays terse — see Decision 1).
- Any change to the ASR content-QA "Verifying speech…" line in the Generation view (a separate, per-chapter system, not the pass this spec targets).
- Live-ticking countdown UI (Decision 3 — refresh-on-server-tick only).
