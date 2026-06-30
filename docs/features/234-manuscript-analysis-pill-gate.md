---
status: active
shipped: null
owner: null
---

# 234 — Manuscript analysis pill feedback + Generate-gate

> Status: active
> Key files: `src/store/prosody-slice.ts`, `src/store/script-review-slice.ts`, `src/store/analysis-substage-selectors.ts`, `src/store/broadcast-middleware.ts`, `src/store/queue-thunks.ts`, `src/store/should-auto-trigger-prosody.ts`, `src/components/top-bar.tsx`, `src/components/detect-emotions-button.tsx`, `src/views/manuscript.tsx`
> URL surface: `#/books/<id>/manuscript` (pill + gate), status-pill on all views while analysis runs
> OpenAPI ops: none (frontend-only; prosody + script-review passes drive server-side SSE, not modified here)

Source spec: [`docs/superpowers/specs/2026-06-30-manuscript-analysis-pill-gate-design.md`](../superpowers/specs/2026-06-30-manuscript-analysis-pill-gate-design.md)
Source plan: [`docs/superpowers/plans/2026-06-30-manuscript-analysis-pill-gate.md`](../superpowers/plans/2026-06-30-manuscript-analysis-pill-gate.md)

## Benefit / Rationale

- **User:** while Detect-emotions or Script Review is running, the top-bar Status pill now shows an "Analysing" sub-stage rung with a live percent ticker, so the user always knows analysis is in progress from any view. The Generate button is disabled with a per-pass explanatory message so they cannot queue generation over a running analysis. The standalone prosody pill is retired — the Status pill is the single source of truth.
- **Technical:** per-book `activeStreams` maps (keyed by `bookId`) replace per-component local state for both the prosody and script-review passes. `selectAnalysisBusyForBook` is the single predicate consumed at three gating sites; `analysisBusyMessage` generates the per-pass warn copy. Cross-tab sync via `BroadcastChannel` keeps the pill live in sibling tabs without a polling round-trip.
- **Architectural:** locks in the two-layer Generate-gate defense (UI disable + `enqueueQueueEntries` thunk filter backstop), the auto-trigger double-fire guard (`shouldAutoTriggerProsody` in-memory + `prosodyAnnotated` disk watermark), and the six-action `sync:substage` outbound set with echo-suppression. Any future analysis pass that wants pill visibility + gate integration adds `setActive`/`updateProgress`/`clear` to its slice and appears automatically.

## Architectural impact

**New seams / extension points:**

- `SubstageEntry { progress: number; label: string }` in `src/store/prosody-slice.ts:14` — the typed shape for both the prosody and script-review streams; shared via import.
- `prosody.activeStreams` (`Record<string, SubstageEntry>`) and `scriptReview.activeStreams` (`Record<string, SubstageEntry>`) — per-book maps replacing any global flag. Both reducers are symmetric: `setActive / updateProgress / clear / applyExternalSet / applyExternalClear`.
- `selectAnalysisBusyForBook(state, bookId)` (`src/store/analysis-substage-selectors.ts:11`) — the authoritative boolean predicate for both UI and thunk gating.
- `analysisBusyMessage(state, bookId)` (`src/store/analysis-substage-selectors.ts:16`) — per-pass user-facing warn string.
- `selectAnalysisSubstage(state)` (`src/store/analysis-substage-selectors.ts:30`, `createSelector`) — memoized selector that returns `{ kind, label, percent }` for the topmost running substage across all books.
- `shouldAutoTriggerProsody(state, bookId)` (`src/store/should-auto-trigger-prosody.ts`) — pure guard; returns `false` when a prosody or review stream is already active for that book (in-memory layer of the double-fire guard).
- `sync:substage` BroadcastChannel message (`src/store/broadcast-middleware.ts:148,156`) — two shapes (`mode: 'set'` with a `SubstageEntry` payload, `mode: 'clear'`); dispatched for six prosody/review actions; echosuppressed by `instanceId`.
- `StatusInput.analysisSubstage?: { kind, percent }` (`src/components/top-bar.tsx:103`) — new optional field on the `summarizeStatus` input; absent = no sub-stage rung.

**Pill ladder (regrouped, H3 fix):**

```
Halted > Stalled > Generating > Loading model > Analysing (primary) > Analysing (substage) > Designing > Paused > Revisions > Idle
```

The standalone prosody pill (`layout-prosody-pill.test.tsx` + its rendering in `layout.tsx`) is **retired** in this plan. Voice-engine load/stop controls now live in the popover under the renamed "Voice engines" label (was "TTS engines", in-scope Status-popover rename only; app-wide copy rename is `fe-44` / #1182).

**Invariants preserved:**

- The discriminated-union `ui.stage` and hash-router grammar are untouched.
- The `BroadcastChannel('audiobook-state')` narrow-scope guard (plan 63): only `activeStreams`-slot mutations propagate cross-tab; per-chapter rows, cast, and manuscript content stay local.
- `applyExternalSet` / `applyExternalClear` are **not** in the outbound action filter (echo-suppression layer 2) so they never re-broadcast an inbound message.
- The `prosodyAnnotated` disk watermark (`putBookState`) is written only when `failed === 0` and is NOT cleared by the in-memory guard — it is the separate, durable complement.

**Reversibility:** the `activeStreams` maps default to `{}` (no migration); removing the substage selectors and broadcast lines reverts to the pre-plan behavior. The retired prosody pill had no external callers.

## Invariants to preserve

1. `prosody.activeStreams` keys in `src/store/prosody-slice.ts:22` are `bookId` strings; `setActive` rounds the 0..1 fraction to an integer percent at write time (`Math.round(progress * 100)`), and `updateProgress` applies the same rounding.
2. `scriptReview.activeStreams` in `src/store/script-review-slice.ts` mirrors the same shape and reducer API as `prosody.activeStreams`; the two maps are independent (a prosody stream for book A never touches a review stream for book A).
3. `selectAnalysisBusyForBook` in `src/store/analysis-substage-selectors.ts:11` is the **sole** gate predicate consumed by both `DetectEmotionsButton`, the three script-review trigger buttons in `manuscript.tsx`, and `enqueueQueueEntries` in `queue-thunks.ts`.
4. `enqueueQueueEntries` filters entries at the thunk level (`src/store/queue-thunks.ts:100-101`): allowed entries are enqueued; gated entries are never POSTed; one warn toast is shown for the first gated pass using `analysisBusyMessage`.
5. The `sync:substage` outbound watcher (`SUBSTAGE_BROADCAST_ACTIONS`, `src/store/broadcast-middleware.ts:181`) sends on exactly six actions: `prosody/{setActive,updateProgress,clear}` and `scriptReview/{setActive,updateProgress,clear}` — `updateProgress` IS broadcast so the cross-tab percent ticker stays live. The two `applyExternalSet`/`applyExternalClear` reducers are deliberately EXCLUDED from this outbound set (echo-suppression layer 2): an inbound message dispatches `applyExternal*`, which therefore never re-broadcasts.
6. `shouldAutoTriggerProsody(state, bookId)` returns `false` if `state.prosody.activeStreams[bookId]` or `state.scriptReview.activeStreams[bookId]` is set (the in-memory layer). Combined with the `prosodyConsidered` Set in `layout.tsx` (session-scope dedup) and the `prosodyAnnotated` disk watermark, this forms a three-layer double-fire guard.
7. The `StatusInput.analysisSubstage` field is **optional** (`?`): callers that don't pass it get `null` by default (no rung). The `selectAnalysisSubstage` selector returns `null` when neither `prosody.activeStreams` nor `scriptReview.activeStreams` has any entry.

## Test plan

### Automated coverage

**Vitest unit tests (`src/store/prosody-slice.test.ts`):**
- `setActive` stores a rounded-percent entry keyed by bookId.
- `updateProgress` only touches the named book, leaves others intact.
- `clear` removes only the named book, leaving others intact.
- `applyExternalSet` / `applyExternalClear` touch only the named key.

**Vitest unit tests (`src/store/script-review-slice.test.ts`):**
- `script-review-slice activeStreams` describe block: `setActive`/`updateProgress`/`clear` are per-book; `applyExternalSet`/`applyExternalClear` touch only the named key.

**Vitest unit tests (`src/store/analysis-substage-selectors.test.ts`):**
- Per-book running flags (`selectProsodyRunningForBook`, `selectReviewRunningForBook`).
- `selectAnalysisSubstage` prefers prosody over review; falls back to review when no prosody runs; returns `null` when idle.
- `selectAnalysisSubstage` returns a stable reference for unchanged input (memoized via `createSelector`).

**Vitest unit tests (`src/store/should-auto-trigger-prosody.test.ts`):**
- Returns `true` when idle.
- Returns `false` when prosody runs for the book.
- Returns `false` when review runs for the book.
- Returns `true` when another book is busy (per-book scoping).

**Vitest component tests (`src/components/detect-emotions-button.test.tsx`):**
- Disabled when there are no attributed sentences.
- Disabled while a review runs on the same book (`selectAnalysisBusyForBook` gate).

**Vitest integration tests (`src/store/prosody-autotrigger.test.tsx`):**
- Covers the full double-fire guard: does NOT fire when a book is already analysis-complete (seed-on-mount); does NOT fire for pre-existing complete books that arrive via async library hydrate (boot seed-race); fires once when a book transitions to `cast_pending` after the seeded first render; skips when `getBookState` returns `prosodyAnnotated:true` (disk watermark); does NOT fire when `prosody.activeStreams` already has the book (in-memory guard); does NOT write `putBookState` when `failed > 0`; calls `putBookState` with `prosodyAnnotated:true` when `failed === 0`.

**Vitest integration tests (`src/store/queue-thunks.test.ts`):**
- `enqueueQueueEntries — analysis gate` describe block: enqueues only un-gated entries and toasts the gated pass.

**Vitest broadcast-middleware tests (`src/store/broadcast-middleware.test.ts`):**
- `broadcast-middleware sync:substage` describe block: posts `set` on `setActive` and `clear` on `clear` (book taken from payload); applies a foreign inbound set and does NOT re-broadcast (echo-suppression layer 2); drops self-echo by `instanceId`; a `clear` on book X leaves book Y intact.

**Playwright e2e tests (`e2e/detect-emotions-pill-progress.spec.ts`):**
- Detect-emotions flow shows "Analysing" sub-stage in the Status pill with progress while the pass runs.

**Playwright e2e tests (`e2e/script-review-pill-progress.spec.ts`):**
- Script-review flow shows "Analysing" sub-stage in the Status pill with progress while the pass runs.

**Playwright e2e tests (`e2e/prosody-auto-trigger-guard.spec.ts`):**
- Auto-trigger guard: the Detect-emotions button is not attached (auto-trigger suppressed) while a prosody stream is active; the progress pill is visible.

**Playwright e2e tests (`e2e/generate-disabled-while-analysing.spec.ts`):**
- Generate button is disabled (and shows an explanatory message) while analysis is running for the book. Script Review chapter button also disabled.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev`).

1. **Open a book → Manuscript view.** With an attributed book in the mock, navigate to `#/books/<id>/manuscript`. Status pill shows idle (no chip).

2. **Trigger Detect-emotions.** Click "Detect emotions" on a chapter. The Status pill should immediately show "Analysing" with a percent ticker. The "Detect emotions" button disables. The Generate button on the same book disables with a tooltip "Wait — emotions are still being detected."

3. **Switch tabs mid-run (multi-tab cross-check).** Open a second tab at the same URL. The Status pill should show "Analysing" within a few seconds (after the next `sync:substage` tick from the originating tab).

4. **Emotions detect completes.** The Status pill returns to idle (or the next active state). The Generate button re-enables.

5. **Trigger Script Review.** Open a chapter's Script Review panel and trigger a review pass. The Status pill shows "Analysing" with a percent ticker. The "Run Script Review" button disables. The Generate button disables with "Wait — script review is in progress."

6. **Attempt Generate while analysis runs.** From the generation view, click Generate. The button should be disabled and not submit.

7. **Attempt queue enqueue while analysis runs.** Open the queue modal and attempt to add a chapter. The chapter should not be enqueued; one warn toast should appear naming the active pass.

8. **Auto-trigger guard.** Reload the app on a `cast_pending` book that has NOT been prosody-annotated. Prosody auto-triggers once. Reload again — it does NOT trigger a second time (disk watermark prevents re-trigger).

## Out of scope

- App-wide user-facing "TTS" → "Voice engines" copy rename (eviction banners, admin page, cast-screen labels, code identifiers). This plan renames only the Status-popover "TTS engines" → "Voice engines" section label. The broad rename is tracked as `fe-44` ([#1182](https://github.com/dudarenok-maker/Castwright/issues/1182)).
- Multi-tab catch-up on tab open mid-run: a tab opened while a run is in progress shows no substage pill until the next progress tick or broadcast. Deliberate v1 limitation.
- Sub-second prosody progress ticks: the current server-side tick rate is chapter-granular (coarse). If a future engine emits sub-second ticks, add a `(stream, bookId)`-keyed debounce in `broadcast-middleware.ts` mirroring the existing analysis-block debounce. Not needed today — `sync:substage` has NO debounce by design (coarse ticks only).
- The two-tab same-tick TOCTOU on the auto-trigger: if two tabs both observe a `cast_pending` transition on the same tick before either has written `prosodyAnnotated`, both may attempt to trigger. The in-memory `prosodyConsidered` Set (session-scope) plus the server-side `prosodyAnnotated` watermark make this a race to a no-op write at worst, not a correctness violation. Closing it cleanly requires a server-side auto-trigger lock, deferred.
- `selectAnalysisBusyForBook` optional-chaining inconsistency: `selectProsodyRunningForBook` and `selectReviewRunningForBook` use `?.activeStreams` (added for manuscript test-store partial state) while `selectAnalysisSubstage` reads `s.prosody.activeStreams` without `?.`. Cosmetic; benign in production (all stores include both slices). A follow-up could harmonize.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any behaviour delta vs. the original spec. Once filled, the plan becomes eligible for archive — move to `docs/features/archive/` in the same PR as the ship.)
