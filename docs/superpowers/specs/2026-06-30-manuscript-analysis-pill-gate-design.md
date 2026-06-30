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

These were resolved interactively during brainstorming and hardened by an adversarial review of the spec (see "Adversarial review outcomes" below); they supersede the corresponding lines in the originating plan.

1. **Pill architecture — fold into the analysing section.** Prosody and script-review are sub-stages of _book analysis_, so their progress belongs **inside the `summarizeStatus` "Analysing" rung**, not in a separate floating pill. The standalone `prosody-pill` is **retired**.
2. **Progress storage — bookId-keyed maps, twin slices.** Review progress extends the existing `script-review-slice.ts` (not a new `review-slice.ts`). **Both** prosody and review progress are stored as a **`Record<bookId, …>` map**, not a singular slot — so concurrent multi-book passes (a first-class invariant) and cross-tab broadcast can't clobber each other. **`prosody-slice` therefore migrates from its current singular `activeStream` to the map shape** (its auto-trigger call sites in `layout.tsx` and `prosody-slice.test.ts` migrate with it).
3. **Cross-tab — broadcast done properly.** Progress syncs across tabs via a **new dedicated message kind** in `broadcast-middleware.ts` (`sync:substage`) with **external-apply reducers** that don't re-broadcast — _not_ by adding the existing progress actions to an allow-set (which would infinite-loop; see finding 1). The keyed-map shape (Decision 2) makes the broadcast collision-free, so the gate holds across tabs without one book's `clear()` releasing another's.

Corrections folded in silently (stale claims in the originating plan): file paths (`summarizeStatus` is in `components/top-bar.tsx`, the auto-trigger is in `components/layout.tsx`, there is no `src/store/layout.tsx`); `prosody-slice.activeStream` is fully built, not "half-built"; the Generate-gate target is `generation.tsx`, not `ModelControlPill`.

## Design

### 1. State model

**Shared entry shape.** Both slices key their progress by `bookId` (mirrors `chapters.activeStreams`), so concurrent books never collide:

```ts
export interface SubstageEntry { progress: number /* 0..100 int */; label: string; }
// state field on each slice:  activeStreams: Record<string /* bookId */, SubstageEntry>
// reducers on each slice:     setActive({bookId,progress,label})
//                             updateProgress({bookId,progress})
//                             clear({bookId})            // per-book, not global
//                             applyExternalStreams(Record<bookId,SubstageEntry>)  // inbound from broadcast; NOT broadcast itself
```

- **`prosody-slice.ts` (migrate).** Replace the singular `activeStream: … | null` with `activeStreams: Record<bookId, SubstageEntry>`. `clear()` gains a `{bookId}` payload. Update the two auto-trigger call sites in `layout.tsx` (~1050/1057) and `prosody-slice.test.ts`.
- **`script-review-slice.ts` (extend).** Add the same `activeStreams` map + the four reducers. `byBook` (results) is unchanged.

**Broadcast (proper protocol — see findings 1 & 2).** The middleware is **not** a generic action allow-set; it's a bespoke per-slice snapshot protocol with a closed message union and separate inbound reducers (echo-suppression layer 2). So:

- Add a **new message kind** `sync:substage` carrying `{ stream: 'prosody' | 'review'; bookId; mode: 'set' | 'clear'; entry? }`.
- The **outbound** watcher matches `prosody/setActive|updateProgress|clear` and `scriptReview/setActive|updateProgress|clear`, re-derives the changed book's entry from `getState()`, and sends a per-book `set`/`clear`. `updateProgress`-only ticks reuse the existing `PROGRESS_DEBOUNCE_MS` debounce, keyed by `(stream, bookId)`.
- The **inbound** handler dispatches `prosodyActions.applyExternalStreams` / `scriptReviewActions.applyExternalStreams` — which are **deliberately absent** from the outbound match set, so they can't re-broadcast (same pattern as `applyExternalAnalysisSnapshot`).
- **Result** actions (`scriptReview/setReview`, `toggleOp`, `toggleClass`, `clearReview`) stay **tab-local** — a passive tab must not pop the review diff modal. Prosody results land in the manuscript slice (separately handled), so prosody-slice has no result action.

Update both slice header comments: replace the "do NOT broadcast" note with "progress map broadcast cross-tab via `sync:substage`; results stay tab-local."

**Selectors (bookId-aware).** The keyed map makes per-book gating exact:

- `selectProsodyRunningForBook(state, bookId): boolean` → `bookId in state.prosody.activeStreams`
- `selectReviewRunningForBook(state, bookId): boolean` → `bookId in state.scriptReview.activeStreams`
- `selectAnalysisSubstage(state): { kind: 'prosody' | 'review'; label: string; percent: number } | null` — feeds the (singular) pill; when multiple books run it surfaces one deterministically (prosody before review, then lowest bookId) and the popover can list the rest.

### 2. Progress wiring & the pill

- **Manual `DetectEmotionsButton`** dispatches `prosodyActions.setActive({bookId})` on start and `updateProgress({bookId})` via the existing `runProsodyPasses` `onProgress` callback. **`clear({bookId})` MUST be in a `finally`** — covering success, error, _and_ abort — so a failed/aborted pass can never leave a stuck stream (which, broadcast cross-tab, would disable Generate in every tab). The button's current `run()` clears `phase` per-branch but has no pill `clear` in `finally` (`detect-emotions-button.tsx:58–74`); the migration adds it. The inline badge re-sources from the slice so it survives navigation.
- **Review** gains a thunk `runReviewScript(bookId, { wholeBook })` in `src/store/script-review-thunk.ts` that dispatches `scriptReviewActions.setActive/updateProgress` around the pass and `setReview` on completion. `handleReviewScript` (`manuscript.tsx:697`) already has a `try/finally` (resets `reviewLoading`); the thunk's `clear({bookId})` lands in that same `finally`. Whole-book RPD gating stays where it is.
- **`summarizeStatus`** gains `analysisSubstage` on `StatusInput`. A new rung sits **directly below `analysis?.state === 'running'`**:

  ```ts
  if (analysisSubstage)
    return { label: 'Analysing', tone: 'peach', icon: 'spinner', detail: `${analysisSubstage.percent}%` };
  ```

  Real analysis still outranks it — the sub-stages run _after_ the main analysis pass completes, so in practice they don't overlap; the ordering only matters for the degenerate manual-trigger-during-analysis case, where the primary pass correctly wins. **Known UX wart (finding 6, accepted):** when the main analysis finishes at "Analysing · 100%" and prosody starts at "Analysing · 0%", the pill's percent resets under the same label — it reads briefly like a regression. Accepted for v1 because it _is_ a genuine new phase; the popover names the active sub-stage, which disambiguates.
- **Popover** (`status-popover.tsx` / `StatusDetail`): the analysis section renders the active sub-stage row with user-facing wording — "Detecting emotions · NN%" / "Reviewing · NN%" (never the word "prosody" in UI copy).
- **Retire** the standalone prosody pill block in `layout.tsx` (~1512). **Blast radius (finding 4):** `data-testid="prosody-pill"` is referenced by `layout.tsx`, `layout-prosody-pill.test.tsx`, **and `e2e/analysis-prosody-toggle.spec.ts`** — delete the unit test and **re-point the e2e spec** at the new analysis-rung pill, don't just drop the unit test.

### 3. Generate-gate (per-book, defense-in-depth)

- **UI.** In `generation.tsx`, disable the Generate / regenerate triggers for **the current book** when `selectProsodyRunningForBook(state, bookId) || selectReviewRunningForBook(state, bookId)`. Other books' Generate stays live (concurrent multi-book invariant).
- **Thunk guard.** `enqueueQueueEntries` is the authoritative backstop (covers cross-tab and stale-state clicks). For a batch it **filters out** entries whose book has an active sub-stage and enqueues the rest (rather than dropping the whole batch), then fires one toast naming the gated book(s). In practice enqueue is per-book, but the filter keeps a mixed-book batch correct.
- **Copy.** "Wait — emotions are still being detected" / "Wait — script review is in progress."

### 4. Auto-trigger double-fire guard

- Extract a pure `shouldAutoTriggerProsody(state, bookId): boolean` returning `false` when `selectProsodyRunningForBook || selectReviewRunningForBook`. The `layout.tsx` auto-trigger effect calls it as the single in-memory source of truth.
- The existing **disk** `prosodyAnnotated` watermark stays the separate "already done" gate — it reads `api.getBookState`, so it is _not_ part of the pure Redux function and is not folded in. (This is narrower than the originating plan's "four cases idle/prosody-active/review-active/already-annotated" — the already-annotated case remains a disk-state async check, by design.)
- **Cross-tab (finding 5 — reduces, doesn't eliminate):** once tab A's `setActive` has broadcast, tab B's auto-trigger early-returns and its Generate disables. But `BroadcastChannel` is asynchronous, so two tabs that detect analysis-complete in the same tick can both pass `shouldAutoTriggerProsody` _before_ either's `setActive` arrives → a residual double-run TOCTOU window. The disk `prosodyAnnotated` watermark dedups the eventual _write_, not the concurrent _run_. This is a narrow single-user-two-tabs edge; documented, not closed in v1.

### Toasts

Start toasts read as a live process, never as a queued item: "Detecting emotions…" / "Reviewing…". Completion fires a success toast (and, for review, the existing diff modal). A cancel mid-run fires a partial-result toast and clears the stream.

## Out of scope / limitations (documented honestly)

- **Mid-run tab open.** Broadcast is action-replay, not state-sync, so a tab opened _while_ a pass is already running won't retroactively learn of it (matches all existing broadcast-middleware behavior). The server queue remains the ultimate backstop against an actual generation race.
- **Popover Cancel.** Cancel stays inline-only on the originating button; a Cancel control in the popover would require storing the `AbortController` on the slice — deferred.
- **No queue-slice reuse.** `queue-slice.ts` / its dispatcher assume TTS-shaped per-chapter `QueueEntry` rows; analysis passes are not modelled as queue entries. Widening `QueueEntry.scope` for future analysis jobs is explicitly out of scope.

## Adversarial review outcomes

The spec was attacked against the live code after the first draft. Dispositions:

1. **Broadcast is not a generic allow-set (Critical → fixed).** `broadcast-middleware.ts` is a bespoke per-slice snapshot protocol with separate inbound reducers; naively adding progress actions would infinite-loop. Resolved by Decision 3's dedicated `sync:substage` kind + `applyExternal*` reducers.
2. **Singular gate-bearing stream clobbers cross-tab (High → fixed).** A `clear()` from book X would release book Y's gate in another tab. Resolved by Decision 2's bookId-keyed map; locked by a `broadcast-middleware.test.ts` case.
3. **Missing `clear()` on the error path jams the gate globally (High → fixed).** Both thunks now `clear({bookId})` in `finally`.
4. **`prosody-pill` retirement under-scoped (Medium → fixed).** `e2e/analysis-prosody-toggle.spec.ts` is re-pointed, not just the unit test.
5. **Cross-tab auto-trigger guard is a TOCTOU (Medium → documented).** Reduces double-fire, doesn't eliminate the same-tick race; accepted for v1.
6. **Pill "Analysing %" discontinuity (Low → accepted).** Percent resets between phases; popover disambiguates.
7. **Enqueue guard, mixed-book batch (Low → fixed).** Filters gated entries, enqueues the rest.

## Test plan

**Unit (Vitest):**
- `prosody-slice.test.ts` (migrate) — singular → `activeStreams` map; `clear({bookId})` removes only that book; concurrent books coexist.
- `script-review-slice.test.ts` — new `activeStreams` map reducers + `applyExternalStreams`.
- `script-review-thunk.test.ts` — `runReviewScript` dispatch sequence (setActive → updateProgress → setReview, with `clear({bookId})` in `finally` on the success AND error paths).
- `prosody-thunk.test.ts` (update) + `prosody-autotrigger.test.tsx` — manual button now drives the slice and clears in `finally`; auto-trigger uses keyed actions.
- `shouldAutoTriggerProsody.test.ts` — idle → true; prosody-active(book) → false; review-active(book) → false; active-on-_other_-book → true.
- `top-bar.test.tsx` — new `analysisSubstage` rung at the correct priority.
- selector tests — per-book `selectProsodyRunningForBook` / `selectReviewRunningForBook` / `selectAnalysisSubstage` (incl. multi-book tie-break determinism).
- `broadcast-middleware.test.ts` — `sync:substage` round-trips `set`/`clear` per book; inbound `applyExternalStreams` does **not** re-broadcast (echo layer 2); `updateProgress` debounces per `(stream, bookId)`; a `clear` on book X leaves book Y's entry intact (the finding-2 regression).

**E2E (Playwright, mock mode):**
- `detect-emotions-pill-progress.spec.ts` — manual prosody → analysis-substage pill updates → navigate away → still updating → completion toast.
- `script-review-pill-progress.spec.ts` — whole-book review → pill updates → navigate away → toast + diff modal.
- `prosody-auto-trigger-guard.spec.ts` — auto-trigger skips `runProsodyPasses` while a stream is active for the same book.
- `generate-disabled-while-analysing.spec.ts` — Generate disabled with the warning copy while a sub-stage runs; other books unaffected.
- **Re-point `e2e/analysis-prosody-toggle.spec.ts`** off the retired `prosody-pill` testid onto the new analysis-rung pill (finding 4).
- extend `mockReviewScript` for a predictable progress cadence.

**Verification commands:**
- `npm run typecheck`
- `npm run test -- top-bar.test.tsx prosody-slice.test.ts prosody-thunk.test.ts src/store/script-review-slice.test.ts src/store/script-review-thunk.test.ts src/store/shouldAutoTriggerProsody.test.ts src/store/broadcast-middleware.test.ts`
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
