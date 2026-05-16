# 36 — Book cover imagery (OpenLibrary)

Status: **stable**

The library card and the Listen detail header render real publisher cover
art when one is cached on disk, sourced from OpenLibrary. When no cover
exists the existing procedural gradient + concentric rings render as a
fallback skeleton.

## Why

Procedural gradients are recognisable but visually homogeneous — the
user wants a quick visual cue that says *this book*, not *this slot in
the workspace*. OpenLibrary is keyless and dedicated to book covers, so
it slots in cleanly without an API-key bootstrap (no GOOGLE_CSE_*, no
quota dashboard).

## Storage

- Bytes: `<bookDir>/.audiobook/cover.jpg` (helper: `coverImagePath` in
  `server/src/workspace/paths.ts`).
- Metadata: `state.json` gains an optional `coverImage` field —
  `{ openLibraryId, originalUrl, fetchedAt }`. Library scan
  (`server/src/workspace/scan.ts`) only surfaces `coverImageUrl` when
  both the file AND the state.json field are present, so a half-completed
  fetch falls back to the gradient cleanly.

## Endpoints

All under `/api/books/{bookId}`:

- `GET  /cover/candidates` → `{ candidates: CoverCandidate[] }` (≤6).
  Routes to `searchCovers(title, author)` in
  `server/src/cover/openlibrary.ts`.
- `POST /cover` body `{ openLibraryId }` → `{ coverImageUrl }`. Re-runs
  the search, downloads the JPEG to disk atomically (tmp + rename),
  patches `state.json.coverImage`.
- `GET  /cover` → JPEG bytes with `Content-Type: image/jpeg`,
  `Cache-Control: public, max-age=3600`. 404 when not cached.
- `DELETE /cover` → 204; removes the file + clears state.json.

## Triggers

Two flavours of fetch:

1. **Auto on import.** `routes/import.ts` fires `backgroundFetchCover`
   (fire-and-forget) right after the first `state.json` write. Picks
   the top OpenLibrary candidate silently. Errors are logged + swallowed
   so OpenLibrary outages can never fail an import.
2. **Manual on demand.** Each library card's "..." menu has a
   **Find cover image** item; the Listen header has a hover-only
   **Change cover** button on the cover. Both open the
   `CoverPicker` modal (`src/modals/cover-picker.tsx`) which renders a
   2×3 grid of candidate thumbnails. Clicking a tile POSTs the chosen
   `openLibraryId`. A **Remove cover** button (rendered only when a
   cover is already pinned) DELETEs and reverts to the gradient.

## Invariants

- **Fallback is always intact.** Both `BookCard` (in
  `src/views/book-library.tsx`) and `CoverArt` (in `src/views/listen.tsx`)
  render the gradient + SVG rings + title text underneath any image, and
  flip back to those when `<img>` errors via `onError`. A missing cover
  on disk → 404 from the GET route → `onError` → gradient. No broken
  image icon ever paints.
- **Cache-bust on swap.** After a successful pick, both surfaces shadow
  the prop with a local override URL appended with `?t=${Date.now()}` so
  the browser refetches the new bytes from the same path.
- **Empty string = removed.** The picker's `onPicked` passes `''` after
  a successful DELETE so the local override hides the prop's stale
  `coverImageUrl` until the parent library refresh resolves.
- **Mock mode is visually meaningful.** `VITE_USE_MOCKS=true` returns 4
  fixed OpenLibrary URLs so the picker grid renders real thumbnails for
  visual review without hitting the server.
- **OpenAPI is authoritative.** `LibraryBook` carries an optional
  `coverImageUrl: string`. The CoverCandidate schema lives in
  `components/schemas/CoverCandidate`. Regenerated via
  `npm run openapi:types` after spec edits.

## KNOWN: scaffolded

- **Export embedding deferred.** Cover bytes are cached at
  `<bookDir>/.audiobook/cover.jpg` and served via `GET /api/books/:bookId/cover`,
  but `server/src/export/build-m4b.ts` and `server/src/export/id3-tags.ts`
  (used by `build-mp3-zip.ts`) do not currently feed that file into the
  output artifact. M4B exports ship without the iTunes `covr` atom and
  MP3.ZIP entries ship without an ID3v2 APIC frame, so PocketBook /
  Voice / Apple Books / BookPlayer all render their default tile rather
  than the OpenLibrary art the user picked.
  - **M4B path (planned A2)**: `buildM4b` passes the cover file as a
    second ffmpeg input with `-map 1:v -c:v copy -disposition:v:0
    attached_pic`. Gracefully skips when the file is absent. New
    regression test: `ffprobe` reports a video stream with
    `disposition.attached_pic = 1` and `codec_name = mjpeg`.
  - **MP3.ZIP path (planned A3)**: `applyId3v24Tags` gains an optional
    `coverJpegPath`; when present, the ffmpeg invocation pipes the JPEG
    in and writes the APIC frame. The existing `audioBytesOnly`
    byte-identity invariant must still hold for the audio frames —
    only the ID3v2 header grows.
  - Plan 32 + plan 33's atom-mapping references currently mark `covr`
    as parked under this section. A4 lifts those caveats once A2 + A3
    ship.
- **No state-driven cover override yet.** The picker writes
  `state.json.coverImage = { openLibraryId, originalUrl, fetchedAt }`,
  but the export-embedding path will read the file directly off disk
  rather than threading the metadata block through the builder. That's
  fine for v1; the `coverImage` block is informational (powers the
  picker's "currently pinned" annotation, not the bytes).

## Test coverage

Automated:

- `server/src/cover/openlibrary.test.ts` — search dedupe, URL shapes,
  empty/no-input fast path, content-type / size cap enforcement,
  timeout error class, atomic-write target.
- `server/src/routes/cover.test.ts` — supertest integration covering
  all four endpoints, error paths (400 missing id, 404 stale candidate,
  502 OpenLibrary 5xx), and 404 on unknown bookId for every route.
- `src/modals/cover-picker.test.tsx` — loading / ready / empty / error
  states, pick happy path + failure-without-close, conditional Remove
  cover button, closed-state inertness.
- `src/views/book-library.test.tsx` — overlay `<img>` only renders when
  `coverImageUrl` is set on the book.
- `src/views/listen.test.tsx` — overlay `<img>` renders on the Listen
  cover when `bookCoverImageUrl` is set; gradient skeleton when null.

## Acceptance walkthrough (manual)

Canonical end-to-end manuscript: `C:\Users\dudar\Downloads\Bonus Keefe Story.txt`
(per `CLAUDE.md`).

1. Fresh import via the Books → Start a new book flow. Within ~2 seconds
   the library card flips from the gradient to a real cover (OpenLibrary
   auto-fetch).
2. Reload (`Cmd/Ctrl+R`). Cover persists — it's served from
   `/api/books/:bookId/cover` against the cached bytes.
3. Open the card's "..." menu → **Find cover image**. Modal opens with
   4–6 thumbnails. Pick a different one → modal closes; card repaints
   with the new image. The Listen view's cover updates on next mount.
4. Re-open the picker → **Remove cover**. Gradient skeleton returns.
5. With the server stopped, refresh. Gradient skeleton renders; no 500s
   in console; the `<img onError>` swallows the failure cleanly.
6. Import a fictional title with no OpenLibrary match (e.g.
   "Definitely Not A Real Book by Nobody"). Import succeeds, card shows
   the gradient, **Find cover image** modal renders the "No covers found
   for …" empty state.

## Files

Modified:
- `openapi.yaml` (LibraryBook.coverImageUrl, CoverCandidate schema, 4 endpoints)
- `src/lib/api-types.ts` (regenerated)
- `src/lib/types.ts` (LibraryBook.coverImageUrl, CoverCandidate alias)
- `src/lib/api.ts` (findCoverCandidates, setCover, removeCover + mocks)
- `src/lib/icons.tsx` (IconImage)
- `src/views/book-library.tsx` (overlay + menu item + picker host)
- `src/views/listen.tsx` (overlay + change-cover button + picker host)
- `src/routes/index.tsx` (onCoverChanged plumbing for both views)
- `server/src/workspace/paths.ts` (coverImagePath)
- `server/src/workspace/scan.ts` (BookStateJson.coverImage + LibraryBook.coverImageUrl)
- `server/src/routes/import.ts` (background auto-fetch hook)
- `server/src/index.ts` (coverRouter mount)

Created:
- `server/src/cover/openlibrary.ts`
- `server/src/cover/openlibrary.test.ts`
- `server/src/routes/cover.ts`
- `server/src/routes/cover.test.ts`
- `src/modals/cover-picker.tsx`
- `src/modals/cover-picker.test.tsx`
