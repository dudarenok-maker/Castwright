---
status: stable
shipped: 2026-06-11
owner: null
---

# fs-22 Wave 2 — "Try the sample" affordance for the bundled demo book

> Status: active
> Key files: `src/lib/api.ts` (loadSample real+mock), `src/routes/index.tsx` (onTrySample handler), `src/views/book-library.tsx`, `src/components/library/library-grid.tsx`, `src/components/library/library-empty-states.tsx`, `src/views/upload.tsx`, `scripts/capture-sample-book.mjs`, `scripts/lib/kokoro-fallback.mjs`, `server/src/routes/samples.ts`, `samples/the-coalfall-commission/`
> URL surface: `#/` (empty-state), `#/new` (upload view "Try the demo book" button)
> OpenAPI ops: `POST /api/samples/:slug/load`

## Benefit / Rationale

- **User:** A first-time visitor can explore the full-cast audiobook workflow immediately — without uploading a manuscript. One click loads a pre-designed, cast-confirmed book into the workspace, ready to generate.
- **Technical:** The `POST /api/samples/:slug/load` endpoint already exists (Wave 1, plan 205). This plan adds only the frontend entry points (api client + two affordances + navigation).
- **Architectural:** Follows the existing api.ts real/mock pattern; the affordance prop (`onTrySample`) threads down through the library view tree exactly as `onStartNew` and `onImportPortable` do. No new slices or middleware needed.

## Architectural impact

- **New seams:** `api.loadSample(slug)` added to both real and mock objects; `onTrySample?: () => void | Promise<void>` prop added (optional) to `BookLibraryView`, `LibraryGrid`, and `EmptyLibrary`.
- **Invariants preserved:** The discriminated-union `ui.stage` is navigated via `uiActions.openBook({ status: book.status })` — the same call the library's `onOpenBook` uses, so routing logic is unchanged.
- **Migration story:** No data-shape change. The sample slug is hardcoded at the call site; adding more samples later only requires changing the slug string.
- **Reversibility:** Remove the prop wiring and the `api.loadSample` entries. No side effects.

## Invariants to preserve

- `uiActions.openBook` in `src/store/ui-slice.ts:200` maps `LibraryBookStatus` values (`analysing`, `cast_pending`, `complete`, `generating`, other) to stages. Always pass `book.status` directly — never a synthetic string like `'confirm'` or `'ready'` that falls through to the wrong branch.
- The `onTrySample` prop on `EmptyLibrary` is optional (`?`). The component hides the button when the prop is absent so renders without it (unit tests, table view) don't break.
- The upload-view `handleSample` is now an `async` function. The `busy` spinner is NOT set here (the load is fast and dispatches navigation immediately); `setError` is called on failure.

## Test plan

### Automated coverage

- Vitest unit (`src/components/library/library-empty-states.test.tsx`) — asserts `EmptyLibrary` renders "try a sample book" and clicking it fires the `onTrySample` spy; also asserts the button is absent when `onTrySample` is not provided.
- Vitest unit (`src/views/upload.test.tsx`) — existing "stacks buttons full-width" test updated to match new button label "Try the demo book".
- Playwright e2e (`e2e/try-sample.spec.ts`) — two specs: (1) upload-view "Try the demo book" button is visible at `#/new` and can be clicked without an error banner; (2) upload-view is reachable as the reliable e2e target (note: empty-state affordance is covered by unit test since mock library is never empty).

### Manual acceptance walkthrough

Run with `npm start` against a real workspace (no mock flag).

1. **Cold boot with empty workspace** — navigate to `http://localhost:5173/#/`. Expected: library empty state with "Your library is empty" and an "or try a sample book" link below the "Import your first book" button.
2. **Click "or try a sample book"** — the server calls `POST /api/samples/the-coalfall-commission/load`, copies the sample book into the workspace, refreshes the library. Expected: the app navigates to the book's cast-confirm or cast view (depending on `book.status`). No error banner.
3. **Upload-view path** — navigate to `#/new`. Expected: "Try the demo book" button is visible in the action chips row (beside "Paste text"). Clicking it performs the same load + navigate as step 2.
4. **Generate works** — after loading the sample, navigate to the Generate view. Expected: chapters are listed and generation can be started with Qwen or Kokoro without errors.
5. **Idempotent load** — click "Try the demo book" a second time. Expected: the server returns `{ alreadyLoaded: true }` (or the same `bookId`); the app finds the book in the refreshed library and opens it. No duplicate book appears.

## Out of scope

- Audio files are NOT included in the sample bundle — the user must run generation themselves.
- The sample book content is original Castwright work (all rights reserved); licensing is covered in `docs/legal/licensing.md`.
- Adding more sample slugs (e.g. a series sample) is a follow-up item.

## Ship notes

Shipped 2026-06-11 (closes #475). The bundling wave (after Wave 1's
replace-manuscript feature in plan 205 and the manual content-design Wave 2):

- **Bundle** `samples/the-coalfall-commission/` committed (PR #727, merge
  `8c36c551`) — manuscript + `.audiobook/{state,cast,manuscript-edits}.json` +
  44 Qwen voice files (13 characters, each with a Kokoro fallback preset). No
  audio; the analysis cache rebuilds from `manuscript-edits.json` on first
  generate.
- **Tooling** — `scripts/capture-sample-book.mjs` + `scripts/lib/kokoro-fallback.mjs`
  (freeze + deterministic preset mapping), `server/src/routes/samples.ts`
  (`POST /api/samples/:slug/load`, idempotent, voices merged no-clobber),
  "Try the sample" affordance (empty-library + upload view).
- **Release packaging** (PR #728, merge `20b9de82`) — `samples/**` added to the
  release-zip manifest; `.gitattributes` marks `.pt`/`.epub` binary; INSTALL.md
  "Try the demo book" section; README + 1.7.0 RELEASE_NOTES bullets (PR #731).

Follow-up shipped same day: analyzer id-drift voice rescue + distinct Replace
icon (PR #730, merge `9e2cb07e`) — see plan 205 cross-reference.
