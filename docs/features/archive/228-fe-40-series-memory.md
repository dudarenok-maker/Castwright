---
status: stable
shipped: 2026-06-21
owner: fe
---

# 228 — Series memory: carried characters across a series (fe-40)

> Status: stable
> Key files:
>   - `server/src/workspace/voice-kind.ts` — `voiceKindFor` (bespoke/preset discriminator, sole source)
>   - `server/src/workspace/series-memory.ts` — `deriveSeriesMemory` pure core
>   - `server/src/workspace/series-memory-scan.ts` — `buildInputsFromBooks` / `buildSeriesInputs`
>   - `server/src/routes/series-memory.ts` — `GET /api/library/series-memory` (detail)
>   - `server/src/workspace/scan.ts` — `scanLibrary` attaches `seriesMemory` summary
>   - `src/components/series-memory/series-memory-chip.tsx` — library door (chip + sparkline)
>   - `src/components/series-memory/series-sparkline.tsx` — per-book carried/principals bars
>   - `src/components/series-memory/series-memory-reveal.tsx` — bespoke breakdown modal
>   - `src/components/series-memory/series-share-card.tsx` — rendered share card
>   - `src/components/series-memory/share-card-modal.tsx` — share/export orchestrator
>   - `src/components/library/library-grid.tsx` — chip wired into card header
>   - `src/views/book-library.tsx` — modal state orchestrator
>   - `src/lib/castwave-glyph.tsx` — Castwave brand separator (·)
>   - `src/lib/api.ts` — `getSeriesMemory` API client
>   - `openapi.yaml` — `SeriesMemorySummary`, `SeriesMemoryDetail`, `CarriedCharacter` schemas
> URL surface: `#/books` (chip on each series card); modal opens inline (no URL change)
> OpenAPI ops: `GET /api/library/series-memory?author=&series=` (detail)

## Benefit / Rationale

- **User:** A "Carried · N characters across M books" chip appears on every series card in the library. Tapping reveals a per-character breakdown (name, voice kind, how many books it spans) and a sparkline visualising carried vs. all-principals per book. From there the user can share the series cast story via a rendered Castwave-branded card or export the raw data as JSON.
- **Technical:** The carried-character predicate is derived purely from `matchedFrom` links already persisted in `cast.json` — no new storage. The derivation (`deriveSeriesMemory`) is a confirmed-only, reverse-chain walk that is idempotent and accumulates a stable count of characters that were explicitly carried (reused with a `matchedFrom` back-reference) across two or more consecutive confirmed books in the series.
- **Architectural:** Adds a read-only analytics surface on top of the existing series/cast data model without touching generation, voice assignment, or cast confirmation paths. The only write-side coupling is that `scanLibrary` now attaches `seriesMemory` on every library response — a non-breaking additive field.

## Architectural impact

### New seams / extension points

- `voiceKindFor` (`server/src/workspace/voice-kind.ts`) — pure function, single source of truth for the `bespoke | preset` classification. Import path must not be duplicated.
- `SeriesMemorySummary` / `SeriesMemoryDetail` / `CarriedCharacter` — generated types from `openapi.yaml` via `src/lib/api-types.ts`. Do not hand-write these.
- `getSeriesMemory(author, series)` in `src/lib/api.ts` — the sole call site for detail fetch; uses mock in `VITE_USE_MOCKS=true`.
- `src/mocks/series-memory.ts` — mock fixtures; the "Northern Coast Trilogy" (`nct`) fixtures are the canonical mock-mode dataset for manual walkthroughs.

### Invariants preserved

- The `LibraryBook.seriesMemory` field is **additive** — `scanLibrary` returns it alongside existing fields; existing callers that ignore it are unaffected.
- `isConfirmed` maps to `status === 'generating' || status === 'complete'` — in-flight books count as confirmed; pending/errored do not.
- The carried predicate requires `matchedFrom.bookId` AND `matchedFrom.characterId` to both be present; a `matchedFrom` with only `bookId` is treated as chain-end by design.

### Migration story

No new storage. `seriesMemory` is computed from existing `cast.json` data on every `GET /api/library` call. No migration required. Adding `seriesMemory` to the library response is backward-compatible; clients that do not consume it see no change.

### Reversibility

Remove the `seriesMemory` attachment in `scanLibrary` (`scan.ts`) and delete the `GET /api/library/series-memory` route to revert. Frontend components can be tree-shaken by removing the chip from `library-grid.tsx` and the modal state from `book-library.tsx`.

## Invariants to preserve

1. **`voiceKindFor` is the only voiceKind source.** The bespoke/preset split is `server/src/workspace/voice-kind.ts:voiceKindFor`. No inline re-derivation of "bespoke" anywhere else.
2. **Carried predicate = confirmed-only, 2+ books.** `deriveSeriesMemory` (`server/src/workspace/series-memory.ts`) excludes books with `isConfirmed = false` and only marks a character as carried if their chain spans ≥ 2 confirmed books. Single-book occurrences produce `spanBooks: 1` and are never counted in `carriedCount`.
3. **Threshold gate before chip renders.** The chip is suppressed when `carriedCount < 1 && confirmedBookCount < 2`. An empty or single-book series shows no chip.
4. **Bespoke ≥ 1 for the "Series memory" claim.** The chip label reads "Series memory · N characters" only when `bespokeCount ≥ 1`. If all carried characters are `preset`, the chip reads "Voice continuity · N characters" (no bespoke moat, no Series memory wording). The wording distinction is enforced in `SeriesMemoryChip` and `SeriesShareCard`.
5. **Mandatory branding on the share card.** `SeriesShareCard` always renders the Castwave glyph separator and the `castwright.ai` attribution line. These cannot be conditionally omitted. `CastwaveGlyph` from `src/lib/castwave-glyph.tsx` is the sole glyph source.
6. **`confirmedBookCount` is the denominator.** Chip, reveal, sparkline, and share card all use `confirmedBookCount` (not `series.books.length` which includes in-flight books) to avoid overcounting in-progress series.
7. **`spanBooks` ≤ `confirmedBookCount`.** The sparkline clamps so the carried bar can never exceed the principals bar. The clamp is in `SeriesSparkline`.
8. **Unit = characters, not scenes or sentences.** The carried count, sparkline, and share card headline all count unique characters, never lines or appearances.
9. **`describeVoice` has no engine slug and no TTS model name.** The label visible to the end-user (e.g. "designed Qwen voice", "preset Kokoro voice") comes from the exported `describeVoice` helper in `server/src/workspace/series-memory.ts`. It must never expose internal engine identifiers like `qwen-tts` or `af_heart`.
10. **No v1 cache.** `GET /api/library/series-memory` is computed on every call. No caching at v1. If caching is added later it must be invalidated on every cast confirmation.

## Test plan

### Automated coverage

Tasks 1–14 landed the following test files:

**T1 — `voiceKindFor`**
- `server/src/workspace/voice-kind.test.ts` — asserts `bespoke` for `designed`/`cloned` overrides; `preset` for Kokoro/Coqui/Gemini/null overrides; Coqui counts as `preset` until a `cloned` marker exists.

**T2 — `deriveSeriesMemory` pure core**
- `server/src/workspace/series-memory.test.ts` — ~10 cases covering: mid-series gap (chain breaks), renamed-via-alias (single dedup row), chip==reveal invariant, bespoke sort order (bespoke first), `spanBooks < M` card, owner fallback, two-bucket partition + overflow, no-slug guard, cycle/branch guard, confirmed-only exclusion, carried predicate (≥ 2 confirmed books), `confirmedBookCount` alignment.

**T3 — `buildInputsFromBooks` / `buildSeriesInputs` + `describeVoice` export**
- `server/src/workspace/series-memory-scan.test.ts` — asserts `buildInputsFromBooks` reuses already-scanned books without a double scan, `buildSeriesInputs` hits the filesystem for a route path, `describeVoice` produces human-readable labels with no engine slug.

**T4 — `GET /api/library/series-memory` route**
- `server/src/routes/series-memory.test.ts` — asserts the route calls `buildSeriesInputs` + `deriveSeriesMemory` and returns `SeriesMemoryDetail`; asserts 400 on missing `author`/`series`; asserts 404 when the series has no confirmed books.

**T5 — OpenAPI + generated types**
- `openapi.yaml` defines `SeriesMemorySummary`, `SeriesMemoryDetail`, `CarriedCharacter` — type consistency enforced by `npm run openapi:types` round-trip (typecheck gate).

**T6 — Castwave glyph**
- `src/lib/castwave-glyph.test.tsx` — asserts the glyph renders a `<span>` with the correct aria-hidden attribute and the Castwave-dot separator character.

**T7–T9 — Chip + sparkline frontend**
- `src/components/series-memory/series-memory-chip.test.tsx` — chip renders "Series memory" label when `bespokeCount ≥ 1`; "Voice continuity" when all preset; suppressed when `carriedCount < 1`.
- `src/components/series-memory/series-sparkline.test.tsx` — bar widths reflect carried/principals ratio; clamp prevents carried > principals.
- `src/components/library/library-grid.test.tsx` — chip appears on a series card; absent on a standalone book; correct label for bespoke vs preset.

**T10 — Reveal modal**
- `src/components/series-memory/series-memory-reveal.test.tsx` — modal opens on chip click; shows per-character rows; aria: labelled dialog, close button, Escape handler; range-collapsed span assertion uses regex to avoid en-dash codepoint trap; fetch error shows fallback state.

**T12 — Share card**
- `src/components/series-memory/series-share-card.test.tsx` — renders headline, character rows, sparkline, mandatory Castwave glyph separator, and `castwright.ai` attribution; bespoke-led sort order; `confirmed N of M books` wording.

**T13 — Share modal + JSON export**
- `src/components/series-memory/share-card-modal.test.tsx` — renders the share card inside the modal; "Export data" triggers a Blob download of the in-hand `SeriesMemoryDetail` JSON (works in mock mode without an endpoint href); PNG export button is absent at v1 (deferred behind `html-to-image` dep sign-off).

**T14 (e2e) — Library chip → reveal → share card**
- `e2e/series-memory.spec.ts` — Playwright golden path in mock mode: library loads; "Northern Coast Trilogy" card shows the series-memory chip; click opens reveal modal; "Share" opens share-card modal; "Export data" downloads JSON; Escape closes. Also exercises: chip absent on standalone book; responsive coverage spec updated.
- `e2e/responsive/coverage.spec.ts` — series-memory chip surface added to the responsive coverage matrix.

**Mock fixtures**
- `src/mocks/series-memory.ts` — canonical "Northern Coast Trilogy" `SeriesMemorySummary` + `SeriesMemoryDetail` fixtures.
- `src/mocks/library.ts` — updated to include `seriesMemory` on the `nct` series mock book entry.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, i.e. `npm run dev`). No server or sidecar needed.

1. **Cold boot at `#/`** → stage = `{ kind: 'books' }`. Library grid shows book cards. Find the "Northern Coast Trilogy" card. Expected: a "Series memory · 3 characters" chip in the card header. *(If running against a real library with a multi-book confirmed series, the chip appears on that series instead.)*

2. **Click the chip** → `SeriesMemoryReveal` modal opens (no URL change). Expected: a dialog labelled "Series memory — Northern Coast Trilogy" (or equivalent series name). The modal body shows:
   - A "Carried across 3 confirmed books" subtitle.
   - At least one `bespoke` character row at the top (e.g. "Elara Voss · designed Qwen voice · books 1–3").
   - A `preset` character row below (e.g. "Thomas Crane · preset Kokoro voice · books 2–3").
   - A `SeriesSparkline` below the character list with correctly-proportioned carried (teal) and principals (grey) bars per book.
   - A "Share" button.

3. **Verify a11y baseline.** The dialog has `role="dialog"` + `aria-labelledby` pointing to the heading. A close button ("×" or "Close") is focusable via keyboard. Pressing Escape closes the modal.

4. **Click "Share"** → `ShareCardModal` opens. Expected:
   - The full `SeriesShareCard` renders inside the modal: a headline ("3 characters carried across 3 books"), character rows in bespoke-first order, the Castwave-dot (`·`) separator rendered by `CastwaveGlyph`, and a `castwright.ai` attribution line.
   - A "Copy" or "Export data" button is present.

5. **Click "Export data"** → a JSON file downloads (Blob). Its content is the `SeriesMemoryDetail` object (same as what the reveal renders). Verify it contains `carriedCharacters`, `confirmedBookCount`, `seriesName`.

6. **Close the modal with Escape.** Both modals dismiss cleanly.

7. **Standalone book card** → verify the series-memory chip does NOT appear on a single-book (non-series) card.

8. **Responsive check** → at 375 px width (phone viewport), the chip text wraps gracefully; the reveal modal is full-screen; the share card renders without overflow.

## Out of scope

- **LibraryTable treatment.** The chip + sparkline land in `LibraryGrid` (card view) only. The table view (`LibraryTable`) does not yet surface series-memory data. See follow-up `fe-41`.
- **Cast-row "Reused · Matched" badge harmonisation.** The per-character `Reused` / `Matched` badge wording in the confirm-cast and cast views uses legacy vocabulary; harmonising to "carried / kept" is a separate follow-up (`fe-42`).
- **PNG share-card export.** v1 ships the rendered card + JSON export only. A PNG screenshot export via `html-to-image` (or equivalent) is deferred behind an explicit dependency sign-off (`fe-43`).
- **Cross-series linking.** Characters that recur across different series by the same author are not tracked here; see `srv-7`.
- **Real-time update on cast confirmation.** The `seriesMemory` field on the library card is recomputed on the next `GET /api/library`. There is no live push update when a book's cast is confirmed.

## Ship notes

Shipped 2026-06-21. Implementing branch: `feat/fe-40-series-memory`. All Tasks 1–14 merged as a single linear series of commits. The full `npm run verify` battery ran green at final tree state.

Behaviour delta vs. original spec:
- PNG export deferred (T13 decision, Task 15 confirmed) — `html-to-image` dep requires a separate sign-off; the "Export PNG" button was intentionally omitted from the share-card modal at v1.
- `cloned` signal for Coqui: defaulted to `preset` until an explicit `cloned` marker exists in the voice override. The headline bespoke case is Qwen `designed` anyway.
- `buildInputsFromBooks` is the library-path variant (reuses scanned books); `buildSeriesInputs` is the route-only variant (reads from disk). The double-scan noted in the Round 2 review was fixed in T3.

## fe-40 follow-ups (delivered 2026-06-22)

The three "Out of scope" items above shipped as a single FE-only round — spec `docs/superpowers/specs/2026-06-22-fe-40-followups-design.md`, plan `docs/superpowers/plans/2026-06-22-fe-40-followups.md`, branch `feat/frontend-fe-40-followups-iso`.

- **fe-42 (#984) — single-word "Carried" vocabulary.** `ReusedBadge` → `CarriedBadge` (stable `data-testid="reused-badge"`), the cast filter chip relabelled via `CHIP_LABELS` (`Reused: 'Carried'` — internal key unchanged), and confirm-cast `Matched · N%` → `Carried · N%`. The lifecycle `Matched` pill (from `voiceState`, not `matchedFrom`) is deliberately untouched, so a reused-preset row reads "Matched · Carried". The issue's second term "Kept" was dropped — no data distinguishes it (`reused === !!matchedFrom`). Owed at merge: regenerate the `confirm` visual baselines (text changed).
- **fe-41 (#983) — series-memory chip in the table view.** `SeriesMemoryChip` gained `showBooks?` (default `true`); the table renders the compact `showBooks={false}` variant in a restructured section header (chip as a responsive sibling of the collapse button). The orchestrator's filter mapping was extracted into the exported pure `applyLibraryFilters`, unit-locking the "seriesMemory survives filtering" invariant. (Table-view-only — the inline sparkline stayed out of scope.)
- **fe-43 (#985) — PNG share-card export.** A "Download image (.png)" button captures the `SeriesShareCard` via a lazily-imported `html-to-image` (2×, `document.fonts?.ready`-gated); a shared `slugifyFilename` sanitises both the PNG and the existing JSON download. Dep signed off as `html-to-image`.
