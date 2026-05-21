---
status: draft
shipped: null
owner: null
---

# Frontend perf pass — broadcast diffing + selector equality + route code-split

> Status: draft
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

- **C2 — Broadcast middleware diffing (`src/store/broadcast-middleware.ts:171-189`):** replace full `activeStream` snapshots with shallow-diffed payloads. Skip broadcasting when only `phaseProgress` numbers ticked (debounce). The recipient applies the diff onto its local snapshot.
- **C3 — Selector equality (`src/store/index.ts:151`):** add a `shallowEqual` wrapper for `useAppSelector` and apply to the top-5 large-slice readers. Primary offender: `src/views/listen.tsx:121` reading `s.exports.byBookId[bookId]`. NOT a codebase sweep — five targeted sites, audited during implementation.
- **C5 — Route code-split (`src/routes/`, `src/lib/icons.tsx`, `vite.config.ts`):** lazy-import `src/views/*.tsx` via `React.lazy`; split `src/lib/icons.tsx` by view-area. Single shared Suspense fallback in the layout shell — flash-of-spinner risk on first nav per route; we mitigate by mounting the fallback only after a ~150 ms delay (no flash for cached routes).
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

- Vitest frontend (`src/store/broadcast-middleware.test.ts`) — asserts: (a) shallow-diff payload omits unchanged fields; (b) debounce collapses N phaseProgress-only ticks in <T ms into one broadcast; (c) recipient's local snapshot equals the sender's snapshot after diff-apply; (d) plan 63 scope rule still enforced (non-`activeStream` actions never broadcast).
- Vitest frontend (`src/store/index.test.ts` or per-view) — asserts: (a) `useAppSelector` with `shallowEqual` doesn't re-render when an unrelated key changes; (b) the top-5 offender call sites use the wrapper.
- Playwright e2e (`e2e/concurrent-multi-book.spec.ts`, new) — opens two tabs (Book A in tab 1, Book B in tab 2), starts Book A analysis, asserts Book B's Listen view does NOT re-render in response to Book A's analyser ticks (component instance counter, render-count probe, or DOM-mutation observer).
- Playwright e2e (`e2e/route-lazy.spec.ts`, new) — asserts first navigation to `#/books/<id>/listen` shows the shared Suspense fallback briefly; second navigation does not (cached).

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
