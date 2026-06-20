---
status: active
shipped: null
owner: null
---

# Companion: finished book leaves Continue listening shelf (app-14)

> Status: active
> Key files: `apps/android/lib/src/data/library_database.dart`, `apps/android/lib/src/data/drift_local_library.dart`, `apps/android/lib/src/domain/home_shelf.dart`, `apps/android/lib/src/data/player_controller.dart`, `apps/android/lib/src/data/companion_runtime.dart`, `apps/android/lib/src/ui/library_home_screen.dart`
> URL surface: indirect — Android companion home screen shelf rail
> OpenAPI ops: none (Branch 1 is all on-device; cross-device sync is deferred to Branch 2)

Related plans: [188 — Android companion app](188-android-companion-app.md) (umbrella), [app-4 finished tracking](188-android-companion-app.md).

## Benefit / Rationale

- **User:** A book you finish listening to stops cluttering the "Continue listening" shelf automatically — and every chapter gets its tick mark — without any manual action. You can still replay a finished book; it re-appears on the shelf and the ticks clear when you resume it.
- **Technical:** A single `Books.hidden` flag (Drift schema 6) drives shelf exclusion. The player emits an early near-end event — rather than waiting for the audio engine's own `completionStream` — so skip/seek into a chapter's final 10 seconds reliably ticks the chapter even if the engine never fires its end event.
- **Architectural:** Keeps all state local (on-device Drift DB) in Branch 1. The `bookCompletedStream` is a new extension point for Branch 2's cross-device sync (calling `POST /api/books/{id}/shelf-status` when the book finishes). The long-press remove uses the same `setBookHidden` seam.

## Architectural impact

**New seams / extension points:**

- `Books.hidden` column (Drift schema 6, `BoolColumn`, default `false`) — the gate that `buildContinueListening` filters on.
- `DriftLocalLibrary.setBookHidden(bookId, bool)` — direct hidden flag setter; used by the long-press remove path and Branch 2's server-push path.
- `DriftLocalLibrary.markBookFinished(bookId)` — sets every chapter's `finished = true` AND `hidden = true` atomically; called by `companion_runtime` on book-completion.
- `PlayerController.bookCompletedStream` — a `Stream<String>` emitting the `bookId` once when playback enters the last `kFinishThreshold` of the last chapter. Branch 2 can subscribe to this alongside the runtime to push to the server.
- `const Duration kFinishThreshold = Duration(seconds: 10)` (top-level in `player_controller.dart`) — the single named constant controlling the "fire early" window. Fires when `remaining <= kFinishThreshold`, covering the 5–10 s zone.

**Invariants preserved:**

- Existing `chapterCompletedStream` / `markPlayed` / resume-sync behavior is unchanged. `markPlayed` now additionally clears `hidden` (reversibility) but its chapter-finishing semantic is the same.
- Chapters ≤ 10 s in duration fall back to the engine's `completionStream` for their per-chapter tick (near-end math can't fire before the audio starts for very short chapters).
- `buildContinueListening` ordering (newest `lastPlayedAt` first) is preserved; `hidden` books are excluded before the sort.

**Migration story:**

- Drift schema 5 → 6: addColumn migration (`await m.addColumn(books, books.hidden)`). No data loss; existing rows default to `hidden = false`.

**Reversibility:**

- `markPlayed(bookId, isoNow)` clears `hidden = false`. So replaying a finished/hidden book restores it to the shelf immediately on the next resume.
- The `Books.hidden` column can be dropped in a future schema revision with no API surface change.

## Invariants to preserve

- `kFinishThreshold` in `player_controller.dart` (top-level constant) is `Duration(seconds: 10)` — the finish fires when remaining audio is at or below 10 s.
- `_nearEndTickedUuid` de-dup in `PlayerController._onTick` ensures a single chapter emits at most one `chapterCompleted` event via the near-end path per chapter open.
- `_bookFinishEmitted` de-dup in `PlayerController._onTick` ensures a single book emits at most one `bookCompleted` event per `openBook` call; the flag is reset in `openBook` / `_loadIndex` so replay re-fires.
- `Books.hidden` in `library_database.dart` (schema 6) is `BoolColumn` with `withDefault(Constant(false))`.
- `DriftLocalLibrary.markPlayed` sets `hidden = false` — replay always un-hides.
- `buildContinueListening` in `home_shelf.dart` filters `b.inProgress && !b.hidden` before sorting.

## Test plan

### Automated coverage

- `apps/android/test/data/drift_local_library_test.dart`:
  - `setBookHidden persists and surfaces via listBooks` — round-trips `hidden = true/false`.
  - `markBookFinished ticks all chapters and hides the book` — all chapters `finished`, `BookSummary.hidden = true`.
  - `markPlayed clears hidden flag` — after `markBookFinished`, calling `markPlayed` sets `hidden = false`.
- `apps/android/test/domain/home_shelf_test.dart`:
  - `buildContinueListening excludes hidden books` — a hidden in-progress book does not appear on the shelf.
  - `buildContinueListening still orders visible books newest-first` — ordering invariant preserved.
- `apps/android/test/data/player_controller_test.dart`:
  - `near-end position ticks the chapter without waiting for completion` — position tick at 51 s of a 60 s chapter emits `chapterCompleted`; a second tick for the same chapter does not re-emit.
  - `last chapter near-end emits bookCompleted once` — position tick in the last 10 s of the last chapter emits `bookCompletedStream` once; a second tick does not re-emit.
  - `non-last chapter near-end does NOT emit bookCompleted` — a near-end tick on a non-last chapter does not emit `bookCompletedStream`.
- `apps/android/test/ui/library_home_screen_test.dart`:
  - `long-press shelf card shows remove-from-shelf sheet` — long-pressing a shelf card opens the bottom sheet.
  - `tapping Remove from Continue listening hides the book` — tapping the remove tile calls `setBookHidden(true)` and the card is gone from the shelf.

Surfaces not yet unit-tested: `companion_runtime` wiring of `bookCompletedStream → markBookFinished` is device glue (no unit harness — consistent with the rest of `companion_runtime`); covered by the above tests + the manual walkthrough below.

### Manual acceptance walkthrough

Run on a real device or emulator connected to the local Castwright server with at least one downloaded book that has two or more chapters.

1. **Finish the last chapter.**
   Play a book to the last chapter. With ≤ 10 s remaining (or use the seek bar to jump to the last 10 s), confirm:
   - The book card disappears from the "Continue listening" shelf on the home screen.
   - Every chapter row in the library / book detail shows a tick mark.

2. **Skip/seek into a chapter's last 10 s.**
   On any chapter (not necessarily the last), seek to within the final 10 s without finishing the chapter. Confirm:
   - A tick mark appears for that chapter.
   - The shelf is unaffected (book stays on shelf unless this was also the last chapter in step 1).

3. **Long-press → Remove.**
   Long-press any card on the "Continue listening" shelf. A bottom sheet appears with "Remove from Continue listening". Tap it.
   - The card disappears immediately from the shelf.

4. **Replay a removed / finished book.**
   Open any book that was removed/finished (it still appears in the full library). Resume or start playback.
   - The book reappears on the "Continue listening" shelf.
   - Chapter ticks are cleared as chapters are replayed.

## Behavior notes

### Auto-delete-finished interaction (C1)

When a book is finished, `markBookFinished` ticks **every** chapter as finished — including chapters the user may have skipped. This is intentional: a completed book should show full tick marks regardless of whether every chapter was listened to in full.

The companion app has an off-by-default **"Auto-delete finished audio"** setting (key `auto-delete-finished`, defaulting to `false` in `app_settings.dart`; toggled in `settings_screen.dart`). If the user has enabled this setting, finishing a book makes the entire book's downloaded audio — including chapters they skipped — eligible for deletion on the next storage-enforcement or sync pass (see `CompanionRuntime.enforceStorageCap` and `DriftLocalLibrary.applyEviction`).

The book itself stays in the library and remains re-downloadable at any time. Replaying a finished book (calling `openBook` again) clears the `hidden` flag via `markPlayed` and restores it to the "Continue listening" shelf. The user can then download and listen again normally.

**Summary:** enabling "Auto-delete finished audio" means finishing any book — even one where chapters were skipped — may free disk space for all of that book's audio on the next enforcement pass.

## Out of scope

Cross-device sync is deferred to Branch 2 (not in this plan):

- Calling `POST /api/books/{id}/shelf-status` on auto-finish or manual remove so the web shelf reflects the phone's state.
- Pulling server `finished`/`hidden` state into Drift on sync so finished state survives a reinstall and a book finished on the web leaves the phone shelf.
- Fixing the `listenedAt` reconcile in `resume_reconcile.dart` to compare parsed `DateTime` instants rather than raw ISO strings (timezone/format skew silently drops a push). See `apps/android/lib/src/domain/resume_reconcile.dart`.

## Suggested follow-ups (Branch 2)

- **Cross-device shelf sync:** On `bookCompletedStream` (and on `setBookHidden(true)` from the long-press), call `POST /api/books/{id}/shelf-status` with `{ finished: true, hidden: true }` so the web app's Listen shelf updates immediately.
- **Server → companion pull:** During delta sync, pull `finished`/`hidden` from the server's `listen-progress.json` (plan 213 `POST /shelf-status` payload) into Drift so reinstalled companions inherit the correct shelf state and a book finished on the web leaves the phone shelf.
- **`listenedAt` reconcile fix:** `resume_reconcile.dart` compares `listenedAt` as raw ISO strings; timezone or sub-second formatting differences can silently drop a valid push. Fix to parse + compare as `DateTime` and add a paired regression test with a timezone-skewed pair.

## Ship notes

(Filled in when status flips to `stable`.)
