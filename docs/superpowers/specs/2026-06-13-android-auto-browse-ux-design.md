---
title: Android Auto in-car browse UX
date: 2026-06-13
status: draft
scope: app (companion / apps/android)
relates: app-9 (in-car media browsing)
---

# Android Auto in-car browse UX

## Context

The companion app (`apps/android`, Flutter + `audio_service` 0.18.18 + `just_audio`)
exposes an Android Auto media browser (app-9). On-device testing (USB Android Auto,
MG head unit) surfaced that **playback works but the in-car experience is broken** in
several distinct ways. The phone media notification renders fully (title / cover /
scrubber), and so does the car's *native* home-screen now-playing widget — proving the
media **session** is correct. The failures are all in the **Android Auto projection**:
the browse tree and the cross-process artwork.

### Observed (worked / didn't)

- ✅ Car native home-screen now-playing widget: cover + title + chapter + play-time + transport.
- ❌ AA app on first open: **"No items"** — empty browse tree.
- ❌ Books only appeared after starting playback on the phone, and then rendered as
  **one tab per book** (hard to use); the selected book showed **"No items."**
- ❌ The book being listened to (*Unraveled*) was **not pre-selected**, and the current
  chapter was **not highlighted**.
- ❌ **No cover art** in the AA projection — neither on the now-playing screen nor on
  browse rows (even though the native home widget showed it).

### Root causes (code-confirmed)

| # | Symptom | Cause |
|---|---------|-------|
| A | "No items" until something forces a refresh | AA calls `getChildren('root')` before the async `_boot()` → `attach()` wires `_childrenProvider`; returns `[]`. Nothing ever calls `AudioService.notifyChildrenChanged` when the runtime becomes ready (`audio_service.dart:3822`). |
| B | Books shown as tabs; "hard to use" | Root returns N browsable books with **no `CONTENT_STYLE_*` hints**; AA's default for browsable root children is the tab strip. |
| C | Selected book shows "No items" | `library.chaptersForBook()` is empty for books with no locally-downloaded audio, yet `listBooks()` still lists them. |
| D | Current chapter not highlighted; current book not pre-selected | Now-playing `mediaItem.id` is the **bare chapter uuid** (`player_controller.dart:175` → `companion_audio_handler.dart:51`), but browse ids are `chapter/<bookId>/<uuid>` (`media_browse_tree.dart:10`) — they never match, so AA can't correlate the active row. No "current book" concept at the root. |
| E | No cover art in the AA projection (now-playing + rows) | `artUri = Uri.file(...)` (`companion_audio_handler.dart:56`) is a **private `file://` path** the AA host process can't read cross-process. The native home widget only worked because it sourced the notification's pre-decoded bitmap. Browse rows set no `artUri` at all. |

## Goals

- AA opens **directly into the current book's chapter list**, current chapter highlighted.
- A clean, driver-safe way to switch books (Library), without one-tab-per-book.
- Everything shown is **playable offline** (downloaded-only) — no dead taps, no "No items."
- Browse tree is **populated on first open** (no empty flash) and **stays live** as
  playback moves.
- **Cover art renders** in the AA projection — now-playing and rows.

## Non-goals

- No change to the working phone notification or the car's native home-screen widget.
- No streaming of non-downloaded audio in the car (LAN server is usually unreachable).
- No per-chapter completion-percentage bars (YAGNI for v1; the active-row highlight is enough).
- No custom AA pixel layout — Android Auto's templates are fixed; we only choose tree
  shape + content-style hints.

## Design

### Browse tree shape

```
root  (2 browsable children → AA renders 2 tabs)
├── "current"  → tab label = current book's title (e.g. "Unraveled")     [Tab 1, default]
│     └── getChildren("current") → current book's DOWNLOADED chapters (playable)
│            • ids: chapter/<bookId>/<uuid>   • current chapter highlighted
└── "library"  → tab label = "Library"                                    [Tab 2]
      └── getChildren("library") → DOWNLOADED books (browsable), ids book/<bookId>
             └── getChildren("book/<bookId>") → that book's downloaded chapters (playable)
```

- **`"current"` is a stable sentinel id**, not the live book id, so the root's *shape*
  never changes — only what `getChildren("current")` resolves to. Tab 1's **label**
  still reflects the live book title.
- **Content-style hints** — *root-level* style (how the 2 top items render) goes in
  `AudioServiceConfig.androidBrowsableRootExtras` (confirmed supported channel,
  `audio_service.dart:3503`); *child-level* style (chapters/books render as **lists**) is
  set as `CONTENT_STYLE_*_HINT = 1 (LIST)` in each parent item's `extras` (`MediaItem.extras`
  are propagated to Android Auto — confirmed in `audio_service` CHANGELOG). Whether the 2
  root items render as **2 tabs or a 2-row list** is AA-controlled; both are acceptable per
  the agreed UX — verify on device, don't over-promise.
- **Downloaded-only — `bytes > 0`, not "row exists"** (adversarial finding). `applyEviction`
  (`drift_local_library.dart:256`) drops a finished chapter's *file* but **keeps the row**
  with `bytes=0`/`fingerprint=null`. So a downloaded filter must check `bytes > 0` (file
  present), not row presence. A **book** is in-library iff it has ≥1 chapter with `bytes>0`.
  Requires exposing `bytes` on `DownloadedChapter` (or a dedicated filtered query).

### Current book + chapter highlight

- **"Current book" resolution** (adversarial finding — `books.lastPlayedAt` is unreliable;
  `markPlayed` is only called from the phone player UI `player_screen.dart:65`, never from
  AA-initiated playback):
  1. **During an active session** → the live `PlayerController.currentBookId` (no query).
  2. **On cold connect** (no book loaded yet) → a new store query for the **most-recently-played
     book**, keyed off the `playback` table's `updatedAt` (written every ~10s by
     `savePlayback`, regardless of which surface drove playback). Cross-check it still has
     ≥1 `bytes>0` chapter; if not, fall back to the next most-recent, else hide Tab 1.
  - To keep this consistent with the app-14 "Continue" rail, also call `markPlayed` on every
    chapter load (handler observes `nowPlayingStream`), so phone- and AA-initiated playback
    update the same signal.
- **Current chapter highlight derives from LIVE state, not the resume store** (adversarial
  finding): the first `savePlayback` is deferred up to 10s, so a store-derived "current
  chapter" lags / points at the previous chapter right after a switch. Use
  `PlayerController.currentChapterUuid`.
- **ID unification**: in `_onNowPlaying`, set the now-playing `MediaItem.id` to
  `chapterMediaId(np.bookId, np.id)` (NowPlaying already carries `bookId`). The id now
  matches the browse row → AA auto-highlights and auto-scrolls to the active chapter.
  `playFromMediaId` already parses `chapter/<bookId>/<uuid>`, so no change there.

### Readiness + refresh (Approach B, hardened)

- `getChildren` awaits a `Completer<void>` that completes when `attach()` runs, **bounded by
  a short timeout (~4s)** so AA never hangs → on timeout, return the loading/unpaired info
  row (and let `notifyChildrenChanged` refresh later). First cold-connect query returns the
  **real** tree — no "No items" flash.
- **Completer lifecycle** (adversarial finding — `attach()` calls `detach()` first):
  `detach()` resets to a *fresh, incomplete* completer; `attach()` completes it. So re-pair /
  unpair / runtime-rebuild cycles behave correctly and a query during the unpaired window
  waits (then times out to the info row) rather than returning stale data.
- `AudioService.notifyChildrenChanged("root")` once on attach (populates tab labels).
- `AudioService.notifyChildrenChanged("current")` whenever the now-playing chapter/book
  changes (driven off `nowPlayingStream`). **Ordering matters** (adversarial finding): update
  the live current-book/chapter state *before* firing the notify, else AA re-queries a stale
  `"current"` node.
- Handle the audio_service **`recentRootId` ("recent")** query gracefully — return the current
  chapter as a single playable item (enables AA/Assistant "resume") rather than misclassifying
  it as the book list.
- The `notifyChildrenChanged` + `markPlayed` calls go through **injected seams** so they're
  observable in unit tests (rather than calling the static API directly from the handler).

### Edge cases

- **No current book** (nothing played / nothing downloaded for the last book): hide Tab 1
  → root collapses to just **"Library."**
- **Unpaired / empty library**: a single non-playable info row —
  "Open Castwright on your phone to set up" — instead of a blank "No items."

### Artwork — staged, cheapest-first (adversarial revision)

The AA host process can't read the app's private `file://` thumbnails (confirmed on device:
native widget shows art via the notification bitmap; AA projection does not). **Don't assume
a custom FileProvider is required — test the config-only path first:**

- **Stage 1 (config only, no native code):** set `artDownscaleWidth/Height` in
  `AudioServiceConfig` (`audio_service.dart:3478`). This forces `audio_service` to decode +
  re-encode the bitmap through its own cache manager, which on some setups makes the art
  reachable by the AA projection. Also set `artUri` on the browse rows (currently unset).
  **Device-test whether this alone makes covers appear in the AA projection.**
- **Stage 2 (fallback, only if Stage 1 fails on device):** expose thumbnails as a
  `content://` URI — Android **`FileProvider`** (manifest `<provider>` + `res/xml/file_paths.xml`)
  + a `MethodChannel` in `MainActivity` (Kotlin) doing `FileProvider.getUriForFile` and
  granting read permission to the AA host package. Set that `content://` as the `artUri` on
  the now-playing item **and** the browse rows.

Artwork is **device-verified, not unit-tested**. We still ship in one PR, but Stage 2 native
code is only written if the on-device Stage-1 test fails — avoids speculative native work.
URI-permission grants to the car host are the main risk if Stage 2 is needed.

## Affected files

- `apps/android/lib/src/domain/media_browse_tree.dart` — tree shape: `current`/`library`
  sentinels + `MediaIdKind`, content-style extras, downloaded-only inputs, no-current /
  unpaired states. (Pure — unit-tested.)
- `apps/android/lib/src/data/companion_audio_handler.dart` — id unification, bounded readiness
  completer + lifecycle, `notifyChildrenChanged`/`markPlayed` seams, `recent` handling, art.
- `apps/android/lib/src/data/companion_runtime.dart` — `_childrenProvider`: `bytes>0`
  downloaded filtering, current-book resolution (live + store fallback), browse-row art,
  content-style extras; signal readiness on attach; fire refresh + markPlayed on now-playing
  change.
- `apps/android/lib/src/data/drift_local_library.dart` + `playback_store.dart` — expose
  `bytes` on `DownloadedChapter` (or a `downloadedChaptersForBook` filtered query) and a new
  `mostRecentlyPlayedBookId()` query over the `playback` table's `updatedAt`.
- `apps/android/lib/src/data/companion_audio_handler.dart` config — `androidBrowsableRootExtras`
  + `artDownscaleWidth/Height` (Stage 1 art).
- **Stage 2 art only (if device test fails):** `AndroidManifest.xml` `<provider>`,
  `res/xml/file_paths.xml` (new), `MainActivity.kt` MethodChannel.

## Testing

| Change | Test |
|--------|------|
| Tree shape (2 top items, current/library, no-current → hide Tab 1, unpaired info row, `recent` → current chapter) | Extend pure builder + `test/domain/media_browse_tree_test.dart` |
| `bytes>0` downloaded filter (books + chapters; evicted `bytes=0` excluded) | `test/data/` with a fake library incl. an evicted row |
| `mostRecentlyPlayedBookId()` query (max `updatedAt`; skips non-downloaded) | `test/data/drift_*` |
| Current book = live `currentBookId`, fallback to store on cold connect | `test/data/companion_audio_handler_test.dart` |
| ID unification (`mediaItem.id == chapter/<bookId>/<uuid>`) | `test/data/companion_audio_handler_test.dart` |
| Readiness completer: awaits attach, **bounded timeout**, **reset on detach/re-attach** | `test/data/companion_audio_handler_test.dart` |
| `notifyChildrenChanged` + `markPlayed` fire on now-playing change (correct order) | Observe via injected seams |
| Artwork (Stage 1 config, Stage 2 if needed) | **Device-only** manual acceptance |

## Device acceptance (head unit)

1. Cold connect (USB AA), nothing playing → AA opens on **Library** (Tab 1 hidden), books
   as a list, downloaded-only.
2. Start a book on the phone → reconnect / reopen AA → opens on **Tab 1 = book title**,
   chapters as a list, **current chapter highlighted**.
3. Switch chapter in AA → highlight moves; Tab 1 stays current.
4. **Library** tab → downloaded books → a book → its chapters → play.
5. A finished-and-evicted chapter does **not** appear (downloaded-only).
6. **Stage-1 art test:** with only `artDownscale*` set, do covers render in the AA projection
   (now-playing + rows)? If no → implement Stage 2.
7. No "No items" on any reachable, downloaded surface.

## Concurrency / lifecycle checklist (adversarial)

- Readiness completer reset correctly across unpair → re-pair (`detach`/`attach`).
- `getChildren` bounded so AA never hangs when the runtime never attaches (unpaired).
- Live current-book/chapter state updated *before* `notifyChildrenChanged("current")`.
- Tapping a chapter in AA (`playFromMediaId`) while the phone is mid-load — verify the player
  tolerates the concurrent `openBook` (device-verify; existing `openBook` is not reentrancy-guarded).
- Most-recent book deleted by storage eviction mid-session → resolution falls back, never
  points at a `bytes=0`/missing book.

## Risks

- **FileProvider URI grant to the AA host** is the fiddliest part; the host package name
  can vary. Verify on the real head unit; fall back to granting broadly if needed.
- `notifyChildrenChanged` timing: ensure the refresh fires *after* the provider can answer
  with the new current book, else AA re-queries an still-stale node.
- Shipped as **one branch / one PR** (per decision) — art + structure land together.
