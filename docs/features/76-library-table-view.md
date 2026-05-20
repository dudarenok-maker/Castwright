---
status: stable
shipped: 2026-05-20
owner: null
---

# Library card↔table view toggle with series-grouped table

> Status: stable
> Key files: `src/views/book-library.tsx`, `src/components/library/library-chrome.tsx`, `src/components/library/library-table.tsx`, `src/components/library/library-grid.tsx`, `src/components/library/library-status-ui.tsx`, `src/components/library/library-empty-states.tsx`
> URL surface: `#/` (books library — no new routes; persisted UI preference only)
> OpenAPI ops: none (purely client-side rendering choice)

## Benefit / Rationale

- **User:** card grid breaks down at 10+ books in a single view — a dense, series-grouped table makes a long library scannable at a glance (title / status / runtime / last-worked-on visible per row without hover or scroll). Toggle persists across reloads so the choice sticks for the user's workflow.
- **Technical:** zero changes to the `LibraryBook` data shape; behaviour parity with cards is total because the table reuses the same `onOpenBook` / `onEditBook` / `onReparseBook` / `onDeleteBook` / `onCoverChanged` callbacks the grid already wires.
- **Architectural:** establishes a precedent for additional library presentations (a future "compact list" or "grouped-by-status" view drops in next to `LibraryGrid` / `LibraryTable` without changes to the orchestrator's filter or persistence shape). Also extracts the shared `STATUS_UI` map + empty-state renderers into their own modules so they're no longer trapped behind the grid file's BookCard internals.

## Architectural impact

- **New seams added:**
  - `src/components/library/library-status-ui.tsx` — `STATUS_UI` map (`Record<LibraryBookStatus, StatusMeta>`) lifted from `library-grid.tsx`. Both grid and table import it.
  - `src/components/library/library-empty-states.tsx` — `EmptyLibrary` / `LibrarySkeleton` / `NoFilterMatch` lifted from `library-grid.tsx`. Grid's existing branches keep using the first two; table adds the third for the "library has authors but every series is empty after the filter" case.
  - `src/components/library/library-table.tsx` — new region component, mirrors the prop contract of `library-grid.tsx` so the orchestrator picks one or the other off the `viewMode` switch.
  - `LibraryViewMode` type (exported from `library-chrome.tsx`) — `'card' | 'table'`.
- **Invariants preserved:**
  - The card grid's render output is byte-for-byte unchanged. The only edit to `library-grid.tsx` is the import lift (STATUS_UI + EmptyLibrary + LibrarySkeleton now imported from the shared modules) — no JSX or markup changed.
  - The orchestrator's filter logic, totals memo, and the `LibraryAuthor` → series → books traversal stay identical. The viewMode switch is a single ternary at the render site.
- **Migration story:** none — `LibraryBook` shape is untouched. localStorage key (`library.viewMode`) is read with a permissive try/catch so storage-unavailable environments (Safari private mode, sandboxed iframes) fall back to the default ('card') without throwing.
- **Reversibility:** delete `library-table.tsx`, drop the conditional in the orchestrator, drop the toggle in `library-chrome.tsx`. The shared status/empty-state modules can stay or roll back into `library-grid.tsx`.

## Invariants to preserve

1. **`LibraryGrid` render output is unchanged from before this plan** — `src/components/library/library-grid.tsx` only lost the inline `STATUS_UI`/`EmptyLibrary`/`LibrarySkeleton` definitions; all JSX paths are identical.
2. **`STATUS_UI` covers every `LibraryBookStatus`** — locked by `src/components/library/library-status-ui.test.ts`. The map is `Record<LibraryBookStatus, …>` so a missing key wouldn't compile, but the round-trip test catches an accidental Partial declaration.
3. **`viewMode` defaults to `'card'`** when localStorage is unavailable, empty, or holds an unrecognised string. `readStoredViewMode` in `src/views/book-library.tsx` is the gate; `book-library.test.tsx` "falls back to card view when localStorage value is garbage" pins it.
4. **localStorage I/O is `try`-wrapped** — `readStoredViewMode` and `writeStoredViewMode` in `src/views/book-library.tsx` swallow any DOMException from disabled / unavailable storage. In-memory state still tracks the toggle; persistence just won't survive reload.
5. **Series grouping** — `library-table.tsx`'s `useMemo` collects all `isStandalone` books across every author into one synthetic group with id `'__standalones__'` at the bottom of the list. Per-author non-standalone series stay separated by `${author.name}::${series.name}` ids.
6. **Per-row callbacks fire the same handlers as the cards** — `onOpenBook`, `onEditBook`, `onReparseBook`, `onDeleteBook`, `onCoverChanged`. The kebab menu uses the same `ConfirmDialog` + `EditBookMetaModal` + `CoverPicker` pieces.

## Out of scope

- **Column sort / column resize / density toggle.** v1 ships a single fixed column order with no user customisation. Backlog item if user demand surfaces.
- **Per-series collapse persistence.** The table's expand/collapse state lives in component-local `useState`; navigating away and back resets to "all expanded". A localStorage key per-series-id is the natural extension when users complain.
- **Mobile-first responsive table.** The table assumes desktop widths (~1100 px+). Smaller viewports horizontal-scroll. A mobile-first re-layout (e.g. one card-per-row on narrow screens regardless of view-mode) is a separate plan.
- **Per-column header click → sort.** Same reason as the first bullet — explicit follow-up.
- **Row selection / multi-select operations.** No bulk operations in v1 from this surface (cards don't expose them either).

## Note on net-new BACKLOG entry

This feature came in **mid-planning as a net-new requirement** — the user added it after the original Bundle B was scoped. Per `feedback_capture_netnew_in_backlog`, net-new items normally require a Round-0 docs PR before code lands; the user explicitly approved bundling the BACKLOG entry into this PR. The entry is appended to the bottom of the Could bucket in `docs/BACKLOG.md` with a "shipped in plan 76" close-out note so future-you sees the for-the-record provenance.

## Test plan

### Automated coverage

- Vitest unit (`src/components/library/library-status-ui.test.ts`) — every `LibraryBookStatus` key resolves to a non-empty label + icon + colour; failure statuses → `danger`; complete → `success`.
- Vitest unit (`src/components/library/library-table.test.tsx`) — series grouping correctness (multi-series author renders both); standalones from every author collected into a single "Standalones" pseudo-section; standalones group absent when no standalones survive the filter; series-position prefix appears in the title column for non-standalone rows; row click → `onOpenBook`; kebab click does NOT fire `onOpenBook`; collapse/expand round-trip; Delete confirm dialog → `onDeleteBook`; Edit modal opens from the kebab; "Open" pill appears on `activeBookId` match.
- Vitest unit (`src/views/book-library.test.tsx`, new sub-describe "view-mode toggle (plan 76)") — toggle is present; defaults to card when storage empty; clicking Table swaps the visible tree (h2 disappears, table row appears); localStorage round-trip across both directions; persisted value seeds on mount; garbage value falls back to card.
- Playwright e2e (`e2e/library-table-view.spec.ts`) — Cards default; click Table → row visible + series header visible; click row → `#/books/sb/listen` route; reload → table mode persists; click Cards → table rows hidden.

### Manual acceptance walkthrough

1. **Cold boot at `#/`** with localStorage empty → expected UI: card grid, Cards pill in the right-aligned toggle is highlighted.
2. **Click Table** → expected UI: dense table replaces the card grid; each series gets a header row; standalones bucket under "Standalones" at the bottom. Toggle pill flips to highlight Table.
3. **Refresh the browser** → expected UI: same view re-mounts in table mode (persisted via `library.viewMode = 'table'`).
4. **Click a series-header chevron** → expected UI: that series collapses to header only; click again expands.
5. **Click a row anywhere outside the kebab** → expected URL: `#/books/<id>/listen` (the same handler the card click fires).
6. **Click the kebab → Edit details** → expected UI: EditBookMetaModal mounts. Close it → expected UI: row still in place, no navigation fired.
7. **Click Cards** → expected UI: card grid returns. `localStorage.getItem('library.viewMode')` now reads `'card'`.

## Ship notes

- **Shipped:** 2026-05-20 on branch `feat/frontend-library-table-view`.
- **Net-new requirement:** Feature arrived mid-planning (user dropped it into Bundle B post-scope). BACKLOG entry appended to the bottom of the Could bucket with a "shipped in plan 76" close-out so the provenance survives.
- **Toggle placement decision:** inside the existing filter row, right-aligned via `justify-between`. Considered a sibling row but it added vertical real estate without enough visual differentiation — keeping it inline keeps the chrome compact.
- **Collapsible state intentionally per-session** — see "Out of scope" for the persistence follow-up.
