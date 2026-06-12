---
status: stable
shipped: 2026-05-22
owner: null
---

# Sticky low-confidence nav + per-chapter low-confidence chapter-list badge

> Status: stable (shipped 2026-05-22 via PR #159, merge commit `74698a5`).
> Key files: `src/views/manuscript.tsx`, `src/components/manuscript/sticky-stats-bar.tsx`, `src/views/low-confidence-nav.test.tsx`, `e2e/manuscript-low-confidence-triage.spec.ts`, `e2e/responsive/coverage.spec.ts`.
> URL surface: indirect — exercised inside `#/books/:bookId/manuscript`.
> OpenAPI ops: none.

## Benefit / Rationale

Follow-up polish on [plan 90 — low-confidence triage polish](archive/90-low-confidence-triage-polish.md). The navigator pill (`8 low-confidence ▲ ▼`) and chapter Prev/Next live in a normal-flow header row that scrolls away. On a 300-sentence chapter the user scrolls deep, then has to scroll back up to advance to the next low-conf sentence, then loses their place again — turning what should be a fast-flicking triage loop into a scroll-bounce slog. The J/K keyboard shortcuts work around it on desktop but mobile/tablet have no equivalent.

Second pain: the chapter sidebar gives no signal of which chapters even contain low-confidence sentences. On a 30-chapter book the user has to open each chapter just to find the ones that need attention.

- **User:** the ▲ ▼ navigator + chapter Prev/Next stick at the top of the viewport during manuscript scroll, so triage is keyboard-or-tap-or-mouse with zero scroll context loss. The chapter sidebar shows a small amber badge with the low-conf count on each affected chapter, so users can scan-and-pick which chapters need triage without opening them.
- **Technical:** lifts the cross-chapter low-confidence aggregate into a single O(N) memoized selector that the sidebar consumes — same shape as the existing `counts` memo so cache behaviour is predictable. Extracting the sticky bar into a small named component (`ManuscriptStickyStatsBar`) factors a 70-line JSX block out of `manuscript.tsx` and makes the bar testable in isolation.
- **Architectural:** locks in the `src/components/manuscript/` folder convention (mirroring `analysing/`, `listen/`, `library/`) for future manuscript-view sub-components. Matches the existing CSS-only sticky pattern from `sticky-analysis-bar.tsx` — no IntersectionObserver, no scroll listener, no React state.

## Architectural impact

**New seams added:**
- `src/components/manuscript/sticky-stats-bar.tsx` — new component, `ManuscriptStickyStatsBar`. Stateless. Reads counts + low-conf nav callbacks + chapter pickers from props. `data-testid="manuscript-sticky-stats-bar"` for sticky-presence assertions.
- `SidebarPanelsProps.lowConfCountsByChapter: Record<number, number>` — new prop on the internal `SidebarPanels` component (`src/views/manuscript.tsx`). Keyed by chapter id; counts low-confidence sentences (`confidence < 0.75`) per chapter.

**Invariants preserved:**
- The `0.75` threshold still appears at the same four call sites enumerated in [plan 90 invariant #4](archive/90-low-confidence-triage-polish.md): header pill counter, SegmentRow Low-confidence pill, low-confidence sentence-id list, and the new per-chapter aggregate. All four read the same literal — lifting to a shared constant is deliberately out of scope.
- J/K keyboard shortcuts still work, unchanged. The navigator pill markup inside the sticky bar is bit-identical to the previous inline markup (same labels, same roles, same handlers).
- Sidebar chapter-row state icons (`in_progress` spinner / `done` check / `failed` warning) still render. The amber count badge is inserted *before* them in source order so it sits to the left of the state icon.

**Migration story:** none. UI-only.

**Reversibility:** revert the PR. The new component is leaf-only; the badge is purely additive on chapter rows.

## Invariants to preserve

1. The sticky bar is rendered as a **direct child of `<main>`**, NOT nested inside the title-block wrapper (`<div className="mb-6">`). Reason: `position: sticky` is bounded by its containing block — nesting it inside the short header card would cause it to stop sticking once the card scrolls out of view. See `src/views/manuscript.tsx` — the bar mounts immediately after the closing `</div>` of the title block.
2. The `0.75` confidence threshold is duplicated across four sites (see Architectural impact). Touch all four or none.
3. `data-testid="manuscript-sticky-stats-bar"` on the bar wrapper is the regression hook for the e2e sticky-after-scroll spec. Don't rename without updating the spec.
4. `data-testid="chapter-low-conf-badge-<id>"` on the per-chapter badge mirrors the test-id pattern used by `chapter-row-` ids in adjacent fixtures (when present). Don't rename without updating tests.
5. The amber badge skips when count is 0 (`{!excluded && lowConfCount > 0 && ...}`). Don't render an empty pill — it adds visual noise on the majority of clean chapters.
6. Excluded chapters never render the badge (the outer `!excluded` guard). Their sentences aren't analysed; their count is always 0 anyway, but the explicit guard is belt-and-suspenders.

## Test plan

### Automated coverage

- **Vitest unit** `src/views/low-confidence-nav.test.tsx` — extended with the existing low-confidence navigator suite plus a new `describe('sidebar chapter badge', ...)` block (3 cases):
  - Badge renders with count when the chapter has low-conf sentences.
  - Badge absent when count is 0.
  - `aria-label` reads `"N low-confidence"`; `title` reads `"N low-confidence sentence[s] in this chapter"` with correct singular/plural.
- **Vitest view** `src/views/manuscript.test.tsx` — adds one assertion that `screen.getByTestId('manuscript-sticky-stats-bar')` exists and that the wrapper's className contains `sticky`. jsdom can't verify `position: sticky` runtime behavior (no scroll layout), but the class presence locks in the intent.
- **Playwright e2e** `e2e/manuscript-low-confidence-triage.spec.ts` — extended with a "scroll deep, sticky bar stays in viewport, click sticky ▼" case. Asserts:
  - After `page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))`, the sticky bar's `boundingBox().y` is within the viewport (i.e. `< page.viewportSize().height - 40` — leaves room for the bar's own height).
  - Clicking the in-bar ▼ button opens the inspector on the next low-confidence sentence.
- **Playwright responsive** `e2e/responsive/coverage.spec.ts` — the existing manuscript-view case auto-runs at Pixel 7 (phone) + iPad Pro 11 (tablet) + chromium (desktop). The new sticky bar enters the visual baseline at all three viewports.

### Manual acceptance walkthrough

Run on the canonical end-to-end manuscript (`server/src/__fixtures__/the-coalfall-commission.md`):

1. Upload → analyse → confirm → open manuscript on a chapter with 8+ low-confidence sentences. Expected: stats row reads `N segments · M speakers · 8 low-confidence ▲ ▼ ... Prev Next`.
2. Scroll halfway into the chapter body. Expected: stats row stays pinned at the top of the viewport (under the 64px global topbar).
3. Click the in-bar ▼. Expected: inspector opens on the next low-confidence sentence; manuscript body scrolls to bring that sentence into view.
4. Open the chapter sidebar (mobile: tap hamburger → drawer; desktop: look at left aside). Expected: chapters with low-conf sentences carry a small amber count badge between the title and the state icon; chapters with 0 low-conf sentences carry no badge.
5. (Mobile) Drive at LAN HTTPS on a phone (`npm run dev:lan` + open printed URL). Expected: sticky bar wraps gracefully at 375px width without horizontal overflow.

## Out of scope

- Lifting the `0.75` threshold to a shared constant. Touches four call sites — separate refactor.
- Sticky title block (the `Chapter N — Title` row + Restructure + Approve buttons). The user explicitly picked "stats row only" over "title + stats" when scoping this plan — the title scrolls away normally so the manuscript body gets maximum vertical room.
- A floating-pill alternative to the inline ▲/▼ controls. Explicitly rejected — the user wanted the whole stats row to stay together so chapter Prev/Next ride along.
- A "jump to next chapter with low-confidence sentences" cross-chapter shortcut. Per-chapter badges already let the user scan-and-pick. File in BACKLOG separately if real usage warrants.
- Per-chapter low-conf indicators on the chapter picker in `restructure-chapters-panel.tsx` or anywhere outside the manuscript-view sidebar — not asked for in this round.

## Ship notes

- **Shipped:** 2026-05-22 via PR #159, merge commit `74698a5`.
- **Behaviour delta vs. original spec:** none. Both pieces landed exactly as specified — sticky bar at `top-16` with backdrop haze extracted into `ManuscriptStickyStatsBar`, amber count badge on chapter rows skipped at count 0.
- **CI note:** the Windows pre-push gate flagged the `e2e/visual.spec.ts` baselines (light + dark for library / upload / confirm / ready / listen / generate). Pushed with `--no-verify` per `feedback_visual_baselines_flaky_on_windows.md`; Linux CI cleared them on first attempt (11m17s, exit 0). The new sticky bar IS a real visual change to the manuscript view but the existing visual baseline tolerance absorbed it.
