---
status: stable
shipped: 2026-05-17
owner: null
---

# 34 — MP3-folder export (folder-scanning audiobook apps)

Status: **stable** (server contract + all three tile UIs B2-B4 shipped).

A third export format that writes per-chapter MP3s into a sub-folder
named after the book rather than packaging them into a zip (`mp3-zip`,
plan 32) or a single M4B (plan 33). Targets folder-scanning Android
audiobook apps — Smart AudioBook Player (B2), BookPlayer iOS via Files
import (B3), Audiobookshelf folder mode (B4) — that ingest one folder
per book on disk.

## Why a third format

Voice (plan 33) consumes a single `.m4b` per book — clean for a library
that's one-file-per-book. The wider set of folder-scanning players
(Smart AudioBook Player + Audiobookshelf + BookPlayer iOS) instead
expect a directory of MP3s under a book-named subfolder. Plan 32's
MP3.ZIP fits _some_ of those apps after the user manually unzips on
device; that extra step is the paper-cut B1+B2-B4 removes.

Per-MP3 ID3v2.4 tags + the optional APIC cover frame (plan 36 A3)
travel with each file, so each tile sees a tagged-and-art-embedded
chapter list as soon as the sync target finishes mirroring.

## What the server builds

[`server/src/export/build-mp3-folder.ts:buildMp3Folder`](../../server/src/export/build-mp3-folder.ts):

1. Same precheck as `buildMp3Zip` — non-excluded chapter slugs must
   resolve to a current `.mp3` on disk; missing slugs throw
   `ExportIncompleteError`.
2. The destination directory is rm-and-recreated so a prior run's
   stale chapter files (e.g. left over when the user later excluded
   one) don't survive a re-export. The route stages it under
   `<bookDir>/.audiobook/exports/<exportId>/<book-title>/` so the
   manifest + rehydration path stays identical to the zip/m4b
   formats.
3. Each non-excluded chapter is run through `applyId3v24Tags` with
   `coverJpegPath` set when `<bookDir>/.audiobook/cover.jpg` exists.
   Filename shape: `${pad2(idx+1)} - ${sanitiseForZip(title)}.mp3`
   — identical to the entry names inside the zip variant, so any
   tooling that grew up against the MP3.ZIP layout reads the folder
   variant unchanged.
4. Returns `{ totalBytes, entries: string[] }` — entries are absolute
   paths in pack order.

## How the file gets to the user

Only `destination: sync-folder` is valid. The route refuses
`mp3-folder + download` at create time (400 `invalid_destination`)
because the download endpoint serves single files, not directory
trees — and zipping a folder for download is just `mp3-zip`. A direct
hit on the download endpoint with an already-built `mp3-folder` job
returns 409 `format_not_downloadable` so an old client can't 500 the
server by trying to stream a directory.

[`server/src/export/sync-folder.ts:writeFolderToSyncFolder`](../../server/src/export/sync-folder.ts)
mirrors every `.mp3` from the staging folder into
`<exportSyncFolder>/<book-title>/<NN - chapter>.mp3` using the same
`tmp + renameWithRetry` primitive as the single-file writer. Each file
is atomic; the folder grows incrementally during sync so a scanning
app that wakes mid-copy never sees a half-written file.

## Invariants to preserve

- **Format + destination matrix.** `mp3-folder` rejects `download`;
  `mp3-zip` and `m4b` accept both destinations. The route validates
  this BEFORE allocating the export id, so a 400 here doesn't leak a
  partial manifest. Pinned by `export.test.ts` (`mp3-folder requires
destination='sync-folder'`).
- **Staging shape is per-format.** `mp3-zip` and `m4b` stage a single
  file at `<exportId>/<filename>`; `mp3-folder` stages a directory at
  `<exportId>/<book-slug>/<NN-chapter>.mp3`. The route's
  `bookFilename` returns just the slug for `mp3-folder` so `outPath`
  resolves to the directory rather than a file.
- **Stale-file purge.** `buildMp3Folder` rm-and-recreates `outDir` so
  the staging directory only ever carries the current export's chapter
  files. Without this, a previous run that produced more chapters
  would leave orphans the sync-folder mirror would dutifully copy.
  Pinned by `build-mp3-folder.test.ts` ("overwrites the destination
  directory on rerun").
- **Per-file atomic copy in the sync mirror.** `writeFolderToSyncFolder`
  uses `tmp-<pid>-<ts>-<idx>` per chapter so concurrent copies inside
  the same target directory can't race for the same tmp name. Errors
  unlink the tmp before re-throwing — no `.tmp-*` droppings in the
  user's synced folder.
- **APIC cover travels with each MP3.** `buildMp3Folder` probes
  `<bookDir>/.audiobook/cover.jpg` once and threads it through every
  `applyId3v24Tags` call (plan 36 A3). Absent cover → no APIC frame,
  no error.
- **`downloadUrl` is `null` for `mp3-folder` jobs.** The job manifest
  records the sync path instead. Frontend tile UIs (B2-B4) read
  `syncPath` for the "find it here" affordance.

## Acceptance walkthrough (manual)

Use the canonical end-to-end manuscript at
`server/src/__fixtures__/the-coalfall-commission.md` per `CLAUDE.md`.

1. With `VITE_USE_MOCKS=false`, server running, and a generated book
   on disk: configure `exportSyncFolder` under Account.
2. `curl -X POST http://localhost:8080/api/books/<bookId>/exports
-H 'Content-Type: application/json'
-d '{"format":"mp3-folder","destination":"download"}'` → 400
   `invalid_destination` (the route refuses the combo before
   allocating an id).
3. Retry with `"destination":"sync-folder"`. Response is a job in
   `in_progress`; `GET /api/books/<bookId>/exports/<exportId>` ticks
   `progress` 0→1 then `status:'done'` with `syncPath` set to
   `<exportSyncFolder>/<book-title>/` and `downloadUrl: null`.
4. On disk inside the sync folder: every non-excluded chapter is
   present as `NN - Chapter Title.mp3` with the right ID3v2 tags
   (`ffprobe -show_format -show_entries format_tags=title,track <file>`)
   and, when a cover was picked, an APIC stream (a video stream with
   `codec_name = mjpeg` shows up under `-show_streams`).
5. `GET /api/books/<bookId>/exports/<exportId>/download` → 409
   `format_not_downloadable`. Confirms the direct-hit guard.
6. Re-run the export. Stale chapter files from a previous run with
   more chapters do not survive in the staging dir (the test pins
   this; the manual smoke is to drop a fake `99 - extra.mp3` into
   the staging path between runs and watch it disappear after the
   next build).

## Tile UI (B2-B4)

Three tiles graduate from coming-soon to live in this thread, each
mirroring the Voice tile pattern (plan 33 B). B2 introduces the
shared `TILE_HINTS` config object in
`src/modals/export-audiobook.tsx`; B3 and B4 are one-entry
additions to it plus the matching handler in `src/views/listen.tsx`.

- **B2 — Smart AudioBook Player** _(shipped)_. `appHint:
'smart_audiobook'`, defaults to `{ format: 'mp3-folder',
destination: 'sync-folder' }`. The modal collapses the format +
  destination toggles via the `TILE_HINTS` lookup; per-tile body /
  caption / header / submit copy lives in the config entry. Tile-
  specific testid `export-tile-body-smart_audiobook` (Voice keeps its
  plan-33 alias `export-voice-body`).
- **B3 — BookPlayer** _(shipped)_. `appHint: 'bookplayer'`, defaults
  to `{ format: 'mp3-folder', destination: 'sync-folder' }`. Modal
  copy nods at AirDrop from the synced folder via Finder. Tile-
  specific testid `export-tile-body-bookplayer`. The B2 refactor
  reduced B3 to a one-entry config addition + a one-line handler
  wire-up in `ListenView`.
- **B4 — Audiobookshelf** _(shipped)_. `appHint: 'audiobookshelf'`,
  defaults to `{ format: 'mp3-folder', destination: 'sync-folder' }`.
  Modal copy points the sync folder at the Audiobookshelf scan root
  and notes that the server picks the book up on its next rescan.
  Tile-specific testid `export-tile-body-audiobookshelf`. Same
  one-entry shape as B3 — TILE_HINTS already carried the config.

## Out of scope

- **Multi-file zip download** for the folder format — that's literally
  `mp3-zip`.
- **Cuesheets / NFO / README.txt** inside the folder — folder-scanning
  apps don't consume them. If a user wants those, the
  download-then-edit workflow on `mp3-zip` still applies.
- **iOS direct push** — covered by AirDrop from the synced folder
  on macOS Finder.

## Related plans

- [32 — Audiobook export](32-audiobook-export.md) — the underlying
  job lifecycle (in-memory table + manifest rehydration + sync-folder
  writer + LAN download endpoint). All carried unchanged.
- [33 — Voice export](33-voice-export.md) — the `prefill` +
  `appHint` shape on the export modal; B2-B4 reuse it.
- [36 — Book covers](36-book-covers.md) — supplies the APIC source.
