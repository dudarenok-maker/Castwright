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
    update the filter-chip `CHIP_ORDER` entry and tally key `'Reused'` →
    `'Carried'` (the string is both the Map key and the visible chip label, so
    they move together — and `statusKeysFor` at cast.tsx:286 just wraps
    `statusFilterKeys`, so the chip-definition key and the row-matching key stay
    consistent once both producers are renamed); update the "Reused" comments.
  - `src/modals/profile-drawer.tsx` — update the `ReusedBadge` import (line ~22)
    to `CarriedBadge` and its usage `{reused && <CarriedBadge />}` (line ~899).
    The drawer mirrors the cast row's badge; missing it fails `tsc`.
- `src/lib/voice-status.ts` (~line 173) — the chip-key push `keys.push('Reused')`
  → `keys.push('Carried')` (keeps the chip count keyed consistently with
  `cast.tsx`).
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

**Acceptance:** `npm run typecheck` is green (the `ReusedBadge → CarriedBadge`
rename is a build concern — both `cast.tsx` and `profile-drawer.tsx` import it);
a repo-wide grep for the visible strings `Reused` and `Matched · ` returns zero
*user-facing* `matchedFrom`-driven sites afterward; the bare lifecycle `Matched`
pill still renders `Matched`; all existing tests green.

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
2. **Restructure the section header.** A clickable chip cannot nest inside the
   collapse `<button>` (invalid HTML; the click would also toggle collapse).
   Wrap the header in a flex `<div>`: the existing collapse `<button>` (left,
   `flex-1`, all current aria + book-count preserved) and the chip as a sibling
   (right). The chip's `onOpen` is independent of the collapse toggle.
3. **Render the chip** when `group.series?.seriesMemory` is present, identical to
   the grid:
   ```tsx
   {group.series?.seriesMemory && (
     <SeriesMemoryChip
       summary={group.series.seriesMemory}
       bookCount={group.series.seriesMemory.confirmedBookCount}
       onOpen={() => onOpenSeriesMemory?.(group.series!)}
     />
   )}
   ```
   No inline sparkline (chip-only); click opens the existing
   `SeriesMemoryReveal`. Standalones and below-threshold series render no chip.
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
- **Count is the unfiltered series total — intentional parity with the grid.**
  The chip shows `seriesMemory.confirmedBookCount`, which is *not* recomputed on
  filter, so with an active search/tag filter the table can show 2 rows while the
  chip reads "5 books." This is identical to the grid's existing behaviour, so
  fe-41 is not a regression; it is deliberate parity, not an oversight.
- **`onOpenSeriesMemory` needs the original `LibrarySeries`** (the reveal reads
  `series.books[0].author` + `series.name`). Pass `group.series` — the original
  object threaded in step 1 — not a reconstructed one.

### Tests

Extend `src/components/library/library-table.test.tsx`:

- Chip renders in the section header for a series carrying `seriesMemory`
  (label + `confirmedBookCount`).
- No chip for a series without `seriesMemory`, and none in the Standalones
  section.
- Clicking the chip fires `onOpenSeriesMemory` with the series and does **not**
  toggle the section's collapse state.
- **Chip survives an active filter** — render the table with a search/tag filter
  that narrows a qualifying series' `books`, and assert the chip still shows (locks
  the `{ ...series }` filter-preservation invariant above).

`e2e/responsive/coverage.spec.ts` already auto-runs the table at every viewport;
no new e2e case is required for fe-41 (the chip is exercised by the grid's
existing `e2e/series-memory.spec.ts` reveal flow, and the table render is unit
covered).

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
  - Put a `ref` on the `SeriesShareCard` wrapper element (the exact DOM node to
    capture — card only, not the modal chrome).
  - Add a **"Download image (.png)"** button beside the existing
    "Download data (.json)" button, same pill styling family.
  - Handler:
    ```ts
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
    during capture; local `error` flag → an inline error line under the buttons
    ("Couldn't render the image — try again.") on a rejected `toPng`. No toast
    dependency; the modal stays self-contained.
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
- **e2e** (`e2e/series-memory.spec.ts`): open the share card → click
  "Download image (.png)" → assert a Playwright `download` event fires with a
  `.png` suggested filename. Runs in mock mode.

**Acceptance:** the share modal's "Download image (.png)" triggers a client-side
download of the full `SeriesShareCard` (Castwave glyph + attribution included),
works in mock mode, and is covered by unit + e2e tests.

## Risks & mitigations

- **fe-42** — two failure modes: (a) the `ReusedBadge → CarriedBadge` export
  rename is a **build break** if either importer (`cast.tsx`, `profile-drawer.tsx`)
  is missed — caught by `npm run typecheck`; (b) a missed test-string assertion —
  caught by `npm test`. The lifecycle-vs-carry `Matched` overload is the
  interpretation trap; the spec pins which sites move and which stay.
- **fe-41** — only non-trivial bit is the header restructure; chip + modal are
  pure reuse. Risk: breaking the collapse `aria-*` wiring — covered by the
  "collapse still toggles independently" test.
- **fe-43** — web-font embedding under html-to-image is the real-world risk;
  `document.fonts.ready` + same-origin fonts mitigate it, and the e2e download
  assertion is the proof it renders end-to-end.

## Out of scope (explicit)

- A real "Kept" badge / any second carry term (no backing data this round).
- Inline sparkline in the table row (chip-only, by decision).
- Server-side / Playwright PNG rendering.
- `LibraryTable` column sort/resize/density (pre-existing plan 76 follow-ups).
