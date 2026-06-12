---
status: stable
shipped: 2026-05-18
owner: null
---

# Voice (Android audiobook player) export — M4B-standards path

> Status: stable end-to-end (live tile + description field shipped 2026-05-18).
> Key files: `server/src/export/build-m4b.ts`, `src/data/listener-apps.ts`,
> `src/views/listen.tsx`, `src/modals/export-audiobook.tsx`
> Paired tests: `server/src/export/build-m4b.test.ts` (audiobook media-kind
> atom regression guard), `src/views/listen.test.tsx` (Voice tile live +
> opens modal in Voice mode), `src/modals/export-audiobook.test.tsx`
> (Voice-mode hides format/destination toggles + submits with the forced shape)
> Cross-links: [32 — Audiobook export](32-audiobook-export.md), [18 — Listen view](18-listen-view.md), [28 — Audio output format](28-chapter-audio-format.md)

## Background

[Voice](https://github.com/PaulWoitaschek/Voice) (formerly Material Audiobook
Player) is the user's daily-driver audiobook player on Android — GPLv3,
F-Droid + Google Play, actively maintained, ships with per-book resume, custom
bookmarks, Android Auto, and a folder-scan library model. It's the second
live listener-app tile on the Listen view (after PocketBook).

Why M4B for Voice specifically:

- One file per book matches Voice's library model — Voice groups by folder,
  one audiobook = one folder. A single `.m4b` is the cleanest case.
- M4B carries chapter markers in the file (QuickTime `chap` track + iTunes
  metadata), so chapter navigation works without a sidecar JSON.
- Voice writes resume position and custom bookmarks to its own per-device
  database, keyed by file path. They "just work" against any file Voice
  finds in its library folder — no server-side metadata supports them.

The integration shape is the same as PocketBook: produce a well-formed file,
get it onto the device (via Syncthing pulling `<exportSyncFolder>`), let
Voice scan the library folder.

## What Voice on Android reads from an `.m4b`

| Atom                  | Purpose                                        | Required for Voice-Android                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chap` track          | Chapter markers — Voice's chapter navigator    | **Yes** (primary)                                                                                                                                                                                                                                        |
| `©nam` (title)        | Book title                                     | **Yes**                                                                                                                                                                                                                                                  |
| `©ART` (artist)       | Author or narrator credit                      | **Yes**                                                                                                                                                                                                                                                  |
| `©alb` (album)        | Book title (Voice ignores; harmless duplicate) | Optional                                                                                                                                                                                                                                                 |
| `aART` (album_artist) | Author                                         | Optional                                                                                                                                                                                                                                                 |
| `©gen` (genre)        | Genre                                          | Optional                                                                                                                                                                                                                                                 |
| `©day` (date)         | Publication date                               | Optional                                                                                                                                                                                                                                                 |
| `covr`                | Cover art (embedded JPEG/PNG)                  | Optional. Now embedded via plan 36 A2 when `<bookDir>/.audiobook/cover.jpg` exists; absent → Voice falls back to the default tile.                                                                                                                       |
| `stik = 2`            | iTunes "audiobook" media kind                  | Not required by Voice on Android specifically — Voice treats every file in its library as an audiobook regardless. **Still worth keeping** for cross-app library moves (Apple Books, Plex, BookPlayer) and as a stable signal of "this is an audiobook." |
| `pgap = 1`            | Gapless playback flag                          | No effect on Voice-Android with single-file M4B                                                                                                                                                                                                          |
| `soal` / series       | Sort fields                                    | Voice groups by folder, not album tag — no effect                                                                                                                                                                                                        |

## What the existing pipeline does

The existing `buildM4b` in [`server/src/export/build-m4b.ts`](../../server/src/export/build-m4b.ts)
already produces a Voice-Android-conformant audiobook M4B. The shape:

1. Walk `state.chapters` in id order, skipping excluded chapters, requiring a
   current `.mp3` for each non-excluded chapter (else `ExportIncompleteError`
   with the missing-slug list).
2. `ffprobe` each MP3 for its exact duration — the chapter timestamps in the
   M4B are derived from these source durations (NOT from a post-encode probe,
   which would drift by AAC priming + concat padding ms per chapter).
3. Write an FFMETADATA sidecar with book-level tags + one `[CHAPTER]` block
   per source chapter. `media_type=2` flips Apple/QuickTime players from
   Music → Audiobook and lands as the `stik` atom under
   `moov/udta/meta/ilst`.
4. Concat-demuxer file lists the absolute MP3 paths, single-quoted so Windows
   backslashes pass through.
5. One ffmpeg pass: concat + FFMETADATA → AAC-LC 96 kbps mono 44.1 kHz with
   `+faststart`. Stream copy is intentionally _not_ used inside MP4 — that
   produces a file no major player accepts.

The mapping `FFMETADATA media_type=2` → mp4 `stik` atom = 2 is the cross-app
audiobook signal. Voice-Android doesn't read it; Apple Books / Plex /
BookPlayer do. The regression guard in `build-m4b.test.ts` walks the atom
tree (with an `ffprobe -show_entries format_tags=media_type` primary path
and a raw `moov/udta/meta/ilst/stik/data` reader as fallback) and asserts
the value lands as 2 in the built file.

## Invariants to preserve

- **The `stik = 2` atom survives the mp4 muxer.** A future ffmpeg upgrade
  silently changing its FFMETADATA-to-atom mapping would still play fine on
  Voice-Android (Voice doesn't read `stik`) but would downgrade the file
  to "music" on Apple Books / Plex / BookPlayer. The test in
  `build-m4b.test.ts` is the guard.
- **No code change to `build-m4b.ts` for Voice.** The existing builder is
  already conformant; this plan locks in that conformance, it does not
  reshape the builder.
- **Voice exports default to M4B + sync-folder.** Voice has no in-app
  download affordance; it scans its library folder. The export modal's
  Voice mode (`appHint === 'voice'`) hides the format and destination
  radios so the user can't accidentally pick a shape Voice can't ingest.
- **The empty-sync-folder banner is reused, not duplicated.** When the user
  clicks the Voice tile without `exportSyncFolder` configured, the existing
  empty-sync-folder error path surfaces — same code path as the generic
  modal's sync-folder tab.
- **Plan 32-audiobook-export's invariants still hold.** The Voice tile is a
  thinner entry point into the same export pipeline (`createBookExport` →
  `buildM4b` → `writeToSyncFolder` → `manifest.json` rehydration). All of
  plan 32's invariants (per-source ffprobe for chapter timestamps,
  excluded chapters never in the output, atomic writes, in-memory jobs
  not authoritative for downloads) continue to govern the Voice flow.

## Manual on-device acceptance (Android)

Pre-req: the user has Syncthing on their PC pulling from
`<exportSyncFolder>` into the Voice library folder on Android. Voice
installed from F-Droid or Google Play.

1. Generate the canonical end-to-end manuscript per `CLAUDE.md` —
   `server/src/__fixtures__/the-coalfall-commission.md`. Run analysis,
   confirm cast, generate every chapter.
2. Listen tab → **Voice** tile. The export modal opens with the format
   radio hidden (M4B forced) and the destination radio hidden
   (sync-folder forced). The destination tabs are replaced by the
   caption "Saves to your Voice library at `<exportSyncFolder>`".
3. Click **Export to Voice library**. The queue row appears with the
   M4B format badge and ticks `queued` → `in_progress` → `done`.
4. On disk: `<exportSyncFolder>/<book-title>.m4b` exists.
5. `ffprobe -v error -show_chapters -show_format -show_entries
format_tags=media_type,title,album,artist,album_artist <m4b>` should
   return:
   - `format_tags.media_type = 2` (the audiobook media-kind atom)
   - one chapter per non-excluded source chapter with the source titles
   - title/album/artist/album_artist matching the book state
6. On the Android device, after Syncthing pulls the new `.m4b`, open
   Voice. The book appears in the library with the correct title and
   author.
7. Tap into the book. The chapter navigator shows the full chapter
   list with the correct titles — confirms the `chap` track reached
   the player.
8. Scrub to mid-chapter, drop a custom bookmark, back out of the book,
   return — Voice resumes at the bookmark.
9. Force-stop Voice entirely, reopen — Voice still resumes at the
   bookmark (per-book resume invariant; Voice-side database, file-path
   keyed).

Negative path:

- With `exportSyncFolder` unset in user settings, click the Voice tile.
  The empty-sync-folder banner appears (reused from the generic modal's
  sync-folder tab). Configure the folder, save, retry.
- Delete one chapter's `.mp3` from the workspace, click Voice. The
  missing-chapter banner appears (shared with the generic flow).
  Regenerate the chapter, retry.

## Known gaps (deferred but harmless to add later)

- **`pgap = 1` gapless flag** — no observable effect on Voice-Android with
  single-file M4B (no inter-file gap to suppress).
- **Series-aware `album = series` mapping** — Voice groups books by folder,
  not by album tag. No observable effect.

## Shipped follow-ups

- **Long-form description (`desc` / `ldes`)** — shipped 2026-05-18. Added a
  `description: string | null` field to `BookStateJson`, `EditableBookMeta`,
  and the listen-view metadata editor (a textarea below Publication date).
  `buildM4b` writes both `description=` (mp4 `desc` atom — short
  description) and `synopsis=` (mp4 `ldes` atom — long description) to
  FFMETADATA with the same value when a description is set. Pinned by
  `build-m4b.test.ts` "embeds the description into the M4B desc / ldes
  atoms" (positive) + "omits desc / ldes atoms when state.description is
  null or blank" (negative). Closes the `[BACKLOG Could #15]` entry.
- **Cover art (`covr`)** — plan 36 A2 wired `buildM4b` to read
  `<bookDir>/.audiobook/cover.jpg` and embed it as the iTunes `covr`
  atom with `attached_pic` disposition. Absent cover → no video stream,
  export still ships. Voice picks the embedded image up automatically.

## Out of scope (intentional)

- **MP3-folder export for other folder-based listener apps** (Smart
  AudioBook Player, BookPlayer, Audiobookshelf folder mode) — separate
  plan if any of those tiles get prioritised next. The user picked Voice
  specifically for the M4B-with-bookmarks UX; doubling the export-format
  surface now would be scope-creep without on-device evidence anyone needs it.
- **iOS Voice equivalents** — different app, separate integration.
- **ID3v2 CHAP frames** — irrelevant; we ship M4B for Voice.
- **Direct USB/ADB push to the device** — Syncthing matches the existing
  `exportSyncFolder` destination's model.

## Ship notes

- **Shipped:** 2026-05-18.
- **Final scope:** the originally-deferred "Long-form description" follow-up landed in the same plan close-out — `description: string | null` field on `BookStateJson` + `EditableBookMeta` + listen-view textarea + FFMETADATA `description` / `synopsis` writes. The earlier known gap is now closed; `[BACKLOG Could #15]` removed.
- **Atom-mapping invariants pinned:** `stik=2` (audiobook media kind) + `desc` / `ldes` (description) survive the mp4 muxer, verified end-to-end by `build-m4b.test.ts` against real ffmpeg + ffprobe.

## Related plans

- [32 — Audiobook export](32-audiobook-export.md) — the underlying export
  pipeline (MP3.ZIP + M4B, download + sync-folder destinations, job
  lifecycle, manifest rehydration). This plan reuses every part of it.
- [18 — Listen view](18-listen-view.md) — the host view; Voice is the
  second tile to graduate from `KNOWN: scaffolded`-disabled-placeholder
  to live, after PocketBook.
- [28 — Audio output format](28-chapter-audio-format.md) — chapter MP3
  invariants that the Voice export carries through unchanged.
