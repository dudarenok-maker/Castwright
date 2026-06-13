---
status: stable
shipped: 2026-05-15
owner: null
---

# Audiobook export — sideload to PocketBook Reader (MP3.ZIP + M4B)

> Status: stable
> Key files: `server/src/export/build-mp3-zip.ts`, `server/src/export/build-m4b.ts`, `server/src/export/id3-tags.ts`, `server/src/export/sync-folder.ts`, `server/src/routes/export.ts`, `server/src/routes/export-lan.ts`, `server/src/workspace/atomic-rename.ts`, `src/modals/export-audiobook.tsx`, `src/components/export-queue-row.tsx`, `src/lib/export-queue-adapter.ts`, `src/store/exports-slice.ts`, `src/views/listen.tsx`
> URL surface: `POST /api/books/:bookId/exports`, `GET /api/books/:bookId/exports/:exportId`, `GET /api/books/:bookId/exports/:exportId/download`, `GET /api/export/lan`
> OpenAPI ops: `createBookExport`, `getBookExport`, `downloadBookExport`, `getExportLanUrls` (`openapi.yaml`)
> Paired tests: `server/src/export/id3-tags.test.ts`, `server/src/export/build-mp3-zip.test.ts`, `server/src/export/build-m4b.test.ts`, `server/src/export/sync-folder.test.ts`, `server/src/routes/export.test.ts`, `src/store/exports-slice.test.ts`, `src/modals/export-audiobook.test.tsx`, `src/views/listen.test.tsx`
> Cross-links: [28 — Audio output format](28-chapter-audio-format.md), [18 — Listen view](18-listen-view.md), [27 — Book state persistence](27-book-state-persistence.md)

## What this covers

Packaging a finished book's per-chapter MP3 files into one of two artifacts the user can sideload onto a PocketBook (or PocketBook Reader on Android, or any other audiobook app):

- **MP3.ZIP** — a zip of per-chapter MP3s with ID3v2.4 tags. No re-encode. Universal compatibility.
- **M4B** — a single AAC-LC file with QuickTime chapter atoms, faststart MP4, 96 kbps mono 44.1 kHz. PocketBook surfaces it under Audiobooks with chapter UI and resume-position state.

The modal exposes a Format toggle (default M4B) alongside the existing destination toggle.

PocketBook publishes no off-device API, no SDK, and no partner programme. The integration shape on every platform — Android app, iOS app, physical e-reader — is **produce a well-formed file, get it onto the device, let the app pick it up.** Android is the friendliest target because Chrome on the phone can hit a LAN URL directly. The sync-folder destination covers users who'd rather route through OneDrive / Syncthing / Drive.

## How the MP3.ZIP is built

1. `state.chapters` is walked in id order; excluded chapters are skipped before any work happens.
2. `findChapterAudio(audioDir, chapter.slug)` (reused from plan 28) probes each chapter's mp3 path. If any non-excluded chapter has no `.mp3`, the build refuses with `ExportIncompleteError` carrying the full missing-slug list.
3. Each chapter MP3 is run through `applyId3v24Tags` (`server/src/export/id3-tags.ts`): ffmpeg with `-c:a copy` copies the LAME VBR V2 frames byte-for-byte and writes a fresh ID3v2.4 header:
   - TIT2 = chapter title
   - TALB = book title
   - TPE1 = narrator credit, falling back to author
   - TPE2 = author
   - TRCK = `N/total`
   - TCON / TDRC = genre / publicationDate when set
4. The tagged file is added to the zip (yazl, **stored** mode — no deflate; MP3 is already compressed) under the entry name `${pad2(idx)} - ${sanitiseForZip(chapter.title)}.mp3`. `sanitiseForZip` downgrades em-dash to `-` and strips FAT32-illegal characters so the file survives MTP-only and SD-card copies on older e-readers.

## How the M4B is built

1. Same precheck as MP3.ZIP — `state.chapters` walked in id order, excluded chapters skipped, each non-excluded chapter must have a current `.mp3`. Failure raises `ExportIncompleteError` with the missing-slug list.
2. Each source MP3 is `ffprobe`'d for its exact duration. Per-chapter durations are the authoritative source for the chapter timestamps in the M4B — we don't derive them from a post-encode probe, because AAC priming samples and concat padding shift offsets by a few ms per chapter, which is enough to make some players show wrong chapter durations.
3. An FFMETADATA sidecar is written to a staging dir with book-level tags (`title`, `artist` = narratorCredit ?? author, `album`, `album_artist`, optional `genre`/`date`, `media_type=2` to flip Apple/QuickTime players from Music → Audiobook) and one `[CHAPTER]` block per source chapter. Timestamps are cumulative milliseconds (`TIMEBASE=1/1000`); each chapter's `END` equals the next chapter's `START` exactly. Tag values are FFMETADATA-escaped (`=`, `;`, `#`, `\`, newline).
4. A concat-demuxer file lists the absolute MP3 paths, single-quoted so Windows backslashes pass through cleanly.
5. One ffmpeg pass: `-f concat -safe 0 -i concat.txt -i FFMETADATA.txt -map 0:a -map_metadata 1 -c:a aac -b:a 96k -ar 44100 -ac 1 -movflags +faststart -f mp4 <out>.m4b`. The built-in `aac` encoder (not libfdk_aac — Gyan.FFmpeg's standard build doesn't ship it, and 96 kbps is comfortably above the threshold where the difference matters for spoken word). ffmpeg's `-progress pipe:1` stdout is parsed for `out_time_us` ticks; the encoder's progress is forwarded to the job's `progress` field as a 0..1 ratio.

## How the file gets to the user

Two destinations, both selectable from the same modal in the Listen view:

- **`destination: 'download'`** — the artifact stages under `<bookDir>/.audiobook/exports/<exportId>/<filename>` and `downloadUrl` resolves to `/api/books/<bookId>/exports/<exportId>/download` (range-aware, `Content-Type: application/zip` for MP3.ZIP or `audio/mp4` for M4B, `Content-Disposition: attachment`). The modal shows a LAN URL + QR (rendered with the `qrcode` lib) so the user can open the link in Chrome on their phone — the file lands in Downloads/ and a tap opens it with PocketBook Reader.
- **`destination: 'sync-folder'`** — after the zip is staged, `writeToSyncFolder(srcPath, exportSyncFolder, filename)` copies it into the user's configured folder via `tmp + renameWithRetry`, sharing the OneDrive-safe EPERM/EBUSY/ENOENT backoff with `state.json` writes. The user's phone picks it up on the next sync.

LAN URL enumeration (`GET /api/export/lan`) filters out 127.x and 169.254.x — those are useless from a phone. Node's `app.listen(PORT)` already binds 0.0.0.0; the only change in `server/src/index.ts` is to log every reachable URL at boot so the user can see what to point their phone at.

## Invariants to preserve

- **No re-encode on the MP3.ZIP path.** `applyId3v24Tags` uses `-c:a copy`. The MPEG frame stream after the ID3v2 header round-trips byte-identical to the source. Any future refactor that inadvertently re-encodes drifts the user-perceived audio away from the chapter-audio plan (28) invariants. Paired test: `id3-tags.test.ts` asserts `audioBytesOnly(dest).equals(audioBytesOnly(src))`.
- **M4B re-encodes; MP3.ZIP does not.** Crossing the streams (re-encoding MP3.ZIP entries, or stream-copying MP3 frames into the M4B container) breaks both formats — MP3.ZIP drifts away from plan 28's audio invariants, and stream-copying MP3 inside MP4 produces a file no PocketBook firmware accepts.
- **M4B chapter timestamps come from per-source `ffprobe`.** Post-encode probes are off by AAC priming + concat padding (a few ms per chapter); summing them across a long book yields visible drift. Always probe the source MP3s.
- **Excluded chapters are never in the zip.** State.chapters' `excluded` flag is the single source of truth.
- **A chapter with no MP3 on disk is refused.** Missing `.mp3` triggers `ExportIncompleteError`. PocketBook reads MP3.ZIP; the precheck surfaces the full punch list so the user can regenerate before retrying.
- **Atomic writes.** Both the staging artifact and the sync-folder copy use `tmp + renameWithRetry`. The retry covers OneDrive's change-detection scan window — same hazard that crashed the library-cast-override path on 2026-05-15.
- **In-memory jobs are not the source of truth for downloads.** A `manifest.json` lands next to the artifact on completion; the route's `rehydrateBook` re-populates the in-memory table on first lookup so download URLs survive server restarts.
- **The export modal is the only entry point.** The Listen view's three "Or download a file" tiles (now two) stay marked as future affordances; the live flow goes through the modal.
- **Cancel signals the server to abort.** `DELETE /api/books/:bookId/exports/:exportId` flips the job to `cancelled`, fires an `AbortController` that the build functions check between chapters (and between the probe loop / ffmpeg spawn for M4B), and removes the staging dir best-effort. The frontend dispatches `exportDismissed` synchronously regardless of the DELETE result so the modal recovers even if the server has already lost the job. Idempotent on already-terminal jobs (returns 204 without touching state). Pinned by `server/src/routes/export.test.ts` ("DELETE cancels a running job", "DELETE is idempotent on already-terminal jobs", "DELETE on an unknown export id 404s").
- **Retry re-POSTs the same spec without re-opening the picker.** From a `failed` job, clicking Retry dispatches `exportDismissed` for the failed id and immediately submits the current `format`/`destination` again. The picker doesn't flash because `handleSubmit` synchronously sets the new `activeJobId` on success. Pinned by `src/modals/export-audiobook.test.tsx` ("retries from FAILED").
- **LAN bind is whatever Node defaults to.** No `host` argument is passed to `app.listen`; the user trusts their LAN. No TLS / auth — out of scope for v1.

## Acceptance walkthrough (Android, end-to-end)

Use the canonical end-to-end manuscript at `server/src/__fixtures__/the-coalfall-commission.md` — see the recipe in [plan 28](28-chapter-audio-format.md). Pre-req: `VITE_USE_MOCKS=false`, sidecar up, ffmpeg on PATH.

1. `npm run start`. Server stdout shows both `Listening on http://localhost:8080` and one or more `[server] LAN URL: http://192.168.x.y:8080` lines.
2. Import the canonical manuscript, generate every chapter. (Skipping a chapter? Make sure it's marked excluded on the Generate view first.)
3. From the Listen view → **Export audiobook** pill. Modal opens on the **Download to phone** tab with the LAN URL + a QR.
4. Scan the QR with Android camera (or type the URL into Chrome). Click **Build download**. Modal shows progress → done. The download URL the modal hands to the browser saves into Downloads/.
5. Tap the downloaded zip on the phone → **Open with PocketBook Reader** → the audiobook appears in the library with chapter list, cover (gradient placeholder for v1), author and narrator fields populated. Seek across chapter boundaries to confirm playback.
6. Now switch to the **Save to sync folder** tab. Enter a OneDrive watch path (e.g. `C:\Users\you\OneDrive\Audiobooks`), Save folder. Click **Build and save**. The zip lands in that folder; the phone picks it up via OneDrive sync.
7. **M4B path:** flip the Format toggle to **M4B**, click Build download. Once done, `ffprobe -show_format -show_streams -show_chapters <file>.m4b` should report `codec_name=aac`, `sample_rate=44100`, one chapter per non-excluded source, monotonic timestamps with each chapter's `end` equal to the next's `start`, and total duration within ±50 ms of the sum of source durations. Side-load to a PocketBook → the file lands under Audiobooks (not Music), the built-in player shows the chapter list, and closing/reopening resumes at the same position.
8. (Negative path) Delete one chapter's mp3 from the workspace and re-open the modal. **Build download** surfaces the missing-chapter banner listing the slug for both formats. Regenerate the chapter and try again.

## Out of scope (follow-ups)

- **Cover art** — _shipped under plan 36 + A2/A3._ The OpenLibrary picker
  caches the chosen JPEG at `<bookDir>/.audiobook/cover.jpg`. Both
  `buildM4b` and `applyId3v24Tags` now read that file when present and
  embed it as the iTunes `covr` atom (M4B) or ID3v2 APIC frame
  (MP3.ZIP). Absent cover → exports still ship without artwork. Pinned
  by `build-m4b.test.ts` ("embeds the OpenLibrary cover...") and
  `id3-tags.test.ts` ("cover embedding (coverJpegPath)").
- **PocketBook Cloud direct upload.** Closed protocol; not worth reverse-engineering when sideload via LAN URL or sync folder works fine.
- **Send-to-PocketBook email gateway** (`@pbsync.com`). Marketed for ebooks; audiobook size limits undocumented. Could be a third destination tab later.
