---
status: stable
shipped: 2026-05-27
owner: null
---

# Cast table sort — by line count, unknown buckets last

> Status: stable
> Key files: `src/views/cast.tsx`
> URL surface: `#/books/<id>/cast`
> OpenAPI ops: none

## Benefit / Rationale

- **User:** the cast table reads most-important-first — characters sort by their
  line count descending, so the narrator and leads sit at the top and walk-on
  parts fall to the bottom. The two generic minor-cast buckets (`Unknown male` /
  `Unknown female`) always pin to the very bottom regardless of their pooled
  line count, so they never crowd out named characters at the top.
- **Technical:** pure display ordering — `compareCastRows` sorts a filtered copy
  inside `CastView`; the store / prop order is never mutated, so selection,
  compare, and `setCharacters` mutations (all keyed by id) are unaffected.
- **Architectural:** the sort lives behind one exported comparator with no new
  state or props, so both the desktop grid and the mobile card list (which both
  iterate the same `filtered` array) get the order for free.

## Architectural impact

- **New seam:** `compareCastRows(a, b)` exported from `src/views/cast.tsx` —
  the single ordering rule, unit-testable in isolation.
- **Invariants preserved:** the comparator runs on the result of `.filter()`
  (a fresh array), never on the `characters` prop, so store order is untouched.
  The `unknown-male` / `unknown-female` ids match the canonical server buckets
  (`server/src/analyzer/fold-minor-cast.ts:95-96`).
- **Migration story:** none — display-only, no data shape change.
- **Reversibility:** drop the `.sort(compareCastRows)` call and the helper;
  rows fall back to prop order.

## Invariants to preserve

1. `UNKNOWN_BUCKET_IDS` in `src/views/cast.tsx` is exactly
   `{ 'unknown-male', 'unknown-female' }` — kept in sync with
   `MALE_BUCKET_ID` / `FEMALE_BUCKET_ID` in `server/src/analyzer/fold-minor-cast.ts`.
2. Sort order: bucket rows last; otherwise line count descending; ties broken by
   `name.localeCompare` (stable). A missing `lines` counts as 0.
3. The sort is applied to `filtered` (post-search-filter copy) in `CastView`, not
   to the `characters` prop or the cast slice.

## Test plan

### Automated coverage

- Vitest unit (`src/views/cast.test.tsx`, `describe('compareCastRows — cast table ordering')`)
  — sorts by line count descending; pins both unknown buckets last regardless of
  line count; orders the two buckets between themselves by line count; breaks
  line-count ties by name ascending; treats a missing line count as zero.
- Vitest unit (`src/views/cast.test.tsx`, `describe('CastView row ordering — wired into render')`)
  — renders the desktop rows in line-count-desc order with the unknown bucket last,
  proving the comparator is wired into the rendered grid (input order ≠ sorted order).

### Manual acceptance walkthrough

1. **`#/books/<id>/cast`** (mock mode) → the character rows read top-to-bottom by
   descending line count; the narrator/leads sit at the top.
2. A book whose roster includes `Unknown male` / `Unknown female` → both buckets
   appear at the very bottom of the list even when their pooled line count exceeds
   some named characters above them.
3. Type into the search box → the filtered subset stays sorted by the same rule.

## Out of scope

- A user-toggleable sort column / direction picker — the order is fixed.
- Re-sorting the Voices view or Generation view rosters — this plan only touches
  the cast table.

## Ship notes

Shipped 2026-05-27 on branch `feat/frontend-cast-sort-by-lines`. Added the
`compareCastRows` comparator + `UNKNOWN_BUCKET_IDS` set to `src/views/cast.tsx`
and applied `.sort(compareCastRows)` to the post-filter `filtered` array (feeds
both the desktop grid and the mobile card list). Paired Vitest unit + render-order
coverage in `src/views/cast.test.tsx`. No behaviour delta vs. the request.
