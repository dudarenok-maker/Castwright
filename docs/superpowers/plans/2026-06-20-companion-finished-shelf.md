# Companion "Finished book → leaves Continue listening" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Android companion, a book that reaches the last ~10s of its last chapter auto-leaves the "Continue listening" shelf (and all its chapters get ticked), chapters tick reliably even when skipped/seeked, and the user can long-press a shelf card to remove a book manually.

**Architecture:** All on-device (Branch 1 of 2 — no server/sync changes here; cross-device sync is the follow-up branch). A new `Books.hidden` flag (Drift schema 6) drives shelf exclusion; `markPlayed` clears it so replay restores the book (reversibility). The player gains a near-end position check that (a) emits the existing per-chapter "completed" event early enough that skipping/seeking still ticks a chapter, and (b) emits a new book-completed event on the last chapter. `companion_runtime` wires book-completed → `markBookFinished` (tick all chapters + hide). The shelf builder filters `hidden`; the shelf card gets a long-press remove.

**Tech Stack:** Flutter / Dart, Drift (SQLite) ORM with code generation (`build_runner`), `flutter_test`.

## Global Constraints

- Branch: `fix/app-companion-finished-shelf` cut from `main`.
- Scope is the Android companion only: `apps/android/lib/**` + `apps/android/test/**`. Do NOT touch the server, the web frontend, or the OpenAPI contract in this branch.
- Finish threshold (verbatim from user decision): a book is finished when playback enters the **last 5–10 seconds of the last chapter on the device**. Implement as a single named constant `kFinishThreshold = Duration(seconds: 10)` (fires when `remaining <= kFinishThreshold`, i.e. anywhere in the final 10s — satisfies the 5–10s window).
- On auto-finish (user decision): **remove the book from the shelf AND mark every chapter finished (full ticks)**. Reversible — replaying the book restores it to the shelf.
- Tests run from `apps/android/` via `flutter test` (use `flutter.bat` under PowerShell on this box). Drift codegen: `dart run build_runner build --delete-conflicting-outputs` from `apps/android/`.
- TDD: every task writes the failing test first, watches it fail, then implements. Commit per task.
- Follow existing companion conventions: pure logic in `domain/`, IO behind `data/`, widgets in `ui/`; new public methods carry a one-line doc comment in the established voice.

---

### Task 1: `Books.hidden` column + Drift migration (schema 6) + library methods

**Files:**
- Modify: `apps/android/lib/src/data/library_database.dart:21-38` (add column), `:97` (schemaVersion), `:100-108` (migration)
- Modify: `apps/android/lib/src/data/drift_local_library.dart:13-30` (BookSummary), `:288-306` (markPlayed/setChapterFinished region — add methods), `:342-356` (listBooks)
- Regenerate: `apps/android/lib/src/data/library_database.g.dart` (via build_runner — do not hand-edit)
- Test: `apps/android/test/data/drift_local_library_test.dart`

**Interfaces:**
- Produces (on `DriftLocalLibrary`):
  - `Future<void> setBookHidden(String bookId, bool hidden)`
  - `Future<void> markBookFinished(String bookId)` — sets every chapter's `finished = true` AND `hidden = true` in one go.
  - `markPlayed(String bookId, String isoNow)` — now ALSO sets `hidden = false` (un-hide on replay).
  - `BookSummary` gains `final bool hidden;` (required field); `listBooks()` populates it from `Books.hidden`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/android/test/data/drift_local_library_test.dart`:

```dart
test('setBookHidden persists and surfaces via listBooks', () async {
  await lib.upsertBookMeta(
      bookId: 'b1', title: 'T', author: 'A', series: '', seriesPosition: null);
  expect((await lib.listBooks()).single.hidden, isFalse);
  await lib.setBookHidden('b1', true);
  expect((await lib.listBooks()).single.hidden, isTrue);
});

test('markPlayed clears hidden (replay restores the book)', () async {
  await lib.upsertBookMeta(
      bookId: 'b1', title: 'T', author: 'A', series: '', seriesPosition: null);
  await lib.setBookHidden('b1', true);
  await lib.markPlayed('b1', '2026-06-20T12:00:00Z');
  expect((await lib.listBooks()).single.hidden, isFalse);
});

test('markBookFinished ticks every chapter and hides the book', () async {
  await lib.upsertBookMeta(
      bookId: 'b1', title: 'T', author: 'A', series: '', seriesPosition: null);
  await lib.recordChapter('b1', 'u1', 'fp', 'audio.mp3');
  await lib.recordChapter('b1', 'u2', 'fp', 'audio.mp3');
  await lib.markBookFinished('b1');
  expect(await lib.finishedChapterUuids('b1'), {'u1', 'u2'});
  expect((await lib.listBooks()).single.hidden, isTrue);
});
```

> NOTE: match the existing test setup in this file (`lib` is a `DriftLocalLibrary` over `NativeDatabase.memory()`). If `recordChapter`/`upsertBookMeta` signatures differ in the current file, mirror the existing passing tests at lines ~54 and ~164.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/android/`): `flutter test test/data/drift_local_library_test.dart`
Expected: FAIL — `hidden` not a member of `BookSummary`; `setBookHidden`/`markBookFinished` undefined.

- [ ] **Step 3a: Add the column + migration**

In `apps/android/lib/src/data/library_database.dart`, inside `class Books`, after `lastPlayedAt` (line 31):

```dart
  /// Whether the user has dismissed this book from the "Continue listening"
  /// shelf — set on auto-finish (last chapter reached) or a manual long-press
  /// remove, cleared on replay (markPlayed). Drives shelf exclusion only; the
  /// book stays fully in the library.
  BoolColumn get hidden => boolean().withDefault(const Constant(false))();
```

Bump the schema version (line 97):

```dart
  @override
  int get schemaVersion => 6;
```

Add the migration step (inside `onUpgrade`, after the `from < 5` line at 106):

```dart
          if (from < 6) await m.addColumn(books, books.hidden);
```

- [ ] **Step 3b: Regenerate Drift codegen**

Run (from `apps/android/`): `dart run build_runner build --delete-conflicting-outputs`
Expected: `library_database.g.dart` regenerates with the `hidden` column; no errors.

- [ ] **Step 3c: Add `hidden` to BookSummary + listBooks**

In `apps/android/lib/src/data/drift_local_library.dart`, `BookSummary` (lines 13-30): add `required this.hidden,` to the constructor and `final bool hidden;` to the fields.

In `listBooks()` (lines 344-355), add to the `BookSummary(...)` map:

```dart
          hidden: b.hidden,
```

- [ ] **Step 3d: Add methods + un-hide on markPlayed**

In `apps/android/lib/src/data/drift_local_library.dart`, replace `markPlayed` (lines 288-292) and add the new methods immediately after `setChapterFinished` (after line 297):

```dart
  Future<void> markPlayed(String bookId, String isoNow) async {
    await _ensureBook(bookId);
    await (_db.update(_db.books)..where((b) => b.bookId.equals(bookId)))
        .write(BooksCompanion(
      lastPlayedAt: Value(isoNow),
      hidden: const Value(false), // replaying un-hides from the shelf
    ));
  }

  /// Hide/un-hide a book from the "Continue listening" shelf without touching
  /// its resume point or chapter ticks (manual long-press remove).
  Future<void> setBookHidden(String bookId, bool hidden) async {
    await _ensureBook(bookId);
    await (_db.update(_db.books)..where((b) => b.bookId.equals(bookId)))
        .write(BooksCompanion(hidden: Value(hidden)));
  }

  /// Mark a whole book finished: tick every chapter and drop it from the shelf.
  /// Reversible — markPlayed (replay) clears `hidden`.
  Future<void> markBookFinished(String bookId) async {
    await (_db.update(_db.chapters)..where((c) => c.bookId.equals(bookId)))
        .write(const ChaptersCompanion(finished: Value(true)));
    await setBookHidden(bookId, true);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `flutter test test/data/drift_local_library_test.dart`
Expected: PASS (incl. the existing tests in the file — the `markPlayed` change must not break `markPlayed and setChapterFinished surface in bookUsages`).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/library_database.dart apps/android/lib/src/data/library_database.g.dart apps/android/lib/src/data/drift_local_library.dart apps/android/test/data/drift_local_library_test.dart
git commit -m "feat(app): add Books.hidden flag + markBookFinished, un-hide on replay (app-14)"
```

---

### Task 2: Exclude hidden books from the "Continue listening" shelf

**Files:**
- Modify: `apps/android/lib/src/domain/home_shelf.dart:6-32`
- Modify: `apps/android/lib/src/ui/library_home_screen.dart:60-69` (pass `hidden`)
- Test: `apps/android/test/domain/home_shelf_test.dart` (create if absent)

**Interfaces:**
- Consumes: `BookSummary.hidden` (Task 1).
- Produces: `ShelfBook` gains `final bool hidden;` (defaulted to `false` so callers/tests not setting it still compile); `buildContinueListening` excludes `hidden` books.

- [ ] **Step 1: Write the failing test**

In `apps/android/test/domain/home_shelf_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright_companion/src/domain/home_shelf.dart';

void main() {
  ShelfBook book(String id, {String? lastPlayedAt, bool hidden = false}) =>
      ShelfBook(
        bookId: id,
        title: id,
        author: 'A',
        lastPlayedAt: lastPlayedAt,
        updatedAt: '',
        hidden: hidden,
      );

  test('buildContinueListening excludes hidden books', () {
    final shelf = buildContinueListening([
      book('a', lastPlayedAt: '2026-06-20T10:00:00Z'),
      book('b', lastPlayedAt: '2026-06-20T11:00:00Z', hidden: true),
    ]);
    expect(shelf.map((b) => b.bookId), ['a']);
  });

  test('buildContinueListening still orders visible books newest-first', () {
    final shelf = buildContinueListening([
      book('a', lastPlayedAt: '2026-06-20T10:00:00Z'),
      book('b', lastPlayedAt: '2026-06-20T11:00:00Z'),
    ]);
    expect(shelf.map((b) => b.bookId), ['b', 'a']);
  });
}
```

> NOTE: confirm the package import prefix used elsewhere in `apps/android/test/` (e.g. `package:castwright_companion/...`) and match it; check an existing test's imports if unsure.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/domain/home_shelf_test.dart`
Expected: FAIL — `ShelfBook` has no `hidden` parameter.

- [ ] **Step 3: Implement**

In `apps/android/lib/src/domain/home_shelf.dart`, add to `ShelfBook` constructor `this.hidden = false,` and field `final bool hidden;` (after `updatedAt`, ~line 22). Then change `buildContinueListening` (lines 28-32):

```dart
List<ShelfBook> buildContinueListening(List<ShelfBook> books) {
  final inProgress = books.where((b) => b.inProgress && !b.hidden).toList()
    ..sort((a, b) => b.lastPlayedAt!.compareTo(a.lastPlayedAt!));
  return inProgress;
}
```

In `apps/android/lib/src/ui/library_home_screen.dart` (lines 60-69), add `hidden: s.hidden,` to the `ShelfBook(...)` map.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/domain/home_shelf_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/home_shelf.dart apps/android/lib/src/ui/library_home_screen.dart apps/android/test/domain/home_shelf_test.dart
git commit -m "feat(app): exclude hidden books from Continue listening shelf (app-14)"
```

---

### Task 3: Near-end chapter tick + book-completed event in PlayerController

**Files:**
- Modify: `apps/android/lib/src/data/player_controller.dart` — constant + fields (~line 110-122), `_loadIndex` reset (212-233), `_onTick` (305-320), `dispose` (355-363)
- Test: `apps/android/test/data/player_controller_test.dart`

**Interfaces:**
- Consumes: `_engine.duration` (`Duration?`), `currentChapterUuid`, `_index`, `_playlist`, existing `_chapterCompleted` stream.
- Produces: `Stream<String> get bookCompletedStream` — emits the `bookId` once when the last chapter enters the final `kFinishThreshold`. Top-level `const Duration kFinishThreshold = Duration(seconds: 10);`.

- [ ] **Step 1: Write the failing tests**

In `apps/android/test/data/player_controller_test.dart`, add (the file already has a fake `AudioEngine` exposing `positionStream`/`completionStream`/`durationStream`; mirror its existing setup at ~line 27 and the chapter-complete test at ~line 284). Use the fake's position controller to push a near-end tick:

```dart
test('near-end position ticks the chapter without waiting for completion',
    () async {
  // openBook a 2-chapter playlist with known durations (60s each), play ch1.
  // Push a position tick at 51s (remaining 9s <= 10s threshold).
  final done = <String>[];
  final sub = pc.chapterCompletedStream.listen(done.add);
  await pc.openBook('b1'); // ch1 = uuid 'u1'
  fakeEngine.emitDuration(const Duration(seconds: 60));
  fakeEngine.emitPosition(const Duration(seconds: 51));
  await Future<void>.delayed(Duration.zero);
  expect(done, ['u1']);
  // A second near-end tick must NOT re-emit for the same chapter.
  fakeEngine.emitPosition(const Duration(seconds: 52));
  await Future<void>.delayed(Duration.zero);
  expect(done, ['u1']);
  await sub.cancel();
});

test('last chapter near-end emits bookCompleted once', () async {
  final books = <String>[];
  final sub = pc.bookCompletedStream.listen(books.add);
  await pc.openBook('b1');
  await pc.playChapter('u2'); // u2 = last chapter
  fakeEngine.emitDuration(const Duration(seconds: 60));
  fakeEngine.emitPosition(const Duration(seconds: 55)); // remaining 5s
  await Future<void>.delayed(Duration.zero);
  fakeEngine.emitPosition(const Duration(seconds: 56));
  await Future<void>.delayed(Duration.zero);
  expect(books, ['b1']);
  await sub.cancel();
});

test('non-last chapter near-end does NOT emit bookCompleted', () async {
  final books = <String>[];
  final sub = pc.bookCompletedStream.listen(books.add);
  await pc.openBook('b1'); // starts at u1 (not last)
  fakeEngine.emitDuration(const Duration(seconds: 60));
  fakeEngine.emitPosition(const Duration(seconds: 55));
  await Future<void>.delayed(Duration.zero);
  expect(books, isEmpty);
  await sub.cancel();
});
```

> NOTE: adapt `fakeEngine.emitPosition/emitDuration` and the playlist-loader fixture to the existing fakes in this test file (it already drives `positionStream` and `completionStream`). If the fake lacks a duration emitter, add one mirroring `completionStream`'s controller. The `pc` / `fakeEngine` / playlist-loader wiring must match the file's existing `setUp`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `flutter test test/data/player_controller_test.dart`
Expected: FAIL — `bookCompletedStream` undefined; no near-end emit.

- [ ] **Step 3a: Add constant, stream, and dedup fields**

At top level of `apps/android/lib/src/data/player_controller.dart` (near other top-level declarations):

```dart
/// A book/chapter counts as finished once playback enters this window before
/// the end — covers the user's "last 5–10 seconds" rule and makes ticks robust
/// to skipping/seeking (no need to hit the engine's exact end-of-file event).
const Duration kFinishThreshold = Duration(seconds: 10);
```

Add fields next to `_chapterCompleted` (after line 113):

```dart
  /// Emits a book's `bookId` once when its LAST chapter enters [kFinishThreshold].
  final StreamController<String> _bookCompleted =
      StreamController<String>.broadcast();
  Stream<String> get bookCompletedStream => _bookCompleted.stream;

  /// Dedup guards so the per-tick near-end check fires at most once per chapter
  /// and once per book; reset on every chapter load.
  String? _nearEndTickedUuid;
  bool _bookFinishEmitted = false;
```

- [ ] **Step 3b: Reset dedup guards on chapter load**

In `_loadIndex` (after `_index = index;`, line 214):

```dart
    _nearEndTickedUuid = null;
    if (index != _playlist.length - 1) _bookFinishEmitted = false;
```

> Rationale: clearing `_nearEndTickedUuid` lets each newly-loaded chapter tick once. `_bookFinishEmitted` is reset only when loading a non-last chapter, so re-seeking within the already-finished last chapter doesn't re-emit; opening/replaying the book loads ch1 (non-last) and clears it.

- [ ] **Step 3c: Add the near-end check to `_onTick`**

In `_onTick` (lines 305-320), add BEFORE the autosave-throttle block (so it runs every tick, not just every 10s):

```dart
  void _onTick(Duration position) {
    final book = _bookId;
    final uuid = currentChapterUuid;
    final dur = _engine.duration;
    if (book != null && uuid != null && dur != null && dur > kFinishThreshold) {
      final remaining = dur - position;
      if (remaining <= kFinishThreshold) {
        if (_nearEndTickedUuid != uuid) {
          _nearEndTickedUuid = uuid;
          if (!_chapterCompleted.isClosed) _chapterCompleted.add(uuid);
        }
        final isLast = _index == _playlist.length - 1;
        if (isLast && !_bookFinishEmitted) {
          _bookFinishEmitted = true;
          if (!_bookCompleted.isClosed) _bookCompleted.add(book);
        }
      }
    }
    // ── existing autosave-throttle block stays exactly as-is below ──
    final last = _lastSave;
    final now = _now();
    if (last == null || now.difference(last) >= _autosaveInterval) {
      // ... unchanged ...
    }
  }
```

> The existing `_chapterCompleted` listener in `companion_runtime` already persists the tick via `setChapterFinished` — emitting here reuses that path; the natural `completionStream` path (which also calls `_advance`) is untouched.

- [ ] **Step 3d: Close the new stream in dispose**

In `dispose()` (after `await _chapterCompleted.close();`, line 361):

```dart
    await _bookCompleted.close();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `flutter test test/data/player_controller_test.dart`
Expected: PASS (including the existing completion/advance tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/player_controller.dart apps/android/test/data/player_controller_test.dart
git commit -m "feat(app): near-end chapter tick + book-completed event (kFinishThreshold) (app-4)"
```

---

### Task 4: Wire book-completed → markBookFinished in companion_runtime

**Files:**
- Modify: `apps/android/lib/src/data/companion_runtime.dart:188-190` (add subscription next to the chapter-completed one) + the subscription-disposal list
- Test: `apps/android/test/data/companion_runtime_test.dart` (or the existing runtime wiring test; create a focused test if none exists)

**Interfaces:**
- Consumes: `player.bookCompletedStream` (Task 3), `library.markBookFinished` (Task 1).

- [ ] **Step 1: Write the failing test**

Add a test that drives a fake/real `PlayerController`'s `bookCompletedStream` and asserts `library.markBookFinished(bookId)` ran (e.g. the book's `hidden` becomes true and chapters become finished). Mirror how `companion_runtime` is constructed in existing runtime tests; if the runtime is hard to assemble, instead assert the wiring at the seam:

```dart
test('book-completed marks the book finished (ticks all + hides)', () async {
  // Arrange a DriftLocalLibrary (memory) with book 'b1' + 2 chapters, and a
  // PlayerController whose bookCompletedStream we can push to.
  final completed = StreamController<String>.broadcast();
  final sub = completed.stream.listen((id) => library.markBookFinished(id));
  completed.add('b1');
  await Future<void>.delayed(Duration.zero);
  expect((await library.listBooks()).single.hidden, isTrue);
  expect((await library.finishedChapterUuids('b1')).length, 2);
  await sub.cancel();
  await completed.close();
});
```

> This proves the listener body (`(id) => library.markBookFinished(id)`) is correct. The literal `player.bookCompletedStream.listen(...)` line in `companion_runtime` is the same one-liner shape already used+trusted for `chapterCompletedStream` at line 189-190.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/data/companion_runtime_test.dart`
Expected: FAIL — `markBookFinished` undefined OR (if Task 1 merged) assertion drives the wiring.

- [ ] **Step 3: Implement the wiring**

In `apps/android/lib/src/data/companion_runtime.dart`, immediately after the `completedSub` (line 190):

```dart
    // app-14: when the last chapter is reached, drop the book from the shelf
    // and tick all its chapters.
    final bookFinishedSub = player.bookCompletedStream
        .listen((bookId) => library.markBookFinished(bookId));
```

Add `bookFinishedSub` to wherever `completedSub`/`connectivitySub` are collected for cancellation on runtime dispose (match the existing pattern in this file — find where `completedSub` is added to a disposables list / cancelled).

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/data/companion_runtime_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/companion_runtime.dart apps/android/test/data/companion_runtime_test.dart
git commit -m "feat(app): drop finished book from shelf + tick all chapters on last-chapter end (app-14)"
```

---

### Task 5: Long-press a shelf card to remove from Continue listening

**Files:**
- Modify: `apps/android/lib/src/ui/library_home_screen.dart:206-244` (`_shelfCard`) + add a remove handler
- Test: `apps/android/test/ui/library_home_screen_test.dart` (create if absent; mirror an existing widget test's harness)

**Interfaces:**
- Consumes: `widget.runtime.library.setBookHidden` (Task 1), the `_refresh()` method (rebuilds `_continue`).

- [ ] **Step 1: Write the failing test**

A widget test: pump `LibraryHomeScreen` with a runtime whose library has one in-progress book; long-press the shelf card (`Key('continue-<id>')`); tap the "Remove from Continue listening" action; assert `setBookHidden(id, true)` ran and the card is gone after refresh.

```dart
testWidgets('long-press shelf card removes the book from Continue listening',
    (tester) async {
  // library has book 'b1' with lastPlayedAt set (on the shelf).
  await tester.pumpWidget(MaterialApp(home: LibraryHomeScreen(runtime: rt)));
  await tester.pumpAndSettle();
  expect(find.byKey(const Key('continue-b1')), findsOneWidget);
  await tester.longPress(find.byKey(const Key('continue-b1')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Remove from Continue listening'));
  await tester.pumpAndSettle();
  expect((await rt.library.listBooks()).single.hidden, isTrue);
  expect(find.byKey(const Key('continue-b1')), findsNothing);
});
```

> NOTE: reuse the runtime/library test harness from `apps/android/test/ui/player_screen_test.dart` (it builds an `rt` with a memory-backed library). Match its construction.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/library_home_screen_test.dart`
Expected: FAIL — no long-press handler / no remove action.

- [ ] **Step 3: Implement**

In `apps/android/lib/src/ui/library_home_screen.dart`, change `_shelfCard`'s `InkWell` to add `onLongPress` and add a handler method. The `InkWell` (line 208):

```dart
    return InkWell(
      key: Key('continue-${b.bookId}'),
      onTap: () => _openBook(b.bookId, b.title),
      onLongPress: () => _confirmRemoveFromShelf(b),
      child: SizedBox(
```

Add the handler method in `_LibraryHomeScreenState`:

```dart
  Future<void> _confirmRemoveFromShelf(ShelfBook b) async {
    final remove = await showModalBottomSheet<bool>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListTile(
          key: const Key('remove-from-shelf'),
          leading: const Icon(Icons.remove_circle_outline),
          title: const Text('Remove from Continue listening'),
          onTap: () => Navigator.of(ctx).pop(true),
        ),
      ),
    );
    if (remove != true) return;
    await widget.runtime.library.setBookHidden(b.bookId, true);
    if (mounted) await _refresh();
  }
```

> The bottom-sheet `ListTile` text `'Remove from Continue listening'` is what the test taps. The book reappears automatically if the user replays it (markPlayed clears `hidden`).

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/ui/library_home_screen_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/ui/library_home_screen.dart apps/android/test/ui/library_home_screen_test.dart
git commit -m "feat(app): long-press a shelf card to remove from Continue listening (app-14)"
```

---

### Task 6: Regression doc, INDEX, full analyze + test

**Files:**
- Create: `docs/features/app-14-continue-listening-finished.md` (regression plan from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md` (add the new plan under its area)

- [ ] **Step 1: Write the regression plan**

From `docs/features/TEMPLATE.md`, document: the finish rule (`kFinishThreshold`, last 5–10s of last chapter), the `Books.hidden` flag + reversibility (cleared on `markPlayed`), the near-end per-chapter tick, the long-press remove, and the manual acceptance walkthrough (finish a book → it leaves the shelf, all chapters ticked; skip a chapter near its end → tick appears; long-press → removed; replay → returns). Add frontmatter `status: active`. Note the deferred Branch 2 (cross-device sync of finished/hidden via `POST /shelf-status`, reinstall survival, `listenedAt` reconcile fix) as a "Suggested follow-up".

- [ ] **Step 2: Update INDEX**

Add the new plan to `docs/features/INDEX.md` under the companion/app area.

- [ ] **Step 3: Full companion analyze + test**

Run (from `apps/android/`):
```bash
flutter analyze
flutter test
```
Expected: analyze clean; all tests pass (no regressions in existing companion suites).

- [ ] **Step 4: Commit**

```bash
git add docs/features/app-14-continue-listening-finished.md docs/features/INDEX.md
git commit -m "docs(docs): regression plan for companion finished-shelf behaviour (app-14)"
```

---

## Deferred to Branch 2 (cross-device sync — NOT in this plan)

- Companion → server: call `POST /api/books/{id}/shelf-status` (`finished`/`hidden`) on auto-finish and manual remove so the web shelf clears too.
- Server → companion: pull server `finished`/`hidden` into Drift so finished state survives a reinstall and a book finished on the web leaves the phone shelf.
- Fix the `listenedAt` reconcile (`resume_reconcile.dart`) to compare parsed instants, not raw ISO strings (timezone/format skew can silently drop a push). Add a regression test with a timezone-skewed pair.

## Self-Review

- **Spec coverage:** Symptom 2 (finished stays on shelf) → Tasks 1+3+4. Symptom 3a (unreliable ticks) → Task 3 near-end tick. Symptom 4 (manual remove) → Tasks 1+5. Symptom 1 + 3b (sync, reinstall survival) → explicitly deferred to Branch 2 per the user's local-first scope decision. ✓
- **Placeholder scan:** all code steps contain concrete code; test fixtures flagged with NOTEs to match existing harnesses (the only honest unknown — the exact fake-engine/runtime test scaffolding — is called out, not hand-waved). ✓
- **Type consistency:** `setBookHidden`, `markBookFinished`, `markPlayed`, `BookSummary.hidden`, `ShelfBook.hidden`, `bookCompletedStream`, `kFinishThreshold`, `_nearEndTickedUuid`, `_bookFinishEmitted` used identically across Tasks 1–5. ✓
