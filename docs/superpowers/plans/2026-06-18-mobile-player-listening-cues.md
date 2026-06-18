# Mobile Player Listening Cues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three listening cues to the Flutter companion's per-book player screen — auto-scroll to the current chapter, a finished-checkmark + current-chapter progress bar, and a chapter label in the bottom transport.

**Architecture:** All UI changes land in one screen (`player_screen.dart`). The "finished" state reuses the already-persisted per-chapter `finished` flag (new read method on `DriftLocalLibrary`). The current chapter's progress comes from the existing `positionStream` + the chapter's manifest `durationSec`. Auto-scroll offset is a pure, unit-tested helper applied via a `ScrollController`; the screen follows chapter changes (incl. auto-advance) by listening to `nowPlayingStream`.

**Tech Stack:** Dart / Flutter, drift (SQLite), `flutter_test` (widget tests), the in-memory `buildDemoRuntime` test harness.

## Global Constraints

- **Surface is `apps/android` only.** No server, web-frontend, sync-manifest, or OpenAPI changes.
- **No new package dependencies.** Auto-scroll uses `ScrollController` + a pure offset helper, NOT `scrollable_positioned_list`.
- **"Finished" = played to its end only.** Reuse the persisted `finished` flag; do NOT invent a positional "everything behind me is done" heuristic.
- **Run tests with `flutter test <path>`** from `apps/android/`. On Windows PowerShell the binary is `flutter.bat`.
- **Match existing style:** colours via `Theme.of(context).colorScheme` (no hex literals); follow the discriminated/`SyncManifestChapter` data already on the screen.
- **Branch:** `fix/app-player-listening-cues` (already cut). Commit after each task.

---

### Task 1: `finishedChapterUuids` read on `DriftLocalLibrary`

Surfaces the persisted per-chapter `finished` flag as a set the UI can query. `DownloadedChapter` does not carry `finished`, so a dedicated read is correct.

**Files:**
- Modify: `apps/android/lib/src/data/drift_local_library.dart` (add method near `setChapterFinished`, ~line 294)
- Test: `apps/android/test/data/drift_local_library_test.dart` (append)

**Interfaces:**
- Produces: `Future<Set<String>> DriftLocalLibrary.finishedChapterUuids(String bookId)` — the uuids of that book's chapters whose `finished` column is `true`.

- [ ] **Step 1: Write the failing test**

Append to `apps/android/test/data/drift_local_library_test.dart` (reuse the file's existing in-memory `DriftLocalLibrary` setup — typically `DriftLocalLibrary(LibraryDatabase(NativeDatabase.memory()), <fileStore>, root: ...)` plus `recordChapterMeta`/`recordChapter`). If the file has a helper that seeds a book + chapters, use it; otherwise seed inline as below:

```dart
test('finishedChapterUuids returns only chapters flagged finished', () async {
  final lib = DriftLocalLibrary(
      LibraryDatabase(NativeDatabase.memory()), InMemoryFileStore(),
      root: '/t');
  await lib.recordChapterMeta(
      bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
      fingerprint: 'demo|10', urlSuffix: 'audio.mp3', durationSec: 100);
  await lib.recordChapterMeta(
      bookId: 'b1', uuid: 'u2', chapterId: 2, title: 'Two',
      fingerprint: 'demo|10', urlSuffix: 'audio.mp3', durationSec: 100);
  await lib.recordChapterMeta(
      bookId: 'b2', uuid: 'u3', chapterId: 1, title: 'Other',
      fingerprint: 'demo|10', urlSuffix: 'audio.mp3', durationSec: 100);

  await lib.setChapterFinished('u1', true);
  await lib.setChapterFinished('u3', true); // different book

  expect(await lib.finishedChapterUuids('b1'), {'u1'});
});
```

Ensure imports at the top of the file cover `package:drift/native.dart` (`NativeDatabase`), `library_database.dart`, `drift_local_library.dart`, and the file store used by the file's other tests (`InMemoryFileStore` from `file_store.dart`). Reuse whatever the existing tests already import.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/data/drift_local_library_test.dart`
Expected: FAIL — `The method 'finishedChapterUuids' isn't defined`.

- [ ] **Step 3: Add the read method**

In `apps/android/lib/src/data/drift_local_library.dart`, immediately after `setChapterFinished`:

```dart
  /// The uuids of [bookId]'s chapters the user has played to the end
  /// (the persisted `finished` flag). Drives the chapter-list "done" check.
  Future<Set<String>> finishedChapterUuids(String bookId) async {
    final rows = await (_db.select(_db.chapters)
          ..where((c) => c.bookId.equals(bookId) & c.finished.equals(true)))
        .get();
    return {for (final r in rows) r.uuid};
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/data/drift_local_library_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/drift_local_library.dart apps/android/test/data/drift_local_library_test.dart
git commit -m "feat(app): read finished chapter uuids from drift store"
```

---

### Task 2: Pure chapter-scroll offset helper

The scroll math, isolated so it is unit-tested without the widget tree (approach A). The screen wiring in Task 5 just applies it.

**Files:**
- Create: `apps/android/lib/src/domain/chapter_scroll.dart`
- Test: `apps/android/test/domain/chapter_scroll_test.dart`

**Interfaces:**
- Produces: `double chapterScrollOffset({required int index, required double rowHeight, double contextRows, required double maxExtent})` — pixel offset placing `index` near the top with `contextRows` rows above it, clamped to `[0, maxExtent]`.

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/domain/chapter_scroll_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/chapter_scroll.dart';

void main() {
  test('index 0 stays at the top', () {
    expect(
        chapterScrollOffset(index: 0, rowHeight: 72, maxExtent: 5000), 0);
  });

  test('deep index scrolls with one row of context above', () {
    // (10 - 1) * 72 = 648
    expect(
        chapterScrollOffset(index: 10, rowHeight: 72, maxExtent: 5000), 648);
  });

  test('offset is clamped to maxExtent', () {
    expect(
        chapterScrollOffset(index: 100, rowHeight: 72, maxExtent: 1000), 1000);
  });

  test('early index that would be negative clamps to 0', () {
    expect(
        chapterScrollOffset(index: 1, rowHeight: 72, contextRows: 2, maxExtent: 5000),
        0);
  });
}
```

> Replace `castwright` with the actual package name from `apps/android/pubspec.yaml` (`name:` field) if it differs — match the imports other test files in `test/domain/` use.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/domain/chapter_scroll_test.dart`
Expected: FAIL — target of URI doesn't exist (`chapter_scroll.dart`).

- [ ] **Step 3: Write the helper**

Create `apps/android/lib/src/domain/chapter_scroll.dart`:

```dart
/// Pixel offset to scroll a fixed-row chapter list so [index] sits near the top
/// with [contextRows] rows still visible above it, clamped to `[0, maxExtent]`.
/// Pure so the player screen's auto-scroll math is testable without a widget
/// tree; the row height is an estimate (rows are near-uniform), so this brings
/// the current chapter into view rather than pixel-aligning it.
double chapterScrollOffset({
  required int index,
  required double rowHeight,
  double contextRows = 1,
  required double maxExtent,
}) {
  final raw = (index - contextRows) * rowHeight;
  if (raw <= 0) return 0;
  return raw > maxExtent ? maxExtent : raw;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/domain/chapter_scroll_test.dart`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/chapter_scroll.dart apps/android/test/domain/chapter_scroll_test.dart
git commit -m "feat(app): pure chapter-list scroll offset helper"
```

---

### Task 3: Finished checkmark + current-chapter progress bar

Reads the finished set (Task 1), refreshes it live on completion, rebuilds on chapter change, and renders the three row states.

**Files:**
- Modify: `apps/android/lib/src/ui/player_screen.dart`
- Test: `apps/android/test/ui/player_screen_test.dart` (create)

**Interfaces:**
- Consumes: `DriftLocalLibrary.finishedChapterUuids(String)` (Task 1); `PlayerController.chapterCompletedStream`, `.nowPlayingStream`, `.positionStream`, `.currentChapterUuid` (existing).
- Produces: state field `Set<String> _finished` and helper `bool _isFinished(String uuid)` used by Task 5's row taps; a `StreamSubscription` list disposed in `dispose()`.

- [ ] **Step 1: Write the failing widget test**

Create `apps/android/test/ui/player_screen_test.dart`. Build the screen over the in-memory demo runtime and assert the finished check + progress bar. (`buildDemoRuntime` seeds `hollow-tide-1` with chapters `ht1-c1/c2/c3` and a resume at `ht1-c2`.)

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/ui/player_screen.dart';

void main() {
  testWidgets('finished chapter shows a check; current chapter shows a progress bar',
      (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo');
    await rt.library.setChapterFinished('ht1-c1', true); // mark chapter 1 done

    await tester.pumpWidget(MaterialApp(
      home: PlayerScreen(
          runtime: rt, bookId: 'hollow-tide-1', title: 'The Drowning Bell'),
    ));
    await tester.pumpAndSettle();

    // Chapter 1 (finished, not current) → a check icon.
    expect(find.byIcon(Icons.check_circle), findsOneWidget);

    // The current chapter (ht1-c2, the resume point) → a LinearProgressIndicator.
    expect(
        find.descendant(
          of: find.byKey(const Key('chapter-ht1-c2')),
          matching: find.byType(LinearProgressIndicator),
        ),
        findsOneWidget);
  });
}
```

> Match the package name and `InMemoryFileStore` import to the conventions in the existing `test/ui/*` and `test/demo/demo_runtime_test.dart` files.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/player_screen_test.dart`
Expected: FAIL — no `check_circle` icon / no `LinearProgressIndicator` under the current row.

- [ ] **Step 3: Load + refresh the finished set, rebuild on chapter change**

In `apps/android/lib/src/ui/player_screen.dart`:

Add imports at the top:

```dart
import 'dart:async';
import '../domain/chapter_scroll.dart';
```

Add state fields to `_PlayerScreenState` (alongside `_chapters`):

```dart
  Set<String> _finished = {};
  final List<StreamSubscription<Object?>> _subs = [];
```

In `_prepare()`, after `_chapters = widget.runtime.sync.chaptersOf(widget.bookId);` and before `_ready = true;`, load the finished set:

```dart
          _finished =
              await widget.runtime.library.finishedChapterUuids(widget.bookId);
```

> Note: `finishedChapterUuids` is async — assign it on a line *before* the `setState(() { ... })` block (await it, store in a local, then set state), or `await` it just above the `setState`. Keep the existing `setState` synchronous. Concretely, restructure the tail of `_prepare()`:
>
> ```dart
>       final chapters = widget.runtime.sync.chaptersOf(widget.bookId);
>       final finished =
>           await widget.runtime.library.finishedChapterUuids(widget.bookId);
>       if (mounted) {
>         setState(() {
>           _chapters = chapters;
>           _finished = finished;
>           _ready = true;
>         });
>         _ensureCurrentPeaks();
>       }
> ```

At the end of `_prepare()`'s `try` (after the `setState`), wire two subscriptions:

```dart
      // Move the highlight + progress as chapters change (incl. auto-advance).
      _subs.add(widget.runtime.player.nowPlayingStream.listen((_) {
        if (mounted) setState(() {});
      }));
      // Tick a chapter to "done" the moment it finishes, no reopen needed.
      _subs.add(widget.runtime.player.chapterCompletedStream.listen((uuid) {
        if (mounted) setState(() => _finished = {..._finished, uuid});
      }));
```

In `dispose()`, cancel them (add before `super.dispose()` is reached — the existing dispose already pauses/syncs; insert at the top of the method):

```dart
    for (final s in _subs) {
      s.cancel();
    }
```

Add the helper method:

```dart
  bool _isFinished(String uuid) => _finished.contains(uuid);
```

- [ ] **Step 4: Render the three row states**

Replace the `itemBuilder` body in `build()` (the `ListTile` for each chapter) with:

```dart
              itemBuilder: (_, i) {
                final c = _chapters[i];
                final current = c.uuid == player.currentChapterUuid;
                final finished = _isFinished(c.uuid);
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    ListTile(
                      key: Key('chapter-${c.uuid}'),
                      leading: CircleAvatar(child: Text('${c.id}')),
                      title: Text(
                        c.title.isEmpty ? 'Chapter ${c.id}' : c.title,
                        style: finished && !current
                            ? TextStyle(
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurfaceVariant)
                            : null,
                      ),
                      subtitle: c.durationSec != null
                          ? Text(formatDuration(c.durationSec))
                          : null,
                      trailing: current
                          ? Icon(_playing ? Icons.volume_up : Icons.pause,
                              color: Theme.of(context).colorScheme.primary)
                          : (finished
                              ? Icon(Icons.check_circle,
                                  color:
                                      Theme.of(context).colorScheme.primary)
                              : null),
                      selected: current,
                      onTap: c.hasAudio ? () => _playChapter(c.uuid) : null,
                      enabled: c.hasAudio,
                    ),
                    if (current) _currentProgressBar(c),
                  ],
                );
              },
```

Add the progress-bar builder method (a thin bar driven by the live position over the chapter's duration):

```dart
  /// A 2px progress bar under the current chapter row, position / duration.
  Widget _currentProgressBar(SyncManifestChapter c) {
    final durMs = (c.durationSec ?? 0) * 1000;
    if (durMs <= 0) return const SizedBox.shrink();
    return StreamBuilder<Duration>(
      stream: widget.runtime.player.positionStream,
      builder: (_, snap) {
        final posMs = (snap.data ?? Duration.zero).inMilliseconds.toDouble();
        final value = (posMs / durMs).clamp(0.0, 1.0);
        return LinearProgressIndicator(
          minHeight: 2,
          value: value,
          key: Key('progress-${c.uuid}'),
        );
      },
    );
  }
```

> `SyncManifestChapter` is already imported via `../domain/sync_manifest.dart` (the screen uses it for `_chapters`). If the import is missing, add it.

- [ ] **Step 5: Run test to verify it passes**

Run: `flutter test test/ui/player_screen_test.dart`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/ui/player_screen.dart apps/android/test/ui/player_screen_test.dart
git commit -m "feat(app): finished check + current-chapter progress bar in player list"
```

---

### Task 4: Name the current chapter in the bottom transport

Adds a single ellipsized `Ch. N · Title` line above the scrubber.

**Files:**
- Modify: `apps/android/lib/src/ui/player_screen.dart` (the `_transport` method)
- Test: `apps/android/test/ui/player_screen_test.dart` (append)

**Interfaces:**
- Consumes: `_chapters`, `player.currentChapterUuid` (existing).
- Produces: a `Text` widget with `Key('player-current-chapter')` (Task 5 wraps it in a tap target).

- [ ] **Step 1: Write the failing test**

Append to `apps/android/test/ui/player_screen_test.dart`:

```dart
  testWidgets('bottom transport names the current chapter', (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo');
    await tester.pumpWidget(MaterialApp(
      home: PlayerScreen(
          runtime: rt, bookId: 'hollow-tide-1', title: 'The Drowning Bell'),
    ));
    await tester.pumpAndSettle();

    // Resume point is ht1-c2 = id 2, title "Bells Beneath".
    expect(find.text('Ch. 2 · Bells Beneath'), findsOneWidget);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/player_screen_test.dart`
Expected: FAIL — `Ch. 2 · Bells Beneath` not found.

- [ ] **Step 3: Add the label builder and render it in `_transport`**

Add a helper method to `_PlayerScreenState`:

```dart
  /// `Ch. <id> · <title>` for the loaded chapter, or empty when none.
  String _currentChapterLabel(PlayerController player) {
    final uuid = player.currentChapterUuid;
    if (uuid == null) return '';
    final match = _chapters.where((c) => c.uuid == uuid);
    if (match.isEmpty) return '';
    final c = match.first;
    final title = c.title.isEmpty ? 'Chapter ${c.id}' : c.title;
    return 'Ch. ${c.id} · $title';
  }
```

In `_transport`, inside the `Column(children: [...])` returned by the inner `StreamBuilder<Duration>` builder, insert as the FIRST child (above the waveform/slider `Builder`):

```dart
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 2, 16, 4),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          _currentChapterLabel(player),
                          key: const Key('player-current-chapter'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                      ),
                    ),
```

> `_transport(PlayerController player)` already receives `player`. `context` is available inside the builder closures.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/ui/player_screen_test.dart`
Expected: PASS (3 tests in the file now).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/ui/player_screen.dart apps/android/test/ui/player_screen_test.dart
git commit -m "feat(app): show current chapter name in player transport"
```

---

### Task 5: Auto-scroll to the current chapter + tap-the-label to scroll

Wires the `ScrollController` + Task-2 helper: jump on open, follow on chapter change, and scroll back when the transport label is tapped.

**Files:**
- Modify: `apps/android/lib/src/ui/player_screen.dart`
- Test: `apps/android/test/ui/player_screen_test.dart` (append)

**Interfaces:**
- Consumes: `chapterScrollOffset(...)` (Task 2); the `nowPlayingStream` subscription added in Task 3; the `player-current-chapter` label (Task 4).
- Produces: `ScrollController _scroll` attached to the chapter `ListView`.

- [ ] **Step 1: Write the failing test**

Append to `apps/android/test/ui/player_screen_test.dart`. The demo book has only 3 chapters (no scroll room), so assert the wiring is present and the tap is handled rather than a pixel offset — offset correctness is covered by `chapter_scroll_test.dart` (Task 2) and the on-device pass.

```dart
  testWidgets('chapter list has a scroll controller and the label is tappable',
      (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), root: '/demo');
    await tester.pumpWidget(MaterialApp(
      home: PlayerScreen(
          runtime: rt, bookId: 'hollow-tide-1', title: 'The Drowning Bell'),
    ));
    await tester.pumpAndSettle();

    final listView = tester.widget<ListView>(find.byType(ListView));
    expect(listView.controller, isNotNull);

    // Tapping the current-chapter label must not throw (scrolls to current).
    await tester.tap(find.byKey(const Key('player-current-chapter')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('player-current-chapter')), findsOneWidget);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/player_screen_test.dart`
Expected: FAIL — `listView.controller` is null (no controller wired yet), or the label is not wrapped in a tap target.

- [ ] **Step 3: Add the controller + scroll method**

In `_PlayerScreenState`, add the field and a row-height constant:

```dart
  final ScrollController _scroll = ScrollController();
  static const double _kRowHeight = 72;
```

Dispose it — in `dispose()`, alongside the `_subs` cancellation from Task 3:

```dart
    _scroll.dispose();
```

Add the scroll method:

```dart
  void _scrollToCurrent({required bool animate}) {
    if (!_scroll.hasClients) return;
    final uuid = widget.runtime.player.currentChapterUuid;
    if (uuid == null) return;
    final i = _chapters.indexWhere((c) => c.uuid == uuid);
    if (i < 0) return;
    final target = chapterScrollOffset(
      index: i,
      rowHeight: _kRowHeight,
      maxExtent: _scroll.position.maxScrollExtent,
    );
    if (animate) {
      _scroll.animateTo(target,
          duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
    } else {
      _scroll.jumpTo(target);
    }
  }
```

- [ ] **Step 4: Attach the controller, jump on open, follow on change, tap to scroll**

(a) Attach the controller to the chapter `ListView.builder` in `build()`:

```dart
            child: ListView.builder(
              controller: _scroll,
              itemCount: _chapters.length,
              ...
```

(b) Jump to the current chapter once after the first frame. In `_prepare()`, immediately after the `setState(() { ... _ready = true; })` block, add:

```dart
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _scrollToCurrent(animate: false);
        });
```

(c) Make the `nowPlayingStream` listener (added in Task 3) also follow the new chapter. Update that listener body to:

```dart
      _subs.add(widget.runtime.player.nowPlayingStream.listen((_) {
        if (mounted) {
          setState(() {});
          _scrollToCurrent(animate: true);
        }
      }));
```

(d) Make the transport label tappable. In `_transport` (Task 4), wrap the `Text` in an `InkWell` (replace the `child: Text(...)` inside the `Align` with):

```dart
                        child: InkWell(
                          onTap: () => _scrollToCurrent(animate: true),
                          child: Text(
                            _currentChapterLabel(player),
                            key: const Key('player-current-chapter'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                        ),
```

- [ ] **Step 5: Run the full screen test file**

Run: `flutter test test/ui/player_screen_test.dart`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/ui/player_screen.dart apps/android/test/ui/player_screen_test.dart
git commit -m "feat(app): auto-scroll player list to the current chapter"
```

---

### Task 6: Full suite, analyze, and device-pass note

**Files:** none (verification only).

- [ ] **Step 1: Analyze**

Run: `flutter analyze` (from `apps/android/`)
Expected: No new issues. Fix any introduced (unused imports, missing `const`).

- [ ] **Step 2: Run the app's test suite**

Run: `flutter test`
Expected: All pass, including the new `drift_local_library_test.dart`, `chapter_scroll_test.dart`, and `player_screen_test.dart`.

- [ ] **Step 3: Manual device pass (record in the PR, not blocking the suite)**

On a paired device, open a deep book (e.g. "Unraveled") resumed mid-book and confirm:
1. The list scrolls to the current chapter on open.
2. Finished chapters show the check; the current chapter shows a moving progress bar.
3. The bottom transport names the current chapter; tapping it scrolls back to that row.
4. On auto-advance to the next chapter, the highlight + progress bar + bottom label move and the list follows.

- [ ] **Step 4: Final commit (if analyze required fixes)**

```bash
git add -A
git commit -m "chore(app): lint cleanups for player listening cues"
```

---

## Self-Review

- **Spec coverage:**
  - Issue 1 (auto-scroll) → Task 2 (offset helper) + Task 5 (wiring, follow-on-advance, tap-to-scroll). ✓
  - Issue 2 (finished check + progress bar) → Task 1 (read) + Task 3 (render + live refresh). ✓
  - Issue 3 (bottom-bar chapter label) → Task 4. ✓
  - "Finished = played to end" → Task 1 reads the persisted flag only; no positional heuristic. ✓
  - Testing (finished rows, progress bar, bottom label, scroll target, read path) → Tasks 1–5 each carry the matching test; Task 6 adds the manual pass. ✓
  - Out of scope (no deps, no server, reject `scrollable_positioned_list`) → Global Constraints + Task 2 helper. ✓
- **Placeholder scan:** No TBD/TODO; every code step shows complete code. Two parameterized notes (package name, existing test-setup reuse) are explicit instructions, not placeholders. ✓
- **Type consistency:** `finishedChapterUuids` (Task 1) consumed in Task 3; `chapterScrollOffset` signature identical in Task 2 test, helper, and Task 5 call; `_currentChapterLabel`/`_scrollToCurrent`/`_isFinished` defined once and reused; `player-current-chapter` key shared by Tasks 4 and 5. ✓
