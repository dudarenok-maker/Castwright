---
status: stable
shipped: 2026-07-07
owner: null
---

# Voice Drift Detector — book/series scope + incremental reveal + shared-singleton Listen audio

> Status: stable
> Key files: `src/modals/drift-report.tsx`, `src/components/layout.tsx`, `src/store/revisions-slice.ts`, `src/store/library-slice.ts`, `src/store/ui-slice.ts`
> URL surface: drift banner on any book view → modal overlay (unchanged)
> OpenAPI ops: none (no server contract change — purely client-side scoping/rendering)

## Benefit / Rationale

- **User:** the Drift Report modal no longer freezes/crashes the browser tab when drift has accumulated across many books (reported: "375 chapters flagged across 10 books"). It now defaults to the active book, offers a "Series" toggle to expand scope, and reveals additional drift cards on scroll instead of mounting hundreds at once.
- **Technical:** two independent, compounding causes are fixed. (1) `layout.tsx` fed the modal the ENTIRE workspace's drift (`selectDriftGroupsByBook`, unscoped) because plan 83's background cross-book poller fills it for every book by design — a new `scopeDriftGroupsByBook` pure filter narrows this to the active book (default) or its series before the modal ever sees it. (2) `DriftListenWidget` mounted two real `<audio>` elements per row **unconditionally** (not gated on the Listen click) — at scale that's ~750 concurrently-live `HTMLMediaElement`s, the actual crash trigger (plan 91's `(book × character × snapshot)` consolidation only collapses cardinality well within one book; across many independent books it barely helps). Rebuilt on the same shared-singleton A/B pattern already used by `CompareCastModal`/`VoiceCompareModal` (`use-sample-playback.ts` + `use-ab-audition.ts`) — at most one real `<audio>` element exists for the whole app now.
- **Architectural:** `scopeDriftGroupsByBook` (revisions-slice.ts) and `findSeriesBookIds` (library-slice.ts) are new, independently-testable pure helpers — no new server endpoint, since both the active-book and cross-book drift data are already fully client-resident (plan 83's poll fetches complete per-book lists). `DriftBookSection` also gained a client-side windowed reveal (`GROUPS_PAGE_SIZE = 20`, IntersectionObserver sentinel — same technique as `change-log.tsx`'s infinite scroll) so even a single heavily-drifted book can't dump hundreds of cards into the DOM at once.

## Architectural impact

- **New seams / extension points**:
  - `scopeDriftGroupsByBook(groupsByBook, scope, activeBookId, seriesBookIds)` — pure filter, exported from `src/store/revisions-slice.ts`.
  - `findSeriesBookIds(authors, bookId)` — pure lookup over the already-loaded library scan, exported from `src/store/library-slice.ts`.
  - `ui.driftReportScope: 'book' | 'series'` + `setDriftReportScope` action in `src/store/ui-slice.ts`, mirroring the existing `driftReportCharacterFilter` pattern; reset to `'book'` on `setShowDriftReport(false)`.
  - `DriftReportModal` gained `scope` / `onScopeChange` / `seriesAvailable` props driving a "This book" / "Series" pill toggle in the header (same visual idiom as the Voice library panel's `all`/`current`/`library` tabs).
- **Invariants preserved**:
  - `DriftReportModal` itself stays scope-agnostic — it renders whatever `groupsByBook` it's handed (multiple books still render fine, per the existing "book header per group" test); scoping is entirely `layout.tsx`'s responsibility, computed before the prop is built.
  - Plan 91's consolidation ((book × character × snapshot) grouping, `React.memo`-wrapped cards, `ProfileCompareCard` always visible) is untouched.
  - Plan 83's background cross-book poll is untouched — this plan changes what the modal *renders*, not what the store *fetches*.
  - Per-character filter (`filterCharacterId` / `onClearFilter`) behavior unchanged.
- **Migration story**: none. `driftReportScope` is a new redux field with a default (`'book'`); no persisted/disk format changes.
- **Reversibility**: revert the PR. No downstream code depends on the new helpers/props outside the modal, layout.tsx, and their tests.

## Invariants to preserve

- `scopeDriftGroupsByBook` falls back to the **unscoped** list when `activeBookId` is `null` (defensive — the real UI always has an active book when the modal is reachable) — `src/store/revisions-slice.ts`.
- `findSeriesBookIds` returns `[bookId]` (not `[]`) when the book isn't found in the library or its series has only one book, so callers can treat the result as "the scope" without a separate standalone check — `src/store/library-slice.ts`.
- `DriftListenWidget` (`src/modals/drift-report.tsx`) must never render a JSX `<audio>` element — playback goes through the shared `useSamplePlayback()` singleton exclusively. A regression test asserts zero `<audio>` DOM nodes at 50-row scale.
- `GROUPS_PAGE_SIZE = 20` in `src/modals/drift-report.tsx` — the windowed-reveal page size. The load-more sentinel (`drift-book-load-more-<bookId>`) only mounts while `hasMore` is true.
- `setShowDriftReport(false)` resets both `driftReportCharacterFilter` and `driftReportScope` — `src/store/ui-slice.ts`.

## Test plan

### Automated coverage

- `src/store/library-slice.test.ts` — `findSeriesBookIds`: same-series lookup, single-book-series fallback, not-found fallback, null bookId.
- `src/store/revisions-slice.test.ts` — `scopeDriftGroupsByBook`: book scope, series scope, single-book series, no-active-book fallback.
- `src/store/ui-slice.test.ts` — `driftReportScope` defaults to `'book'`, `setDriftReportScope` transitions, reset on close.
- `src/modals/drift-report.test.tsx`:
  - "scale regression" describe block — zero `<audio>` elements at 50-row scale; only the first page of group cards renders; the IntersectionObserver sentinel reveals more on intersect; the sentinel disappears once exhausted; a small book never shows it.
  - "book/series scope toggle" describe block — hidden by default / without `onScopeChange`; renders pressed state and fires the callback in both directions.
  - "Listen A/B compare player" describe block — rebuilt on the shared-singleton mock (same idiom as `compare-cast-modal.test.tsx`); toggling visibility, calling `playback.play()` with the right URL, fetch-once-cache for the voice sample, cross-side mutex via button state, and unmount-scoped stop.
- `src/components/layout.test.tsx` — the plan-91 book-title-fallback test now lands on an active book (confirm stage) and asserts book-A alone renders by default, with the Series toggle bringing book-B into view; the saved→library→bookId fallback chain assertion is scoped to the modal's heading role (not the top-bar breadcrumb, which independently renders a book title once a book is active).

### Manual acceptance walkthrough

1. Seed two books in the same series with drift on both (or wait for the plan-83 background poll to pick up a second book's drift while the active book has some too).
2. Open the Drift Report from the top banner → expect only the active book's cards, no "Series" toggle if standalone, or a "This book" (pressed) / "Series" pill pair if the active book has series-mates.
3. Click "Series" → the other book's cards appear under their own BOOK header.
4. Seed 50+ distinct single-chapter drift events for one book (simulates a heavily-drifted book) → expect only the first ~20 cards to render, with a "Loading more…" sentinel; scroll to the bottom → more cards reveal.
5. Click "Listen" on any row, then "Chapter" then "Voice profile" → confirm only one plays at a time (Chapter's label reverts once Voice starts) and the browser tab stays responsive throughout, even with many rows visible.

## Ship notes

Shipped 2026-07-07. Fixes the user-reported "voice drift detection pop-up crashes the browser because it doesn't limit data to a book or series" bug. Branch `fix/frontend-drift-modal-book-scope`.
