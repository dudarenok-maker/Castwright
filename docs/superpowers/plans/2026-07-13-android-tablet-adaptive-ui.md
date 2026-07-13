# Tablet & Large-Screen Adaptive UI — Implementation Plan (app-21)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Flutter companion a two-pane list-detail layout on tablets/foldables (library + persistent player pane), cover-forward browsing, and correct rotation/foldable behaviour — with phone behaviour unchanged and no code the iOS/iPad target would have to replace.

**Architecture:** A homegrown adaptive shell built on `LayoutBuilder` + two pure decision modules (window size class, foldable pane split). The audio engine already lives on the persistent `CompanionRuntime.player`; a new `activateBook` runtime method owns book-level audio orchestration, while a `PlayerPane` widget keyed by the active book owns per-book view state. The library content is extracted into a `LibraryPane` so it renders identically single-pane (phone/tablet-portrait) and inside the two-pane `Row` (tablet-landscape/foldable-open).

**Tech Stack:** Flutter (Material 3), Dart, `flutter_test`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-13-android-tablet-adaptive-ui-design.md`
**Worktree / branch:** `C:\Claude\Projects\wt-app-tablet-adaptive` on `feat/app-tablet-adaptive-ui` (already created; rebased on `main` incl. PR #1581).

## Global Constraints

- **Scope:** `apps/android/` only. **No server, OpenAPI, or thumbnail-endpoint changes.**
- **No new dependencies.** Adaptive layer uses only Flutter framework APIs: `MediaQuery` size + `MediaQuery.displayFeatures`, Material 3 widgets. **No** `flutter_adaptive_scaffold`, `dual_screen`, `flutter_displaymode`, or Jetpack WindowManager bindings.
- **iOS-neutral:** logical-dp breakpoints; `DisplayFeature` is a framework type (empty list on iOS); `PopScope` not Android back-idioms; touch targets ≥48 dp.
- **Material 3 breakpoints:** compact `<600`, medium `600–839`, expanded `≥840` dp.
- **Phone (compact) behaviour is unchanged.** No new nav destinations; no `NavigationRail`; settings stays an app-bar action (dialog on large screens).
- **Preserve widget keys verbatim** (`Key('book-<id>')`, `Key('chapter-<uuid>')`, `Key('player-*')`) so `marketing_capture_test.dart` (phone-sized, expects a PlayerScreen push) stays green.
- **Commands (run from `apps/android/`):** `flutter analyze` · `flutter test` · `flutter test test/<path>` for one file. Flutter is on PATH (`flutter`), or `C:\Users\dudar\flutter\bin\flutter.bat`.
- **Commits:** conventional-commit subjects, scope `app` (e.g. `feat(app): …`). Co-author + session trailers per repo convention.

---

## File structure

**Create:**
- `apps/android/lib/src/domain/window_size.dart` — pure size-class + layout decision.
- `apps/android/lib/src/domain/pane_split.dart` — pure foldable-aware pane split.
- `apps/android/lib/src/ui/player_pane.dart` — reusable player body (chapter list + cover header + transport), keyed by active book.
- `apps/android/lib/src/ui/library_pane.dart` — extracted library content (search + continue rail + grouped tree/grid + actions).
- `apps/android/lib/src/ui/adaptive_library_shell.dart` — single-pane vs two-pane switch.
- `apps/android/test/domain/window_size_test.dart`
- `apps/android/test/domain/pane_split_test.dart`
- `apps/android/test/data/activate_book_test.dart`
- `apps/android/test/ui/player_pane_test.dart`
- `apps/android/test/ui/adaptive_library_shell_test.dart`

**Modify:**
- `apps/android/lib/src/data/player_controller.dart` — `switchBook` gains `bookTitle`/`artPath`.
- `apps/android/lib/src/data/companion_runtime.dart` — add `activateBook`.
- `apps/android/lib/src/ui/player_screen.dart` — becomes a thin compact host over `PlayerPane`.
- `apps/android/lib/src/ui/library_home_screen.dart` — hosts `ActiveBook` + composes `AdaptiveLibraryShell`; library body moves to `LibraryPane`.
- `apps/android/test/data/player_controller_test.dart` — cover the new `switchBook` params.

---

## Task 1: Window size class (pure)

**Files:**
- Create: `apps/android/lib/src/domain/window_size.dart`
- Test: `apps/android/test/domain/window_size_test.dart`

**Interfaces:**
- Produces: `enum WindowSizeClass { compact, medium, expanded }`; `WindowSizeClass windowSizeClassFor(double widthDp)`; `enum LibraryLayout { singlePane, twoPane }`; `LibraryLayout libraryLayoutFor(WindowSizeClass c)`.

- [ ] **Step 1: Write the failing test**

```dart
// apps/android/test/domain/window_size_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/window_size.dart';

void main() {
  group('windowSizeClassFor', () {
    test('boundaries', () {
      expect(windowSizeClassFor(0), WindowSizeClass.compact);
      expect(windowSizeClassFor(599), WindowSizeClass.compact);
      expect(windowSizeClassFor(600), WindowSizeClass.medium);
      expect(windowSizeClassFor(839), WindowSizeClass.medium);
      expect(windowSizeClassFor(840), WindowSizeClass.expanded);
      expect(windowSizeClassFor(1280), WindowSizeClass.expanded);
    });
  });

  group('libraryLayoutFor', () {
    test('twoPane only when expanded', () {
      expect(libraryLayoutFor(WindowSizeClass.compact), LibraryLayout.singlePane);
      expect(libraryLayoutFor(WindowSizeClass.medium), LibraryLayout.singlePane);
      expect(libraryLayoutFor(WindowSizeClass.expanded), LibraryLayout.twoPane);
    });
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/domain/window_size_test.dart`
Expected: FAIL — `window_size.dart` / symbols not found (compile error).

- [ ] **Step 3: Write minimal implementation**

```dart
// apps/android/lib/src/domain/window_size.dart

/// Material 3 window size classes, derived purely from logical width (dp).
/// Platform-neutral: an iPad classifies identically to an Android tablet.
enum WindowSizeClass { compact, medium, expanded }

WindowSizeClass windowSizeClassFor(double widthDp) {
  if (widthDp < 600) return WindowSizeClass.compact;
  if (widthDp < 840) return WindowSizeClass.medium;
  return WindowSizeClass.expanded;
}

/// Whether the library shows a persistent detail pane (two-pane) or pushes the
/// player as a route (single-pane). Two-pane only at the expanded breakpoint.
enum LibraryLayout { singlePane, twoPane }

LibraryLayout libraryLayoutFor(WindowSizeClass c) =>
    c == WindowSizeClass.expanded ? LibraryLayout.twoPane : LibraryLayout.singlePane;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/domain/window_size_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/window_size.dart apps/android/test/domain/window_size_test.dart
git commit -m "feat(app): window size class helper for adaptive layout (app-21)"
```

---

## Task 2: Foldable-aware pane split (pure)

**Files:**
- Create: `apps/android/lib/src/domain/pane_split.dart`
- Test: `apps/android/test/domain/pane_split_test.dart`

**Interfaces:**
- Consumes: `DisplayFeature`, `DisplayFeatureType`, `DisplayFeatureState`, `Size`, `Rect` from `package:flutter/widgets.dart`.
- Produces: `class PaneSplit { final double leftWidth; final double gutter; const PaneSplit(this.leftWidth, this.gutter); }`; `PaneSplit paneSplitForHinge(Size size, List<DisplayFeature> features, {double defaultLeftFraction = 0.4, double minLeft = 360, double maxLeft = 440})`.

- [ ] **Step 1: Write the failing test**

```dart
// apps/android/test/domain/pane_split_test.dart
import 'dart:ui';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/pane_split.dart';

DisplayFeature _vHinge(Rect bounds) => DisplayFeature(
      bounds: bounds,
      type: DisplayFeatureType.hinge,
      state: DisplayFeatureState.postureHalfOpened,
    );

void main() {
  test('no features → default fraction, clamped, no gutter', () {
    final s = paneSplitForHinge(const Size(1000, 700), const []);
    expect(s.gutter, 0);
    expect(s.leftWidth, 400); // 1000 * 0.4
  });

  test('clamps to min/max', () {
    expect(paneSplitForHinge(const Size(700, 700), const []).leftWidth, 360); // 280→min
    expect(paneSplitForHinge(const Size(2000, 900), const []).leftWidth, 440); // 800→max
  });

  test('vertical hinge → split at hinge left edge, gutter = hinge width', () {
    // hinge occupies x∈[498,502], full height → vertical seam
    final s = paneSplitForHinge(
        const Size(1000, 700), [_vHinge(const Rect.fromLTWH(498, 0, 4, 700))]);
    expect(s.leftWidth, 498);
    expect(s.gutter, 4);
  });

  test('horizontal hinge is ignored (falls through to default)', () {
    final h = DisplayFeature(
      bounds: const Rect.fromLTWH(0, 348, 1000, 4), // wide+short = horizontal
      type: DisplayFeatureType.fold,
      state: DisplayFeatureState.postureFlat,
    );
    final s = paneSplitForHinge(const Size(1000, 700), [h]);
    expect(s.gutter, 0);
    expect(s.leftWidth, 400);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/domain/pane_split_test.dart`
Expected: FAIL — symbols not found.

- [ ] **Step 3: Write minimal implementation**

```dart
// apps/android/lib/src/domain/pane_split.dart
import 'package:flutter/widgets.dart';

/// Left-pane width + the gutter that straddles a foldable hinge (0 when none).
class PaneSplit {
  const PaneSplit(this.leftWidth, this.gutter);
  final double leftWidth;
  final double gutter;
}

/// Compute the two-pane split. With no qualifying hinge, the left pane is
/// [defaultLeftFraction] of the width, clamped to [minLeft]/[maxLeft]. With a
/// vertical hinge/fold present, the split aligns to the hinge's left edge and the
/// gutter spans the hinge so no pane renders under it.
///
/// Pure: [features] is passed in (not read from context) so it unit-tests, and is
/// simply empty on platforms that don't fold (iOS) — identical to the no-hinge path.
PaneSplit paneSplitForHinge(
  Size size,
  List<DisplayFeature> features, {
  double defaultLeftFraction = 0.4,
  double minLeft = 360,
  double maxLeft = 440,
}) {
  for (final f in features) {
    final isHinge =
        f.type == DisplayFeatureType.hinge || f.type == DisplayFeatureType.fold;
    final isActive = f.state == DisplayFeatureState.postureHalfOpened ||
        f.state == DisplayFeatureState.postureFlat;
    final isVertical = f.bounds.width < f.bounds.height; // left/right seam
    if (isHinge && isActive && isVertical) {
      return PaneSplit(f.bounds.left, f.bounds.width);
    }
  }
  final w = (size.width * defaultLeftFraction).clamp(minLeft, maxLeft);
  return PaneSplit(w.toDouble(), 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/domain/pane_split_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/pane_split.dart apps/android/test/domain/pane_split_test.dart
git commit -m "feat(app): foldable-aware pane split helper (app-21)"
```

---

## Task 3: `PlayerController.switchBook` carries title + art

**Files:**
- Modify: `apps/android/lib/src/data/player_controller.dart` (`switchBook`, ~line 320)
- Test: `apps/android/test/data/player_controller_test.dart`

**Interfaces:**
- Produces: `Future<void> switchBook(String bookId, {String bookTitle = '', String? artPath})` — threads both into its `openBook` call so the media-session metadata survives a switch.

- [ ] **Step 1: Write the failing test** (append to the existing test file's `main`)

```dart
  test('switchBook forwards bookTitle + artPath to openBook (media metadata)', () async {
    final engine = FakeAudioEngine();       // existing test fake in this file
    final store = FakePlaybackStore();       // existing test fake
    final controller = PlayerController(
      audioEngine: engine,
      playbackStore: store,
      playlistLoader: (id) async => [
        PlayableChapter(uuid: '$id-c1', path: '/x/$id-c1.mp3', title: 'One'),
      ],
      clock: () => DateTime(2026, 1, 1),
    );
    await controller.openBook('A', bookTitle: 'Book A', artPath: '/art/a.jpg');
    NowPlaying? np;
    final sub = controller.nowPlayingStream.listen((n) => np = n);
    await controller.switchBook('B', bookTitle: 'Book B', artPath: '/art/b.jpg');
    await Future<void>.delayed(Duration.zero);
    expect(np?.album, 'Book B');
    expect(np?.artPath, '/art/b.jpg');
    await sub.cancel();
  });
```

> If the existing fakes have different names, match them — read the top of `player_controller_test.dart` first and reuse its harness verbatim.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/data/player_controller_test.dart -r expanded`
Expected: FAIL — `switchBook` doesn't accept named args (compile error), or `album`/`artPath` are empty/null.

- [ ] **Step 3: Write minimal implementation** (edit `switchBook`)

```dart
  /// Save the active book's position, then restore another book at its own resume
  /// point — per-book state preserved across switches. [bookTitle]/[artPath] flow
  /// to the media session so the lock-screen/car metadata updates on every switch.
  Future<void> switchBook(String bookId, {String bookTitle = '', String? artPath}) async {
    await saveNow();
    final acc = _accumulator;
    if (acc != null) {
      final handoff = acc.switchBook(bookId);
      await _persistStatsHandoff(handoff);
    }
    await openBook(bookId, bookTitle: bookTitle, artPath: artPath);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/data/player_controller_test.dart -r expanded`
Expected: PASS (all existing tests in the file still green — `switchBook`'s old zero-arg call sites, if any in tests, still compile because the new params are optional).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/player_controller.dart apps/android/test/data/player_controller_test.dart
git commit -m "fix(app): switchBook forwards title+art to media session (app-21)"
```

---

## Task 4: `CompanionRuntime.activateBook` (audio orchestration)

**Files:**
- Modify: `apps/android/lib/src/data/companion_runtime.dart` (add method to the class)
- Test: `apps/android/test/data/activate_book_test.dart`

**Interfaces:**
- Consumes: `sync.ensureDetail`, `library.coverThumbPath`, `library.markPlayed`, `player.currentBookId`, `player.saveNow`, `player.openBook`, `player.switchBook` (Task 3), `resumeSync.syncBook`.
- Produces: `Future<void> activateBook(String bookId, {required String title, String? artPath})`.

- [ ] **Step 1: Write the failing test**

Build a runtime via the `@visibleForTesting` `CompanionRuntime.forDemo(...)` factory with spy fakes, then assert ordering + idempotency. Model the fakes on the existing runtime/controller test fakes.

```dart
// apps/android/test/data/activate_book_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/companion_runtime.dart';
// ... imports for the fakes: ApiClient/SyncController/DriftLocalLibrary/PlayerController/
//     ThumbnailCache/SettingsStore/AppSettings/ResumeSyncService/SleepTimer.
// Use lightweight fakes/spies recording call order into a shared List<String> log.

void main() {
  test('first activation opens the book, marks played, reconciles', () async {
    final log = <String>[];
    final rt = buildDemoRuntime(log); // helper below constructs forDemo(...) with spies
    await rt.activateBook('A', title: 'Book A', artPath: '/art/a.jpg');
    expect(log, [
      'ensureDetail:A',
      'openBook:A:Book A:/art/a.jpg',
      'markPlayed:A',
      'syncBook:A',
    ]);
  });

  test('switching a different active book: saveNow → push outgoing → switch', () async {
    final log = <String>[];
    final rt = buildDemoRuntime(log, currentBookId: 'A');
    await rt.activateBook('B', title: 'Book B', artPath: '/art/b.jpg');
    expect(log, [
      'ensureDetail:B',
      'saveNow',
      'syncBook:A',           // outgoing pushed BEFORE switch (fresh position)
      'switchBook:B:Book B:/art/b.jpg',
      'markPlayed:B',
      'syncBook:B',
    ]);
  });

  test('re-activating the already-open book is a no-op', () async {
    final log = <String>[];
    final rt = buildDemoRuntime(log, currentBookId: 'A');
    await rt.activateBook('A', title: 'Book A');
    expect(log, isEmpty); // early guard: no markPlayed, no syncBook, no reopen
  });
}
```

> Write `buildDemoRuntime` in the test file: construct `CompanionRuntime.forDemo(...)` passing spy fakes whose methods append to `log`. Give the fake `PlayerController` a settable `currentBookId` and record `saveNow`/`openBook`/`switchBook`. If `forDemo` requires a concrete `PlayerController` (not an interface), wrap a real `PlayerController` over a spy `AudioEngine`/`PlaybackStore` and assert via the engine/store spies instead — mirror `player_controller_test.dart`'s harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/data/activate_book_test.dart`
Expected: FAIL — `activateBook` not defined.

- [ ] **Step 3: Write minimal implementation** (add to `CompanionRuntime`)

```dart
  /// Book-level audio orchestration for selecting/opening a book (app-21). The
  /// per-book *view* state (chapter list, finished ticks, cover header, peaks,
  /// scroll) is owned by PlayerPane, which reloads on the ActiveBook change — this
  /// method only drives the engine + persistence + server reconcile.
  Future<void> activateBook(String bookId, {required String title, String? artPath}) async {
    // 0. Early idempotency guard: re-selecting the open book is a true no-op.
    if (player.currentBookId == bookId) return;

    // 1. Ensure detail so PlayerPane can read sync.chaptersOf.
    await sync.ensureDetail(bookId);

    // 2. Resolve cover art if not supplied.
    final art = artPath ?? await library.coverThumbPath(bookId);

    // 3. Hand off / open.
    final outgoing = player.currentBookId;
    if (outgoing != null) {
      await player.saveNow();                              // persist LIVE outgoing pos
      try {
        await resumeSync.syncBook(outgoing);               // push fresh outgoing
      } catch (_) {/* offline / no record */}
      await player.switchBook(bookId, bookTitle: title, artPath: art);
    } else {
      await player.openBook(bookId, bookTitle: title, artPath: art);
    }

    // 4. Continue-listening + LRU eviction ordering.
    await library.markPlayed(bookId, DateTime.now().toIso8601String());

    // 5. Reconcile the newly-active book (bidirectional; offline-safe).
    try {
      await resumeSync.syncBook(bookId);
    } catch (_) {/* offline / no record */}
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/data/activate_book_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/companion_runtime.dart apps/android/test/data/activate_book_test.dart
git commit -m "feat(app): CompanionRuntime.activateBook orchestration (app-21)"
```

---

## Task 5: Extract `PlayerPane` (keyed by active book); `PlayerScreen` becomes a thin host

**Files:**
- Create: `apps/android/lib/src/ui/player_pane.dart`
- Modify: `apps/android/lib/src/ui/player_screen.dart`
- Test: `apps/android/test/ui/player_pane_test.dart` (+ existing `player_screen_test.dart` stays green)

**Interfaces:**
- Produces: `class PlayerPane extends StatefulWidget { const PlayerPane({super.key, required this.runtime, required this.bookId, required this.title}); }` — same trio `PlayerScreen` takes today. It renders the chapter list + cover header + transport, loads per-book view state in `initState`, and shows an empty state when `bookId` is null (two-pane only). Callers pass `key: ValueKey(bookId)`.

**Extraction rule:** move the body of `_PlayerScreenState` into `_PlayerPaneState` **verbatim**, with the four deltas below. Keep every widget `Key` unchanged.

- [ ] **Step 1: Write the failing test**

```dart
// apps/android/test/ui/player_pane_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/ui/player_pane.dart';
// Reuse the demo runtime harness that player_screen_test.dart uses.

void main() {
  testWidgets('empty state when no active book', (tester) async {
    await tester.pumpWidget(const MaterialApp(
      home: Scaffold(body: PlayerPane(runtime: null, bookId: null, title: '')),
    ));
    expect(find.text('Select a book to start listening'), findsOneWidget);
  });

  testWidgets('renders chapters for the active book', (tester) async {
    final runtime = await buildDemoRuntime(); // same helper style as player_screen_test
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: PlayerPane(
            key: const ValueKey('the-drowning-bell'),
            runtime: runtime,
            bookId: 'the-drowning-bell',
            title: 'The Drowning Bell'),
      ),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('player-playpause')), findsOneWidget);
  });
}
```

> Make `runtime`/`bookId` nullable on `PlayerPane` so the empty-state path needs no runtime. Copy `buildDemoRuntime` from `player_screen_test.dart`'s setup (demo `runtimeOverride`).

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/player_pane_test.dart`
Expected: FAIL — `player_pane.dart` not found.

- [ ] **Step 3: Create `PlayerPane`**

Create `player_pane.dart` with `PlayerPane` (nullable `runtime`/`bookId`) and `_PlayerPaneState`. Move these members **verbatim** from `_PlayerScreenState` (player_screen.dart): fields `_ready,_playing,_error,_coverArtPath,_chapters,_finished,_subs,_peaks,_scroll,_kRowHeight`; methods `_ensurePeaks,_ensureCurrentPeaks,_scrollToCurrent,_prepare,_playChapter,_togglePlay,_isFinished,_currentChapterLabel,_fmt,_coverHeader,_currentProgressBar,_transport,_openBoostSheet,_cycleSpeed`; the `_speeds` list. Then apply the **four deltas**:

```dart
// DELTA 1 — empty state: guard build() at the top.
@override
Widget build(BuildContext context) {
  if (widget.bookId == null || widget.runtime == null) {
    return const Center(child: Text('Select a book to start listening'));
  }
  // ... the rest of the former PlayerScreen build BODY (the Column with the
  // chapter ListView.builder + Divider + _transport), but WITHOUT the Scaffold /
  // AppBar (the host provides those). Keep the cover header:
  //   if (_coverArtPath != null) _coverHeader(),
}

// DELTA 2 — do NOT call player.openBook here. activateBook (Task 4) already
// opened/switched the book before this pane was (re)built. _prepare keeps only the
// VIEW loads: ensureDetail (idempotent), chaptersOf, finishedChapterUuids,
// coverThumbPath→_coverArtPath, stream subscriptions, _ensureCurrentPeaks,
// post-frame _scrollToCurrent, and `_playing = runtime.player.playing`.
// Remove from _prepare: the resumeSync.syncBook pull, markPlayed, and
// player.openBook calls (now in activateBook).

// DELTA 3 — seed the speed label from the engine, not a hardcoded 1.0.
double _speed = 1.0; // becomes:
// in initState (after runtime is available):
//   _speed = widget.runtime!.player.speed;

// DELTA 4 — dispose keeps the local save + best-effort push (idempotent), but the
// pane no longer OWNS book lifecycle; guard on runtime != null.
```

Reference `bookId`/`title` via `widget.bookId!`/`widget.title` where the old code used `widget.bookId`/`widget.title`.

- [ ] **Step 4: Rewrite `PlayerScreen` as a thin host**

```dart
// player_screen.dart — replaces the old stateful body.
import 'package:flutter/material.dart';
import '../data/companion_runtime.dart';
import 'player_pane.dart';

/// Compact host: an AppBar + the reusable PlayerPane, pushed as a route on phones
/// and tablet-portrait. On large screens the pane is embedded by AdaptiveLibraryShell.
class PlayerScreen extends StatelessWidget {
  const PlayerScreen({
    super.key,
    required this.runtime,
    required this.bookId,
    required this.title,
  });

  final CompanionRuntime runtime;
  final String bookId;
  final String title;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: PlayerPane(
          key: ValueKey(bookId), runtime: runtime, bookId: bookId, title: title),
    );
  }
}
```

> If `player_screen_test.dart` referenced private members of `_PlayerScreenState`, update it to drive through `PlayerPane` instead; keep the same keys/assertions. The marketing capture only taps keys, so it is unaffected.

- [ ] **Step 5: Run tests to verify they pass**

Run: `flutter test test/ui/player_pane_test.dart test/ui/player_screen_test.dart`
Expected: PASS. Then `flutter analyze` — expect no new warnings.

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/ui/player_pane.dart apps/android/lib/src/ui/player_screen.dart apps/android/test/ui/player_pane_test.dart apps/android/test/ui/player_screen_test.dart
git commit -m "refactor(app): extract PlayerPane; PlayerScreen becomes thin host (app-21)"
```

---

## Task 6: Extract `LibraryPane` + add `ActiveBook` (no behaviour change)

**Files:**
- Create: `apps/android/lib/src/ui/library_pane.dart`
- Modify: `apps/android/lib/src/ui/library_home_screen.dart`
- Test: existing `test/ui/library_screen_test.dart` + `home_screen_test.dart` stay green.

**Interfaces:**
- Produces: `class ActiveBook extends ChangeNotifier { String? get bookId; String get title; void select(String? id, {String title}); }`; `class LibraryPane extends StatelessWidget` rendering the current library body (search, continue rail, grouped tree, actions) from props/callbacks, with a `void Function(String bookId, String title) onSelect`.

This task is a **pure refactor**: move the library body out of `_LibraryHomeScreenState.build`/helpers into `LibraryPane`, driven by the same state, and route book selection through an `onSelect` callback (which `LibraryHomeScreen` still wires to the existing push behaviour for now — two-pane wiring is Task 7). Behaviour is unchanged; existing widget tests must stay green.

- [ ] **Step 1: Add `ActiveBook`** in `library_pane.dart`:

```dart
import 'package:flutter/foundation.dart';

/// Single source of truth for which book the detail pane shows (app-21).
class ActiveBook extends ChangeNotifier {
  String? _bookId;
  String _title = '';
  String? get bookId => _bookId;
  String get title => _title;
  void select(String? id, {String title = ''}) {
    if (_bookId == id) return;
    _bookId = id;
    _title = title;
    notifyListeners();
  }
}
```

- [ ] **Step 2: Move the library body into `LibraryPane`.** Move `_continueRail`, `_shelfCard`, `_confirmRemoveFromShelf`, `_sectionHeader`, `_authorSection`, `_seriesSection`, `_bookTile`, `_cover`, `_action`, `_removeDownload`, `_progressWidget`, `_subtitleWidget`, `_statusLabel`, the search `TextField`, and the offline/sync/settings `AppBar` actions into a `LibraryPane` widget that takes the data (`books`, covers, progress, etc.) + callbacks (`onSelect`, `onDownload`, `onSync`, `onOpenSettings`, `onRefresh`). Keep **all keys** (`Key('book-…')`, `Key('continue-…')`, `library-search`, `library-sync`, `offline-chip`, `open-settings`). Replace the old `_open(book)`/`_openBook(...)` push with `onSelect(book.bookId, book.title)`.

- [ ] **Step 3: Reduce `LibraryHomeScreen`** to: own the data-loading state (`_refresh` etc.) + an `ActiveBook` instance, and render `LibraryPane` inside its `Scaffold`. Wire `onSelect` to the **existing** push for now:

```dart
void _onSelect(String bookId, String title) {
  _activeBook.select(bookId, title: title);
  // Task 7 replaces this with layout-aware routing.
  Navigator.of(context).push(MaterialPageRoute(
    builder: (_) => PlayerScreen(runtime: widget.runtime, bookId: bookId, title: title),
  )).then((_) { if (mounted) _refresh(); });
}
```

- [ ] **Step 4: Run tests**

Run: `flutter test test/ui/library_screen_test.dart test/ui/home_screen_test.dart` then `flutter analyze`.
Expected: PASS, no new analyze warnings. (Behaviour identical — this is a move.)

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/ui/library_pane.dart apps/android/lib/src/ui/library_home_screen.dart
git commit -m "refactor(app): extract LibraryPane + ActiveBook (no behaviour change) (app-21)"
```

---

## Task 7: `AdaptiveLibraryShell` — two-pane at expanded, wired to `activateBook`

**Files:**
- Create: `apps/android/lib/src/ui/adaptive_library_shell.dart`
- Modify: `apps/android/lib/src/ui/library_home_screen.dart`
- Test: `apps/android/test/ui/adaptive_library_shell_test.dart`

**Interfaces:**
- Consumes: `windowSizeClassFor`, `libraryLayoutFor` (Task 1), `paneSplitForHinge` (Task 2), `LibraryPane` + `ActiveBook` (Task 6), `PlayerPane` (Task 5), `runtime.activateBook` (Task 4).
- Produces: `class AdaptiveLibraryShell extends StatelessWidget` taking `runtime`, `activeBook`, the `LibraryPane`, and an `onSelect` that performs the layout-aware routing.

- [ ] **Step 1: Write the failing test**

```dart
// apps/android/test/ui/adaptive_library_shell_test.dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/ui/adaptive_library_shell.dart';
// build a demo runtime + a small fake LibraryPane child with a tappable Key('book-x').

void main() {
  Future<void> pumpAt(WidgetTester tester, double logicalWidth, Widget child) async {
    tester.view.physicalSize = Size(logicalWidth, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(home: child));
    await tester.pumpAndSettle();
  }

  testWidgets('two-pane at ≥840 dp', (tester) async {
    await pumpAt(tester, 1000, buildShell()); // helper builds AdaptiveLibraryShell
    expect(find.byKey(const Key('adaptive-two-pane')), findsOneWidget);
    // empty detail pane before selection:
    expect(find.text('Select a book to start listening'), findsOneWidget);
  });

  testWidgets('single-pane below 840 dp', (tester) async {
    await pumpAt(tester, 700, buildShell());
    expect(find.byKey(const Key('adaptive-two-pane')), findsNothing);
  });

  testWidgets('two-pane select fills detail with no route push', (tester) async {
    final pushes = <Route<dynamic>>[];
    await pumpAt(tester, 1000, buildShell(observer: _SpyObserver(pushes)));
    await tester.tap(find.byKey(const Key('book-x')));
    await tester.pumpAndSettle();
    expect(pushes, isEmpty); // filled the pane, did not push PlayerScreen
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/adaptive_library_shell_test.dart`
Expected: FAIL — `adaptive_library_shell.dart` not found.

- [ ] **Step 3: Implement the shell**

```dart
// apps/android/lib/src/ui/adaptive_library_shell.dart
import 'package:flutter/material.dart';
import '../data/companion_runtime.dart';
import '../domain/pane_split.dart';
import '../domain/window_size.dart';
import 'library_pane.dart';
import 'player_pane.dart';

class AdaptiveLibraryShell extends StatelessWidget {
  const AdaptiveLibraryShell({
    super.key,
    required this.runtime,
    required this.activeBook,
    required this.libraryPane,
  });

  final CompanionRuntime runtime;
  final ActiveBook activeBook;
  final LibraryPane libraryPane;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, constraints) {
      final layout = libraryLayoutFor(windowSizeClassFor(constraints.maxWidth));
      if (layout == LibraryLayout.singlePane) return libraryPane;

      final split = paneSplitForHinge(
          constraints.biggest, MediaQuery.of(context).displayFeatures);
      return Row(
        key: const Key('adaptive-two-pane'),
        children: [
          SizedBox(width: split.leftWidth, child: libraryPane),
          if (split.gutter > 0) SizedBox(width: split.gutter) else const VerticalDivider(width: 1),
          Expanded(
            child: AnimatedBuilder(
              animation: activeBook,
              builder: (_, __) => PlayerPane(
                key: ValueKey(activeBook.bookId),
                runtime: activeBook.bookId == null ? null : runtime,
                bookId: activeBook.bookId,
                title: activeBook.title,
              ),
            ),
          ),
        ],
      );
    });
  }
}
```

- [ ] **Step 4: Make selection layout-aware** in `library_home_screen.dart`. Replace Task 6's temporary `_onSelect` so it (a) always `activateBook`s, (b) in two-pane just updates `ActiveBook` (the shell fills the pane), (c) in single-pane pushes `PlayerScreen`:

```dart
Future<void> _onSelect(String bookId, String title) async {
  await widget.runtime.activateBook(bookId, title: title);
  _activeBook.select(bookId, title: title);
  final twoPane = libraryLayoutFor(
          windowSizeClassFor(MediaQuery.of(context).size.width)) ==
      LibraryLayout.twoPane;
  if (!twoPane && mounted) {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => PlayerScreen(runtime: widget.runtime, bookId: bookId, title: title),
    ));
    if (mounted) _refresh();
  }
}
```

And render `AdaptiveLibraryShell(runtime: widget.runtime, activeBook: _activeBook, libraryPane: <the LibraryPane>)` as the `Scaffold` body.

- [ ] **Step 5: Run tests to verify they pass**

Run: `flutter test test/ui/adaptive_library_shell_test.dart test/ui/library_screen_test.dart` then `flutter analyze`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/ui/adaptive_library_shell.dart apps/android/lib/src/ui/library_home_screen.dart apps/android/test/ui/adaptive_library_shell_test.dart
git commit -m "feat(app): AdaptiveLibraryShell two-pane list-detail on large screens (app-21)"
```

---

## Task 8: Cover-forward grid on medium/expanded

**Files:**
- Modify: `apps/android/lib/src/ui/library_pane.dart`
- Test: `apps/android/test/ui/library_screen_test.dart` (add a wide-surface case)

**Interfaces:**
- Consumes: `windowSizeClassFor` (Task 1).
- Produces: within `LibraryPane`, book rows render as a cover **grid** when `windowSizeClassFor(width) != compact`, else the existing `ListTile` tree.

- [ ] **Step 1: Write the failing test** (forces a wide surface, expects grid tiles)

```dart
  testWidgets('wide surface renders cover grid tiles', (tester) async {
    tester.view.physicalSize = const Size(1000, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: buildLibraryPane())));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('library-grid')), findsOneWidget);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/library_screen_test.dart -r expanded`
Expected: FAIL — no `library-grid` key.

- [ ] **Step 3: Implement the grid branch.** In `LibraryPane.build`, compute `final compact = windowSizeClassFor(MediaQuery.of(context).size.width) == WindowSizeClass.compact;`. When not compact, render each series' books as a `GridView`/`Wrap` (`Key('library-grid')`) of larger cover tiles (reuse the cached `_covers[bookId]` thumbnails; tile keeps `Key('book-<id>')` + tap → `onSelect`). When compact, keep the existing `_bookTile` `ListTile` list unchanged.

```dart
// sketch of the per-series render branch
Widget _books(SeriesGroup series) {
  if (_compact) return Column(children: series.books.map(_bookTile).toList());
  return Wrap(
    key: const Key('library-grid'),
    spacing: 12, runSpacing: 12,
    children: [for (final b in series.books) _bookGridTile(b)],
  );
}
// _bookGridTile: a ~140-wide cover (Image.file(_covers[b.bookId])) + title +
// status pill + the same download/menu _action(b); keeps Key('book-<id>'); tap → onSelect.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `flutter test test/ui/library_screen_test.dart` then `flutter analyze`.
Expected: PASS (compact tests still green — the grid is only on wide surfaces).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/ui/library_pane.dart apps/android/test/ui/library_screen_test.dart
git commit -m "feat(app): cover-forward library grid on tablet/foldable (app-21)"
```

---

## Task 9: App-lifecycle resume-push observer

**Files:**
- Modify: `apps/android/lib/main.dart` (the top `_HomePageState`, which owns the runtime) OR `library_home_screen.dart` — attach a `WidgetsBindingObserver`.
- Test: `apps/android/test/ui/lifecycle_resume_test.dart`

**Interfaces:**
- Consumes: `player.saveNow`, `player.currentBookId`, `resumeSync.syncBook`.

- [ ] **Step 1: Write the failing test** — a widget hosting the observer; drive `didChangeAppLifecycleState(AppLifecycleState.paused)` and assert `saveNow` + `syncBook(currentBookId)` fire (spy runtime).

```dart
  testWidgets('paused → saveNow + syncBook(current)', (tester) async {
    final spy = SpyRuntime(currentBookId: 'A');
    await tester.pumpWidget(MaterialApp(home: LifecycleResumePusher(runtime: spy, child: const SizedBox())));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(spy.saveNowCalls, 1);
    expect(spy.syncBookCalls, ['A']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/lifecycle_resume_test.dart`
Expected: FAIL — `LifecycleResumePusher` not defined.

- [ ] **Step 3: Implement a small `LifecycleResumePusher`** StatefulWidget that `WidgetsBinding.instance.addObserver(this)` in `initState`, removes it in `dispose`, and on `AppLifecycleState.paused` runs `await runtime.player.saveNow();` then best-effort `runtime.resumeSync.syncBook(runtime.player.currentBookId!)` when non-null. Wrap the post-pairing UI (`LibraryHomeScreen`) with it in `main.dart`.

```dart
class LifecycleResumePusher extends StatefulWidget {
  const LifecycleResumePusher({super.key, required this.runtime, required this.child});
  final dynamic runtime; // CompanionRuntime (or a spy in tests)
  final Widget child;
  @override
  State<LifecycleResumePusher> createState() => _LifecycleResumePusherState();
}
class _LifecycleResumePusherState extends State<LifecycleResumePusher> with WidgetsBindingObserver {
  @override
  void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); }
  @override
  void dispose() { WidgetsBinding.instance.removeObserver(this); super.dispose(); }
  @override
  Future<void> didChangeAppLifecycleState(AppLifecycleState s) async {
    if (s != AppLifecycleState.paused) return;
    await widget.runtime.player.saveNow();
    final id = widget.runtime.player.currentBookId;
    if (id != null) {
      try { await widget.runtime.resumeSync.syncBook(id); } catch (_) {}
    }
  }
  @override
  Widget build(BuildContext context) => widget.child;
}
```

> Prefer a concrete `CompanionRuntime` type in production; the `dynamic` keeps the test spy simple. If lint forbids `dynamic`, define a tiny interface the runtime satisfies.

- [ ] **Step 4: Run tests to verify they pass**

Run: `flutter test test/ui/lifecycle_resume_test.dart` then `flutter analyze`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/main.dart apps/android/lib/src/ui/adaptive_library_shell.dart apps/android/test/ui/lifecycle_resume_test.dart
git commit -m "feat(app): flush resume on app pause (two-pane has no per-book dispose) (app-21)"
```

---

## Task 10: Full suite + docs (plan status, release notes, INDEX)

**Files:**
- Modify: `docs/features/188-android-companion-app.md` (add principle #6 + an `app-21` row), `docs/features/INDEX.md` (if applicable), `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/superpowers/specs/2026-07-13-android-tablet-adaptive-ui-design.md` (status → active).

- [ ] **Step 1: Run the whole app suite**

Run (from `apps/android/`): `flutter analyze` then `flutter test`
Expected: analyze clean; all tests PASS.

- [ ] **Step 2: Release notes** — append a technical line to `docs/release-notes-next.md` (PR-refed) and a brand-voice user line to the in-progress version block at the top of `RELEASE_NOTES.md` (e.g. "Castwright's Android app now stretches out on tablets and foldables — your library and the player, side by side.").

- [ ] **Step 3: Plan 188 update** — add the iOS-readiness **principle #6** (pure-framework adaptive layer, no Android-only plugins) and an `app-21` entry to the item decomposition / build-progress table. Flip the spec's frontmatter/status to `active`.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(app): release notes + plan 188 update for tablet UI (app-21)"
```

---

## Self-review notes (author)

- **Spec coverage:** Components 1–7 → Tasks 1,2,(3+4 orchestration+switchBook),5,7,8,6; testing → per-task + Task 10; iOS-readiness → Global Constraints + Task 10 principle #6; marketing follow-up → filed as a separate ticket at PR time (not a task here).
- **Type consistency:** `activateBook(String, {required String title, String? artPath})`, `switchBook(String, {String bookTitle, String? artPath})`, `ActiveBook.select(String?, {String title})`, `paneSplitForHinge(Size, List<DisplayFeature>, {...})`, `windowSizeClassFor`/`libraryLayoutFor` — used consistently across tasks.
- **Emulator acceptance** (Pixel Tablet + Pixel Fold + phone regression) is a post-implementation verification step, tracked in the session task list, not a plan task.
- **Ordering:** Tasks 1–2 (pure, parallelizable) → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Task 7 depends on 4/5/6; Task 8 depends on 6.
