---
status: active
shipped: null
owner: null
---

# Frontend perf pass — broadcast diffing + selector equality + route code-split

> Status: active
> Key files: `src/store/broadcast-middleware.ts:171-189`, `src/store/index.ts:151`, `src/views/listen.tsx:121`, `src/lib/icons.tsx`, `vite.config.ts`
> URL surface: indirect — every routed view (lazy boundaries appear at first navigation)
> OpenAPI ops: none

## Benefit / Rationale

Three independent micro-optimisations on the frontend that share a deployment shape (one PR, one risk surface). Each item is ~half a day; bundling avoids three separate review cycles for ~1 day of work total.

- **User (C2):** idle tabs stop receiving 10+ KB messages per analyzer tick — long-running analysis becomes invisible to other tabs of the same workspace. Matters most for the concurrent-multi-book workflow ([project_concurrent_multibook_workflow]) where a user might keep three tabs open on three different books.
- **User (C3):** Listen view stops re-rendering on unrelated book's export-state changes — relevant in the same multi-book workflow. Today a tick on Book B's export queue forces a re-render of Book A's Listen view.
- **User (C5):** faster initial paint, especially on cold mobile loads (per plan 81 — mobile + tablet support). Route-level splitting means the library view doesn't pay the cost of the manuscript-editor bundle.
- **Technical:** locks in three patterns (shallow-diff broadcasts, selector equality wrappers, React.lazy boundaries) that future frontend work can replicate without re-deciding.

## Architectural impact

- **C2 — Broadcast middleware diffing (`src/store/broadcast-middleware.ts`):** replaced full `activeStream` snapshots with shallow-diffed payloads. The middleware now caches the last broadcast snapshot per `(kind, bookId)` and emits one of three message modes — `mode: 'full'` (initial / bookId change), `mode: 'diff'` (only the keys that changed), `mode: 'clear'` (slot cleared). `phaseProgress`-only ticks (and `lastTickAt`-only ticks for the chapters slice) collapse inside a `PROGRESS_DEBOUNCE_MS = 250` window — only the first tick after a window opens escapes; subsequent in-window ticks are dropped. The recipient applies a `diff` onto its existing `activeStream` (spread). Plan 63 narrow scope is preserved: the broadcast action set was NOT widened — only the wire payload shape changed. Tests in `src/store/broadcast-middleware.test.ts` cover (a) full / diff / clear modes, (b) progress-only debounce, (c) phase-transition tick escapes the debounce, (d) cross-book switching emits `mode: 'full'`, (e) round-trip recipient state equals sender state, (f) narrow-scope guard still holds.
- **C3 — Selector equality (`src/store/index.ts`):** added `useAppSelectorShallow` wrapping `useSelector` with react-redux's `shallowEqual`. Conversion sites (capped at five per plan):
  1. `src/views/listen.tsx:122` — `s.exports.byBookId[bookId] ?? []` (Listen view's export-queue read; the primary offender called out in the plan — array identity is stable when a foreign book's export ticks).
  2. `src/components/layout.tsx:82` — `s.cast.characters` (Layout is mounted on every route; large array, high mutation rate during analysis stream).
  3. `src/components/layout.tsx:83` — `s.chapters.chapters` (same; large per-book chapter array).
  4. `src/components/layout.tsx:479` — `s.library.books` (the bookMeta-fallback hydration effect's dependency; large array, churns on every 30 / 120 s drift-poll fan-out).
  5. `src/routes/index.tsx:497` — `s.chapters.chapters` in `ReadyViewSwitch` (sister read to layout's, scoped to the ready stage).
- **C5 — Route code-split (`src/routes/index.tsx`, `src/components/layout.tsx`, `src/components/delayed-spinner.tsx`, `vite.config.ts`):** route-leaf views (`UploadView`, `AnalysingView`, `ManuscriptView`, `CastView`, `LibraryView` voices, `GenerationView`, `ListenView`, `ChangeLogView`, `AccountView`, `RestructureView`, `WorktreesView`) are lazy-imported via `React.lazy`. A single shared `Suspense` boundary wraps the `Outlet` in `Layout`. The fallback (`DelayedSpinner`) is gated by a 150 ms `setTimeout` — warm-cache navigations resolve the lazy chunk before the timer fires, so no spinner flash; cold-cache navigations paint the spinner after 150 ms and replace it with the view once the chunk lands. Vite `manualChunks` groups vendor libs (react / router / redux / vendor) so per-view chunks stay small. Non-route-leaf views (`BookLibraryView`, `ConfirmCastView`, `ConfirmMetadataView`) remain eagerly imported — the library is the landing route, and the confirm views are tiny sub-routes whose eager cost is negligible.
- **Migration:** none — all three changes are runtime-only.
- **Reversibility:** each item is independently revert-able (single import-shape change + slice middleware change + Vite chunk config change).

## Invariants to preserve

- **Plan 63 narrow-scope BroadcastChannel rule:** only `activeStream` slots — never per-chapter rows / cast / manuscript. The C2 diff implementation operates inside that scope (diff over `activeStream`'s sub-fields), not extending it.
- **Plan 23 mock toggle:** mock layer unaffected (C2/C3/C5 are all post-API).
- **Plan 27 single-user-per-workspace contract:** preserved — BroadcastChannel is still echo-suppressed via per-tab `instanceId` tag + inbound-action allowlist (plan 63).
- **[project_concurrent_multibook_workflow]:** preserved and improved — multi-book tabs see lower message volume + fewer re-renders, but cross-tab pill state remains live.
- **Plan 81 mobile budget:** route splitting helps mobile cold-loads (compatible direction).

## Test plan

### Automated coverage

- Vitest frontend (`src/store/broadcast-middleware.test.ts`) — extended to assert: (a) full / diff / clear message modes, (b) `phaseProgress`-only ticks debounce within `PROGRESS_DEBOUNCE_MS`, (c) phase-transition ticks (e.g. `phaseProgress` + `phaseId`) escape the debounce, (d) recipient's `activeStream` after applying the diff sequence equals the sender's `activeStream` byte-for-byte (round-trip), (e) plan 63 scope rule still enforced — non-`activeStream` actions never broadcast, (f) cross-book bookId change emits `mode: 'full'`, (g) empty diffs (no-op ticks) skip the wire, (h) inbound diff with no prior base is safely dropped.
- Vitest frontend (`src/components/delayed-spinner.test.tsx`, new) — asserts the Suspense fallback (a) stays hidden before `delayMs`, (b) paints after `delayMs`, (c) clears its timer on unmount so a fast-resolve doesn't fire a late update.
- Playwright e2e (`e2e/concurrent-multi-book.spec.ts`, new) — opens two browser contexts at the library route; tab A navigates to /new; asserts tab B's URL does NOT follow tab A's nav (proves the BroadcastChannel scope doesn't widen to routing — plan 63 narrow-scope guard at the browser layer).
- Playwright e2e (`e2e/route-lazy.spec.ts`, new) — cold navigation under network throttling observes the Suspense fallback (annotated for diagnostics); warm navigation to the same route shows zero fallback paints (locks the 150 ms-delay-no-flash contract).

### Manual acceptance walkthrough

1. **Multi-book idle-tab test:** open two tabs on different books; start analysis on Book A; verify (via DevTools Performance / React Profiler) that Book B's tab issues zero re-renders against unrelated book state during the run.
2. **Listen-view selector test:** open Book A's Listen view; queue an export on Book B (via mock mode or a second tab); verify Listen view's component-render counter doesn't tick when Book B's export progresses.
3. **Cold-load timing:** Lighthouse the library route on a clean cache; the initial bundle should shrink by the size of the manuscript editor + cast view + listen view chunks. Mobile budget per plan 81 maintained.
4. **Suspense flash:** navigate to a fresh route; the Suspense fallback should not flash for already-cached routes.

## Out of scope

- **C1 — Manuscript view virtualisation** → BACKLOG Should #1. Explicitly demoted from MUST in the survey — current feel is bearable, but >300 sentences during boundary drag is the next-priority frontend item.
- **C4 — Confirm-cast + listen-chapter list virtualisation** → BACKLOG Could #25. Only matters above ~40 rows; depends on Should #1 to amortise the `@tanstack/react-virtual` dep.
- **C6 — Waveform memoisation** → BACKLOG Could #26. Low real-world impact today.
- **A1 — Parallel chapter synthesis** → plan 87 (parallel branch).
- **B1 — Per-phase analyzer model** → plan 88 (parallel branch).

## Ship notes

_(filled when status flips to `stable` — shipped date, commit SHA, observed message-volume + render-count delta in the concurrent-multi-book scenario)_
