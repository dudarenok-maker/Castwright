# fe-40 follow-ups — design spec

**Date:** 2026-06-22
**Issues:** fe-41 (#983), fe-42 (#984), fe-43 (#985)
**Predecessor:** fe-40 series memory (shipped 2026-06-21, plan [228](../../features/archive/228-fe-40-series-memory.md), PR #986)
**Status:** approved — ready for implementation plan

## Goal

Ship the three deliberately-deferred fe-40 follow-ups as one cohesive,
frontend-only round: harmonise the series-carry vocabulary, surface the
series-memory chip in the table view, and add a PNG export to the share card.

## Scope & delivery

Three independent, FE-scoped items. Their file sets are disjoint: only **fe-41**
touches the orchestrator (`src/views/book-library.tsx`, one prop-wiring line);
fe-42 and fe-43 don't touch it at all. Nothing collides.

- **One branch:** `feat/frontend-fe-40-followups`.
- **Three commits**, one per item, in this order: fe-42 (copy) → fe-41 (table
  chip) → fe-43 (PNG export). Ordering is convenience only; there are no
  inter-item dependencies.
- **One PR** closing all three: `Closes #983`, `Closes #984`, `Closes #985`.
- **One local `npm run verify`** (the pre-push gate is the real CI here; cloud
  CI stays opt-in).
- **Docs:** append a short "fe-40 follow-ups (delivered)" subsection to the
  archived plan `docs/features/archive/228-fe-40-series-memory.md` recording the
  three deltas. No new plan doc — each item is small and issue-specified, and
  ships paired tests.

## Global constraints

Copied from project conventions; every task inherits these.

- **No hex literals in component code** — use the CSS-custom-property design
  tokens (`--magenta`, `--peach`, `--ink`, `--cream`, etc.) via Tailwind.
- **OpenAPI is the type source of truth** — but these three items add **no new
  API shapes** (fe-42 is copy, fe-41 reuses the existing `seriesMemory`
  summary, fe-43 is pure client-side). `openapi.yaml` is untouched.
- **Touch-equivalence + 44px touch targets** — any new interactive control
  ships its tap path and meets WCAG 2.5.5 on phone (`min-h-[44px] sm:min-h-0`).
- **Test discipline** — new behaviour ships paired automated tests; the PNG
  button (crosses a redux/layout-free but DOM-capture seam) gets a Vitest unit
  test plus a Playwright e2e download assertion.
- **Reproduce the existing look** — fe-41's chip is the *same* `SeriesMemoryChip`
  the grid uses; fe-43 captures the *existing* locked `SeriesShareCard`. No
  visual redesign.

---

## fe-42 — single-word "Carried" vocabulary

### Decision & rationale

The series-carry concept is a **single** data signal: `voice-status.ts:149`
derives `reused: !!c.matchedFrom`. There is **no** existing signal for "a voice
kept from the prior cast *without* a match", so the issue's proposed second term
("Kept") would be dead vocabulary — it has no population to render. Building a
real "Kept" predicate would mean new cross-book derivation and a new
per-character flag; that scope is explicitly **out** for this round (revisit when
voice-cloning / series work gives a second term real data).

Therefore: **one concept, one word — "Carried"** — applied only to the
`matchedFrom`-driven markers. The unrelated **lifecycle** `Matched` pill (a
preset-voice state for Kokoro/Coqui, derived from `voiceState`, not
`matchedFrom`) is a different concept and is **left untouched** — renaming it
would be a category error.

### Render sites (copy + symbol changes only — no logic change)

- `src/views/confirm-cast.tsx` (~line 435) — the cast-review pill
  `Matched · {Math.round(confidence*100)}%` → `Carried · {…}%`. Guard
  (`matched && character.matchedFrom?.confidence != null`) unchanged.
- `src/components/primitives.tsx` (~line 225) — the badge component:
  - Rename the export `ReusedBadge` → `CarriedBadge`.
  - Visible label `Reused` → `Carried`.
  - `title` attribute → "Voice carried from a prior book in this series".
  - **Keep `data-testid="reused-badge"`** unchanged to avoid unrelated test
    churn (the testid is an internal hook, not user-facing copy). The icon
    (`IconLink`) and lighter-weight styling stay.
- **`CarriedBadge` has two render sites — both must update or the rename is a
  TypeScript build break:**
  - `src/views/cast.tsx` — update the `ReusedBadge` import (line ~19) to
    `CarriedBadge` and its usage `{reused && <CarriedBadge />}` (line ~1450);
    relabel the filter chip via the existing `CHIP_LABELS` map — add
    `Reused: 'Carried'` (the codebase idiom: its comment states "the key stays
    stable… only the displayed text changes", cf. `Variants: 'Has variants'`).
    The internal `'Reused'` key in `CHIP_ORDER` / `tally.set` / `statusFilterKeys`
    stays UNCHANGED — only its display label flips; update the "Reused" comments.
  - `src/modals/profile-drawer.tsx` — update the `ReusedBadge` import (line ~22)
    to `CarriedBadge` and its usage `{reused && <CarriedBadge />}` (line ~899).
    The drawer mirrors the cast row's badge; missing it fails `tsc`.
- `src/lib/voice-status.ts` (~line 173) — `keys.push('Reused')` stays UNCHANGED
  (internal chip key; the relabel lives only in `CHIP_LABELS`). _(An earlier spec
  draft renamed this key; superseded by the CHIP_LABELS approach during plan
  authoring — see plan header "Deviation from the spec".)_
- Comments mentioning "Reused" in the touched files updated to match.

**Not touched — the lifecycle `Matched` pill (separate concept, derived from
`voiceState`, not `matchedFrom`).** Expected consequence, *not* a missed rename: a
reused **preset** character (`voiceState:'reused'`) resolves its lifecycle label to
`'Matched'` (`voice-status.ts:124-127`) **and** carries the badge. Today that row
reads "Matched · Reused"; after fe-42 it reads **"Matched · Carried."** The
lifecycle "Matched" (preset voice is ready) is a different axis from carry
provenance, so it correctly stays. A reviewer seeing a surviving bare "Matched"
must not read it as an incomplete rename. The confirm-cast `Matched · N%` pill is a
separate surface; the `· N%` distinguishes it from the bare lifecycle "Matched".

### Tests

No behaviour changes, so test *structure* stays; only the asserted strings flip.
Update the exact-string assertions in:

- `src/views/cast.test.tsx` — the `Matched`/`Reused` chip + badge assertions
  (e.g. `chip(/^Reused/)` → `chip(/^Carried/)`; the lifecycle `Matched`
  assertions that are **not** `matchedFrom`-driven stay as `Matched`).
- `src/views/confirm-cast.test.tsx` — `getByText('Matched · 95%')` →
  `getByText('Carried · 95%')` and the `/Matched · /` queries.
- `src/modals/profile-drawer.test.tsx` — the reused-badge assertions.
- `src/test/a11y.test.tsx` — any `Reused`/`Matched · %` assertions surfaced by a
  repo-wide grep at implementation time. (`match-detail.tsx`/`.test.tsx` are
  **not** sites — their earlier grep hits were `matchedFrom`, not the visible
  strings.)

**Visual baselines (R4-2) — fe-42 busts the `confirm` snapshot.** The visual suite
snapshots `#/books/:id/confirm`, whose fixture cast (`src/data/characters.ts`,
`matchedFrom` on the Eliza/Marcus seeds) renders the `Matched · N%` pill. Changing
it to `Carried · N%` changes the rendered pixels, so `confirm.png` (and
`confirm-dark.png`, if present) **will fail `test:e2e:visual`** — green unit tests
won't reveal it; it surfaces at pre-push / `run-ci`. Regen these per-platform
baselines as part of fe-42: `e2e/linux/` (CI, regen on Linux via the
`regen-visual-baselines` workflow) **and** `e2e/win32/` (local pre-push). No other
snapshot is affected (no `cast`/`table` snapshot exists).

**Acceptance:** `npm run typecheck` is green (the `ReusedBadge → CarriedBadge`
rename is a build concern — both `cast.tsx` and `profile-drawer.tsx` import it);
a repo-wide grep for the visible strings `Reused` and `Matched · ` returns zero
*user-facing* `matchedFrom`-driven sites afterward; the bare lifecycle `Matched`
pill still renders `Matched`; the `confirm` visual baselines are regenerated; all
tests green. **`Carried · N%` at the confirm (proposal) stage is the deliberate
choice** (R2-4) — single-word "Carried" everywhere beats re-introducing a second
word for the pre-confirmation moment.

---

## fe-41 — series-memory chip in the table view

### Structural context

`src/components/library/library-table.tsx` renders **per-book rows grouped by
series**; there is no dedicated series row. Each series is a collapsible
`<section>` whose header is a single full-width `<button>` (toggles collapse,
carries `aria-expanded`/`aria-controls` + the book count). The `seriesMemory`
summary lives on the `LibrarySeries` object, but the table's internal
`SeriesGroup` currently captures only `{ id, label, authorOverride, books }` —
it **drops** the `LibrarySeries` reference.

### Changes

1. **Thread the series through `SeriesGroup`.** Add `series: LibrarySeries | null`
   (null for the synthetic `__standalones__` group). Populate it when building
   `groups` in the `useMemo`.
2. **Restructure the section header, responsively.** A clickable chip cannot nest
   inside the collapse `<button>` (invalid HTML; the click would also toggle
   collapse). Wrap the header in a flex `<div>`: the existing collapse `<button>`
   (left, `flex-1`, all current aria + book-count preserved) and the chip as a
   sibling. The chip's `onOpen` is independent of the collapse toggle.
   - **Phone (`<640px`):** the wrapper is `flex-wrap` (or `flex-col sm:flex-row`)
     so the chip drops to its own line under the collapse row rather than
     overflowing the narrow header. The mobile protocol mandates `<640px` behave,
     and `e2e/responsive/coverage.spec.ts` runs the table at phone width.
3. **Compact chip variant — no books clause in the table.** Add an optional
   `showBooks?: boolean` (default `true`) to `SeriesMemoryChip`. The grid keeps the
   default ("Your cast · N voices, M books"); the **table passes
   `showBooks={false}`** → "Your cast · N voices". Two reasons:
   - **Avoids a contradictory adjacent count.** The table header already renders
     `{group.books.length} books` (the filtered group size); the chip's own
     `confirmedBookCount` is a *different* number, so showing both inches apart
     reads as a bug. Dropping the chip's books clause removes the clash — the
     header owns the book count, the chip owns the voice count.
   - Shorter text fits the narrow header (helps step 2).

   Render when `group.series?.seriesMemory` is present:
   ```tsx
   {group.series?.seriesMemory && (
     <SeriesMemoryChip
       summary={group.series.seriesMemory}
       bookCount={group.series.seriesMemory.confirmedBookCount}
       showBooks={false}
       onOpen={() => onOpenSeriesMemory?.(group.series!)}
     />
   )}
   ```
   No inline sparkline (chip-only); click opens the existing
   `SeriesMemoryReveal`. Standalones and below-threshold series render no chip.
   (`bookCount` stays a required prop; the table just passes it and the component
   omits the clause when `showBooks={false}` — no separate `aria-label` needed, the
   visible "Your cast · N voices" is a complete accessible name.)
4. **Prop + orchestrator wiring.** `LibraryTable` gains
   `onOpenSeriesMemory?: (s: LibrarySeries) => void` (same signature the grid
   already has). In `book-library.tsx`, pass
   `onOpenSeriesMemory={(s) => setOpenSM(s)}` to `<LibraryTable>` — one line; the
   `SeriesMemoryReveal` + `ShareCardModal` are already rendered globally and need
   no change.

### Invariants this relies on (verified, pin them)

- **Filter preserves `seriesMemory`.** The chip only renders because the
  orchestrator builds `filteredAuthors` with `{ ...series, books: filterBooks(...) }`
  (`book-library.tsx:316-327`) — the spread keeps `seriesMemory`, and `filterBooks`
  only narrows the `books` array. This is an *implicit, currently-untested*
  dependency shared with the grid: a future refactor that reconstructs series
  objects would silently kill the chip in both views. The fe-41 test (below) locks
  it for the table.
- **Table chip hides its book count (`showBooks={false}`)** so it never sits a
  `confirmedBookCount` next to the header's filtered `group.books.length` — see
  change 3. (The grid keeps showing books; there the chip isn't adjacent to a
  second book count.)
- **`onOpenSeriesMemory` needs the original `LibrarySeries`** (the reveal reads
  `series.books[0].author` + `series.name`). Pass `group.series` — the original
  object threaded in step 1 — not a reconstructed one.

### Tests

Extend `src/components/library/library-table.test.tsx` (the table *renders* what
it's given — it does not filter, so these prove rendering, not preservation):

- Chip renders in the section header for a series carrying `seriesMemory`, showing
  the compact text "Your cast · N voices" (**no** books clause).
- No chip for a series without `seriesMemory`, and none in the Standalones
  section.
- Clicking the chip fires `onOpenSeriesMemory` with the series and does **not**
  toggle the section's collapse state.
- **Query scoping (R3-2):** the section now contains two buttons (collapse + chip).
  New chip assertions must target `getByTestId('series-memory-chip')` (or the chip's
  exact accessible name), **not** a loose `getByRole('button', { name: /…/ })`, or
  they'll throw "multiple elements." Existing collapse-toggle tests stay green —
  their fixtures carry no `seriesMemory`, so no chip renders there.

**Filter-preservation invariant lives one layer up (R2-2).** `LibraryTable` can't
prove the orchestrator's filter keeps `seriesMemory` — it never filters. Add the
assertion where the spread happens: a test that runs `filteredAuthors`' logic (an
orchestrator-level test in `book-library`, or a `library-slice` test if `filterBooks`
is exercised there) and asserts a series retains `seriesMemory` after an active
search/tag filter narrows its `books`.

`e2e/responsive/coverage.spec.ts` already auto-runs the table at every viewport;
no new e2e case is required for fe-41 (the chip is exercised by the grid's
existing `e2e/series-memory.spec.ts` reveal flow, and the table render is unit
covered).

**Visual baselines:** fe-41 busts **none** — the visual suite has no `cast`/`table`
snapshot, and `library.png` defaults to card view (whose grid chip already shipped
in fe-40's baseline). No regen for fe-41.

**Acceptance:** in table view, a qualifying series row shows the same chip as the
card view; clicking it opens the reveal; standalone rows show no chip; the
collapse toggle still works independently.

---

## fe-43 — PNG share-card export

### Decision

Capture approach: **`html-to-image`** (client-side, ~50 KB gzipped, works in
mock mode). Chosen over `dom-to-image-more` (marginal size win, same font
caveat) and a server-side Playwright shot (most font-faithful but server-scoped,
no mock-mode support — wrong fit for an FE-only round).

### Changes

- **Dependency:** add `html-to-image` to `package.json`.
- **`src/components/series-memory/share-card-modal.tsx`:**
  - **Ref strategy (R2-1):** `SeriesShareCard` is a plain component, **not** a
    `forwardRef`, so there's no node to hand `toPng`. The **surgical** approach is
    for the modal to wrap `<SeriesShareCard/>` in its own ref'd `<div>` — *don't*
    modify the shipped card component. The wrapper must be `w-full max-w-sm` so the
    card (its own `mx-auto max-w-sm`, self-contained `bg-[#1b1714]` — verified
    series-share-card.tsx:23) fills it edge-to-edge with **no transparent margin**;
    capture `wrapperRef.current`. No `backgroundColor` capture option needed (the
    card paints its own background).
  - Add a **"Download image (.png)"** button beside the existing
    "Download data (.json)" button, same pill styling family.
  - **Lazy-load the lib (R4-1).** `ShareCardModal` is a *static* import in
    `book-library.tsx`, so a static `import { toPng } from 'html-to-image'` would
    pull ~50 KB gz into the library chunk for everyone. Dynamic-import it inside the
    handler instead — it only loads when a user actually exports.
  - Handler:
    ```ts
    const { toPng } = await import('html-to-image');   // lazy — keeps 50KB off the library chunk
    await document.fonts?.ready;              // optional-chain: jsdom has no document.fonts
    const url = await toPng(node, { pixelRatio: 2, cacheBust: true });
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugifyFilename(seriesName)}-series-cast.png`;
    a.click();
    ```
    **The `?.` is load-bearing for the unit test:** jsdom does **not** implement
    `document.fonts`, so a bare `document.fonts.ready` throws `TypeError` *before*
    the mocked `toPng` is reached and the test can't exercise the path. Optional
    chaining is a no-op in the browser (where `document.fonts` exists) and safe in
    jsdom (where it's `undefined` → the `await undefined` resolves immediately).
  - **Filename — `slugifyFilename` (small shared helper).** `seriesName` can hold
    characters illegal in filenames (`:` / `/` — the mock series key even uses
    `::`). The existing JSON download (`${seriesName}-series-memory.json`) has this
    same latent issue. Add a tiny `slugifyFilename(s)` (strip/replace
    `[\\/:*?"<>|]` → `-`, collapse repeats) and apply it to **both** the new PNG
    and the existing JSON download in this file — a one-liner that fixes both
    rather than propagating the bug. (Scoped to this file; not a new module.)
  - **States:** local `busy` flag → button shows a disabled "Rendering…" label
    during capture (also blocks double-fire); local `error` flag → an inline error
    line under the buttons ("Couldn't render the image — try again.") on a rejected
    `toPng`/`import`. **The error line carries `role="alert"` (R3-3)** so a
    screen-reader user hears the failure — axe won't flag a missing live region, so
    this only happens if specified. No toast dependency; the modal stays
    self-contained.
  - **Filename stem (R3-4):** PNG is `…-series-cast.png` vs the JSON's
    `…-series-memory.json` — a deliberate distinction (the card is the *cast* story;
    the JSON is the full *memory* detail), not an oversight.
- Fonts (General Sans + Lora) are self-hosted, same-origin woff2, so
  html-to-image inlines them; the `document.fonts?.ready` await guards against a
  capture firing before the faces are ready.

### Tests

- **Vitest** (`share-card-modal.test.tsx`): mock `html-to-image`'s `toPng`.
  - Clicking "Download image (.png)" awaits `toPng`, creates an anchor with the
    returned data URL and the slugified `download` filename, and clicks it (spy on
    `HTMLAnchorElement.prototype.click` / `createElement`). Runs under jsdom with
    no `document.fonts` — the `?.` guard is what lets this test reach `toPng`.
  - A rejected `toPng` surfaces the inline error line and re-enables the button.
  - `slugifyFilename` replaces illegal characters (assert a `seriesName` with `:`
    / `/` yields a safe `.png` *and* `.json` filename — covers the shared helper
    on both downloads).
- **e2e** (`e2e/series-memory.spec.ts`): wrap the click in
  `page.waitForEvent('download')`, open the share card → click "Download image
  (.png)" → assert the `download` fires with a `.png` suggested filename. Runs in
  mock mode. **This proves the wire, not pixel fidelity** — `toPng` yields a PNG
  even on font fallback, so a green e2e means "the export button works end-to-end,"
  not "fonts embedded perfectly." (`vi.mock('html-to-image')` still intercepts the
  dynamic `import()` in the unit test — no change to the mock approach.)

**Acceptance:** the share modal's "Download image (.png)" triggers a client-side
download of the full `SeriesShareCard` (Castwave glyph + attribution included),
works in mock mode, and is covered by unit + e2e tests.

## Risks & mitigations

- **fe-42** — three failure modes: (a) the `ReusedBadge → CarriedBadge` export
  rename is a **build break** if either importer (`cast.tsx`, `profile-drawer.tsx`)
  is missed — caught by `npm run typecheck`; (b) a missed test-string assertion —
  caught by `npm test`; (c) the **`confirm` visual baseline bust** — *not* caught by
  unit tests, only at pre-push/`run-ci`; the spec mandates regenerating
  `confirm.png`/`confirm-dark.png` for `e2e/linux` + `e2e/win32`. The
  lifecycle-vs-carry `Matched` overload is the interpretation trap; the spec pins
  which sites move and which stay.
- **fe-41** — non-trivial bits are the header restructure (risk: breaking the
  collapse `aria-*` wiring — covered by the "collapse still toggles independently"
  test) and the `showBooks` prop (keep the grid's default behaviour unchanged —
  covered by the grid's existing chip tests staying green). Busts no visual
  baseline.
- **fe-43** — web-font embedding under html-to-image is the real-world risk;
  `document.fonts?.ready` + same-origin fonts mitigate it; the e2e download
  assertion proves the wire (not pixel fidelity). The lazy `import()` keeps the
  ~50 KB off the library chunk.

## Out of scope (explicit)

- A real "Kept" badge / any second carry term (no backing data this round).
- Inline sparkline in the table row (chip-only, by decision).
- Server-side / Playwright PNG rendering.
- `LibraryTable` column sort/resize/density (pre-existing plan 76 follow-ups).
