---
status: draft
date: 2026-07-03
topic: fs-54 Audiobookshelf export/hand-off robustness + global Export status pill
---

# fs-54 — Audiobookshelf export robustness + a global Export status pill

_Design spec · 2026-07-03 · issue [#978](https://github.com/dudarenok-maker/Castwright/issues/978) (`moscow:could`, `area:fs`, `type:feature`)_

This spec is **design/plan only** — implementation is a separate handover.

## Problem

**fs-54 (the tracked issue):** the Audiobookshelf tile in the export modal
(`src/components/listen/listen-download-section.tsx:203-227`) already exists, but it's
literally identical to the two other folder-scanning-app tiles (Smart AudioBook Player,
BookPlayer): `mp3-folder` format, `sync-folder` destination, per-chapter ID3v2.4 tags,
flat `<syncFolder>/<book-title>/` layout (`docs/features/archive/34-mp3-folder-export.md`).
Nothing about the hand-off is actually Audiobookshelf-specific. Gaps against how
Audiobookshelf actually ingests a library:

- No series/series-position anywhere in exported metadata (ID3 or FFMETADATA) — a real
  gap given Audiobookshelf surfaces series prominently and Castwright's series-memory
  feature (`fe-40`) is a marketed moat.
- No `metadata.json` sidecar — Audiobookshelf's own preferred, most reliable metadata
  source (it takes priority over embedded tags when present).
- No folder-level `cover.jpg` — Audiobookshelf's folder-scan mode looks for one in
  addition to embedded art.
- No single-file M4B option offered on the tile, despite Castwright already building a
  fully-chaptered, cover-embedded M4B for the separate Voice tile — arguably the more
  robust hand-off shape for Audiobookshelf.
- Flat folder layout has no author level, so Audiobookshelf's "Author/Series/Title"
  library-scan mode can't group a multi-book, multi-author sync folder correctly.

**Adjacent, newly-identified gap (not yet tracked as its own issue):** the export queue
lives and is only visible inside the Listen view's `ExportQueue` rail
(`listen-download-section.tsx:314-374`). The underlying job data
(`src/store/exports-slice.ts`) is already global and cross-book (a store-level
`createExportPollMiddleware` keeps polling regardless of which view is mounted), but
there is no cross-app way to see "an export is running" or "an export just finished"
without physically navigating back to that book's Listen view — unlike Analysis,
Generation, and "Design full cast", which all get a persistent pill in the top bar
(`src/components/top-bar.tsx`) that survives navigation.

## Goals

- Make the Audiobookshelf hand-off actually robust against how Audiobookshelf ingests a
  folder library: series metadata, an ABS-native sidecar, cover art at the folder level,
  a single-file M4B option, and author-level folder grouping.
- Do the above via **shared builder/primitive changes** wherever a change benefits more
  than just Audiobookshelf, rather than bolting on Audiobookshelf-only code paths —
  avoids a wire-protocol change (no `appHint` needs to reach the server) and keeps the
  three folder-scanning tiles behaviorally consistent.
- Add a fourth global status pill — **Export** — mirroring the existing
  Analysis/Generation/Design pills exactly: cross-book aggregation, stalled detection,
  survives navigation, one click routes back to the relevant book.

## Non-goals (out of scope for this spec)

- **Direct Audiobookshelf API push** (uploading/registering a book via ABS's HTTP API)
  and **triggering a library rescan** after a sync-folder write. Both need a new
  ABS-server-URL + API-key setting that doesn't exist today. Documented here as the
  natural next phase; not designed further in this spec. (Per the triage decision on
  issue #978: Audiobookshelf support is "a bridge, not a pivot" — the companion app
  remains the strategic library answer, so this stays file-export-first.)
- **Series-level folder nesting** (`<syncFolder>/<author>/<series>/<title>/`). Only an
  author level is added; a series level is a plausible future refinement, not required
  for Audiobookshelf to ingest correctly.
- **A cross-book export queue modal.** The Export pill always routes to a single book's
  Listen view (the existing `ExportQueue` rail), even with multiple concurrent exports —
  no new modal UI.
- **New e2e coverage.** Existing Playwright specs already cover the export
  modal/tile flow at the browser level; the pill aggregation logic is a Vitest-level
  concern (jsdom can exercise `layout.tsx`'s pill IIFEs directly), matching how the
  Analysis/Generation/Design pills are tested today.

## Design — Part 1: Audiobookshelf hand-off robustness

### 1.1 Format choice on the Audiobookshelf tile

The export modal's `TILE_HINTS` entry for `appHint: 'audiobookshelf'`
(`src/modals/export-audiobook.tsx`) stops collapsing to one fixed
`{ format: 'mp3-folder', destination: 'sync-folder' }` prefill. It exposes a format
toggle between `mp3-folder` and `m4b`, both defaulting to `destination: 'sync-folder'`.
Users on Audiobookshelf's "Book" folder-scan mode can pick either; M4B is the more
robust single-file shape (chapters + cover + metadata all embedded in one file, no
folder-content ambiguity) and reuses the exact builder (`server/src/export/build-m4b.ts`)
the Voice tile already ships.

### 1.2 Series metadata in the shared builders

Both metadata builders gain series passthrough when `state.series` /
`state.seriesPosition` are set (silently omitted when absent — no error, matches how
`genre`/`date` are already optional today):

- **`buildFfmetadata`** (`server/src/export/build-m4b.ts:148`) — add
  `series=<name>` / `series-part=<position>` FFMETADATA lines alongside the existing
  `title`/`artist`/`album`/`genre`/`date` lines.
- **`applyId3v24Tags`** (`server/src/export/id3-tags.ts`) — add series to the `Id3Tags`
  interface and thread it through as ffmpeg `-metadata` flags. ID3v2 has no first-class
  series frame; the plan phase picks between `TIT1` (content-group, semantically closest
  to "collection") and a custom `TXXX:SERIES` / `TXXX:SERIES-PART` frame pair — needs a
  quick check against what Audiobookshelf's own ID3 parser actually reads, since an
  unrecognized frame is silently ignored rather than erroring.

This is a shared-builder change, not Audiobookshelf-only — every export tile that
carries a series book benefits (Voice/M4B, Smart AudioBook Player, BookPlayer).

### 1.3 `metadata.json` + folder-level `cover.jpg` for every mp3-folder export

`buildMp3Folder` (`server/src/export/build-mp3-folder.ts`) additionally writes, at the
book-folder root alongside the per-chapter MP3s:

- **`metadata.json`** — Audiobookshelf's own documented sidecar schema: `title`,
  `subtitle` (omitted — Castwright has no subtitle field), `authors` (array, from
  `state.author`), `narrators` (array, from `artistForExport`-equivalent human-narrator
  logic in `narrator-credit.ts`, omitted when the narrator is the Castwright brand
  default), `series` (array-of-objects `{ name, sequence }` per ABS's schema, omitted
  when absent), `genres` (array, from `state.genre`), `description` (from
  `state.description`), `publishedYear` (parsed from `state.publicationDate`),
  `language` (from the book's detected/set language, if the codebase already surfaces
  one at export time — needs confirming in the plan phase against `fs-2`'s language
  field).
- **`cover.jpg`** — copied from `coverImagePath(bookDir)` when it exists, same source
  the per-chapter APIC frames already use. Atomic tmp+rename, same as the MP3 files;
  skipped silently when no cover exists.

Applying this to **every** mp3-folder export (not gated by `appHint`) avoids threading a
new field through `BookExportRequest` → job storage → `buildMp3Folder` just to
distinguish "this export is for Audiobookshelf" from "this export is for Smart AudioBook
Player" — a distinction the server has never needed to make before. Smart AudioBook
Player and BookPlayer simply ignore the two extra files; Audiobookshelf treats
`metadata.json` as authoritative over embedded tags.

### 1.4 Author-level folder nesting on every sync-folder destination

Applied uniformly, not just for Audiobookshelf, again to avoid `appHint` wire-threading
and to keep sync-folder behavior consistent across every export tile:

- **`writeFolderToSyncFolder`** (`server/src/export/sync-folder.ts`) — layout changes
  from `<destDir>/<bookSubfolder>/` to `<destDir>/<author>/<bookSubfolder>/`.
- **`writeToSyncFolder`** (same file) — layout changes from flat `<destDir>/<filename>`
  to `<destDir>/<author>/<filename>`. This is the writer the Voice/M4B tile and
  `mp3-zip`-to-sync-folder use today.
- The new author path segment is sanitized with the existing `sanitiseForZip`
  (`server/src/export/build-mp3-zip.ts:176`) helper — same guarantee already given to
  the book-title segment, applied to the author segment too.

**This is a breaking layout change** for any existing user who already has a sync
folder watched by a Voice-tile/mp3-zip consumer expecting flat files. Ships with an
explicit callout in `docs/release-notes-next.md` and `RELEASE_NOTES.md` per the
before-shipping checklist, not silently.

## Design — Part 2: Global Export status pill

Mirrors the existing Analysis/Generation/Design pills
(`src/components/top-bar.tsx`, aggregated in `src/components/layout.tsx`) exactly. The
underlying data is already cross-book and navigation-independent
(`src/store/exports-slice.ts`'s `byBookId`, driven by the store-level
`createExportPollMiddleware` in `src/store/exports-middleware.ts`) — this section is
purely a new pill consumer of data that already exists, no new state-management
substrate.

### 2.1 `ExportPillData`

New type in `top-bar.tsx`, sibling to `GenerationPillData`/`AnalysisPillData`/
`DesignPillData`:

```ts
export type ExportPillState = 'running' | 'stalled' | 'done' | 'failed';
export interface ExportPillData {
  state: ExportPillState;
  done: number;
  total: number;
  percent: number;
  onClick: () => void;
}
```

`stalled` should reuse the same `STALL_THRESHOLD_MS` idea the other three pills use
(`layout.tsx`'s per-second `forceClockTick`), but `BookExportJob` doesn't currently carry
a `lastTickAt`-equivalent field — the plan phase decides whether to add one (stamped on
each `exportUpdated` poll) or derive staleness from time-since-last-poll-response
tracked client-side in the aggregation IIFE itself (simpler, no wire/schema change).

### 2.2 Aggregation (`layout.tsx`)

New `exportPill` IIFE alongside the existing `generationPill`/`analysisPill`/
`designPill` ones (`layout.tsx:1262-1393`): scans `exports.byBookId` across every book
for non-terminal (`in_progress`) jobs, sums `done`/`total` the same way
`aggregateStreamsByBook` collapses per-book generation streams before summing across
books. Pill is visible whenever at least one non-terminal job exists anywhere.

### 2.3 Completion linger

Mirrors the Design pill's `'done'` state (`layout.tsx:1369-1393`,
`DesignPillState` includes `'done'` and lingers briefly before the middleware clears
the snapshot): when a book's last non-terminal export job transitions to `done` or
`failed`, the pill shows a brief "Export done" / "Export failed" summary before
clearing. This is the actual "don't have to babysit it" payoff — without it, a solo
export's pill just vanishes the instant it finishes, and a user who stepped away would
have missed it entirely.

### 2.4 Click target

Always navigates to `/books/{bookId}/listen` — the book with the (single, or most
recently updated) in-flight or just-finished export. No new cross-book queue modal;
the existing per-book `ExportQueue` rail (`listen-download-section.tsx:314-374`) is
the landing spot, same as how a single-book Generation pill routes to that book's
Generate view.

### 2.5 Wiring into the compact Status pill

Added to `summarizeStatus()` and `StatusDetail` (`src/components/status-popover.tsx`)
alongside `analysis`/`generation`/`design`, so Export participates in the same compact
top-bar summary and hover/tap popover.

## Error handling

- `metadata.json` / folder-`cover.jpg` writes use the same atomic tmp+rename primitive
  as the MP3 files — a failure there can't leave a half-written, ABS-confusing folder
  behind. Missing cover source → skipped silently (matches today's APIC behavior).
- The sanitized author-folder segment prevents a pathological author name (containing
  `/`, `:`, reserved Windows names, etc.) from escaping the sync folder or colliding on
  disk — the same guarantee `sanitiseForZip` already gives the title segment.
- No new failure surface for the pill — it only ever reflects `BookExportJob.status`
  values the export system already produces and already surfaces via the existing
  error-toast path (`notifications-slice.ts`) on failure.

## Testing (paired, per CLAUDE.md testing discipline)

- **Server:**
  - `build-mp3-folder.test.ts` — `metadata.json` shape (all fields present when the book
    has them; series/narrator/description omitted, not null-filled, when absent),
    `cover.jpg` presence/absence.
  - `build-m4b.test.ts` — series/series-part FFMETADATA lines present/absent.
  - `id3-tags.test.ts` — series frame presence/absent, whichever frame the plan settles
    on.
  - `sync-folder.test.ts` — author-level path assertions for both `writeFolderToSyncFolder`
    and `writeToSyncFolder`; a sanitized-author-name case (path-hostile characters).
- **Frontend:**
  - `export-audiobook.test.tsx` (or `listen-download-section.test.tsx`) — Audiobookshelf
    tile's new format toggle (mp3-folder vs m4b, both defaulting to sync-folder).
  - `layout.test.tsx` / `top-bar.test.tsx` — `exportPill` aggregation: single running,
    multi-book aggregate, stalled, done-linger, failed — mirroring the existing
    `generationPill`/`designPill` test cases.
- **Regression plan:** this is cross-cutting (server export builders + the shared
  sync-folder primitive + a new frontend pill), so it gets its own
  `docs/features/NN-*.md` regression plan per the before-shipping checklist, not just
  inline tests.
- **No new e2e spec** — see Non-goals.

## Key files

- `server/src/export/build-mp3-folder.ts` — `metadata.json` + `cover.jpg`.
- `server/src/export/build-m4b.ts` — series FFMETADATA lines.
- `server/src/export/id3-tags.ts` — series ID3 frame.
- `server/src/export/sync-folder.ts` — author-level nesting for both writers.
- `server/src/export/build-mp3-zip.ts` — `sanitiseForZip` (reused for the author
  segment).
- `src/modals/export-audiobook.tsx` — Audiobookshelf `TILE_HINTS` format toggle.
- `src/components/top-bar.tsx` — `ExportPillData`, `ExportPill` component.
- `src/components/layout.tsx` — `exportPill` aggregation IIFE, `showStatus` wiring.
- `src/components/status-popover.tsx` — `StatusDetail`/`summarizeStatus` wiring.
- `src/store/exports-slice.ts`, `src/store/exports-middleware.ts` — existing substrate,
  read but not restructured.

## Future work (explicitly out of scope here)

- Direct Audiobookshelf API push + post-sync library-rescan trigger, gated behind a new
  ABS server URL + API key setting.
- Series-level folder nesting (`<author>/<series>/<title>/`).
- A cross-book export queue modal, if multi-book concurrent exports turn out to be
  common enough that "navigate to the most recent book" feels insufficient in practice.
