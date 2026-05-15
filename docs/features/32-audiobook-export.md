# Audiobook export — sideload to PocketBook Reader (Phase A: MP3.ZIP)

> Status: stable
> Key files: `server/src/export/build-mp3-zip.ts`, `server/src/export/id3-tags.ts`, `server/src/export/sync-folder.ts`, `server/src/routes/export.ts`, `server/src/routes/export-lan.ts`, `server/src/workspace/atomic-rename.ts`, `src/modals/export-audiobook.tsx`, `src/components/export-queue-row.tsx`, `src/lib/export-queue-adapter.ts`, `src/store/exports-slice.ts`, `src/views/listen.tsx`
> URL surface: `POST /api/books/:bookId/exports`, `GET /api/books/:bookId/exports/:exportId`, `GET /api/books/:bookId/exports/:exportId/download`, `GET /api/export/lan`
> OpenAPI ops: `createBookExport`, `getBookExport`, `downloadBookExport`, `getExportLanUrls` (`openapi.yaml`)
> Paired tests: `server/src/export/id3-tags.test.ts`, `server/src/export/build-mp3-zip.test.ts`, `server/src/export/sync-folder.test.ts`, `server/src/routes/export.test.ts`, `src/store/exports-slice.test.ts`, `src/modals/export-audiobook.test.tsx`, `src/views/listen.test.tsx`
> Cross-links: [28 — Audio output format](28-chapter-audio-format.md), [18 — Listen view](18-listen-view.md), [27 — Book state persistence](27-book-state-persistence.md)

## What this covers

Packaging a finished book's per-chapter MP3 files into a single zip that PocketBook Reader (Android), Smart AudioBook Player, BookPlayer, Voice, Plex, etc. all accept as a multi-chapter audiobook. Phase A only — Phase B (`m4b`) follows in a later plan.

PocketBook publishes no off-device API, no SDK, and no partner programme. The integration shape on every platform — Android app, iOS app, physical e-reader — is **produce a well-formed file, get it onto the device, let the app pick it up.** Android is the friendliest target because Chrome on the phone can hit a LAN URL directly. The sync-folder destination covers users who'd rather route through OneDrive / Syncthing / Drive.

## How the zip is built

1. `state.chapters` is walked in id order; excluded chapters are skipped before any work happens.
2. `findChapterAudio(audioDir, chapter.slug)` (reused from plan 28) probes each chapter's mp3 path. If any non-excluded chapter has no `.mp3` (or has only a legacy `.wav`), the build refuses with `ExportIncompleteError` carrying the full missing-slug list.
3. Each chapter MP3 is run through `applyId3v24Tags` (`server/src/export/id3-tags.ts`): ffmpeg with `-c:a copy` copies the LAME VBR V2 frames byte-for-byte and writes a fresh ID3v2.4 header:
   - TIT2 = chapter title
   - TALB = book title
   - TPE1 = narrator credit, falling back to author
   - TPE2 = author
   - TRCK = `N/total`
   - TCON / TDRC = genre / publicationDate when set
4. The tagged file is added to the zip (yazl, **stored** mode — no deflate; MP3 is already compressed) under the entry name `${pad2(idx)} - ${sanitiseForZip(chapter.title)}.mp3`. `sanitiseForZip` downgrades em-dash to ` - ` and strips FAT32-illegal characters so the file survives MTP-only and SD-card copies on older e-readers.

## How the file gets to the user

Two destinations, both selectable from the same modal in the Listen view:

- **`destination: 'download'`** — the artifact stages under `<bookDir>/.audiobook/exports/<exportId>/<filename>` and `downloadUrl` resolves to `/api/books/<bookId>/exports/<exportId>/download` (range-aware, `Content-Type: application/zip`, `Content-Disposition: attachment`). The modal shows a LAN URL + QR (rendered with the `qrcode` lib) so the user can open the link in Chrome on their phone — the file lands in Downloads/ and a tap opens it with PocketBook Reader.
- **`destination: 'sync-folder'`** — after the zip is staged, `writeToSyncFolder(srcPath, exportSyncFolder, filename)` copies it into the user's configured folder via `tmp + renameWithRetry`, sharing the OneDrive-safe EPERM/EBUSY/ENOENT backoff with `state.json` writes. The user's phone picks it up on the next sync.

LAN URL enumeration (`GET /api/export/lan`) filters out 127.x and 169.254.x — those are useless from a phone. Node's `app.listen(PORT)` already binds 0.0.0.0; the only change in `server/src/index.ts` is to log every reachable URL at boot so the user can see what to point their phone at.

## Invariants to preserve

- **No re-encode.** `applyId3v24Tags` uses `-c:a copy`. The MPEG frame stream after the ID3v2 header round-trips byte-identical to the source. Any future refactor that inadvertently re-encodes drifts the user-perceived audio away from the chapter-audio plan (28) invariants. Paired test: `id3-tags.test.ts` asserts `audioBytesOnly(dest).equals(audioBytesOnly(src))`.
- **Excluded chapters are never in the zip.** State.chapters' `excluded` flag is the single source of truth.
- **Mixed-format archives are refused.** A chapter with only `.wav` triggers `ExportIncompleteError`. PocketBook reads MP3.ZIP, not "MP3-or-WAV.ZIP."
- **Atomic writes.** Both the staging artifact and the sync-folder copy use `tmp + renameWithRetry`. The retry covers OneDrive's change-detection scan window — same hazard that crashed the library-cast-override path on 2026-05-15.
- **In-memory jobs are not the source of truth for downloads.** A `manifest.json` lands next to the artifact on completion; the route's `rehydrateBook` re-populates the in-memory table on first lookup so download URLs survive server restarts.
- **The export modal is the only entry point.** The Listen view's three "Or download a file" tiles (now two) stay marked as future affordances; the live flow goes through the modal.
- **LAN bind is whatever Node defaults to.** No `host` argument is passed to `app.listen`; the user trusts their LAN. No TLS / auth — out of scope for v1.

## Acceptance walkthrough (Android, end-to-end)

Use the canonical end-to-end manuscript at `C:\Users\dudar\Downloads\Bonus Keefe Story.txt` — see the recipe in [plan 28](28-chapter-audio-format.md). Pre-req: `VITE_USE_MOCKS=false`, sidecar up, ffmpeg on PATH.

1. `npm run start`. Server stdout shows both `Listening on http://localhost:8080` and one or more `[server] LAN URL: http://192.168.x.y:8080` lines.
2. Import the canonical manuscript, generate every chapter. (Skipping a chapter? Make sure it's marked excluded on the Generate view first.)
3. From the Listen view → **Export audiobook** pill. Modal opens on the **Download to phone** tab with the LAN URL + a QR.
4. Scan the QR with Android camera (or type the URL into Chrome). Click **Build download**. Modal shows progress → done. The download URL the modal hands to the browser saves into Downloads/.
5. Tap the downloaded zip on the phone → **Open with PocketBook Reader** → the audiobook appears in the library with chapter list, cover (gradient placeholder for v1), author and narrator fields populated. Seek across chapter boundaries to confirm playback.
6. Now switch to the **Save to sync folder** tab. Enter a OneDrive watch path (e.g. `C:\Users\you\OneDrive\Audiobooks`), Save folder. Click **Build and save**. The zip lands in that folder; the phone picks it up via OneDrive sync.
7. (Negative path) Delete one chapter's mp3 from the workspace and re-open the modal. **Build download** surfaces the missing-chapter banner listing the slug. Regenerate the chapter and try again.

## Out of scope (follow-ups)

- **Phase B — single-file M4B** with chapter markers, `media_type=2`, faststart MP4. ffmpeg concat + FFMETADATA chapters file + `-c:a aac -b:a 64k -ac 1`. Add `format: 'm4b'` to the modal once the muxer lands.
- **Cover art**. The book only carries a 2-tuple gradient today; no JPEG to embed. Adding real cover input is a separate UI thread (upload field on the metadata editor, plus storage under `.audiobook/cover.jpg`).
- **Cancel / dismiss / retry on running jobs.** The modal renders progress but doesn't yet expose a Cancel button. Retry on `failed` jobs is wired in `ExportQueueRow` but not surfaced — the user re-clicks Build.
- **PocketBook Cloud direct upload.** Closed protocol; not worth reverse-engineering when sideload via LAN URL or sync folder works fine.
- **Send-to-PocketBook email gateway** (`@pbsync.com`). Marketed for ebooks; audiobook size limits undocumented. Could be a third destination tab later.
