---
status: active
shipped: null
owner: null
---

# Prosody + script-review progress detail — chapter counts and ETA

> Status: active
> Key files: `src/lib/substage-progress-text.ts`, `src/store/prosody-slice.ts`,
> `src/store/script-review-slice.ts`, `src/store/analysis-substage-selectors.ts`,
> `src/store/prosody-thunk.ts`, `src/store/script-review-thunk.ts`,
> `src/components/status-popover.tsx`, `src/components/detect-emotions-button.tsx`,
> `src/views/manuscript.tsx`, `server/src/routes/annotate-emotion.ts`,
> `server/src/routes/instruct-annotation.ts`, `server/src/routes/script-review.ts`
> URL surface: indirect — surfaces inside the manuscript view (`#/books/<id>/manuscript`)
> and the top-bar Status popover, both present regardless of hash.
> OpenAPI ops: none (SSE `phase` event payload shape only — not a REST response body)

## Benefit / Rationale

- **User:** Watching "Detect emotions" or "Review Script" run no longer means
  staring at a bare percentage. Both surfaces now show "Chapter 3 of 12 · ~2m
  left" — how far through the book the pass is, and roughly how much longer
  it'll take — refreshed each time the server finishes another chapter.
  "Review Script" also gained an inline running chip for the first time; it
  previously showed a static "Reviewing…" label with no progress feedback at
  all.
- **Technical:** A single pure formatter (`formatSubstageDetail`) renders
  identical copy across three otherwise-independent surfaces (Status-popover,
  Detect-emotions chip, Review-Script chip), so future copy changes are a
  one-file edit. The `SubstageEntry` shape's three new fields are optional and
  additive — every consumer that doesn't know about them keeps working
  unchanged (last-known-value semantics on the reducers, `undefined`-tolerant
  `toEqual` in existing tests).
- **Architectural:** Establishes a light, deliberately-coarser sibling to the
  heavier per-chapter ETA machinery in `server/src/routes/analysis.ts`
  (observed ms/char rate, no fixed-overhead baseline, no floor, no
  cross-resume persistence) — proving that pattern scales down cleanly to a
  route that doesn't need the heavier one's precision. Establishes the
  two-pass ETA reconciliation pattern (Decision 5) as the template for any
  future multi-pass operation that wants one combined "time left" figure
  instead of two independently-resetting counters.

## Architectural impact

- **New seams / extension points:**
  - `SubstageEntry` (`prosody-slice.ts` / `script-review-slice.ts`) gains
    three optional fields: `chapterIndex?`, `totalChapters?`,
    `estRemainingMs?`. Any future substage-style progress stream can reuse
    the same shape and the same `formatSubstageDetail` renderer.
  - `runProsodyPasses`'s `onProgress` callback widened from
    `(fraction) => void` to `(fraction, detail?: SubstageDetail) => void` —
    a new, narrower `SubstageDetail` interface (`prosody-thunk.ts`) carries
    `label?`/`chapterIndex?`/`totalChapters?`/`estRemainingMs?` per tick.
  - Three SSE routes (`annotate-emotion.ts`, `instruct-annotation.ts`,
    `script-review.ts`) each track a local `actualMsTotal`/`actualCharsTotal`
    pacing accumulator and emit `chapterIndex`/`totalChapters`/
    `estRemainingMs` on every `phase` event.
- **Invariants preserved:**
  - The compact top-bar Status pill (`summarizeStatus`, the `Analysing · N%`
    chip) is untouched — `layout.tsx`'s `StatusInput.analysisSubstage`
    mapping still passes only `{ kind, percent }`. Only the popover-facing
    `StatusDetail.analysisSubstage` widened.
  - `detect-emotions-button.tsx` keeps its pre-existing local React state
    (`phase`/`progress`/`status`/`error`) — not migrated to read from Redux.
    That state still drives the throttle notice, the inter-pass label, and
    the terminal success/error summaries, none of which have a Redux home.
  - `broadcast-middleware.ts`'s `sync:substage` cross-tab message forwards
    the whole `SubstageEntry` object — no middleware changes were needed for
    the three new optional fields to ride along.
  - Server-side pacing is a genuinely lighter model than
    `server/src/routes/analysis.ts`'s: no fixed per-chapter overhead
    baseline, no `Math.max(floor, …)` clamp, no engine/device-split fallback
    rate, no cross-resume rate cache (these three passes aren't resumable
    across a page reload).
- **Migration story:** None — purely additive optional fields on an
  in-memory, non-persisted Redux slice (`ProsodyState`/`ScriptReviewState`
  are transient, never written to `state.json`). No lazy-migration path
  needed.
- **Reversibility:** Any layer can be reverted independently since every
  field is optional and every consumer tolerates its absence — e.g. reverting
  the three server routes alone drops `estRemainingMs`/`chapterIndex` from
  the wire, and the client renders the label-only chip exactly as it did
  before this feature (the `formatSubstageDetail`/`formatChapterCount`
  guards return `null` and the callers already omit the detail line in that
  case).

## Invariants to preserve

1. `chapterIndex` is always the **1-based sequential position** among the
   chapters the current pass processes — never the raw manuscript
   `chapterId` (which can skip numbers when earlier chapters are excluded
   from narration). See `server/src/routes/annotate-emotion.ts`'s
   `chapterIndex: i + 1` inside its `for (let i = 0; …)` loop, mirrored in
   `instruct-annotation.ts` and `script-review.ts`.
2. `estRemainingMs` is **absent** on a route's very first chapter (no
   observed rate yet) and **never emitted at all** for a pass that processes
   exactly one chapter (`totalChapters === 1`) — both routes' own gate
   (`if (actualCharsTotal > 0)`) and `formatChapterCount`'s
   `if (totalChapters <= 1) return null;` guard in
   `src/lib/substage-progress-text.ts:100-104`.
3. A chapter that fails mid-pass still contributes its real wall-clock
   duration to the pacing rate — the `actualMsTotal`/`actualCharsTotal`
   accumulation sits in a `finally` block bracketing the **whole**
   per-chapter chunk loop (not a single chunk), so a mid-chunk failure in
   `script-review.ts` (which chunks separately from the other two routes)
   still counts real elapsed time toward the next chapter's estimate.
4. The two-pass reconciliation rule for "Detect emotions"
   (`src/store/prosody-thunk.ts`, `runProsodyPasses`):
   - **While pass 1 (emotion) runs:** combined `estRemainingMs` = pass 1's
     own `estRemainingMs` **plus** a projection of pass 2's full duration
     (`elapsed-so-far-in-pass-1 + pass-1's-own-estRemainingMs`), since pass 2
     hasn't run a single chapter yet and has no observed rate of its own.
   - **While pass 2 (instruct) runs:** combined `estRemainingMs` = pass 2's
     own `estRemainingMs` only (pass 1 is complete and fully accounted for).
   - Until pass 2 reports its own first estimate, the last pass-1-derived
     combined number stays **frozen** rather than dropping to `undefined` —
     avoids a false "no estimate" blip right at the pass boundary.
   - The chapter counter (`chapterIndex`/`totalChapters`) is passed through
     **unmodified per-pass** — never inflated to a fake `1..2N`. The label
     ("Detecting emotions" vs "Detecting instruct") is what disambiguates the
     reset from "12 of 12" back to "1 of 12", not the counter itself.
5. The compact top-bar Status pill (`top-bar.tsx`'s `summarizeStatus` /
   `StatusInput.analysisSubstage`) stays terse — `{ kind, percent }` only,
   deliberately not widened. Only `StatusDetail.analysisSubstage` (the
   popover) carries the full shape (`src/components/top-bar.tsx:168-170`,
   `src/components/layout.tsx` around line 1439).
6. `formatSubstageDetail`/`formatChapterCount`/`formatEtaClause`
   (`src/lib/substage-progress-text.ts`) are the single source of the
   rendered copy for all three surfaces — no surface hand-rolls its own
   "Chapter N of M" or "~Xm left" string.

## Test plan

### Automated coverage

- Vitest unit (`src/lib/substage-progress-text.test.ts`) — the three pure
  formatters: chapter-count formatting/nulling on a single-chapter pass,
  ETA-clause rounding (under a minute / minutes / hours+minutes), and the
  combined `formatSubstageDetail` join/omit logic.
- Vitest unit (`src/store/prosody-slice.test.ts`,
  `src/store/script-review-slice.test.ts`) — `setActive`/`updateProgress`
  accept and store the three new optional fields; an update that omits a
  field doesn't clobber a previously-stored value (last-known-value
  semantics).
- Vitest unit (`src/store/analysis-substage-selectors.test.ts`) —
  `selectAnalysisSubstage` passes `chapterIndex`/`totalChapters`/
  `estRemainingMs` through from whichever slice's entry wins, and omits them
  cleanly (as `undefined`) when the entry lacks them.
- Vitest server (`server/src/routes/annotate-emotion.test.ts`,
  `server/src/routes/instruct-annotation.test.ts`,
  `server/src/routes/script-review.test.ts`) — every `phase` event carries
  `chapterIndex`/`totalChapters` from chapter 1 on; `estRemainingMs` is
  absent on the first chapter and present (a number) from the second chapter
  onward; a chapter/chunk that throws still contributes its wall-clock
  duration to the next estimate; `script-review.test.ts` additionally
  asserts a single-chapter review never emits `estRemainingMs`; the
  `" — chapter N"` label suffix is dropped from all three routes' `label`.
- Vitest unit (`src/lib/api-detect-emotions.test.ts`,
  `src/lib/api-review-script.test.ts`) — the client SSE parser forwards
  `chapterIndex`/`totalChapters`/`estRemainingMs` off a `phase` event into
  the `onPhase` callback for `detectEmotions`/`detectInstruct`/
  `reviewScript`; the mock API layer (`mockDetectEmotions`,
  `mockDetectInstruct`, `mockReviewScript` in `src/lib/api.ts`) emits
  plausible values for the same fields so `VITE_USE_MOCKS` mode and e2e can
  exercise the feature.
- Vitest unit (`src/store/prosody-thunk.test.ts`) — the Decision-5 two-pass
  ETA reconciliation: combined estimate while pass 1 runs (own-remaining +
  pass-1-total-as-pass-2-proxy), the frozen hold at the pass boundary until
  pass 2 produces its own number, the switch to pass 2's own number once
  available, and pass-through of `chapterIndex`/`totalChapters`/`label`.
- Vitest unit (`src/store/script-review-thunk.test.ts`) — `onPhase` forwards
  `label`/`chapterIndex`/`totalChapters`/`estRemainingMs` into the dispatched
  `updateProgress` payload, while a phase event that omits them still
  dispatches an exact `{ bookId, progress }` payload (no stray `undefined`
  keys) — locks in the pre-existing exact-equality test.
- Vitest unit (`src/components/status-popover.test.tsx`) — the
  Analysis-section substage row renders the `formatSubstageDetail` line
  under the label+percent when chapter/ETA fields are present, and omits the
  detail line entirely when neither is available.
- Vitest unit (`src/components/detect-emotions-button.test.tsx`) — the
  inline running chip renders the chapter-count + reconciled ETA once
  `runProsodyPasses`'s `onProgress` supplies a detail object (asserted with
  a tolerance range, since real — not fake — elapsed time feeds the
  reconciliation math in this test); pre-existing throttle/terminal-summary/
  error rendering stays unaffected.
- Vitest unit (`src/views/manuscript.test.tsx`) — the new Review-Script
  inline chip renders while a review is in flight, showing the same
  chapter-count + ETA text sourced directly from
  `scriptReview.activeStreams[bookId]`.
- Playwright e2e (`e2e/detect-emotions-pill-progress.spec.ts`) — extended to
  assert the inline chip shows `Chapter N of M` text during a mocked run
  (`mockDetectEmotions` ships `chapterIndex`/`totalChapters` from its first
  tick).

Not independently re-tested (verified as unaffected by design, per the
spec's "Edge cases" §5): cross-tab sync (the whole `SubstageEntry` object
already rides `sync:substage` unchanged; `broadcast-middleware.test.ts`
covers whole-entry forwarding generically) and reload mid-pass (these passes
were never resumable across a reload, before or after this change).

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, the default for `npm run dev`).

1. Open a book's manuscript view (`#/books/<id>/manuscript`) with more than
   one chapter → click **Detect emotions** → confirm the modal. Expected:
   the inline running chip shows a spinner, a status label, a
   `Chapter N of M` line once the mock's first phase tick lands, and after a
   short delay a `· ~Xm left` (or `less than a minute left`) clause appended
   to that same line. The percent counter on the right keeps advancing
   independently.
2. While that pass runs, open the top-bar Status pill and expand the
   popover. Expected: the "Analysis" section's substage row shows the same
   label + percent, with an identical `Chapter N of M · ~X left` line
   underneath — sourced from the same Redux entry as the inline chip.
3. Let the emotion pass finish and watch it hand off to the instruct pass.
   Expected: the label flips from "Detecting emotions" to "Detecting
   instruct", the chapter counter resets from "N of M" back to "1 of M" (not
   "M+1 of 2M"), and the ETA does **not** show a discontinuous jump back to
   a tiny number — per Decision 5 it should already reflect roughly the
   pass-2-sized estimate projected during pass 1.
4. On the same book, click **Review Script** on any chapter with the review
   menu set to "whole book" (or trigger a multi-chapter review). Expected: a
   brand-new inline chip appears next to the Review Script button — this
   chip did not exist before this feature; previously the button showed no
   inline progress at all. It shows the same chapter-count + ETA line,
   sourced directly from the Redux `scriptReview.activeStreams` entry.
5. Trigger a single-chapter script review (via the per-chapter review
   affordance, not whole-book). Expected: the chip/popover row shows the
   label + percent only — no `Chapter N of M` or `~X left` clause, since a
   1-chapter review never has a "remaining chapters" pool.

## Out of scope

- The compact top-bar Status pill (`summarizeStatus`, the `Analysing · N%`
  chip) — stays terse by design (Decision 1 of the design spec). Any future
  work to enrich it belongs in a separate plan.
- The ASR content-QA "Verifying speech…" line in the Generation view — a
  separate, per-chapter system untouched by this feature.
- A live-ticking client-side countdown — the ETA only refreshes when the
  server reports the next completed chapter (Decision 3); no `setInterval`
  countdown was added.
- Improving the ETA's char-count-as-proxy accuracy for `script-review.ts`
  (Decision 2) — an accepted limitation, since that route's cost is
  dominated by variable LLM *output* (op count), not input text length. See
  `docs/superpowers/specs/2026-07-02-prosody-review-progress-detail-design.md`
  §"Out of scope" and its adversarial-review outcome 6.
- The full design rationale, including two rounds of adversarial review
  (data-model, server-pacing, and plan-level passes), lives in
  `docs/superpowers/specs/2026-07-02-prosody-review-progress-detail-design.md`;
  the task-by-task implementation plan is
  `docs/superpowers/plans/2026-07-02-prosody-review-progress-detail.md`.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any behaviour delta vs. the original spec. Once filled, the plan becomes eligible for archive — move to `docs/features/archive/` in the same PR as the ship.)
