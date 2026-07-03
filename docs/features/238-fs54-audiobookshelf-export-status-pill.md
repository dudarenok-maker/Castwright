---
status: active
shipped: null
owner: null
---

# 238 — fs-54: Audiobookshelf export robustness + global Export status pill

> Status: active
> Key files: `server/src/export/build-m4b.ts`, `server/src/export/id3-tags.ts`, `server/src/export/build-mp3-folder.ts`, `server/src/export/sync-folder.ts`, `server/src/routes/export.ts`, `src/modals/export-audiobook.tsx`, `src/store/exports-slice.ts`, `src/store/export-pill-middleware.ts`, `src/components/top-bar.tsx`, `src/components/layout.tsx`, `src/components/status-popover.tsx`
> URL surface: indirect — the export modal (`#/books/<id>/listen`) and the top-bar Status pill, present everywhere
> OpenAPI ops: none — no wire-protocol change

## Benefit / Rationale

- **User:** an Audiobookshelf user gets series metadata, an ABS-native `metadata.json`, a folder cover, an M4B option, and author-grouped sync folders — the tile is no longer identical to Smart AudioBook Player/BookPlayer's. Everyone gets a persistent Export pill so a started export doesn't require staying on the Listen view to know when it finishes.
- **Technical:** closes a real bug (metadata.json/cover.jpg were being silently dropped by the sync-folder copy filter) and a wrong-gate bug (series metadata) caught during design review — see the design spec's three assumption-checker rounds.
- **Architectural:** the Export pill reuses the exact Analysis/Generation/Design pill pattern (cross-book aggregation IIFE in `layout.tsx`, terminal-linger middleware modeled on `cast-design-stream-middleware.ts`) rather than inventing a new one.

## Architectural impact

- **New seams:** `ExportsState.linger` + `exportLingerSet`/`exportLingerCleared` actions; `export-pill-middleware.ts` as a new middleware in the store chain.
- **Invariants preserved:** no `BookExportRequest`/`BookExportJob` wire-schema change; `writeFolderToSyncFolder`/`writeToSyncFolder` signatures unchanged (author-nesting is caller-side in `routes/export.ts`).
- **Migration story:** none — additive slice state, defaults to `{}`.
- **Reversibility:** each of the 12 tasks is an independent commit; any can be reverted without breaking the others except Task 8 (exports-slice) is a dependency of Task 9/11.

## Invariants to preserve

- The series-emission gate is `state.isStandalone !== true && !!state.series?.trim()` — never presence of `state.series` alone. Pinned by `build-m4b.test.ts`, `build-mp3-folder.test.ts`'s "Audiobookshelf sidecars" describe block, and `id3-tags.test.ts`.
- `writeFolderToSyncFolder`'s copy filter is an allowlist (`.mp3` OR `metadata.json` OR `cover.jpg`), not a bare extension check — `server/src/export/sync-folder.ts`. Pinned by `sync-folder.test.ts`'s "copies metadata.json and cover.jpg through the allowlist" case.
- Sync-folder destinations nest under `<syncFolder>/<sanitizeForZip(author)>/...` — a breaking layout change from the prior flat structure, applied uniformly to both `writeFolderToSyncFolder` and `writeToSyncFolder` call sites in `routes/export.ts`. Pinned by `export.test.ts`'s two "nests ... under a sanitized author subfolder" cases.
- The Export pill's visibility is the union of (a) any non-terminal job and (b) an active linger entry — `layout.tsx`'s `exportPill` IIFE. Breaking this union makes the linger unreachable (the pill would vanish the instant the last job goes terminal).

## Testing

Full matrix: `build-m4b.test.ts`, `id3-tags.test.ts`, `build-mp3-folder.test.ts`, `sync-folder.test.ts`, `export.test.ts` (server); `export-audiobook.test.tsx`, `exports-slice.test.ts`, `export-pill-middleware.test.ts`, `top-bar.test.tsx`, `layout.test.tsx`, `status-popover.test.tsx` (frontend). No new e2e — the pill aggregation is exercised by rendering the real `<Layout>` in `layout.test.tsx`, and the export modal/tile flow is already covered by existing Playwright specs at the browser level.

## Residual / follow-up

- Whether a pre-`isStandalone`-field legacy book could reach the export path with `state.isStandalone` genuinely `undefined` on disk was flagged during design review as unresolved — `import.ts` guarantees an explicit boolean on every book created through it, but this wasn't independently re-verified against `state-migrate.ts`'s backfill coverage. Worth a spot-check during implementation if a real legacy-book test fixture is available.
- The M4B path carries series metadata via the `grouping`/`disc` MP4 atoms (Task 1) rather than a dedicated series field, since ffmpeg's mov muxer drops any `-metadata` key it doesn't recognize (verified against real ffmpeg during plan review) — whether Audiobookshelf's own M4B parser reads either atom as series info is unconfirmed. The mp3-folder path's `metadata.json` (Task 4) remains the authoritative, ABS-documented series channel.
- Direct Audiobookshelf API push + post-sync library-rescan trigger — explicitly out of scope (needs a new ABS server URL + API key setting).
- Series-level folder nesting (`<author>/<series>/<title>/`) and a cross-book export queue modal — explicitly out of scope, see the design spec's Future work section.
- **`metadata.json`'s exact schema needs on-box confirmation against a real Audiobookshelf install** (found during the mandatory PR code-review): the tests only assert what `writeAudiobookshelfSidecars` writes, never that ABS actually parses it — specifically whether `series` wants `{name, sequence}` objects (current implementation) vs. a `"Name #1"` string, and whether `publishedYear` should be a string rather than a number. A shape mismatch would silently defeat the authoritative half of Part 1 (ABS falls back to embedded tags/filename parsing) with zero test signal, since there's no real ABS instance in this repo's test matrix.
- **Sync-folder destinations never prune stale files** (found during the mandatory PR code-review) — `writeFolderToSyncFolder` only copies files present in the fresh staging dir; it never removes a destination file that's absent from the current export. This is a pre-existing limitation of the whole sync-folder mechanism (predates fs-54), but Task 4's conditional `cover.jpg` (written only when a cover currently exists) makes it newly visible: removing a book's cover and re-exporting leaves the old `cover.jpg` sitting in the Audiobookshelf-scanned folder indefinitely, since ABS treats the folder-level cover as authoritative over embedded art. Fixing this well (deciding whether to prune only `cover.jpg`, or diff-and-prune more broadly, and how that interacts with a user's own files that may live alongside a sync target) is its own small design question, not folded into this PR.
- **Single-file M4B sync-folder exports land flat under `<author>/`, not `<author>/<title>/`** (checked during the mandatory PR code-review, which flagged it as plausible but unconfirmed) — unlike the mp3-folder branch. This is intentional, not an oversight: `bookFilename()` derives the filename from the book's *title* (`slugify(state.title)`), so two books by the same author never collide on-disk, and the design spec (§1.1) explicitly chose M4B specifically because it's "the more robust single-file shape … no folder-content ambiguity" — it doesn't need a folder wrapper the way mp3-folder's per-chapter files + sidecars do. Whether Audiobookshelf's scanner actually treats several top-level `.m4b` files under one author folder as independent single-file books (a documented, common ABS layout) rather than merging them is the same class of on-box-only uncertainty as the `metadata.json` schema item above — not verifiable from this repo's test matrix.
