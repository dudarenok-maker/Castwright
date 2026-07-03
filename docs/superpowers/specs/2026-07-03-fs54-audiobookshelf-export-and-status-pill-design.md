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

**Two rounds of adversarial review, two wrong gates — this is the corrected one.**
Round 1 gated on "`state.series` is set", which is wrong because standalone books carry
the synthetic sentinel `STANDALONES_SERIES = 'Standalones'`
(`server/src/workspace/paths.ts:75`), never an empty string. Round 2's fix,
`state.seriesPosition != null`, is **also** wrong: `series` and `seriesPosition` are
populated independently at ingest (`server/src/ingest/epub.ts:127-128` — a book can carry
a real series name with a `null` position when the source EPUB has no calibre-style
index), so gating series-name emission on position presence silently drops series
metadata for exactly the books missing a numeric index — the opposite failure mode from
round 1.

**The correct, authoritative signal is `BookStateJson.isStandalone: boolean`**
(`server/src/workspace/scan.ts:58`) — the codebase's own purpose-built discriminator,
already used the same way by `server/src/analytics/listen-stats-aggregate.ts:91`
(`if (b.isStandalone || !b.series) continue;`):

- Emit `series=<state.series>` whenever `!state.isStandalone` — regardless of whether
  `seriesPosition` is set.
- Emit `series-part=<state.seriesPosition>` **only when `seriesPosition != null`** — a
  genuinely optional sub-field of an emitted series, not the series gate itself.
- When `state.isStandalone` is `true`, omit series entirely (never emit the
  `'Standalones'` sentinel name).

Both metadata builders gain this series passthrough:

- **`buildFfmetadata`** (`server/src/export/build-m4b.ts:148`) — add
  `series=<name>` / `series-part=<position>` FFMETADATA lines alongside the existing
  `title`/`artist`/`album`/`album_artist`/`genre`/`date` lines.
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
book-folder root alongside the per-chapter MP3s (in the staging directory it already
builds into):

- **`metadata.json`** — Audiobookshelf's own documented sidecar schema: `title`,
  `subtitle` (omitted — Castwright has no subtitle field), `authors` (array, from
  `state.author`), `narrators` (array, from `artistForExport`-equivalent human-narrator
  logic in `narrator-credit.ts`, omitted when the narrator is the Castwright brand
  default), `series` (array-of-objects `{ name, sequence }`, **gated on
  `!state.isStandalone`, with `sequence` present only when `seriesPosition != null`** —
  see §1.2), `genres` (array, from `state.genre`), `description` (from
  `state.description`), `publishedYear` (parsed from `state.publicationDate`),
  `language` (from the book's detected/set language, if the codebase already surfaces
  one at export time — needs confirming in the plan phase against `fs-2`'s language
  field).
- **`cover.jpg`** — copied from `coverImagePath(bookDir)` when it exists, same source
  the per-chapter APIC frames already use. Atomic tmp+rename, same as the MP3 files;
  skipped silently when no cover exists.

**Critical plumbing gap caught by adversarial review:** writing these two files into the
staging directory is not sufficient — they never reach the user's actual sync folder as
scoped. The only path from staging to the real destination for a folder export is
`writeFolderToSyncFolder` (`server/src/export/sync-folder.ts:67-93`), which today
hard-filters the copy to `.mp3` files only (`if (!name.toLowerCase().endsWith('.mp3'))
continue;`, line 82) — and folder exports have no download-endpoint fallback (`format_
not_downloadable`, `server/src/routes/export.ts`). Without a fix, `metadata.json` and
`cover.jpg` are built, then silently discarded during the sync copy, and existing
builder-level unit tests (which only assert against the staging output) would stay green
while the feature does nothing in production. **Fix:** `writeFolderToSyncFolder`'s copy
filter changes from an extension check to an explicit allowlist —
`name.toLowerCase().endsWith('.mp3') || name === 'metadata.json' || name === 'cover.jpg'`
— so the two new sidecar files travel with the chapter MP3s. `server/src/export/
sync-folder.ts` is therefore a key file for **this** section, not only for §1.4's
author-nesting change.

Applying this to **every** mp3-folder export (not gated by `appHint`) avoids threading a
new field through `BookExportRequest` → job storage → `buildMp3Folder` just to
distinguish "this export is for Audiobookshelf" from "this export is for Smart AudioBook
Player" — a distinction the server has never needed to make before. Smart AudioBook
Player and BookPlayer simply ignore the two extra files; Audiobookshelf treats
`metadata.json` as authoritative over embedded tags.

### 1.4 Author-level folder nesting on every sync-folder destination

Applied uniformly, not just for Audiobookshelf, again to avoid `appHint` wire-threading
and to keep sync-folder behavior consistent across every export tile.

**Neither sync-folder writer needs a signature change.** `writeFolderToSyncFolder`
and `writeToSyncFolder` both already take a `destDir` argument; today's call sites in
`server/src/routes/export.ts` pass the bare `syncFolder` setting straight through
(`writeFolderToSyncFolder(outPath, syncFolder, bookSubfolder)` at line ~520,
`writeToSyncFolder(outPath, syncFolder, job.filename)` at line ~565) — and `export.ts`
is exactly where `state.author` is already in scope. The fix lives entirely in
`export.ts`: both call sites build `const authoredSyncDir = join(syncFolder,
sanitiseForZip(state.author))` and pass `authoredSyncDir` as `destDir` instead of the
bare `syncFolder`. Net effect is identical to the originally-stated layout —
`writeFolderToSyncFolder` lands at `<syncFolder>/<author>/<bookSubfolder>/`,
`writeToSyncFolder` lands at `<syncFolder>/<author>/<filename>` — but `sync-folder.ts`
itself is unchanged for this section (it already just copies into whatever `destDir` it's
given). `server/src/routes/export.ts` is therefore a key file for this section.

- The new author path segment is sanitized with the existing `sanitiseForZip`
  (`server/src/export/build-mp3-zip.ts:176`) helper — same guarantee already given to
  the book-title segment, applied to the author segment too.

**This is a breaking layout change** for any existing user who already has a sync
folder watched by a Voice-tile/mp3-zip consumer expecting flat files. Ships with an
explicit callout in `docs/release-notes-next.md` and `RELEASE_NOTES.md` per the
before-shipping checklist, not silently.

## Design — Part 2: Global Export status pill

Mirrors the existing Analysis/Generation/Design pills
(`src/components/top-bar.tsx`, aggregated in `src/components/layout.tsx`). The live
running/stalled states read straight from `exports-slice.ts`'s existing `byBookId` — no
new substrate needed there. **The completion linger needs a Redux-readable home**, and
two adversarial review rounds caught two different wrong shapes for it: round 1's draft
claimed no new substrate was needed at all; round 2 caught that a snapshot living only
inside a middleware closure can't be read by a React selector — the Design pill's own
`'done'` state is only readable because it lives in the **`castDesign` slice**
(`src/store/cast-design-stream-middleware.ts` dispatches into it; `layout.tsx:168` reads
it via `useAppSelector`), not in the middleware itself. §2.1 and §2.3 below fix this by
adding the linger snapshot as **slice state**, not middleware-only state.

Job-shape correction, also caught on review: `BookExportJob` (the OpenAPI-generated type,
`openapi.yaml`'s `BookExportJob` schema) is a single 0..1 `progress` ratio per job, not a
sub-divided `{done, total}` counter the way a generation stream's chapter count is — so
the Export pill cannot reuse the Generation pill's `done`/`total` shape verbatim. It
aggregates a **count of jobs**, not a fraction of sub-items, and status has five values
(`queued | in_progress | done | failed | cancelled`, not just `in_progress`/terminal) —
non-terminal is `queued` **or** `in_progress` (`exports-middleware.ts:51`'s `TERMINAL`
set is `{done, failed, cancelled}`, so its complement includes `queued`).

### 2.1 `ExportPillData` and the linger snapshot

New type in `top-bar.tsx`, sibling to `GenerationPillData`/`AnalysisPillData`/
`DesignPillData` — count-based, not done/total-based:

```ts
export type ExportPillState = 'running' | 'stalled' | 'done' | 'failed';
export interface ExportPillData {
  state: ExportPillState;
  /** Non-terminal (queued + in_progress) job count across every book.
      Present only for 'running'/'stalled'. */
  runningCount?: number;
  /** Average `progress` across in_progress jobs (queued jobs have no
      progress to average). Undefined while only queued jobs exist, or
      during the terminal 'done'/'failed' linger — those states render
      as text ("Export done"/"Export failed"), not a percent bar, same
      as the Design pill's own 'done' summary has no percent. */
  percent?: number;
  onClick: () => void;
}
```

The linger snapshot itself is new **state on `ExportsState`** (`exports-slice.ts`), not
middleware-only memory:

```ts
export interface ExportsState {
  byBookId: Record<string, BookExportJob[]>;
  lanUrls: string[];
  lanPort: number | null;
  /** New: per-book terminal-completion snapshot for the pill's linger.
      Keyed by bookId; a later completion for the same book overwrites
      an earlier one (consistent with the other three pills aggregating
      per-book, not per-stream). */
  linger: Record<string, { state: 'done' | 'failed' }>;
}
```

with two new reducers, `exportLingerSet` / `exportLingerCleared`, dispatched by the new
middleware in §2.3. This is a Redux-readable field `layout.tsx`'s IIFE can select
directly, unlike a snapshot trapped in middleware closure state.

`stalled` should reuse the same `STALL_THRESHOLD_MS` idea the other three pills use
(`layout.tsx`'s per-second `forceClockTick`), applied only to `in_progress` jobs (a
`queued` job isn't "stalled" in the same sense — it's just waiting its turn). But
`BookExportJob` doesn't currently carry a `lastTickAt`-equivalent field — the plan phase
decides whether to add one (stamped on each `exportUpdated` poll) or derive staleness
from time-since-last-poll-response tracked client-side in the aggregation IIFE itself
(simpler, no wire/schema change).

### 2.2 Aggregation (`layout.tsx`)

New `exportPill` IIFE alongside the existing `generationPill`/`analysisPill`/
`designPill` ones (`layout.tsx:1262-1393`): scans `exports.byBookId` across every book
for non-terminal (`queued` **or** `in_progress`) jobs and counts them (`runningCount`);
`percent` averages `progress` across the `in_progress` subset only. **Pill visibility is
the union of two independent sources**, not non-terminal jobs alone: (a) at least one
non-terminal job exists anywhere, OR (b) `exports.linger` (§2.1/§2.3) has at least one
entry. Without (b), the pill would vanish the instant the last job goes terminal,
making the §2.3 linger unreachable — an internal contradiction an earlier draft had
between this section and §2.3, caught on review.

### 2.3 Completion linger

A small new middleware, `src/store/export-pill-middleware.ts`, modeled directly on
`cast-design-stream-middleware.ts`'s snapshot+timer pattern: watches for `exportUpdated`
actions, and when a job transitions into `done` or `failed` **and** no other non-terminal
job remains for that book, dispatches `exportLingerSet({ bookId, state })` (writing into
the new `exports.linger` slice state from §2.1) and starts a short timer — matching the
Design pill's lingering-summary duration — that dispatches `exportLingerCleared({
bookId })` when it fires. If a new export starts on the same book before the timer
fires (`exportStarted` for that `bookId`), the pending timer is cancelled and the linger
entry cleared immediately, same guard `cast-design-stream-middleware.ts` already uses —
so a fresh run's live progress is never shadowed by a stale done/failed summary.

**`cancelled` is deliberately excluded from the linger** — it's a result of the user's
own dismiss/retry action, not something they need to be notified about after the fact —
so a cancelled job never calls `exportLingerSet`; the pill just clears immediately if
nothing else is running for that book, matching today's Generation/Analysis pill
behavior for a halted stream.

**The linger is separate from `byBookId`, on purpose.** It does not remove or alter the
underlying job in `exports.byBookId` — the finished job stays exactly where it was,
visible in that book's `ExportQueue` rail (`listen-download-section.tsx:314-374`).
Reusing `exportDismissed` to "clear" the linger was considered and rejected: dismissing
the actual job would make the rail row the §2.4 pill-click lands on already gone by the
time the user clicks it. Keeping the linger as independent slice state avoids that.

This is the actual "don't have to babysit it" payoff — without it, a solo export's pill
just vanishes the instant it finishes, and a user who stepped away would have missed it
entirely.

### 2.4 Click target

Always navigates to `/books/{bookId}/listen` — the book with the (single, or most
recently updated) in-flight or just-finished export. No new cross-book queue modal;
the existing per-book `ExportQueue` rail (`listen-download-section.tsx:314-374`) is
the landing spot, same as how a single-book Generation pill routes to that book's
Generate view.

### 2.5 Wiring into the compact Status pill

Added to `summarizeStatus()` and the `StatusDetail` interface (both defined in
`src/components/top-bar.tsx`) alongside `analysis`/`generation`/`design`, plus a new
`export` prop/section on `<StatusPopover>` (`src/components/status-popover.tsx`, the
consumer that renders `StatusDetail` — `AnalysisPill`/`GenerationPill`/`DesignPill` at
lines ~205/231/238), so Export participates in the same compact top-bar summary and
hover/tap popover.

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
  - `build-mp3-folder.test.ts` — `metadata.json` shape: three cases pin the corrected
    gate — (1) `isStandalone: true` → no `series` field at all (not even the
    `'Standalones'` sentinel name); (2) `isStandalone: false` + `seriesPosition: null`
    (a real series book with no calibre index) → `series` present, `sequence` absent;
    (3) `isStandalone: false` + `seriesPosition` set → both present. Plus `cover.jpg`
    presence/absence.
  - `build-m4b.test.ts` — same three-case series/series-part FFMETADATA matrix as above.
  - `id3-tags.test.ts` — series frame presence/absent, whichever frame the plan settles
    on.
  - `sync-folder.test.ts` — `writeFolderToSyncFolder`'s allowlist actually copies
    `metadata.json`/`cover.jpg` through (regression-pins the dropped-sidecar bug caught
    in review) while still excluding unrelated stray files.
  - `export.test.ts` — author-level destination-path assertions for both sync-folder
    call sites (`writeFolderToSyncFolder`/`writeToSyncFolder` invocations), including a
    sanitized-author-name case (path-hostile characters).
- **Frontend:**
  - `export-audiobook.test.tsx` (or `listen-download-section.test.tsx`) — Audiobookshelf
    tile's new format toggle (mp3-folder vs m4b, both defaulting to sync-folder).
  - `layout.test.tsx` / `top-bar.test.tsx` — `exportPill` aggregation: single running
    (queued and in_progress both count as running), multi-book `runningCount`, `percent`
    averaged over `in_progress` only, stalled, visibility via the linger union (§2.2) when
    zero non-terminal jobs remain but a linger entry exists, cancelled-clears-immediately.
  - `exports-slice.test.ts` — `exportLingerSet`/`exportLingerCleared` reducer cases.
  - `export-pill-middleware.test.ts` — new file, mirrors
    `cast-design-stream-middleware.test.ts`'s snapshot-and-timer coverage: done/failed
    dispatches `exportLingerSet` only when no other non-terminal job remains for that
    book, clears after the timer, restarts (cancel pending timer + immediate clear) when
    a new export starts on the same book before the timer fires, cancelled never
    dispatches `exportLingerSet`.
- **Regression plan:** this is cross-cutting (server export builders + the shared
  sync-folder primitive + a new frontend pill), so it gets its own
  `docs/features/NN-*.md` regression plan per the before-shipping checklist, not just
  inline tests.
- **No new e2e spec** — see Non-goals.

## Key files

- `server/src/export/build-mp3-folder.ts` — `metadata.json` + `cover.jpg` written into
  staging.
- `server/src/export/build-m4b.ts` — series FFMETADATA lines (`!isStandalone` gate,
  `seriesPosition != null` for `series-part` only).
- `server/src/export/id3-tags.ts` — series ID3 frame.
- `server/src/export/sync-folder.ts` — `writeFolderToSyncFolder`'s copy filter relaxed
  to allowlist `metadata.json`/`cover.jpg` alongside `.mp3` (§1.3 fix). Writer
  signatures are unchanged for §1.4 — see `routes/export.ts` below.
- `server/src/routes/export.ts` — **both** sync-folder call sites (`~line 520`
  `writeFolderToSyncFolder`, `~line 565` `writeToSyncFolder`) build an
  author-sanitized `destDir` before calling the writers, for §1.4's author nesting.
- `server/src/export/build-mp3-zip.ts` — `sanitiseForZip` (reused for the author
  segment).
- `src/modals/export-audiobook.tsx` — Audiobookshelf `TILE_HINTS` format toggle.
- `src/components/top-bar.tsx` — `ExportPillData`, `ExportPill` component.
- `src/components/layout.tsx` — `exportPill` aggregation IIFE (progress + linger
  snapshot union), `showStatus` wiring.
- `src/components/status-popover.tsx` — new `export` prop/section on `<StatusPopover>`.
- `src/store/exports-slice.ts` — new `linger` state field + `exportLingerSet`/
  `exportLingerCleared` reducers (§2.1). `byBookId`/progress handling unchanged.
- `src/store/exports-middleware.ts` — existing progress-poll substrate, unchanged.
- `src/store/export-pill-middleware.ts` — **new file**, dispatches the done/failed
  linger snapshot + timer into `exports-slice.ts`'s new `linger` state, modeled on
  `src/store/cast-design-stream-middleware.ts`.

## Future work (explicitly out of scope here)

- Direct Audiobookshelf API push + post-sync library-rescan trigger, gated behind a new
  ABS server URL + API key setting.
- Series-level folder nesting (`<author>/<series>/<title>/`).
- A cross-book export queue modal, if multi-book concurrent exports turn out to be
  common enough that "navigate to the most recent book" feels insufficient in practice.
