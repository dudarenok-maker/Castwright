---
status: stable
shipped: 2026-05-17
owner: dudarenok-maker
---

# 40 — Cover framing + local-disk upload

> Status: stable (shipped 2026-05-17)
> Key files: `src/modals/cover-picker.tsx`, `src/views/book-library.tsx`, `src/views/listen.tsx`, `src/lib/cover-framing.ts`, `src/views/account.tsx` (account default), `server/src/routes/cover.ts`, `server/src/cover/upload.ts`, `server/src/workspace/user-settings.ts` (account default), `openapi.yaml`
> URL surface: indirect — invoked from the BookCard "..." menu and the Listen view's "Change cover" hover button (both established in plan [36](36-book-covers.md)).
> OpenAPI ops: `POST /api/books/{bookId}/cover/upload`, `PATCH /api/books/{bookId}/cover/framing`. Augments plan 36's existing four endpoints. `UserSettings.coverPickerDefaultTab` also added (account-level default for which tab opens first).

## Benefit / Rationale

- **User:** OpenLibrary covers are portrait (≈2:3) but our render slots are square (`CoverArt`, 1:1) and landscape (`BookCard`, 16:10). Default `object-cover` centering crops the title/author/key art away — the visible region is the middle of the page. The user can now drag-pan + zoom so the meaningful part lands inside the frame. Separately, when OpenLibrary has zero candidates (self-pub, new releases, non-English titles) the only fallback today is the procedural gradient — a local-disk upload route lets the user bring their own art.
- **Technical:** framing is metadata-only (CSS `object-position` + `transform: scale`) — no re-encode on the stored JPEG, no second file on disk, no migration of pre-existing covers. Upload reuses the established atomic-write helper at `<bookDir>/.audiobook/cover.jpg`, so the export pipeline (M4B `covr`, MP3 `APIC`) keeps working unchanged.
- **Architectural:** extends plan 36's data model without breaking its invariants (single JPEG path, gradient fallback on `<img onError>`, cache-bust on swap). Opens a sanctioned client→server file-upload seam that future features (custom voice samples, manuscript attachments) can reuse.

## Architectural impact

**New seams / extension points:**

- `computeCoverStyle(framing?)` helper in `src/lib/cover-framing.ts` — pure function from framing record to `{ objectPosition?, transform? }`. Surfaces in `BookCard` and `CoverArt` via a single `framing?` prop. Tested in isolation.
- Multipart upload handler in `server/src/cover/upload.ts`. Server middleware (`multer` vs. `formidable`) is selected based on what the import route already uses — audit before adding a dep.
- `state.json.coverImage.source: 'openlibrary' | 'local'` discriminator. Future "cover history" or "share this cover" features attach to this field.

**Invariants preserved (must not violate):**

- Plan 36 — fallback gradient is always intact; cache-bust by `?t=${Date.now()}` on `onPicked`; empty-string-on-remove; OpenAPI is the type source of truth.
- Plan 24 — `LibraryBook.coverFraming` and the new endpoints are defined in `openapi.yaml`, types regenerated via `npm run openapi:types`. No hand-written API types.
- Plan 25 — no hex literals in component code; the framing tab uses the existing tokens (`--peach`, `--ink`).
- Plan 26 — slice reducers (if any new) mutate via Immer drafts; no spreads.
- Plan 27 — `state.json` writes go through the existing atomic temp-file-rename writer; the new fields ride on the existing write path.

**Migration story:**

- New optional fields on `state.json.coverImage`: `source`, `originalFilename`, `uploadedAt`, `framing`. All optional — pre-existing files (which omit `source`) read as `source = 'openlibrary'` by inference (any record with `openLibraryId` is openlibrary; absent both → treat as openlibrary for back-compat).
- Pre-existing books have no `framing` block → renderers default to current behaviour (bare `object-cover`).
- Cross-link to plan [27](27-book-state-persistence.md) — this lands before plan 27's schema versioning (Should #8), so when versioning lands we'll bump to `schema: 2` retroactively to capture this shape.

**Reversibility:**

- Framing: deleting the `framing` block in `state.json` (or PATCH with `{ offsetX: 0, offsetY: 0, zoom: 1 }`) restores the original render.
- Uploaded cover: DELETE `/cover` (plan 36) wipes the file + metadata. Falls back to gradient.
- Endpoints: new endpoints are additive — removing them doesn't break the existing OpenLibrary flow.

## Invariants to preserve

1. `<bookDir>/.audiobook/cover.jpg` is the only JPEG path. Both OpenLibrary and local uploads land here. Framing never writes bytes.
2. `computeCoverStyle(undefined) === {}` — pre-existing books with no framing render identically to today's `object-cover` behaviour.
3. Upload accepts only `image/jpeg` and `image/png`. PNG is transcoded to JPEG server-side so the export pipeline's `covr`/APIC frames stay JPEG. Other content types → 415.
4. Upload size cap = 10 MB. Larger → 413 with a clear error message in the picker.
5. Framing values are clamped server-side: `offsetX`, `offsetY` ∈ [-100, 100]; `zoom` ∈ [1.0, 3.0]. Out-of-range → 400.
6. The export pipeline reads bytes off disk, not from `state.json.coverImage`. Adding `framing` metadata must not change export behaviour. Plan 36's `build-m4b.test.ts` and `id3-tags.test.ts` continue to pass without modification.
7. The "Remove cover" button in the picker footer (plan 36) is unaffected — it still DELETEs the file and clears all metadata, including any uploaded `originalFilename` and `framing`.

## Test plan

### Automated coverage

To add in the implementation run (this plan ships paired tests, per the testing discipline in `CLAUDE.md`):

- **Vitest unit** `src/lib/cover-framing.test.ts` (new) — `computeCoverStyle({offsetX, offsetY, zoom})` boundary cases: undefined → `{}`; zoom=1 → only `objectPosition`; zoom>1 → both `objectPosition` and `transform`; signed offsets map symmetrically; clamping happens at the boundary (-100, 100, 1.0, 3.0).
- **Vitest component** `src/modals/cover-picker.test.tsx` (extend) — three new describe blocks:
  - "tab switching" — Search/Upload/Frame visibility (Frame disabled when no cover is pinned).
  - "upload happy path + rejection" — selecting a JPEG fires `api.uploadCover`; selecting a 12 MB file shows a size error; selecting a GIF shows a type error.
  - "framing save" — dragging the canvas + adjusting the zoom slider, then Save fires `api.setCoverFraming` with the right payload.
- **Vitest component** `src/views/book-library.test.tsx` (extend) — overlay `<img>` style reflects `coverFraming` prop (assert `style.objectPosition`).
- **Vitest component** `src/views/listen.test.tsx` (extend) — same for `CoverArt`.
- **Vitest server** `server/src/routes/cover.test.ts` (extend) — supertest cases for the two new endpoints: happy path; validation 400s (out-of-range framing values; missing file field); 404 on unknown bookId; 413 on oversized multipart; 415 on `image/gif`.
- **Vitest server** `server/src/cover/upload.test.ts` (new) — JPEG passes through unchanged; PNG is transcoded to JPEG; rejection of `application/pdf`.
- **Playwright e2e** `e2e/cover-upload.spec.ts` (optional, can defer) — open picker → Upload tab → `setInputFiles` with a test PNG → assert modal closes and BookCard `<img>` `src` updates. Defer-acceptable per `CLAUDE.md` if scope tight.

### Manual acceptance walkthrough

Canonical end-to-end manuscript: `server/src/__fixtures__/the-coalfall-commission.md` (per `CLAUDE.md`). Run with the real backend + Kokoro sidecar.

1. **Fresh import.** Books → Start a new book → paste the canonical manuscript. Within ~2 s the BookCard flips from gradient to OpenLibrary cover (top half cropped by default — this is the problem we're solving).
2. **Frame tab.** Open the card's "..." menu → **Cover image** (modal header label changed from plan 36's "Find cover image"). Click the **Frame** tab. The canvas shows the cover at 1:1 with the current crop position. Drag down so the title text is visible inside the square. Adjust the zoom slider to ~1.4× to tighten on the title. Click **Save**.
   - Expected: modal closes; BookCard repaints with the new framing; Listen header's `CoverArt` also repaints (next visit). `Cmd/Ctrl+R` reload preserves the framing — comes back identical.
3. **Upload tab.** Re-open the picker. Click the **Upload** tab. Drag a local PNG onto the drop zone (or click "Choose file"). Preview renders. Click **Save**.
   - Expected: modal closes; BookCard shows the uploaded image (transcoded to JPEG on disk — verify with `ls <bookDir>/.audiobook/cover.jpg`); the previous OpenLibrary metadata is replaced with `source: 'local'`, `originalFilename`, `uploadedAt` in `state.json`.
4. **Re-frame the uploaded cover.** Frame tab → adjust → Save. Same flow as step 2 but on the uploaded image. Framing persists.
5. **Export sanity.** Trigger an M4B export from the Listen view. Run `ffprobe -show_streams <exported.m4b>` and confirm `Stream #0:2: Video: mjpeg (attached_pic)` is still present — the uploaded JPEG is now the embedded cover. Bytes match `<bookDir>/.audiobook/cover.jpg` (md5 compare).
6. **Type/size rejection.** Upload tab → drag a `.gif`. Error toast "Only JPEG and PNG covers are supported." Drag a 12 MB JPEG. Error toast "Cover must be under 10 MB."
7. **Remove + fallback.** Modal footer → **Remove cover**. Gradient skeleton returns on both surfaces; framing block is gone from `state.json`.
8. **Pre-existing book.** Open a book whose cover was set under plan 36 (before this change shipped). Confirm it still renders with default (un-framed) `object-cover` — no visual regression.

## Account-level defaults

`UserSettings.coverPickerDefaultTab` (enum `'search' | 'upload'`, default
`'search'`) controls which tab the modal opens on first paint. Persisted
to `server/user-settings.json` via the existing user-settings Zod schema
(`server/src/workspace/user-settings.ts`). Read at modal mount via
`useAppSelector(s => s.account.coverPickerDefaultTab)` so account-wide
preference takes effect on the next picker open without a refresh.

The Frame tab is never a valid default — it requires a cover, which a
new book may not have. The schema enum explicitly excludes it.

**Parked follow-ups (deferred this round, not part of v1):**

- `defaultFramingZoom` (per-account default zoom). Covers vary enough
  that a global value isn't useful; per-cover framing on the Frame tab
  handles the real case.
- `autoFetchCoverOnBookCreate` (new background behaviour — auto-pick the
  top OpenLibrary candidate at book-create time). Larger scope, separate
  follow-up plan.

## Out of scope

- **Per-surface framing.** Same framing applies to both `BookCard` (16:10) and `CoverArt` (1:1). A future iteration could split.
- **Baking framing into the exported JPEG.** Today the export embeds the raw on-disk bytes; the framing is in-app only. The mismatch is intentional v1 — re-encoding on export adds latency and a step. Revisit if user feedback prioritises it.
- **Multi-cover history.** Single current cover only; uploading a new one replaces the old.
- **Camera capture / clipboard paste.** Disk file picker only.
- **Cover sourcing beyond OpenLibrary + local disk.** Google Books / Amazon / etc. are not in scope; see plan 36's rationale for OpenLibrary-only.
- **Drag-pan on touch devices.** Pointer events should cover both mouse and touch via `pointerdown`/`pointermove`, but a dedicated touch QA pass is deferred until the app surfaces on mobile (not v1).

## Ship notes

Shipped 2026-05-17 across four commits on `feat/frontend-plan-40`:

1. **Phase 1 — Foundation** (commit `513bc54`): OpenAPI extensions
   (`UserSettings.coverPickerDefaultTab`, `CoverFraming` schema,
   `LibraryBook.coverFraming`, `POST /cover/upload`,
   `PATCH /cover/framing`). `src/lib/cover-framing.ts` pure helper
   (`computeCoverStyle`, `clampFraming`, `DEFAULT_FRAMING`) +
   15 Vitest cases.
2. **Phase 2 — Server** (commit `ac15540`): multipart upload via
   multer with `LIMIT_FILE_SIZE` → 413 mapping, PNG → JPEG transcode
   via `sharp@^0.34` (q=85), atomic write through
   `workspace/atomic-rename`. `patchStateFraming` clamps server-side
   to [-100,100] / [1.0, 3.0]. `BookStateJson.coverImage` shape
   extended (legacy records infer `source: 'openlibrary'` from
   `openLibraryId`); `LibraryBook.coverFraming` surfaced by scan when
   both file and state are present. +32 server tests across
   `upload.test.ts`, `cover.test.ts` (extended),
   `user-settings.test.ts` (new).
3. **Phase 3 — Frontend API + account** (commit `4885dba`):
   `api.uploadCover`, `api.patchCoverFraming`, `UploadCoverError`
   typed envelope. `setCoverPickerDefaultTab` reducer on the account
   slice. "Covers" FormCard in `src/views/account.tsx`. +3
   account-slice tests.
4. **Phase 4 — UI + render integration** (commit `a03a5cc`):
   Three-tab CoverPicker (Search / Upload / Frame) with the account
   default seeding the initial tab. Upload tab does client
   pre-validation (MIME + size); on success the modal auto-switches
   to Frame for immediate reframing. Frame tab is a square preview
   with Pointer-Events drag (touch + mouse via the unified API),
   zoom range 1.0–3.0× step 0.05, Reset button. PATCH debounced
   300 ms after last interaction. `BookCard` + `CoverArt` apply
   `computeCoverStyle(framing)` to the `<img>` style; routes/index
   threads `bookCoverFraming` through to ListenView. +13 frontend
   tests across `cover-picker.test.tsx`, `book-library.test.tsx`,
   `listen.test.tsx`. +1 e2e spec (`e2e/cover-framing.spec.ts`)
   exercising the upload → Frame auto-switch → zoom → Reset path.

Net diff vs main at ship: ~20 files / +2k lines (incl. test fixtures
and regenerated `api-types.ts`). Full pre-push verify green; the only
intermittent miss was the pre-existing `export.test.ts` DELETE-cancels
flake, unrelated and known.
