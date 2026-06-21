# fe-40 follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three deferred fe-40 follow-ups — fe-42 (single-word "Carried" vocabulary), fe-41 (series-memory chip in the table view), fe-43 (PNG share-card export) — as one frontend-only branch.

**Architecture:** Pure frontend, no API changes. fe-42 is copy + a component rename behind a stable `data-testid`, relabelling the cast filter chip through the existing `CHIP_LABELS` indirection. fe-41 reuses the shipped `SeriesMemoryChip` (gaining a `showBooks` prop) inside the table's series-section header, wired to the orchestrator's already-global reveal/share modals. fe-43 adds a client-side PNG capture of the existing `SeriesShareCard` via a lazily-imported `html-to-image`.

**Tech Stack:** Vite + React 18 + TypeScript + Redux Toolkit; Vitest + React Testing Library (jsdom); Playwright (chromium) e2e; `html-to-image` (new dep).

**Spec:** `docs/superpowers/specs/2026-06-22-fe-40-followups-design.md`. **Issues:** fe-41 (#983), fe-42 (#984), fe-43 (#985).

**Deviation from the spec (intentional, discovered during planning):** fe-42's filter-chip relabel uses the existing `CHIP_LABELS` map (`cast.tsx:129`, whose comment states "the key stays stable… only the displayed text changes") rather than renaming the internal `'Reused'` key across `CHIP_ORDER` / `tally.set` / `statusFilterKeys`. This is the codebase's own idiom (cf. `Variants: 'Has variants'`), strictly more surgical, and leaves the internal key churn-free. The spec's render-site list for the chip is superseded by Task 1 Step 6. (Spec will be synced in Task 5.)

## Global Constraints

- **No hex literals in component code** — use the CSS-custom-property tokens via Tailwind (`text-magenta`, `bg-peach`, `text-ink`, etc.). Existing `bg-[#1b1714]` on the share card is pre-existing and not touched.
- **No API/OpenAPI changes** — fe-42 is copy, fe-41 reuses the existing `seriesMemory` summary, fe-43 is client-side. `openapi.yaml` and `src/lib/api-types.ts` are untouched.
- **Touch targets ≥44×44 px on phone** — `min-h-[44px] sm:min-h-0` (the chip already complies; the new PNG button must too).
- **Keep `data-testid="reused-badge"`** stable through the badge rename (internal hook, not user-facing copy).
- **Delivery:** one branch `feat/frontend-fe-40-followups` (already cut); one PR closing all three — body carries `Closes #983`, `Closes #984`, `Closes #985`.
- **Test discipline:** every task ships paired tests; fe-42 additionally regenerates the `confirm` visual baselines.

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/components/primitives.tsx` | `ReusedBadge` → `CarriedBadge` (text + title; testid kept) | 1 |
| `src/views/cast.tsx` | badge import/use rename; `CHIP_LABELS` adds `Reused: 'Carried'` | 1 |
| `src/modals/profile-drawer.tsx` | badge import/use rename | 1 |
| `src/views/confirm-cast.tsx` | `Matched · N%` → `Carried · N%` | 1 |
| `e2e/{linux,win32}/…/confirm*.png` | regenerated visual baselines | 1 |
| `src/components/series-memory/series-memory-chip.tsx` | add `showBooks?: boolean` (default `true`) | 2 |
| `src/components/library/library-table.tsx` | thread `series` into `SeriesGroup`; restructure header; render compact chip | 3 |
| `src/views/book-library.tsx` | pass `onOpenSeriesMemory` to `<LibraryTable>`; orchestrator-level filter-preservation test target | 3 |
| `src/components/series-memory/share-card-modal.tsx` | `slugifyFilename`, ref wrapper, PNG button, lazy `toPng` | 4 |
| `package.json` | add `html-to-image` | 4 |
| `docs/features/archive/228-fe-40-series-memory.md` | "fe-40 follow-ups (delivered)" note | 5 |
| spec file | sync the CHIP_LABELS deviation | 5 |

---

## Task 1: fe-42 — single-word "Carried" vocabulary

Unify every `matchedFrom`-driven marker to "Carried". Rename the badge component (name matches reality; testid stays), relabel the filter chip through `CHIP_LABELS`, and change the confirm-cast pill. The **lifecycle** `Matched` pill (preset-voice state, derived from `voiceState` not `matchedFrom`) is intentionally left as `Matched`.

**Files:**
- Modify: `src/components/primitives.tsx:225-236`
- Modify: `src/views/cast.tsx:19` (import), `:1450` (usage), `:129-131` (`CHIP_LABELS`)
- Modify: `src/modals/profile-drawer.tsx:22` (import), `:899` (usage)
- Modify: `src/views/confirm-cast.tsx:433-437`
- Test: `src/views/cast.test.tsx`, `src/views/confirm-cast.test.tsx`, `src/modals/profile-drawer.test.tsx`
- Regenerate: `e2e/linux/responsive/visual.spec.ts-snapshots/confirm*.png`, `e2e/win32/responsive/visual.spec.ts-snapshots/confirm*.png`

**Interfaces:**
- Produces: `CarriedBadge` (replaces `ReusedBadge`) — `export function CarriedBadge(): JSX.Element`, same call shape (no props), same `data-testid="reused-badge"`.

- [ ] **Step 1: Update the tests to expect "Carried" (write the failing assertions)**

In `src/views/confirm-cast.test.tsx`, change the matched-pill assertions:
```ts
// was: expect(screen.getByText('Matched · 95%')).toBeInTheDocument();
expect(screen.getByText('Carried · 95%')).toBeInTheDocument();
// and any queryByText(/Matched · /) → /Carried · /
```
In `src/views/cast.test.tsx`, change the provenance-badge + chip assertions (NOT the lifecycle `Matched` pill assertions). Search for `getByText('Reused')` / `chip(/^Reused/)` and switch the visible text to `Carried`:
```ts
// badge text:
expect(within(narratorRow).getByText('Carried')).toBeInTheDocument();
// filter chip (label is now "Carried", internal key stays 'Reused'):
expect(chip(/^Carried/).textContent).toContain('1');
// the click-to-filter test still targets the chip by its visible label:
fireEvent.click(chip(/^Carried/));
```
In `src/modals/profile-drawer.test.tsx`, the reused-badge assertions switch `Reused` → `Carried` (the badge still has `data-testid="reused-badge"`, so any testid-based query is unchanged; only `getByText('Reused')` → `getByText('Carried')`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- cast.test confirm-cast.test profile-drawer.test`
Expected: FAIL — assertions for `Carried` don't match the still-"Reused"/"Matched ·" DOM.

- [ ] **Step 3: Rename the badge in `primitives.tsx`**

Replace `src/components/primitives.tsx:225-236`:
```tsx
export function CarriedBadge() {
  return (
    <span
      data-testid="reused-badge"
      title="Voice carried from a prior book in this series"
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium text-purple-deep/70 bg-purple-deep/4"
    >
      <IconLink className="w-2.5 h-2.5" />
      Carried
    </span>
  );
}
```
Also update the doc comment above it (lines 220-224): "marks a character whose voice was **carried** from a prior book in the series."

- [ ] **Step 4: Update both badge importers**

`src/views/cast.tsx:19` — in the `from '../components/primitives'` import block, `ReusedBadge` → `CarriedBadge`. `src/views/cast.tsx:1450` — `{reused && <CarriedBadge />}`.

`src/modals/profile-drawer.tsx:22` — same import rename. `:899` — `{reused && <CarriedBadge />}`.

- [ ] **Step 5: Relabel the cast filter chip via `CHIP_LABELS`**

`src/views/cast.tsx:129-131` — add the `Reused` entry (keep `Variants`):
```ts
const CHIP_LABELS: Record<string, string> = {
  Variants: 'Has variants',
  Reused: 'Carried',
};
```
Do **not** touch `CHIP_ORDER` (line 120), `tally.set('Reused', …)` (line 386), or `statusFilterKeys` (`voice-status.ts:173`) — the internal `'Reused'` key stays stable; only its display text changes. This mirrors the existing `Variants` pattern.

- [ ] **Step 6: Change the confirm-cast pill**

`src/views/confirm-cast.tsx:433-437`:
```tsx
{matched && character.matchedFrom?.confidence != null && (
  <Pill color="library">
    Carried · {Math.round(character.matchedFrom.confidence * 100)}%
  </Pill>
)}
```

- [ ] **Step 7: Run typecheck + tests to verify green**

Run: `npm run typecheck`
Expected: PASS (the rename reaches both importers — a missed importer would error here).
Run: `npm test -- cast.test confirm-cast.test profile-drawer.test`
Expected: PASS.
Run: `npm test` (full frontend) to catch any other site asserting the old strings (e.g. `src/test/a11y.test.tsx`). Fix any stragglers by switching the visible string `Reused`→`Carried` / `Matched · `→`Carried · ` (never the bare lifecycle `Matched`).
Also run `grep -rn "Matched · " e2e/` — if a non-visual e2e spec asserts the confirm pill text, update it to `Carried · ` here (so it surfaces before the full `verify` battery, not after).

- [ ] **Step 8: Regenerate the `confirm` visual baselines**

The confirm fixture renders the `Carried · N%` pill (matchedFrom seeds in `src/data/characters.ts`), so `confirm.png` / `confirm-dark.png` change.

Local (Windows) — regenerate the `e2e/win32` baselines so pre-push passes. Use the project script (it pins `--workers=1`, which guards against the Windows font-hinting race that raw `playwright test` would re-introduce):
```bash
npm run test:e2e:visual -- -g confirm --update-snapshots
```
Expected: the `e2e/win32/responsive/visual.spec.ts-snapshots/confirm.png` and `confirm-dark.png` files are rewritten. (Per `docs/testing` history these confirm baselines are Windows-font-flaky; if the immediately-following verification run diffs, re-run once — see `feedback_visual_baselines_flaky_on_windows`.)

`e2e/linux` baselines (the ones CI uses) cannot be produced on Windows — **flag to the controller/user** to trigger the `regen-visual-baselines` GitHub workflow on this branch (or regenerate on a Linux box) so the `run-ci` / merge visual leg is green. Note this explicitly in the task report.

- [ ] **Step 9: Commit**

```bash
git add src/components/primitives.tsx src/views/cast.tsx src/modals/profile-drawer.tsx src/views/confirm-cast.tsx \
  src/views/cast.test.tsx src/views/confirm-cast.test.tsx src/modals/profile-drawer.test.tsx \
  'e2e/win32/responsive/visual.spec.ts-snapshots/confirm*.png'
git commit -m "refactor(frontend): fe-42 unify series-carry vocabulary to 'Carried'

Rename ReusedBadge -> CarriedBadge (testid kept), relabel the cast
filter chip via CHIP_LABELS, and change confirm-cast 'Matched · N%' ->
'Carried · N%'. Lifecycle 'Matched' pill (voiceState, not matchedFrom)
unchanged. Regenerated the confirm visual baseline (win32); linux
baseline owed via the regen workflow.

Closes #984"
```
(Stage the specific `confirm*.png` snapshot files, not the whole `e2e/win32` dir, so an unrelated baseline drift doesn't ride along. `Closes #984` — fe-42 is fully delivered in this single task.)

---

## Task 2: fe-41a — `showBooks` prop on `SeriesMemoryChip`

Give the shared chip an opt-out for its trailing books clause, so the table can render a compact "Your cast · N voices" without a second book count next to the header's own. The grid keeps the default.

**Files:**
- Modify: `src/components/series-memory/series-memory-chip.tsx`
- Test: `src/components/series-memory/series-memory-chip.test.tsx`

**Interfaces:**
- Produces: `SeriesMemoryChip` now accepts `showBooks?: boolean` (default `true`). Signature: `{ summary: SeriesMemorySummary; bookCount: number; showBooks?: boolean; onOpen: () => void }`.

- [ ] **Step 1: Write the failing test**

Append to `src/components/series-memory/series-memory-chip.test.tsx`:
```tsx
it('omits the books clause when showBooks is false', () => {
  const summary = {
    carriedCount: 8, bespokeCount: 5, designedCount: 5,
    confirmedBookCount: 3, spanBooks: 3, perBook: [],
  };
  render(<SeriesMemoryChip summary={summary} bookCount={3} showBooks={false} onOpen={() => {}} />);
  const chip = screen.getByTestId('series-memory-chip');
  expect(chip).toHaveTextContent('Your cast · 8 voices');
  expect(chip).not.toHaveTextContent('books');
});

it('keeps the books clause by default', () => {
  const summary = {
    carriedCount: 8, bespokeCount: 5, designedCount: 5,
    confirmedBookCount: 3, spanBooks: 3, perBook: [],
  };
  render(<SeriesMemoryChip summary={summary} bookCount={3} onOpen={() => {}} />);
  expect(screen.getByTestId('series-memory-chip')).toHaveTextContent('Your cast · 8 voices, 3 books');
});
```
(If the file has no imports yet, mirror the existing chip test's imports: `render`, `screen` from `@testing-library/react`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- series-memory-chip.test`
Expected: FAIL — `showBooks` is not a prop; the books clause always renders.

- [ ] **Step 3: Implement the prop**

Replace `src/components/series-memory/series-memory-chip.tsx`:
```tsx
import type { SeriesMemorySummary } from '../../lib/types';
import { CastwaveGlyph } from '../../lib/castwave-glyph';

export function SeriesMemoryChip({ summary, bookCount, showBooks = true, onOpen }: {
  summary: SeriesMemorySummary; bookCount: number; showBooks?: boolean; onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="series-memory-chip"
      onClick={onOpen}
      className="inline-flex items-center gap-1.5 rounded-full px-3 min-h-[44px] sm:min-h-0 sm:py-1 text-xs font-semibold text-white dark:text-ink bg-gradient-to-r from-magenta to-peach hover:-translate-y-px transition-transform"
    >
      <CastwaveGlyph className="w-3.5 h-3.5" />
      Your cast · {summary.carriedCount} voices{showBooks ? `, ${bookCount} books` : ''}
    </button>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- series-memory-chip.test`
Expected: PASS (both new tests + any pre-existing chip tests, which use the default and still see ", N books").

- [ ] **Step 5: Commit**

```bash
git add src/components/series-memory/series-memory-chip.tsx src/components/series-memory/series-memory-chip.test.tsx
git commit -m "feat(frontend): fe-41 add showBooks prop to SeriesMemoryChip

Optional showBooks (default true) lets the table render a compact
'Your cast · N voices' variant; grid keeps the books clause.

Refs #983"
```

---

## Task 3: fe-41b — series-memory chip in the table view

Thread the `LibrarySeries` into the table's group model, restructure the collapsible section header so a clickable chip can sit beside the collapse toggle (responsively), render the compact chip, and wire the open handler to the orchestrator's existing reveal. Add the filter-preservation invariant test at the orchestrator layer.

**Files:**
- Modify: `src/components/library/library-table.tsx` (`SeriesGroup` interface ~58-71; groups `useMemo` ~91-123; section header ~140-161; `Props` ~42-56)
- Modify: `src/views/book-library.tsx` (pass `onOpenSeriesMemory` to `<LibraryTable>` ~420-432; extract `applyLibraryFilters` from the `filteredAuthors` memo ~314-331)
- Test: `src/components/library/library-table.test.tsx`, `src/views/book-library.test.tsx`

**Interfaces:**
- Consumes: `SeriesMemoryChip` with `showBooks` (Task 2); `LibrarySeries` (`src/lib/types.ts:612`, has `name`, `books`, `seriesMemory?`); the orchestrator's `setOpenSM` already renders `<SeriesMemoryReveal>`/`<ShareCardModal>` (book-library.tsx:435-451).
- Produces: `LibraryTable` prop `onOpenSeriesMemory?: (s: LibrarySeries) => void`; exported `applyLibraryFilters(authors, { filter, search, tags, languages }): LibraryAuthor[]` from `book-library.tsx`.

- [ ] **Step 1: Write the failing table tests**

Add to `src/components/library/library-table.test.tsx`. First extend the `renderTable` helper to pass the new prop (add `onOpenSeriesMemory?` to its `opts` type and `onOpenSeriesMemory={opts.onOpenSeriesMemory}` to the `<LibraryTable>` element). Then:
```tsx
const SUMMARY = {
  carriedCount: 8, bespokeCount: 5, designedCount: 5,
  confirmedBookCount: 3, spanBooks: 3, perBook: [],
};

describe('LibraryTable — series-memory chip (fe-41)', () => {
  const authorsWith = (seriesMemory: typeof SUMMARY | undefined): LibraryAuthor[] => [
    {
      name: 'Marin Vale',
      series: [
        {
          name: 'Northern Coast Trilogy',
          seriesMemory,
          books: [makeBook({ bookId: 'n1', title: 'North One', seriesPosition: 1 })],
        },
      ],
    },
  ];

  it('renders the compact chip (no books clause) for a series with seriesMemory', () => {
    renderTable({ authors: authorsWith(SUMMARY) });
    const chip = screen.getByTestId('series-memory-chip');
    expect(chip).toHaveTextContent('Your cast · 8 voices');
    expect(chip).not.toHaveTextContent('books');
  });

  it('renders no chip when the series has no seriesMemory', () => {
    renderTable({ authors: authorsWith(undefined) });
    expect(screen.queryByTestId('series-memory-chip')).toBeNull();
  });

  it('renders no chip in the Standalones section', () => {
    const authors: LibraryAuthor[] = [
      { name: 'A', series: [{ name: 'S', seriesMemory: SUMMARY,
        books: [makeBook({ bookId: 's1', title: 'Solo', isStandalone: true })] }] },
    ];
    renderTable({ authors });
    expect(screen.queryByTestId('series-memory-chip')).toBeNull();
  });

  it('clicking the chip fires onOpenSeriesMemory without toggling collapse', () => {
    const onOpenSeriesMemory = vi.fn();
    renderTable({ authors: authorsWith(SUMMARY), onOpenSeriesMemory });
    // chip scoped by testid (the section also has the collapse button) — R3-2
    fireEvent.click(screen.getByTestId('series-memory-chip'));
    expect(onOpenSeriesMemory).toHaveBeenCalledTimes(1);
    expect(onOpenSeriesMemory.mock.calls[0][0].name).toBe('Northern Coast Trilogy');
    // collapse did NOT fire: the book row is still present
    expect(screen.getByText('North One')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- library-table.test`
Expected: FAIL — no chip is rendered, `onOpenSeriesMemory` is not a prop.

- [ ] **Step 3: Add the prop and thread the series into `SeriesGroup`**

In `src/components/library/library-table.tsx`:

Import the chip and type (top of file, alongside existing imports):
```tsx
import { SeriesMemoryChip } from '../series-memory/series-memory-chip';
import type { LibraryAuthor, LibraryBook, LibrarySeries } from '../../lib/types';
```
Add to `Props` (the interface ~42-56):
```tsx
  onOpenSeriesMemory?: (s: LibrarySeries) => void;
```
Add it to the destructured params of `LibraryTable({ … })`.

Add `series` to the `SeriesGroup` interface (~58-71):
```tsx
interface SeriesGroup {
  id: string;
  label: string;
  authorOverride: string | null;
  /** Original LibrarySeries (for the series-memory chip + reveal); null for
      the synthetic Standalones group. */
  series: LibrarySeries | null;
  books: LibraryBook[];
}
```
In the groups `useMemo` (~101-108 and the standalones push ~112-119), set `series`:
```tsx
        if (groupBooks.length > 0) {
          out.push({
            id: `${author.name}::${series.name}`,
            label: `${author.name} — ${series.name}`,
            authorOverride: null,
            series,
            books: groupBooks,
          });
        }
```
and for the standalones group add `series: null,`.

- [ ] **Step 4: Restructure the section header and render the chip (responsive)**

Replace the header `<button>` block (`library-table.tsx:141-161`) with a flex row holding the collapse button (unchanged aria) and the chip as a sibling that wraps below on phone:
```tsx
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <button
                type="button"
                onClick={() => setCollapsed((m) => ({ ...m, [group.id]: !isCollapsed }))}
                aria-expanded={!isCollapsed}
                aria-controls={`library-table-body-${group.id}`}
                className="flex-1 min-w-0 flex items-center justify-between gap-3 px-1 py-1 rounded-lg hover:bg-ink/3 transition-colors"
              >
                <span className="inline-flex items-center gap-2 min-w-0">
                  {isCollapsed ? (
                    <IconChevR className="w-3.5 h-3.5 text-ink/60" />
                  ) : (
                    <IconArrowDn className="w-3.5 h-3.5 text-ink/60" />
                  )}
                  <span className="text-[11px] uppercase tracking-[0.18em] font-semibold text-ink/55 truncate">
                    {group.label}
                  </span>
                </span>
                <span className="text-[11px] text-ink/40 shrink-0">
                  {group.books.length} {group.books.length === 1 ? 'book' : 'books'}
                </span>
              </button>
              {group.series?.seriesMemory && (
                <SeriesMemoryChip
                  summary={group.series.seriesMemory}
                  bookCount={group.series.seriesMemory.confirmedBookCount}
                  showBooks={false}
                  onOpen={() => onOpenSeriesMemory?.(group.series!)}
                />
              )}
            </div>
```
(The collapse button is now `flex-1 min-w-0` with a `truncate` label; the chip is a sibling, so it never nests in the button and wraps below it when the row is too narrow.)

- [ ] **Step 5: Run the table tests to verify they pass**

Run: `npm test -- library-table.test`
Expected: PASS (all four new cases + the existing collapse/grouping cases — those fixtures carry no `seriesMemory`, so no chip renders and their `getByRole('button')` queries stay unambiguous).

- [ ] **Step 6: Wire the orchestrator**

`src/views/book-library.tsx:420-432` — add the prop to `<LibraryTable>` (mirrors the grid at line 406):
```tsx
          <LibraryTable
            loaded={loaded}
            isLibraryEmpty={authors.length === 0}
            authors={filteredAuthors}
            activeBookId={activeBookId}
            onOpenBook={onOpenBook}
            onDeleteBook={onDeleteBook}
            onReparseBook={onReparseBook}
            onReplaceManuscript={onReplaceManuscript}
            onEditBook={onEditBook}
            onCoverChanged={onCoverChanged}
            onStartNew={onStartNew}
            onOpenSeriesMemory={(s) => setOpenSM(s)}
          />
```

- [ ] **Step 7: Extract the filter mapping into an exported pure helper**

The chip only renders because the orchestrator's `filteredAuthors` memo spreads `{ ...series }`, keeping `seriesMemory` while `filterBooks` narrows `books`. To lock that invariant cleanly — without a slow, debounce-dependent render test against an unknown harness — extract the memo body into an exported pure function and have the memo call it. Behaviour-preserving; existing `book-library.test.tsx` tests stay green.

In `src/views/book-library.tsx`, replace the inline `filteredAuthors` memo (lines ~314-331) with a call to a new exported helper defined at module scope:
```tsx
export function applyLibraryFilters(
  authors: LibraryAuthor[],
  opts: { filter: Filter; search: string; tags: string[]; languages: string[] },
): LibraryAuthor[] {
  return authors
    .map((author) => ({
      ...author,
      series: author.series
        .map((series) => ({
          ...series,
          books: filterBooks(
            series.books.filter((b) => matchesFilter(b, opts.filter)),
            opts.search,
            opts.tags,
            opts.languages,
          ),
        }))
        .filter((series) => series.books.length > 0),
    }))
    .filter((author) => author.series.length > 0);
}
```
And the memo becomes:
```tsx
  const filteredAuthors = useMemo<LibraryAuthor[]>(
    () =>
      applyLibraryFilters(authors, {
        filter,
        search: debouncedSearch,
        tags: activeTags,
        languages: activeLanguages,
      }),
    [authors, filter, debouncedSearch, activeTags, activeLanguages],
  );
```
(`Filter` is the local `type Filter = 'all' | 'in_progress' | 'complete'`; `matchesFilter` and `filterBooks` are already imported in this file.) Run `npm run typecheck && npm test -- book-library` — existing orchestrator tests stay green (pure refactor).

- [ ] **Step 8: Lock the invariant — unit-test the helper directly**

In `src/views/book-library.test.tsx`, add a focused test (no render, no debounce):
```tsx
import { applyLibraryFilters } from './book-library';
// ...
it('applyLibraryFilters preserves seriesMemory when a search narrows the books', () => {
  const summary = {
    carriedCount: 8, bespokeCount: 5, designedCount: 5,
    confirmedBookCount: 3, spanBooks: 3, perBook: [],
  };
  const authors: LibraryAuthor[] = [
    {
      name: 'Marin Vale',
      series: [
        {
          name: 'Northern Coast Trilogy',
          seriesMemory: summary,
          books: [
            // shape via this file's existing book factory if it has one;
            // otherwise a minimal LibraryBook with title 'North One' / 'North Two'.
            makeLibBook({ bookId: 'n1', title: 'North One' }),
            makeLibBook({ bookId: 'n2', title: 'North Two' }),
          ],
        },
      ],
    },
  ];
  const out = applyLibraryFilters(authors, { filter: 'all', search: 'North One', tags: [], languages: [] });
  // search narrowed books 2→1 but the series object kept its seriesMemory:
  expect(out[0].series[0].books).toHaveLength(1);
  expect(out[0].series[0].seriesMemory).toEqual(summary);
});
```
Reuse the file's existing `LibraryBook` factory if present (mirror its name); otherwise define a tiny local `makeLibBook` like `library-table.test.tsx`'s `makeBook`. The assertion exercises the real `{ ...series }` spread — if a future refactor drops `seriesMemory` during filtering, this goes red.

- [ ] **Step 9: Run the full frontend suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/components/library/library-table.tsx src/components/library/library-table.test.tsx src/views/book-library.tsx src/views/book-library.test.tsx
git commit -m "feat(frontend): fe-41 series-memory chip in the table view

Thread LibrarySeries through SeriesGroup, restructure the section header
(collapse toggle + chip as responsive siblings), render the compact
showBooks=false chip, and wire onOpenSeriesMemory to the orchestrator's
existing reveal. Extract applyLibraryFilters so the filter-preservation
invariant (seriesMemory survives filtering) is unit-locked.

Closes #983"
```

---

## Task 4: fe-43 — PNG share-card export

Add a "Download image (.png)" button to the share modal that captures the existing `SeriesShareCard` via a lazily-imported `html-to-image`, plus a shared `slugifyFilename` applied to both the PNG and the existing JSON download.

**Files:**
- Modify: `package.json` (add `html-to-image`)
- Modify: `src/components/series-memory/share-card-modal.tsx`
- Test: `src/components/series-memory/share-card-modal.test.tsx`, `e2e/series-memory.spec.ts`

**Interfaces:**
- Consumes: `SeriesShareCard` (renders `data-testid="series-share-card"`, self-contained `bg-[#1b1714]`).

- [ ] **Step 1: Add the dependency**

Run: `npm install --save html-to-image`
Expected: `html-to-image` appears in `package.json` `dependencies` and `package-lock.json` updates.

- [ ] **Step 2: Update the existing unit tests (write the failing assertions)**

In `src/components/series-memory/share-card-modal.test.tsx`, the current test asserts the PNG button is ABSENT (lines 30-38). Flip it and add the new behaviour. Update the imports and add a mock at the top:
```ts
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ShareCardModal, slugifyFilename } from './share-card-modal';

vi.mock('html-to-image', () => ({
  toPng: vi.fn().mockResolvedValue('data:image/png;base64,AAAA'),
}));
```
Replace the "no PNG dep in v1" test (lines 30-38) with:
```tsx
it('renders the Download image (.png) button', () => {
  render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
  expect(screen.getByRole('button', { name: /download image \(\.png\)/i })).toBeInTheDocument();
});

it('captures the card and triggers a .png download on click', async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /download image \(\.png\)/i }));
  const { toPng } = await import('html-to-image');
  await waitFor(() => expect(toPng).toHaveBeenCalled());
  await waitFor(() => expect(click).toHaveBeenCalled());
});

it('surfaces an alert when capture fails', async () => {
  const { toPng } = await import('html-to-image');
  (toPng as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error('boom'));
  render(<ShareCardModal detail={detail} seriesName="X" onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /download image \(\.png\)/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't render/i);
});
```
And add a direct unit test for the exported helper (this is where the sanitisation is asserted concretely — the helper is shared by both downloads):
```tsx
describe('slugifyFilename', () => {
  it('replaces filename-illegal characters with a single dash', () => {
    expect(slugifyFilename('Marin Vale: North/Coast')).toBe('Marin Vale- North-Coast');
    expect(slugifyFilename('A::B')).toBe('A-B');
    expect(slugifyFilename('')).toBe('series');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- share-card-modal.test`
Expected: FAIL — no PNG button / no `role="alert"` exists yet.

- [ ] **Step 4: Implement the modal changes**

Edit `src/components/series-memory/share-card-modal.tsx`. First **replace the existing line-1 import** `import { useEffect } from 'react';` with the three hooks below. Then add the slug helper at module scope (near the existing `downloadJson`, lines ~6-14) and apply it to the JSON filename:
```tsx
// line 1 — replaces `import { useEffect } from 'react';`
import { useEffect, useRef, useState } from 'react';

// module scope, beside the existing downloadJson:
export function slugifyFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'series';
}

function downloadJson(detail: SeriesMemoryDetail, seriesName: string) {
  const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugifyFilename(seriesName)}-series-memory.json`;
  a.click();
  URL.revokeObjectURL(url);
}
```
Inside `ShareCardModal`, add state + ref + handler:
```tsx
  const cardRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function downloadPng() {
    const node = cardRef.current;
    if (!node) return;
    setBusy(true);
    setError(false);
    try {
      const { toPng } = await import('html-to-image');
      await document.fonts?.ready;
      const url = await toPng(node, { pixelRatio: 2, cacheBust: true });
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slugifyFilename(seriesName)}-series-cast.png`;
      a.click();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
```
Wrap the card in the ref'd div and add the button + alert. Replace the `<SeriesShareCard … />` + button block (lines 62-71):
```tsx
        <div ref={cardRef} className="w-full max-w-sm mx-auto">
          <SeriesShareCard detail={detail} seriesName={seriesName} owner={owner} />
        </div>

        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => downloadJson(detail, seriesName)}
            className="rounded-full px-5 py-2.5 font-semibold text-ink bg-gradient-to-r from-magenta to-peach"
          >
            Download data (.json)
          </button>
          <button
            onClick={downloadPng}
            disabled={busy}
            className="rounded-full px-5 py-2.5 font-semibold text-cream border border-cream/30 hover:bg-white/10 disabled:opacity-60"
          >
            {busy ? 'Rendering…' : 'Download image (.png)'}
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-center text-xs text-peach">
            Couldn't render the image — try again.
          </p>
        )}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npm test -- share-card-modal.test`
Expected: PASS. (jsdom has no `document.fonts`; the `?.` lets `await document.fonts?.ready` resolve and reach the mocked `toPng`.)

- [ ] **Step 6: Add the e2e download assertion**

Add a second `test(...)` **inside** the existing `test.describe('series-memory: …', () => { … })` block (before its closing `});` at line 57) — not at file top level. It repeats the navigation and clicks the PNG button:
```ts
  test('share card exports a PNG download', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('series-memory-chip').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByText('Share this cast').click();
    await expect(page.getByTestId('series-share-card')).toBeVisible({ timeout: 5_000 });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /download image \(\.png\)/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
  });
```

- [ ] **Step 7: Run the e2e to verify it passes**

Run: `npm run test:e2e -- series-memory`
Expected: PASS — a `download` event fires with a `.png` filename. (This proves the export wire end-to-end in mock mode; it does not assert pixel/font fidelity.)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/components/series-memory/share-card-modal.tsx src/components/series-memory/share-card-modal.test.tsx e2e/series-memory.spec.ts
git commit -m "feat(frontend): fe-43 PNG share-card export via html-to-image

Add a 'Download image (.png)' button that lazily imports html-to-image
and captures the SeriesShareCard at 2x; shared slugifyFilename sanitizes
both the PNG and the existing JSON download. Busy/disabled state + an
aria role=alert on capture failure.

Closes #985"
```

---

## Task 5: docs — record the follow-ups, remove backlog rows, sync the spec

**Files:**
- Modify: `docs/features/archive/228-fe-40-series-memory.md`
- Modify: `docs/BACKLOG.md`
- Modify: `docs/superpowers/specs/2026-06-22-fe-40-followups-design.md`

- [ ] **Step 1: Append a "fe-40 follow-ups (delivered)" subsection to the archived plan**

In `docs/features/archive/228-fe-40-series-memory.md`, add a short subsection recording the three deltas with dates + the issues they closed (fe-41 #983 table chip, fe-42 #984 "Carried" vocabulary, fe-43 #985 PNG export), and pointing at this plan + the spec. One paragraph per item; no need to restate the spec.

- [ ] **Step 2: Remove the shipped backlog rows (CLAUDE.md ship step)**

Delete the three rows from `docs/BACKLOG.md` — they are now shipped:
- `#### \`fe-41\` …` (line ~458)
- `#### \`fe-42\` …` (line ~464)
- `#### \`fe-43\` …` (line ~470)

Remove each item's full block (heading + its What/Benefit/Acceptance lines), not just the heading. Verify with `grep -n "fe-41\|fe-42\|fe-43" docs/BACKLOG.md` → no matches remain.

- [ ] **Step 3: Sync the spec's CHIP_LABELS deviation**

In the fe-42 "Render sites" of the spec, replace the `CHIP_ORDER`/`tally`/`statusFilterKeys` key-rename instruction with the `CHIP_LABELS` approach actually used (add `Reused: 'Carried'`; internal key stays stable). One-line correction so the spec matches the shipped code.

- [ ] **Step 4: Commit**

```bash
git add docs/features/archive/228-fe-40-series-memory.md docs/BACKLOG.md docs/superpowers/specs/2026-06-22-fe-40-followups-design.md
git commit -m "docs(docs): record fe-40 follow-ups delivery, drop backlog rows, sync spec

Refs #983 #984 #985"
```

---

## Final verification (before opening the PR)

- [ ] Run `npm run verify` — full battery (typecheck + all tests + e2e + build). Expected: green, except the **`e2e/linux` confirm visual baseline**, which must be regenerated via the `regen-visual-baselines` workflow on this branch (it cannot be produced on Windows; the local `e2e/win32` baseline was regenerated in Task 1).
- [ ] Open the PR with `Closes #983`, `Closes #984`, `Closes #985` in the body; enumerate the three user-visible deltas + the incidental JSON-filename sanitisation.

## Self-review notes

- **Spec coverage:** fe-42 → Task 1; fe-41 (`showBooks`) → Task 2; fe-41 (table) → Task 3; fe-43 → Task 4; docs/spec-sync → Task 5. Every spec section maps to a task. The CHIP_LABELS deviation is documented in the header and synced in Task 5.
- **Invariants from the spec:** filter preservation → Task 3 Steps 7-8 (extract `applyLibraryFilters` + unit-test it directly, per R2-2 / P2-1); compact chip avoids the double-count → Task 2 + Task 3 Step 4; ref wrapper / self-contained bg → Task 4 Step 4; lazy import → Task 4 Step 4; `role="alert"` → Task 4 Step 4; `document.fonts?.ready` → Task 4 Step 4; visual baseline regen → Task 1 Step 8.
- **Type consistency:** `SeriesMemoryChip` gains `showBooks?: boolean` in Task 2 and is consumed with `showBooks={false}` in Task 3. `onOpenSeriesMemory?: (s: LibrarySeries) => void` is declared in Task 3 (table) and supplied in Task 3 (orchestrator). `CarriedBadge` replaces `ReusedBadge` in Task 1 across all three files.
