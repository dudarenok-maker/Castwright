---
status: active
shipped: null
owner: null
---

# Confirm-cast + Listen chapter-list virtualisation

> Status: active
> Key files: `src/views/confirm-cast.tsx`, `src/components/listen/listen-player-region.tsx`, `src/views/confirm-cast.test.tsx`, `src/components/listen/listen-player-region.test.tsx`
> URL surface: `#/books/<id>/confirm` (cast picker), `#/books/<id>/listen` (chapter list)
> OpenAPI ops: none (purely client-side render perf)

## Benefit / Rationale

- **User:** Confirm-cast picker for a 40+ character book stops mounting every row at once — no jank on chapter / book switch. Listen-view's chapter list scrolls smoothly even on novels with 60+ chapters. Below the per-view threshold (40 rows) nothing changes for the median user.
- **Technical:** Reuses the `@tanstack/react-virtual` dep that plan 92 added — no new dep cost, no extra bundle bytes beyond what manuscript already imports.
- **Architectural:** demonstrates both shapes of the virtualizer pattern in one diff:
  - `useWindowVirtualizer` for the confirm-cast list (page-scroll architecture, like manuscript view).
  - `useVirtualizer` with `getScrollElement` for the listen chapter list (internal `max-h-[560px] overflow-y-auto` scroll container).
  Subsequent virt callers can pick whichever shape matches their scroll context.

## Architectural impact

- **New seams / extension points**:
  - `confirm-cast-virtual-container` `data-testid` on the windowed-render wrapper in `confirm-cast.tsx`. Public test hook.
  - `listen-chapters-virtual-container` `data-testid` on the windowed-render wrapper inside the existing `listen-chapters-scroll` element. Public test hook.
  - Soft thresholds inlined as `40` in both files. Not a tunable knob today; future virt callers pick their own per-view threshold.
  - `CharacterList` helper component extracted from `ConfirmCastView` — encapsulates the virt setup so the parent stays focused on the confirmation flow.
- **Invariants preserved**:
  - All existing `ConfirmCharacterCard` props + behaviour unchanged. Library-override checkbox, decision tile, match pill all still render the same way.
  - Listen `ChapterListenRow` props + key (`ch.id`) preserved on the flat path. The virtual path uses `virtualItem.key` because each row's `<div>` wrapper is the React-keyed element.
  - The internal scroll container's `data-testid="listen-chapters-scroll"` selector still resolves (e2e specs rely on it). Now also carries a ref.
- **Migration story**: none. No state shape changes, no API contract changes, no on-disk format changes.
- **Reversibility**: revert the PR. Each virtualizer is local to its file; no downstream code depends on the new wrappers.

## Invariants to preserve

- The threshold is **40 rows**, defined inline in both `src/views/confirm-cast.tsx` (`const virtualEnabled = characters.length >= 40`) and `src/components/listen/listen-player-region.tsx` (`const chapterVirtEnabled = listenable.length >= 40`). Changing it requires updating the matching threshold test fixtures (each test file's "Plan 93" block uses 20 + 60).
- Confirm-cast uses `useWindowVirtualizer` because the page scroll is the relevant scroll surface; listen-chapter uses `useVirtualizer` with `getScrollElement` because the chapter list scrolls internally inside `max-h-[560px]`. Don't flip without a layout refactor.
- `useWindowVirtualizer` / `useVirtualizer` are always called (no early return) — React hook order must stay stable across renders. The threshold gates the `count` prop, not the hook call site.
- Confirm-cast's `<div ref={listRef}>` measures `scrollMargin` from `getBoundingClientRect().top + window.scrollY` on `useLayoutEffect`. If you move the list inside an internal scroll container, switch to `useVirtualizer` and pass the container ref to `getScrollElement` (no scrollMargin needed in that path).
- Listen's chapter virtualizer uses default `estimateSize: () => 88` matching the median `ChapterListenRow` height (avatar + title + 16px row padding). If `ChapterListenRow` grows taller, bump the estimate to reduce visible re-flow on first render.
- `overscan: 5` rows above + below the viewport keeps neighbouring rows in the DOM. Don't reduce below 3 without re-pinning interaction behaviour (e.g. focus traversal between rows expects the next row to exist).

## Test plan

### Automated coverage

- **Vitest** (`src/views/confirm-cast.test.tsx`) +2 cases:
  - "renders the flat character list below the 40-row threshold" — 20 characters → no virtual container.
  - "switches to the virtualised container at or above the threshold" — 60 characters → virtual container present.
- **Vitest** (`src/components/listen/listen-player-region.test.tsx`) +2 cases:
  - "renders the flat chapter list below the 40-row threshold" — 20 chapters → no virtual container.
  - "switches to the virtualised container at or above the threshold" — 60 chapters → virtual container present.
- **Playwright** (existing `e2e/responsive/coverage.spec.ts`): confirm-cast + listen views still render at all three viewports under the no-horizontal-overflow assertion. Threshold-gated paths exercised under mocks because Solway Bay has < 40 rows.

### Manual acceptance walkthrough

Run `npm run dev` in mock mode (`VITE_USE_MOCKS=true`).

1. Open `http://localhost:5173/#/books/sb/confirm`. Solway Bay's < 40 characters → flat render.
2. Open `http://localhost:5173/#/books/sb/listen`. Same — flat render.
3. Inject 60 synthetic characters via DevTools console: `__store__.dispatch({ type: 'cast/setCharacters', payload: Array.from({length: 60}, (_, i) => ({ id: 'c' + i, name: 'Char ' + i, role: 'Lead', color: 'slot-4', voiceState: 'generated' })) })`. The Confirm view (visit `#/books/sb/confirm` to see) now renders the virtualised wrapper; only ~10–20 rows in DevTools Elements panel.
4. For listen-chapter: stress with a book that has 60+ chapters by uploading a long book, OR inject via `__store__.dispatch({ type: 'chapters/setChapters', ... })`. Verify smooth scroll within the `max-h-[560px]` chapter list.
5. Chrome DevTools Performance: scroll through a 60+ row list — no scripting blocks > 50 ms.

## Out of scope

- **Waveform memoisation** (Backlog Could #25) — deferred; low impact.
- **Other view-list virtualisation candidates** (Generation view chapter list, Voice library, Changelog) — apply the same pattern if they hit per-view perf gaps. Not in scope today.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any
behaviour delta vs. the original spec.)
