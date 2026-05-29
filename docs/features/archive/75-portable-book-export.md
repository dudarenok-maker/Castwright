---
status: stable
shipped: 2026-05-20
owner: dudarenok
---

# 75 — Portable book bundle (export + import)

> Status: stable
> Key files: `server/src/export/build-portable-book.ts`, `server/src/import/scan-import-folder.ts`, `server/src/routes/exports-portable.ts`, `src/components/listen/listen-download-section.tsx`, `src/components/library/library-chrome.tsx`, `src/views/book-library.tsx`, `src/lib/api.ts`
> URL surface: Listen view ("Or download a file" rail — Portable bundle tile); Library view ("Import portable bundle" button next to "Start a new book").
> OpenAPI ops: `GET /api/books/{bookId}/export/portable`, `POST /api/import/portable`

## Benefit / Rationale

- **User:** Move a complete in-progress (or finished) book between machines without re-uploading the manuscript, re-running analysis, re-casting voices, or re-rendering chapter audio. Closes the gap between "I generated this on my desktop GPU" and "I want it on my laptop" — and gives the same artifact a second life as a per-book backup.
- **Technical:** A single .zip captures every load-bearing artifact under `books/<Author>/<Series>/<Book>/`: state.json, manuscript, audio/*, .audiobook/cover.*, .audiobook/change-log.json, audio/<slug>.peaks.json, audio/<slug>.segments.json. `MANIFEST.json` carries schemaVersion + sha256 hashes so import-side validation is independent of file ordering.
- **Architectural:** Establishes a versioned bundle format (`PORTABLE_SCHEMA_VERSION`) the workspace tree can be projected into and rehydrated from. Per-file atomic write (.tmp sibling → rename) keeps a half-imported book recoverable by deleting the partial target dir.

## Architectural impact

- **New seams / extension points:**
  - `buildPortableBundle(bookDir, state)` returns `{ buffer, sizeBytes, entries, manifest }` — pure function over a book directory. Independent of route plumbing so tests can drive it directly with a fixture tree.
  - `importPortableBundle(zipBuffer, opts)` with `onConflict: 'rename' | 'overwrite' | 'fail'`. Default `'rename'` keeps a double-click on Import from silently overwriting.
  - `MANIFEST.json` envelope shape pins the schema (currently version 1).
  - `api.exportPortable(bookId): Promise<Blob>` + `api.importPortable(file): Promise<PortableImportResult>` — frontend-facing surface, both real and mock.
- **Invariants preserved:**
  - `BookStateJson` schema unchanged — the bundle ships whatever shape state.json currently has (forward-compat with parallel agents adding `audioFormat` / `tags`).
  - `listen-progress.json` stays per-machine and is never bundled.
  - Existing three download tiles (M4B, MP3 ZIP, Streaming link) untouched — the Portable bundle is a 4th tile.
- **Migration story:** First-ship of the format, no migration. Future incompatible changes bump `PORTABLE_SCHEMA_VERSION`; the import side refuses bundles with a higher version than the running server understands (HTTP 400, `reason: 'unsupported_schema'`).
- **Reversibility:** No on-disk schema changes; removing the routes + tile reverts the feature with no data loss. Bundles produced under v1 remain readable.

## Bundle internal layout

```
portable-book/
  MANIFEST.json
  state.json
  manuscript.<ext>
  cover.<ext>           (optional — .jpg, .png, ...)
  change-log.json       (optional)
  audio/
    <chapter-slug>.mp3         (or .m4a / .ogg / .opus, mirroring disk)
    <chapter-slug>.segments.json
    <chapter-slug>.peaks.json  (when present)
```

Deterministic entry order: MANIFEST first → state.json → manuscript → cover (if any) → change-log (if any) → audio entries in chapter-id order. Every entry is "stored" (no deflate) — MP3 / M4A are already compressed, and stored entries make round-trip checksum tests stable.

## MANIFEST schema (v1)

```jsonc
{
  "schemaVersion": 1,
  "exportedAt": "2026-05-20T12:00:00.000Z",
  "exportedFrom": {
    "appVersion": "1.3.1",
    "stateSchemaVersion": 2          // optional, present iff state.json.schema is set
  },
  "book": {
    "bookId": "demo__standalones__example",
    "title": "Example",
    "author": "Demo",
    "series": "Standalones"
  },
  "contents": {
    "stateJsonHash": "<sha256-hex>",
    "manuscriptHash": "<sha256-hex>",
    "coverHash": "<sha256-hex>",     // optional
    "audioCount": 12,
    "totalSizeBytes": 47482817
  }
}
```

## Excluded files

- `.audiobook/listen-progress.json` — per-machine listening bookmark.
- `.audiobook/analysis-state.json` — in-flight analyzer scratch.
- `.audiobook/dropped-quotes.json` — operator-audit only, large, not needed to re-create the book.
- `.audiobook/exports/` — staged export artifacts.
- `.audiobook/state.json.bak.*` — rotating backups; the live state.json is the authoritative copy.
- `audio/<slug>.previous.mp3` / `.previous.segments.json` — rollback-only artifacts; not portable.

## Conflict handling on import

When the target `books/<Author>/<Series>/<Title>/` directory already exists:

| `onConflict` | Behaviour |
|---|---|
| `rename` (default) | Appends ` (imported)`, then ` (imported 2)`, ` (imported 3)`, … to the title until the slug-based directory is free. state.json's `title` + `bookId` are rewritten in-place to match. The response includes `conflict: { strategy: 'rename', renamedTo: '<new path>' }`. Capped at 100 attempts. |
| `overwrite` | Writes into the existing directory, replacing files by path. Files on disk that are NOT in the bundle are LEFT IN PLACE — listen-progress.json survives an overwrite. |
| `fail` | Returns HTTP 409 with `{ error: 'bundle_conflict', existingPath }` without touching disk. |

## Round-trip guarantee

For any fixture book exported via `buildPortableBundle` and re-imported via `importPortableBundle`, the following are byte-identical:

- state.json (modulo title/bookId edits in the `rename` branch)
- manuscript.<ext>
- every `audio/<slug>.<ext>`
- cover.<ext>, when present
- change-log.json, when present

Pinned by `server/src/import/scan-import-folder.test.ts` "round-trip" case. The MANIFEST `exportedAt` field is the one expected non-deterministic field; everything else in MANIFEST is hash-derived and stable.

## Invariants to preserve

- `PORTABLE_SCHEMA_VERSION` in `server/src/export/build-portable-book.ts:31` MUST be bumped on any incompatible MANIFEST or layout change.
- `buildPortableBundle` MUST exclude `.audiobook/listen-progress.json` and `.previous.*` files — pinned by the matching test cases in `build-portable-book.test.ts`.
- `importPortableBundle` default conflict strategy MUST be `'rename'` — pinned by `scan-import-folder.test.ts` ("rename strategy on conflict").
- `state.manuscriptFile` MUST be preserved through the round-trip — the bundle's manuscript entry name mirrors this field. Pinned by the round-trip test.
- The Listen view's existing three download tiles MUST remain present alongside the Portable tile. Pinned by `listen-download-section.test.tsx` ("renders the Portable bundle tile alongside the existing three").
- The Library view's "Import portable bundle" button MUST be additive — absent when `onImportPortable` prop is not provided. Pinned by `book-library.test.tsx` ("omits the Import button entirely when onImportPortable is not provided").

## Test plan

### Automated coverage

- Vitest server (`server/src/export/build-portable-book.test.ts`) — 9 cases covering MANIFEST shape + hash assertions, listen-progress exclusion, `.previous.*` exclusion, peaks.json inclusion, audio round-trip, deterministic entry order, optional-file omission, missing-manuscript rejection, byte-determinism across two runs.
- Vitest server (`server/src/import/scan-import-folder.test.ts`) — 7 cases covering basic write, missing-MANIFEST rejection, future-schema rejection, default rename conflict handling, fail conflict handling, overwrite-preserves-private-files, end-to-end round-trip (build → import → byte-identical).
- Vitest server (`server/src/routes/exports-portable.test.ts`) — 5 cases covering GET 200 with zip body + Content-Disposition, GET 404 on unknown book, POST multipart accept + rename, POST 400 on malformed zip, POST 400 on missing file field.
- Vitest frontend (`src/components/listen/listen-download-section.test.tsx`) — 3 cases for the Portable bundle tile (renders alongside existing three, fires callback, disables when no handler).
- Vitest frontend (`src/views/book-library.test.tsx`) — 2 new cases for the Import button (renders + fires handler when `onImportPortable` is provided; omitted otherwise).

### Manual acceptance walkthrough

Run with the real server + `npm run dev` (mock mode also works end-to-end on the tile presence; the round-trip requires the real backend).

1. Open Listen view for any complete book. The "Or download a file" rail now shows four tiles in a 4-column grid on desktop. The fourth tile is "Portable bundle".
2. Click Download on the Portable bundle tile. The browser saves a `<slug>.portable.zip` file. Open it with any zip viewer and confirm MANIFEST.json is the first entry.
3. Navigate to the Library view. A pill button "Import portable bundle" sits to the left of "Start a new book".
4. Click Import portable bundle, select the zip from step 2. A toast surfaces "Imported: <book-title>"; the library refreshes and the imported book appears (with " (imported)" appended to the title if the source book was still present in the workspace).
5. Open the imported book — every chapter has audio, the manuscript matches, and the cover is identical.

## Out of scope

- No cross-version migration. A bundle declaring `schemaVersion: 2` from a future build is refused with HTTP 400; the operator must use a server new enough to read it.
- No encrypted bundles. Bytes are written verbatim — share carefully.
- No diff/merge of an imported book against an existing book ("apply the new analysis but keep the old audio"). Operators wanting that today use `onConflict: 'rename'` and copy artifacts manually.
- No multi-book bundles. One bundle = one book. A workspace-wide backup is a future Could.
- No streaming import for very large bundles. The current implementation loads the whole zip into memory; the multipart limit (50 MB matching the manuscript upload) keeps this bounded.

## Ship notes

Shipped 2026-05-20 on branch `feat/server-portable-book-export`. Closes BACKLOG Could #10 ("Portable book export with embedded state"). Adds the `yauzl` (and `@types/yauzl`) dependency to `server/package.json` since it was not previously installed despite being a natural pair for the existing `yazl` writer.
