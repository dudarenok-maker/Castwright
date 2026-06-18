# Mobile player-screen listening cues — design

- **Date:** 2026-06-18
- **Surface:** `apps/android` (Flutter companion app), `lib/src/ui/player_screen.dart`
- **Branch:** `fix/app-player-listening-cues`
- **Type:** UX fix (no server, no web frontend, no new feature surface)

## Problem

On the per-book player screen (the chapter list + bottom transport), three
listening cues are missing. Observed on a real device (book "Unraveled", ~45
chapters):

1. **No auto-scroll to the current chapter.** The list always opens at chapter
   1. When you resume mid-book (e.g. chapter 38), you must manually scroll to
   find where you are.
2. **No "finished" indicator.** A chapter you have completed looks identical to
   one you have never started. The only visible state is the currently-playing
   chapter (highlight + speaker icon).
3. **The bottom transport doesn't name the current chapter.** The scrubber +
   transport buttons carry no chapter title — the only way to see which chapter
   is playing is the speaker icon in the list, which requires scrolling.

All three live in one file (`player_screen.dart`) and are one cohesive change.

## What already exists (no new tracking needed)

- **Per-chapter `finished` is already persisted.** The drift `Chapters` table
  has a `finished` boolean column (`library_database.dart:69`), written via
  `DriftLocalLibrary.setChapterFinished(uuid, bool)`. It is set `true` whenever
  a chapter plays to its end — `companion_runtime.dart:189` wires
  `PlayerController.chapterCompletedStream` → `setChapterFinished(uuid, true)`.
  Nothing reads it back for display today.
- **Live position + per-chapter duration are available.**
  `PlayerController.positionStream` ticks the current position;
  `SyncManifestChapter.durationSec` carries each chapter's length; the screen
  already knows `player.currentChapterUuid`.
- **The screen is presentational and store-free-testable** — it takes a
  `CompanionRuntime` and renders from `_chapters` (the sync manifest) +
  controller streams, so the three cues are widget-testable.

## Definition of "finished" (decided)

A chapter shows **finished** only when it was actually played to its end (the
persisted `finished` flag). Manually skipping to the next chapter before the end
does **not** mark the prior chapter finished — this is honest about true
completion and reuses data already stored, rather than inventing a positional
"everything behind me is done" heuristic.

The **current** chapter additionally shows a live within-chapter progress bar.

## Design

### 1. Auto-scroll to the current chapter — approach A (no new dependency)

`ListView.builder` gets a `ScrollController`. After the first frame
(`WidgetsBinding.instance.addPostFrameCallback`), jump to the current chapter's
index using an estimated fixed row height, clamped to the scroll extent, placing
the current chapter near the top with one row of context above it:

```
target = (currentIndex * estimatedRowHeight) - oneRowOfContext
controller.jumpTo(target.clamp(0, position.maxScrollExtent))
```

For a ~45-chapter list the estimate lands within a row or so — sufficient to
"bring it into view." When a chapter **auto-advances**, animate (not jump) to
the new current index so the list follows playback.

Rationale: matches the project's "simplicity first / no speculative deps" rule.
The exact alternative (`scrollable_positioned_list` with `initialScrollIndex`)
was considered and rejected to avoid adding a dependency for a "good enough"
visual nicety.

### 2. Finished checkmark + current-chapter progress bar

**Read path.** Add `Future<Set<String>> finishedChapterUuids(String bookId)` to
`DriftLocalLibrary` — a query over the `Chapters` table for rows of that book
with `finished == true`. The player screen:

- loads it once in `_prepare()` into a `Set<String> _finished`, and
- refreshes it on `PlayerController.chapterCompletedStream` (so a chapter ticks
  to "done" live the moment it finishes, without a screen reopen).

**Row rendering** (in the existing `ListView.builder` item):

| State | Leading | Text | Extra |
|---|---|---|---|
| Finished (`uuid ∈ _finished`, not current) | check glyph | dimmed | — |
| Current (`uuid == currentChapterUuid`) | existing CircleAvatar + speaker/pause trailing icon (unchanged) | highlighted (unchanged `selected`) | thin `LinearProgressIndicator` under the tile |
| Not started | existing CircleAvatar | neutral | — |

The progress bar is a 1–2px `LinearProgressIndicator` whose value is
`position / chapterDuration`, driven by the same `positionStream` the transport
already listens to (clamped to `0..1`; hidden when duration is unknown).

A chapter can be both finished and current (you finished it and it is still
loaded) — current-state styling wins so the row still reads as "now playing."

### 3. Name the current chapter in the bottom transport

Add one ellipsized line above the scrubber inside `_transport`:

```
Ch. 38 · Chapter Thirty-Two
```

Built from `currentChapterUuid` → the matching `_chapters` entry's `id` +
`title` (falling back to `Chapter <id>` when the title is empty, matching the
list's existing fallback). Tapping the line scrolls the list back to the current
chapter (reuses the Issue-1 scroll target). No new data.

## Out of scope

- Positional / "everything before me is done" completion heuristics.
- Per-chapter resume positions (the app stores a single per-book resume point —
  unchanged).
- Any server, sync-manifest, or web-frontend change.
- The exact `scrollable_positioned_list` approach (rejected above).

## Testing

Flutter widget tests on `PlayerScreen` (store-free, via a fake/seeded
`CompanionRuntime`), one case per behavior:

1. **Finished rows** render the check glyph and dimmed styling for uuids in the
   finished set; a non-finished, non-current row does not.
2. **Current-chapter progress bar** renders a `LinearProgressIndicator` at the
   expected fraction for a given position/duration, and only on the current row.
3. **Bottom-bar label** shows `Ch. <id> · <title>` for the current chapter and
   updates when the current chapter changes.
4. **Auto-scroll** target: the screen computes/applies the current-index scroll
   offset on open (assert the controller's resolved offset is non-zero for a
   deep resume index, ~zero for index 0).
5. **Finished read path**: a unit test that `DriftLocalLibrary
   .finishedChapterUuids(bookId)` returns exactly the uuids flagged via
   `setChapterFinished`.

Plus a manual device pass (the screen is the on-device surface): resume "Unraveled"
mid-book → confirm it scrolls to the current chapter, finished chapters carry
checks, the current chapter shows a moving progress bar, and the bottom bar names
the chapter.

## Files

- `apps/android/lib/src/ui/player_screen.dart` — all three cues.
- `apps/android/lib/src/data/drift_local_library.dart` — add
  `finishedChapterUuids(bookId)` read.
- `apps/android/test/…` — new widget + unit tests above.
