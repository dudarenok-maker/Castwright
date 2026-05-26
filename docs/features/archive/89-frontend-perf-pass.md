---
status: stable
shipped: '2026-05-21'
owner: dudarenok-maker
---

# Frontend perf pass — broadcast diffing + selector equality + route code-split

> Status: stable
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
- **C4 — Confirm-cast + listen-chapter list virtualisation** → BACKLOG Could #24. Only matters above ~40 rows; depends on Should #1 to amortise the `@tanstack/react-virtual` dep.
- **C6 — Waveform memoisation** → BACKLOG Could #25. Low real-world impact today.
- **A1 — Parallel chapter synthesis** → plan 87 (parallel branch).
- **B1 — Per-phase analyzer model** → plan 88 (parallel branch).

## Ship notes

Shipped **2026-05-21** via PR [#104](https://github.com/dudarenok-maker/AudioBook-Generator/pull/104), merged at `9ffb79b`. All three sub-items (C2/C3/C5) landed as planned.

- **C2 (broadcast diffing):** `src/store/broadcast-middleware.ts` shallow-diffs `activeStream` snapshots + debounces phaseProgress-only ticks. Test suite grew 13 → 22.
- **C3 (selector equality):** new `useAppSelectorShallow` in `src/store/index.ts`. Applied at five sites: `src/views/listen.tsx:122`, `src/components/layout.tsx:82`, `src/components/layout.tsx:83`, `src/components/layout.tsx:480`, `src/routes/index.tsx:497`.
- **C5 (route code-split):** `React.lazy` views via `src/routes/index.tsx`, single shared Suspense fallback in the layout shell with a 150 ms delay (`src/components/delayed-spinner.tsx`, new). `vite.config.ts` `manualChunks`. `src/components/stat-tiles.tsx` extracted to break an eager-import anchor from `library-chrome.tsx`/`library-grid.tsx`.
- **Build delta:** main bundle 410 kB → 345 kB (gzip 108 kB → 91 kB); per-view chunks ≤70 kB gzipped each.
- **Tests:** 1,371 frontend unit + 1,211 server + 2 new Playwright specs (`e2e/route-lazy.spec.ts`, `e2e/concurrent-multi-book.spec.ts`) all green.

Plan 63 narrow-scope BroadcastChannel rule preserved: broadcast action allowlist unchanged; diff scope strictly inside `activeStream`. Narrow-scope test cases (per-chapter row, inbound `applyExternal*` reducer) still red-line non-broadcast behaviour.

One pre-existing intermittent `Worker exited unexpectedly` flake in `test:server` exists on `main` — verified via stash-round-trip during this round; caught + re-ran cleanly so verify cache stayed green. Tracked as part of **BACKLOG Should #3** (the broader pre-push gate de-flake work).

### Follow-up — GenerationView chunk prefetch (2026-05-26, PR #246 `ba3c855`)

C5's lazy boundary meant the Generate view's chunk only began downloading on first navigation to it. Under a heavy generation run the main thread is busy, so that cold download stretched the route Suspense fallback into a multi-second "Loading…" — read as a stall. Fix: proactively warm the Generate chunk so it's resolved before navigation.

- **`src/routes/prefetch.ts` (new):** `importGenerationView = () => import('../views/generation')` — the single dynamic-import specifier shared by both the `React.lazy` def in `src/routes/index.tsx` and the prefetch, so Vite warms the exact chunk the route awaits.
- **`src/components/layout.tsx`:** a one-shot `useEffect` (ref-guarded) fires `importGenerationView()` once the user is inside a book (`stageKind === 'ready'`) OR any generation stream is live (`activeStreams.length > 0`). `import()` is idempotent, so warming is free if the chunk already loaded.
- **C5 invariant preserved:** the view stays lazy (no eager-import bloat on the library landing route); only the _download timing_ moves earlier. Behaviourally invisible — the view renders identically.
- **Tests:** `src/routes/prefetch.test.ts` locks that the shared thunk resolves the `GenerationView` module (a path typo would silently no-op the prefetch). No new e2e — the Generate view's load/render seam is already covered (`e2e/responsive/coverage.spec.ts`, `e2e/generation-parallel.spec.ts`, `e2e/queue-modal.spec.ts`), and the optimization is load-timing, which CI (warm chunks) can't observe deterministically.
