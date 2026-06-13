---
status: active
shipped: null
owner: null
---

# Manuscript view virtualisation

> Status: active
> Key files: `src/views/manuscript.tsx`, `package.json`, `e2e/manuscript-virtualisation.spec.ts`, `src/views/manuscript.test.tsx`
> URL surface: `#/books/<id>/manuscript`
> OpenAPI ops: none (purely client-side render perf)

## Benefit / Rationale

- **User:** boundary-drag jank and chapter-switch lag above ~300 sentences (backlog Should #1, "the frontend's worst offender") no longer pin the main thread. The view stays responsive at any chapter length. Behaviour-preserving — every interaction the user had before still works, just on a windowed DOM.
- **Technical:** for a 300-sentence alternating-character chapter, sentence rows in the DOM drop from ~300 (one per sentence) to ~20–40 (visible + overscan window) under a desktop viewport. The cost is one new dep (`@tanstack/react-virtual`) and a soft threshold gate (`segments.length >= 60`) so the flat-render path stays for short chapters where windowing is pure overhead.
- **Architectural:** introduces the `useWindowVirtualizer` pattern (windowed render against the document scroll, not an internal scroll container — preserves the current page-flow architecture) that the list-virt branch (plan 93, confirm-cast + listen chapter list) immediately reuses. Same dep, same idiom, same scroll model.

## Architectural impact

- **New seams / extension points**:
  - `@tanstack/react-virtual` dep, version `^3.13.25`. Consumed by `useWindowVirtualizer` in `src/views/manuscript.tsx`. Same hook can be imported by `src/views/confirm-cast.tsx` and `src/components/listen/listen-player-region.tsx` in plan 93.
  - `manuscript-virtual-container` `data-testid` on the windowed-render wrapper — public surface for tests + future affordances that need to know when virtualisation is engaged.
  - Soft threshold constant inlined as `60` in `manuscript.tsx`. Not a tunable knob today; if other surfaces want a different threshold they pick their own.
- **Invariants preserved**:
  - Boundary-drag PointerEvent path (`onBoundaryPointerDown` + the window `pointermove`/`pointerup` listeners at `manuscript.tsx:332-363`) is untouched. `document.elementFromPoint()` works against whatever is in the visible DOM at the moment of the move — the windowed render keeps a buffer (overscan: 5) around the visible viewport, so adjacent sentences are always present when the user is dragging.
  - `data-sentence-id` + `data-sentence-idx` attributes still emitted on every rendered sentence span; only off-screen rows are missing from the DOM.
  - `jumpToLowConfidence` (J/K shortcut + ▲/▼ pill) updated to call `virtualizer.scrollToIndex(segIdx, { align: 'center' })` first when virtualisation is active; the existing `scrollIntoView` runs on the next animation frame to refine to the specific sentence span. Below the threshold the existing direct `scrollIntoView` path applies.
  - All existing manuscript Vitest cases stay green (10 original tests + 2 new threshold-pinning cases).
- **Migration story**: none. No state shape changes, no on-disk format changes, no API contract changes. Lazy in the sense that a manuscript with fewer than 60 segments behaves identically to today.
- **Reversibility**: revert the PR. The virtualizer is a leaf concern in one file plus one dep; no downstream code depends on the new wrapping div or the testid.

## Invariants to preserve

- The threshold is **60 segments**, defined inline in `src/views/manuscript.tsx` (`const virtualEnabled = segments.length >= 60`). Below it, the flat `segments.map((seg, segIdx) => <Fragment key={seg.id}>...</Fragment>)` render runs verbatim. Above it, the windowed render takes over. Changing the threshold may require updating both the Vitest threshold test (`src/views/manuscript.test.tsx` "Plan 92" block — uses 20 + 120 fixtures) and the e2e (`e2e/manuscript-virtualisation.spec.ts` — uses 200).
- `useWindowVirtualizer` is configured with `scrollMargin` measured from `articleRef.current.getBoundingClientRect().top + window.scrollY` on `useLayoutEffect`. The remeasure deps are `[currentChapterId, segments.length]` plus a `resize` listener. If the article's `offsetTop` source changes (e.g. a new sticky header), update the measurement path in lockstep — wrong scrollMargin produces visually-correct render but broken `scrollToIndex` targeting.
- `useWindowVirtualizer` is always called (no early return) — React hook order must stay stable across renders. The threshold gates `count: virtualEnabled ? segments.length : 0`, not the hook call site.
- Boundary drag's `elementFromPoint` only finds sentences that are in the DOM. Overscan: 5 segments above + below the visible window. If overscan is reduced and the user drags slowly past the buffer, the drag will lose its candidate-sentence target. Don't reduce overscan below 3 without re-pinning the drag e2e.

## Test plan

### Automated coverage

- **Vitest** (`src/views/manuscript.test.tsx`):
  - "renders the flat segment list below the 60-segment threshold (no virtual container)" — 20 alternating-character sentences → 20 segments → flat render → `manuscript-virtual-container` testid absent.
  - "switches to the virtualised container above the threshold" — 120 alternating-character sentences → 120 segments → virtualised wrapper present.
- **Playwright e2e** (`e2e/manuscript-virtualisation.spec.ts`):
  - "14-sentence Solway Bay chapter renders flat (below the threshold)" — real-browser counterpart of the unit test's flat case.
  - "200 alternating-character sentences engage the virtualizer and keep only a windowed subset in the DOM" — dispatches a synthetic 200-sentence payload via `window.__store__.dispatch(manuscript/hydrateFromBookState)`, asserts the virtual container appears AND the DOM has fewer than 60 `[data-index]` children (the perf invariant — windowed render, not "render all").

### Manual acceptance walkthrough

Run `npm run dev` in mock mode (`VITE_USE_MOCKS=true`, on by default in `.env.development`).

1. Open `http://localhost:5173/#/books/sb/manuscript`. Solway Bay's chapter 3 has 14 sentences → flat render. Boundary drag works as today.
2. Replace the mock manuscript fixture in `src/data/sentences.ts` with a 300+ sentence chapter (or load the canonical Marlow manuscript referenced in CLAUDE.md). The view should render quickly, scroll smoothly, and surface only a small windowed subset of sentence rows in the Elements panel of DevTools.
3. Drag a boundary handle past several segments — the handle stays attached to the pointer; candidate sentence detection still highlights the right row as you scroll.
4. Press `J` repeatedly to jump through low-confidence sentences. Each jump scrolls the target sentence into the centre of the viewport even when the source row was hundreds of segments away.
5. Chrome DevTools Performance panel: record a boundary-drag interaction in a 500-segment chapter. No scripting blocks > 50 ms; FPS stays >= 30 throughout the drag.

## Out of scope

- **Confirm-cast + Listen chapter list virtualisation** (Backlog Could #24) — separate branch (plan 93). Same `useWindowVirtualizer` dep; smaller threshold (~40 rows) because those lists have less DOM per row.
- **Waveform memoisation** (backlog `fe-6`) — deferred; low impact today.
- **Internal-scroll-element virtualisation** — keeping the page-scroll architecture so `useWindowVirtualizer` is the right fit. If the manuscript view ever moves to an internal scroll container, switch to `useVirtualizer` and pass the container ref to `getScrollElement`.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any
behaviour delta vs. the original spec.)
