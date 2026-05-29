---
status: stable
shipped: 2026-05-20
owner: null
---

# 73 — Library search + per-book tag filter

> Status: stable
> Key files: `src/views/book-library.tsx`, `src/components/library/library-chrome.tsx`, `src/modals/edit-book-meta.tsx`, `src/store/library-slice.ts`, `src/lib/use-debounced-value.ts`, `server/src/workspace/scan.ts`, `server/src/routes/book-state.ts`, `openapi.yaml`
> URL surface: `#/` (books library)
> OpenAPI ops: extends `LibraryBook.tags` on `GET /api/library`; new `tags` field accepted on `PUT /api/books/{bookId}/state` (slice=state).

## Benefit / Rationale

- **User:** library browsing becomes tenable at 10+ titles. Search-by-title narrows to one or two cards in two keystrokes; tag chips cross-cut the alphabetical Author/Series tree (priority, draft, genre, "favourite", etc.).
- **Technical:** introduces the `useDebouncedValue` hook and a pair of pure selectors (`selectAllTags`, `filterBooks`) — the orchestrator composes them, but they remain individually testable.
- **Architectural:** `tags` lands as an optional field on `BookStateJson` (lazy-migrated at read time) and a required `string[]` on `LibraryBook` (scan pads with `[]`). The chip editor lives in the existing `EditBookMetaModal`, so the round-trip rides on the established `slice: 'state'` PUT path — no new endpoint, no new slice.

## Architectural impact

- **New seams:**
  - `useDebouncedValue<T>(value, delayMs)` (`src/lib/use-debounced-value.ts`) — generic trailing-edge debounce hook.
  - `selectAllTags(state)` and `filterBooks(books, search, activeTags)` exported from `src/store/library-slice.ts`.
  - `EditBookMetaPatch.tags: string[]` — full-replacement on save.
  - `BookStateJson.tags?: string[]` (lazy, defaults to `[]` on read in `server/src/workspace/scan.ts`).
- **Invariants preserved:**
  - `LibraryGrid` stays a pure render of pre-filtered authors (plan 60's orchestrator/sub-component split).
  - Status pill (`All / In progress / Complete`) logic is unchanged; the new filters compose by intersection with status.
  - OpenAPI is still the type source of truth — `tags?: string[]` lands in `LibraryBook` via the spec, and `npm run openapi:types` regenerates `src/lib/api-types.ts`.
  - RTK immer drafts preserved; no slice reducers were rewritten as spreads.
- **Migration:** books whose `state.json` predates the field load with `state.tags === undefined`; the scan pads with `[]` so the wire shape always carries an array. First write of any tag value lands the field on disk. No write happens until the user opens the edit modal and saves — pre-existing books with no tags never trigger a disk mutation.
- **Reversibility:** removing the chip-filter row + search input from `library-chrome.tsx` reverts the user surface; the `tags` field can stay on disk indefinitely without UI consequences.

## Invariants to preserve

1. `LibraryBook.tags` is always an array on the wire — `scan.ts` pads `[]` for books missing the field on disk. The chip-filter row in `library-chrome.tsx` and `selectAllTags` both rely on this.
2. `filterBooks` semantics: `search` is case-insensitive substring on `title + author`; `activeTags` is an intersection (book must carry **every** active tag). Status pill is composed by the orchestrator BEFORE this filter runs.
3. Search input debounce is ~150 ms (`useDebouncedValue` default). Tests expect the no-results pane to appear within 2 s of typing.
4. The chip editor in `EditBookMetaModal`:
   - Comma OR Enter commits the typed input; backspace on an empty input pops the last chip.
   - Duplicates are silently dropped (case-sensitive — `Favourite` ≠ `favourite`, by design).
   - Empty / whitespace-only tokens are dropped.
   - Suggestions dropdown surfaces tags from other books in the library; the active book's own tags are excluded from suggestions to avoid re-add prompts.
5. The PUT `slice: 'state'` route's `pickTags` whitelist drops non-string entries, trims, dedupes, and rejects empty strings — see `server/src/routes/book-state.ts`.
6. The "no results" pane (`data-testid="library-no-results"`) only fires when an active search/tag filter narrowed an otherwise-non-empty library to zero. An empty library still falls through to the existing `EmptyLibrary` panel in `library-grid.tsx`.

## Test plan

### Automated coverage

- Vitest unit (`src/store/library-slice.test.ts`) — asserts `selectAllTags` sorts the cross-book union and tolerates legacy `undefined`; asserts `filterBooks` covers case-insensitive title/author search, single-tag and multi-tag intersection, and composition with search.
- Vitest unit (`src/components/library/library-chrome.test.tsx`) — asserts search input wiring, tag-chip render + aria-pressed state, toggleTag dispatch, clear-filters affordance gating.
- Vitest unit (`src/modals/edit-book-meta.test.tsx`) — asserts chip render, Enter/comma commits, paste-with-commas, duplicate prevention, last-chip backspace, suggestions dropdown filtering + click-to-add, and that uncommitted typed input is rescued on Save.
- Vitest unit (`src/views/book-library.test.tsx`) — adds two assertions: search input is present, and a non-matching query renders the no-results pane within the debounce window.
- Playwright e2e (`e2e/library-search-tags.spec.ts`) — 5 specs covering search-narrow, no-results pane, single-chip filter, multi-chip intersection, and clear-filters reset against the mock library.

### Manual acceptance walkthrough

1. **Cold boot at `#/`** with the mock library → 4 cards visible across two series (Northern Coast Trilogy + Standalones). The search input is in the chrome row above the status pills. The tag-chip row shows `favourite`, `series-1` (sorted).
2. **Type "north" in the search input** → after ~150 ms, only "The Northern Star" remains. The status pill row is unchanged.
3. **Clear the search, then click the `favourite` chip** → only books carrying that tag remain ("Solway Bay" and "Twilight Stations").
4. **Click `series-1` as well** → intersection narrows to "Solway Bay" only (it has both `favourite` and `series-1`).
5. **Click "Clear filters"** in the chrome row → search clears, both chips deselect, every book is back.
6. **Open the "…" menu on a card, click "Edit details"** → the modal shows a Tags row with chip(s) for that book's current tags. Type "priority" + Enter → chip appears. Type "alpha, beta" + Enter → two more chips. Click X on `priority` → it's removed. Click Save → patch fires with the new tag list.
7. **After save** → the library refetches, the new chip(s) appear in the tag-filter row.

## Out of scope

- Tag colours / icons / namespaces. v1 keeps tags as plain strings; future-you can layer colour onto chip-row rendering without changing the disk shape.
- Tag rename / merge / cross-book bulk operations. The chip editor mutates one book at a time.
- Tag-chip rendering on the BookCard itself. v1 stops at the filter chip row in the chrome region; the card layout is untouched.
- Tag search-by-tag-substring inside the autocomplete dropdown is a `includes` substring, not a full fuzzy ranking — Won't until > 50 distinct tags exist (today's mock library has 3).

## Ship notes

Shipped 2026-05-20 on branch `feat/frontend-library-search-tags`. Replaces BACKLOG Could #7. Five Playwright specs added; one new Vitest file (`library-chrome.test.tsx`), one new Vitest file (`edit-book-meta.test.tsx`), library-slice gains 12 new assertions across `selectAllTags` + `filterBooks` + the (pre-existing) reducer suite, and `book-library.test.tsx` gains 2 new assertions for the search input + no-results pane.
