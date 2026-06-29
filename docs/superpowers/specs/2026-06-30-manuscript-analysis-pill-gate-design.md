# Manuscript analysis passes — pill feedback + Generate-gate

_Design spec — 2026-06-30_

## Problem

Two buttons in the Manuscript header — **Detect emotions** (`DetectEmotionsButton`, the two-pass prosody annotation) and **Review Script** (the fs-58 LLM script-review pass, with per-chapter and whole-book variants) — run long, block the page, and give no durable feedback once the user navigates away. The whole-book review can run for minutes with no visible progress. Worse, while either pass is mid-flight a user can still press **Generate**, racing the analysis against TTS generation.

Both passes already push their _results_ into Redux correctly. The work here is UI/state plumbing: surface live progress, and prevent the race.

## Current state (verified against the codebase)

- `prosody-slice.ts` is **fully built** — `activeStream: { bookId; progress; label } | null` with `setActive` / `updateProgress` / `clear`. The **auto-trigger** (`layout.tsx:985`, Task 13/fs-65) already drives it and renders a **standalone** prosody pill (`layout.tsx:1512`, `data-testid="prosody-pill"`).
- The **manual** `DetectEmotionsButton` (`src/components/detect-emotions-button.tsx`) drives **only local component state** — so its progress is invisible from the Status pill and is lost on navigation.
- `runProsodyPasses` (`src/store/prosody-thunk.ts:48`) is **shared** by the manual button and the auto-trigger, and already accepts an `onProgress` callback.
- `script-review-slice.ts` **exists** (transient, non-broadcast, bookId-keyed `byBook` of review ops). It has **no** progress/`activeStream` field. `handleReviewScript` (`src/views/manuscript.tsx:697`) runs the pass inline and dispatches `scriptReviewActions.setReview` on completion.
- `summarizeStatus` (`src/components/top-bar.tsx:111`) is the pure helper feeding the unified **Status pill**. Its ladder is `halted > stalled > generation-running > analysis-running > design-running > model-loading > analysis-paused > revisions-pending > idle`. It has **no** prosody/review rung today.
- **Neither** `prosody` nor `scriptReview` is in `broadcast-middleware.ts`. `prosody-slice.ts`'s header explicitly says _do not broadcast_.
- **Generate is not gated** on either pass anywhere. The real Generate path is `generation.tsx` → `enqueueQueueEntries` (`src/store/queue-thunks.ts`). `ModelControlPill` is the TTS model load/stop control, **not** Generate.
- **No double-fire guard** exists between the manual button and the auto-trigger — both call `runProsodyPasses` for the same book with no shared mutex. `shouldAutoTriggerProsody` does not exist.

## Decisions

These three were resolved interactively during brainstorming; they supersede the corresponding lines in the originating plan.

1. **Pill architecture — fold into the analysing section.** Prosody and script-review are sub-stages of _book analysis_, so their progress belongs **inside the `summarizeStatus` "Analysing" rung**, not in a separate floating pill. The standalone `prosody-pill` is **retired**.
2. **Review progress storage — extend `script-review-slice.ts`.** Add a transient `activeStream` to the existing slice rather than creating a new `review-slice.ts`. The slice is already transient and non-broadcast and already owns review state.
3. **Cross-tab — broadcast the progress.** Add the prosody + scriptReview _progress_ actions to `broadcast-middleware.ts` so the Generate-gate and auto-trigger guard hold across tabs. (The originating plan assumed this worked "for free"; it did not — the slices were never broadcast.)

Corrections folded in silently (stale claims in the originating plan): file paths (`summarizeStatus` is in `components/top-bar.tsx`, the auto-trigger is in `components/layout.tsx`, there is no `src/store/layout.tsx`); `prosody-slice.activeStream` is fully built, not "half-built"; the Generate-gate target is `generation.tsx`, not `ModelControlPill`.

## Design

### 1. State model

**`script-review-slice.ts` (extend).** Add a transient field, a structural twin of `prosody-slice`:

```ts
export interface ReviewActiveStream { bookId: string; progress: number /* 0..100 int */; label: string; }
// in ScriptReviewState:  activeStream: ReviewActiveStream | null
// reducers:              setActive, updateProgress, clear   (mirror prosody-slice)
```

`byBook` (results) is unchanged.

**Broadcast.** In `broadcast-middleware.ts`, add **only the progress actions** to the broadcast allow-set:

- `prosody/setActive`, `prosody/updateProgress`, `prosody/clear`
- `scriptReview/setActive`, `scriptReview/updateProgress`, `scriptReview/clear`

The **result** actions (`scriptReview/setReview`, `toggleOp`, `toggleClass`, `clearReview`) stay **tab-local** — a passive tab must not have the review diff modal pop open. Prosody results already land in the (separately-handled) manuscript slice, so prosody-slice has no result action to worry about.

Update both slice header comments: replace the "do NOT broadcast" note with "progress actions broadcast for cross-tab gating; results stay tab-local."

**Selectors (new, bookId-aware).** Because `activeStream` is _singular_ (one active pass at a time) and concurrent multi-book is a first-class invariant, the gate is **per-book**:

- `selectProsodyRunningForBook(state, bookId): boolean`
- `selectReviewRunningForBook(state, bookId): boolean`
- `selectAnalysisSubstage(state): { kind: 'prosody' | 'review'; label: string; percent: number } | null` — whichever stream is active; feeds the pill.

### 2. Progress wiring & the pill

- **Manual `DetectEmotionsButton`** dispatches `prosodyActions.setActive` on start, `updateProgress` via the existing `runProsodyPasses` `onProgress` callback, and `clear` on completion/cancel. The inline badge re-sources from the slice so it survives navigation. (The auto-trigger already does exactly this; the manual path simply joins it.)
- **Review** gains a thunk `runReviewScript(bookId, { wholeBook })` in `src/store/script-review-thunk.ts` that dispatches `scriptReviewActions.setActive/updateProgress/clear` around the pass and `setReview` on completion. `handleReviewScript` in `manuscript.tsx` delegates to it. Whole-book RPD gating stays where it is.
- **`summarizeStatus`** gains `analysisSubstage` on `StatusInput`. A new rung sits **directly below `analysis?.state === 'running'`**:

  ```ts
  if (analysisSubstage)
    return { label: 'Analysing', tone: 'peach', icon: 'spinner', detail: `${analysisSubstage.percent}%` };
  ```

  Real analysis still outranks it — the sub-stages run _after_ the main analysis pass completes, so in practice they don't overlap; the ordering only matters for the degenerate manual-trigger-during-analysis case, where the primary pass correctly wins.
- **Popover** (`status-popover.tsx` / `StatusDetail`): the analysis section renders the active sub-stage row with user-facing wording — "Detecting emotions · NN%" / "Reviewing · NN%" (never the word "prosody" in UI copy).
- **Retire** the standalone prosody pill block in `layout.tsx` (~1512) and delete `layout-prosody-pill.test.tsx` (replaced by the summarizeStatus rung test).

### 3. Generate-gate (per-book, defense-in-depth)

- **UI.** In `generation.tsx`, disable the Generate / regenerate triggers for **the current book** when `selectProsodyRunningForBook(state, bookId) || selectReviewRunningForBook(state, bookId)`. Other books' Generate stays live (concurrent multi-book invariant).
- **Thunk guard.** `enqueueQueueEntries` early-returns and fires a toast when a sub-stage targets the entry's book — the authoritative backstop that also covers the cross-tab case and any stale-state click.
- **Copy.** "Wait — emotions are still being detected" / "Wait — script review is in progress."

### 4. Auto-trigger double-fire guard

- Extract a pure `shouldAutoTriggerProsody(state, bookId): boolean` returning `false` when `selectProsodyRunningForBook || selectReviewRunningForBook`. The `layout.tsx` auto-trigger effect calls it as the single in-memory source of truth.
- The existing **disk** `prosodyAnnotated` watermark stays the separate "already done" gate — it reads `api.getBookState`, so it is _not_ part of the pure Redux function and is not folded in. (This is narrower than the originating plan's "four cases idle/prosody-active/review-active/already-annotated" — the already-annotated case remains a disk-state async check, by design.)
- **Cross-tab:** now genuinely covered — tab B sees tab A's broadcast `activeStream`, so its auto-trigger early-returns and its Generate disables.

### Toasts

Start toasts read as a live process, never as a queued item: "Detecting emotions…" / "Reviewing…". Completion fires a success toast (and, for review, the existing diff modal). A cancel mid-run fires a partial-result toast and clears the stream.

## Out of scope / limitations (documented honestly)

- **Mid-run tab open.** Broadcast is action-replay, not state-sync, so a tab opened _while_ a pass is already running won't retroactively learn of it (matches all existing broadcast-middleware behavior). The server queue remains the ultimate backstop against an actual generation race.
- **Popover Cancel.** Cancel stays inline-only on the originating button; a Cancel control in the popover would require storing the `AbortController` on the slice — deferred.
- **No queue-slice reuse.** `queue-slice.ts` / its dispatcher assume TTS-shaped per-chapter `QueueEntry` rows; analysis passes are not modelled as queue entries. Widening `QueueEntry.scope` for future analysis jobs is explicitly out of scope.

## Test plan

**Unit (Vitest):**
- `script-review-slice.test.ts` — new `activeStream` reducers.
- `script-review-thunk.test.ts` — `runReviewScript` dispatch sequence (setActive → updateProgress → setReview → clear; cancel path).
- `prosody-thunk.test.ts` (update) + `prosody-autotrigger.test.tsx` — manual button now drives the slice; auto-trigger unchanged.
- `shouldAutoTriggerProsody.test.ts` — idle → true; prosody-active → false; review-active → false.
- `top-bar.test.tsx` — new `analysisSubstage` rung at the correct priority.
- selector tests — per-book `selectProsodyRunningForBook` / `selectReviewRunningForBook` / `selectAnalysisSubstage`.
- broadcast-middleware test — the six progress actions broadcast; the result actions do not.

**E2E (Playwright, mock mode):**
- `detect-emotions-pill-progress.spec.ts` — manual prosody → analysis-substage pill updates → navigate away → still updating → completion toast.
- `script-review-pill-progress.spec.ts` — whole-book review → pill updates → navigate away → toast + diff modal.
- `prosody-auto-trigger-guard.spec.ts` — auto-trigger skips `runProsodyPasses` while a stream is active for the same book.
- `generate-disabled-while-analysing.spec.ts` — Generate disabled with the warning copy while a sub-stage runs; other books unaffected.
- extend `mockReviewScript` for a predictable progress cadence.

**Verification commands:**
- `npm run typecheck`
- `npm run test -- top-bar.test.tsx prosody-thunk.test.ts src/store/script-review-slice.test.ts src/store/script-review-thunk.test.ts src/store/shouldAutoTriggerProsody.test.ts`
- `npm test` (full unit)
- `npm run test:e2e -- e2e/detect-emotions-pill-progress.spec.ts e2e/script-review-pill-progress.spec.ts e2e/prosody-auto-trigger-guard.spec.ts e2e/generate-disabled-while-analysing.spec.ts`
- `npm run verify` (full battery)

**Manual smoke (mock mode):**
1. Cold-boot a book → auto-trigger fires → Status pill shows "Analysing · NN%" → Generate disabled with warning copy → navigate to Listen mid-stream → pill keeps updating → return → completion toast.
2. Open a fresh book already past its first emotion pass → click Detect emotions → manual pass runs (auto-trigger won't re-fire, manual still does) → pill updates.
3. Review Script ▾ → Review whole book → "Analysing · NN%" → Generate disabled → navigate away → pill keeps updating → toast + diff modal on completion.
4. Cancel mid-run from the inline badge → pill resets, partial-result toast.

## Shipping checklist

- New `docs/features/` regression plan (or extend the fs-65 plan) + GH issue.
- `docs/features/INDEX.md` entry.
- `npm run verify` green.
- End-of-turn summary names the user-visible delta and the locking tests.
