# app-20 On-device Demo / Guest Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shipped "Try the demo" guest-mode entry to the companion app's "Not paired yet" screen that runs the full app on-device against the existing demo runtime — no server, no network — so Google Play's "Sign-in details" review can grant "full access to all features."

**Architecture:** Additive, optional-defaulted changes only. A new interactive `DemoTickingAudioEngine` replaces the posed engine on the production demo path; `buildDemoRuntime` gains an optional `engine` param (default: posed engine, so marketing capture is unchanged); `main.dart`'s `HomePage` gets a `try-demo` button + `_startDemo`/`_exitDemo` with injectable `path_provider`/`rootBundle`/`FileStore` seams for host tests; covers ship as committed downscaled assets extracted to an app-private demo root; `LibraryHomeScreen`/`AppSettingsScreen` get a `demoMode` flag for the badge + demo-accurate settings chrome.

**Tech Stack:** Flutter (Dart), `flutter_test`, Node ESM + `sharp` (build-time cover downscale), `node:test`.

## Global Constraints

- **All changes additive/optional-defaulted.** Existing callers of `buildDemoRuntime` (`test/demo/demo_runtime_test.dart:8,21,29`, `integration_test/marketing_capture_test.dart:35`) and `LibraryHomeScreen`/`AppSettingsScreen` (marketing `runtimeOverride` path) MUST stay green with zero edits. New params default to today's behavior.
- **`_startDemo` sets `_runtime`/`_paired`/`_demoMode` DIRECTLY via `setState` — never through `_boot()`.** `_boot`'s `runtimeOverride` branch reloads `_paired = await store.load()` (`main.dart:178`); the production `SecurePairingStore` returns `null`, which would drop to "Not paired yet" and never render the library.
- **`_startDemo` passes `offline: false`.** `demoHttpSend(offline:)` means "server returns 503," not "device offline." `false` keeps all four books (incl. not-downloaded `hollow-tide-3`); the fake zero-socket transport is what makes it airplane-safe. `true` would fail the four-books acceptance.
- **The ticking engine's streams MUST be broadcast, and `dispose()` MUST cancel the timer.** `positionStream` is subscribed 3× (`player_controller.dart:75`, `player_screen.dart:269,292`), `durationStream` direct (`player_screen.dart:288`).
- **No hex color literals / follow existing widget-key + `const Key('…')` conventions.** Touch targets and Material3 theming already handled by the shared screens — do not restyle.
- Book IDs are exactly: `hollow-tide-1`, `hollow-tide-2`, `hollow-tide-3`, `coalfall-commission` (`lib/src/demo/demo_data.dart:99-143`).
- Run Flutter tests from `apps/android/`: `flutter test <path>`. Run Node tests from repo root: `node --test <path>`.

---

### Task 1: Committed demo-cover asset pipeline

Build-time `sharp` downscale of the git-ignored `brand/book-covers/{bookId}.png` sources into small committed `apps/android/assets/demo-covers/{bookId}.png`, declared in `pubspec.yaml`.

**Files:**
- Create: `scripts/build-demo-covers.mjs`
- Create: `scripts/tests/build-demo-covers.test.mjs`
- Modify: `package.json` (add `build:demo-covers` script)
- Modify: `apps/android/pubspec.yaml:100-105` (add `assets:`)
- Create (committed, generated): `apps/android/assets/demo-covers/{hollow-tide-1,hollow-tide-2,hollow-tide-3,coalfall-commission}.png`

**Interfaces:**
- Produces: `coverTargets(srcDir, outDir) → [{id, src, out}]` and `const COVER_WIDTH` (consumed only by the colocated test); the committed asset files `assets/demo-covers/{bookId}.png` (consumed at runtime by Task 5's `_startDemo`).

- [ ] **Step 0: Add the `sharp` build-time devDependency**

`sharp` is NOT currently in the repo (the brand scripts render via `@playwright/test` chromium, not sharp). Add it as a build-only dep:

Run (from repo root): `npm install --save-dev sharp`
Expected: `package.json` `devDependencies` gains `sharp`, `package-lock.json` updates, install succeeds (prebuilt binary).

The script (Step 3) also imports `sharp` **lazily inside `main()`** so the pure-helper test (Step 1) loads without needing sharp resolved.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/build-demo-covers.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { coverTargets, COVER_WIDTH } from '../build-demo-covers.mjs';

test('coverTargets maps the four bookIds to matching src/out basenames', () => {
  const targets = coverTargets('/src', '/out');
  assert.equal(targets.length, 4);
  assert.deepEqual(
    targets.map((t) => t.id).sort(),
    ['coalfall-commission', 'hollow-tide-1', 'hollow-tide-2', 'hollow-tide-3'],
  );
  for (const t of targets) {
    assert.equal(basename(t.src), `${t.id}.png`);
    assert.equal(basename(t.out), `${t.id}.png`);
  }
});

test('COVER_WIDTH is a small display size', () => {
  assert.ok(COVER_WIDTH > 0 && COVER_WIDTH <= 600);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/tests/build-demo-covers.test.mjs`
Expected: FAIL — `Cannot find module '../build-demo-covers.mjs'`.

- [ ] **Step 3: Write the script**

Create `scripts/build-demo-covers.mjs`:

```js
// Build-time downscale of the git-ignored brand/book-covers/{bookId}.png sources
// into small committed apps/android/assets/demo-covers/{bookId}.png for the app-20
// on-device demo. Mirrors the brand/ -> public/ generated-PNG pattern. Run:
//   node scripts/build-demo-covers.mjs           (reads brand/book-covers/)
//   DEMO_COVERS_SRC=/path node scripts/build-demo-covers.mjs
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BOOK_IDS = ['hollow-tide-1', 'hollow-tide-2', 'hollow-tide-3', 'coalfall-commission'];

/** Display width of the committed demo covers (px). Keeps them small. */
export const COVER_WIDTH = 400;

/** The four (id, src, out) render targets. Sources/outputs are {bookId}.png. */
export function coverTargets(srcDir, outDir) {
  return BOOK_IDS.map((id) => ({
    id,
    src: resolve(srcDir, `${id}.png`),
    out: resolve(outDir, `${id}.png`),
  }));
}

async function main() {
  const { default: sharp } = await import('sharp'); // lazy: keeps the pure-helper test import-light
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const srcDir = process.env.DEMO_COVERS_SRC || resolve(root, 'brand/book-covers');
  const outDir = resolve(root, 'apps/android/assets/demo-covers');
  mkdirSync(outDir, { recursive: true });
  for (const t of coverTargets(srcDir, outDir)) {
    if (!existsSync(t.src)) {
      console.error(`[demo-covers] MISSING source ${t.src}`);
      process.exitCode = 1;
      continue;
    }
    await sharp(t.src).resize({ width: COVER_WIDTH }).png({ quality: 80 }).toFile(t.out);
    console.log(`[demo-covers] ${t.id} -> ${t.out}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/tests/build-demo-covers.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Generate the committed cover assets**

The brand sources are git-ignored and live in a checkout that has `brand/` (this repo's main checkout at `C:/Claude/Projects/Audiobook-Generator/brand/book-covers/`). Point the script at it:

Run (from repo root of the worktree):
```bash
DEMO_COVERS_SRC="C:/Claude/Projects/Audiobook-Generator/brand/book-covers" node scripts/build-demo-covers.mjs
```
Expected: four `[demo-covers] <id> -> …/assets/demo-covers/<id>.png` lines, exit 0.
Verify each output is small (`ls -la apps/android/assets/demo-covers/` — expect low-hundreds-of-KB PNGs, not multi-MB).

- [ ] **Step 6: Declare the asset dir + npm script**

In `apps/android/pubspec.yaml`, replace the commented `# assets:` block (around line 102-105) so it reads:

```yaml
  uses-material-design: true

  assets:
    - assets/demo-covers/
```

In `package.json`, add to `"scripts"`:

```json
    "build:demo-covers": "node scripts/build-demo-covers.mjs",
```

- [ ] **Step 7: Commit**

```bash
git add scripts/build-demo-covers.mjs scripts/tests/build-demo-covers.test.mjs package.json package-lock.json apps/android/pubspec.yaml apps/android/assets/demo-covers
git commit -m "build(scripts): committed demo-cover asset pipeline for app-20"
```

---

### Task 2: `DemoTickingAudioEngine`

An interactive demo `AudioEngine`: position advances on a timer (no real audio), broadcast streams, real `dispose`.

**Files:**
- Create: `apps/android/lib/src/demo/demo_ticking_audio_engine.dart`
- Test: `apps/android/test/demo/demo_ticking_audio_engine_test.dart`

**Interfaces:**
- Consumes: `AudioEngine` (`lib/src/data/audio_engine.dart`).
- Produces: `class DemoTickingAudioEngine implements AudioEngine` with ctor `DemoTickingAudioEngine({Duration duration, Duration tick})`. Consumed by Task 3 (`buildDemoRuntime` engine param) and Task 5 (`_startDemo`).

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/demo/demo_ticking_audio_engine_test.dart`:

```dart
import 'package:castwright/src/demo/demo_ticking_audio_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('position advances while playing and stops when paused', () async {
    final e = DemoTickingAudioEngine(
      duration: const Duration(seconds: 10),
      tick: const Duration(milliseconds: 10),
    );
    await e.play();
    await Future<void>.delayed(const Duration(milliseconds: 60));
    final afterPlay = e.position;
    expect(afterPlay, greaterThan(Duration.zero));
    await e.pause();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(e.position, afterPlay); // no advance after pause
    await e.dispose();
  });

  test('positionStream is broadcast (multiple concurrent subscribers)', () async {
    final e = DemoTickingAudioEngine(tick: const Duration(milliseconds: 10));
    var a = 0, b = 0;
    final s1 = e.positionStream.listen((_) => a++);
    final s2 = e.positionStream.listen((_) => b++); // would throw if single-sub
    await e.play();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    await s1.cancel();
    await s2.cancel();
    expect(a, greaterThan(0));
    expect(b, greaterThan(0));
    await e.dispose();
  });

  test('seek clamps and emits; setSpeed accepted', () async {
    final e = DemoTickingAudioEngine(duration: const Duration(seconds: 10));
    await e.setSpeed(2.0);
    await e.seek(const Duration(seconds: 100));
    expect(e.position, const Duration(seconds: 10)); // clamped to duration
    await e.seek(const Duration(seconds: -5));
    expect(e.position, Duration.zero); // clamped to zero
    await e.dispose();
  });

  test('dispose cancels the timer (no emissions afterward)', () async {
    final e = DemoTickingAudioEngine(tick: const Duration(milliseconds: 10));
    await e.play();
    await e.dispose();
    // A later listen on a closed broadcast controller yields no events.
    var emitted = 0;
    final sub = e.positionStream.listen((_) => emitted++);
    await Future<void>.delayed(const Duration(milliseconds: 40));
    await sub.cancel();
    expect(emitted, 0);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/android/`): `flutter test test/demo/demo_ticking_audio_engine_test.dart`
Expected: FAIL — target of URI doesn't exist / `DemoTickingAudioEngine` undefined.

- [ ] **Step 3: Write the engine**

Create `apps/android/lib/src/demo/demo_ticking_audio_engine.dart`:

```dart
import 'dart:async';

import '../data/audio_engine.dart';

/// Interactive demo [AudioEngine] for the app-20 on-device guest mode: position
/// advances on a timer with NO real audio, so a reviewer sees the player respond
/// to play/pause/seek/speed. Streams are broadcast — the player subscribes
/// positionStream/durationStream from multiple widgets — and [dispose] cancels
/// the timer so no emission outlives an exit-demo teardown.
class DemoTickingAudioEngine implements AudioEngine {
  DemoTickingAudioEngine({
    Duration duration = const Duration(minutes: 23, seconds: 40),
    Duration tick = const Duration(milliseconds: 500),
  })  : _duration = duration,
        _tick = tick;

  final Duration _duration;
  final Duration _tick;

  Duration _position = Duration.zero;
  bool _playing = false;
  double _speed = 1.0;
  Timer? _timer;

  final _positionCtl = StreamController<Duration>.broadcast();
  final _playingCtl = StreamController<bool>.broadcast();
  final _durationCtl = StreamController<Duration?>.broadcast();
  final _completionCtl = StreamController<void>.broadcast();

  @override
  Duration get position => _position;
  @override
  Stream<Duration> get positionStream => _positionCtl.stream;
  @override
  bool get playing => _playing;
  @override
  Stream<bool> get playingStream => _playingCtl.stream;
  @override
  Duration? get duration => _duration;
  @override
  Stream<Duration?> get durationStream => _durationCtl.stream;
  @override
  Stream<void> get completionStream => _completionCtl.stream;

  void _setPlaying(bool v) {
    _playing = v;
    if (!_positionCtl.isClosed) _playingCtl.add(v);
    _timer?.cancel();
    _timer = null;
    if (v) {
      _timer = Timer.periodic(_tick, (_) {
        final next = _position + _tick * _speed;
        if (next >= _duration) {
          _position = _duration;
          _positionCtl.add(_position);
          _setPlaying(false);
          _completionCtl.add(null);
          return;
        }
        _position = next;
        _positionCtl.add(_position);
      });
    }
  }

  @override
  Future<void> setFilePath(String path) async {
    if (!_durationCtl.isClosed) _durationCtl.add(_duration);
  }

  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {
    if (!_durationCtl.isClosed) _durationCtl.add(_duration);
  }

  @override
  Future<void> play() async => _setPlaying(true);
  @override
  Future<void> pause() async => _setPlaying(false);

  @override
  Future<void> seek(Duration position) async {
    _position = position < Duration.zero
        ? Duration.zero
        : (position > _duration ? _duration : position);
    if (!_positionCtl.isClosed) _positionCtl.add(_position);
  }

  @override
  Future<void> setSpeed(double speed) async => _speed = speed;
  @override
  Future<void> setVolumeBoost(double db) async {}

  @override
  Future<void> dispose() async {
    _timer?.cancel();
    _timer = null;
    await _positionCtl.close();
    await _playingCtl.close();
    await _durationCtl.close();
    await _completionCtl.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/demo/demo_ticking_audio_engine_test.dart`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/demo/demo_ticking_audio_engine.dart apps/android/test/demo/demo_ticking_audio_engine_test.dart
git commit -m "feat(app): interactive DemoTickingAudioEngine for on-device demo"
```

---

### Task 3: `buildDemoRuntime` engine param + drop `forDemo` `@visibleForTesting`

Make the demo runtime accept an injected engine (default: posed) and make `forDemo` a sanctioned production path.

**Files:**
- Modify: `apps/android/lib/src/demo/demo_runtime.dart:42-47` (signature), `:112-117` (engine), `:141-144` (remove ignore)
- Modify: `apps/android/lib/src/data/companion_runtime.dart:93` (drop `@visibleForTesting`)
- Modify: `apps/android/lib/src/data/player_controller.dart:97` (add a `@visibleForTesting` `audioEngine` getter — `_engine` is private today)
- Modify: `apps/android/test/ui/library_home_screen_test.dart:105` (remove now-stale ignore, if present)
- Test: `apps/android/test/demo/demo_runtime_engine_test.dart`

**Interfaces:**
- Consumes: `DemoTickingAudioEngine` (Task 2), `AudioEngine`.
- Produces: `buildDemoRuntime({bool offline, FileStore? fs, String coversDir, String root, AudioEngine? engine})` — new optional `engine`, default posed `DemoAudioEngine`. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/demo/demo_runtime_engine_test.dart`:

```dart
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/demo/demo_audio_engine.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/demo/demo_ticking_audio_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults to the posed DemoAudioEngine when no engine is passed', () async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    expect(rt.player.audioEngine, isA<DemoAudioEngine>());
    await rt.dispose();
  });

  test('uses the injected engine when provided', () async {
    final rt = await buildDemoRuntime(
      fs: InMemoryFileStore(),
      coversDir: '/covers',
      engine: DemoTickingAudioEngine(),
    );
    expect(rt.player.audioEngine, isA<DemoTickingAudioEngine>());
    await rt.dispose();
  });
}
```

> Note: `PlayerController._engine` is private today (`player_controller.dart:97`), so this test needs a getter — added in Step 3 below.

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/demo/demo_runtime_engine_test.dart`
Expected: FAIL — `buildDemoRuntime` has no `engine` named parameter.

- [ ] **Step 3a: Add the `audioEngine` test getter to `PlayerController`**

In `apps/android/lib/src/data/player_controller.dart`, add `import 'package:flutter/foundation.dart' show visibleForTesting;` (if not already imported) and a getter directly below `final AudioEngine _engine;` (line 97):
```dart
  /// The injected engine — exposed for tests that assert demo-engine wiring.
  @visibleForTesting
  AudioEngine get audioEngine => _engine;
```

- [ ] **Step 3: Add the engine param**

In `apps/android/lib/src/demo/demo_runtime.dart`:

Add the import near the other demo imports (top of file):
```dart
import '../data/audio_engine.dart';
```

Change the signature (around line 42-47) to add `engine`:
```dart
Future<CompanionRuntime> buildDemoRuntime({
  bool offline = false,
  FileStore? fs,
  String coversDir = '',
  String root = '/demo',
  AudioEngine? engine,
}) async {
```

Change the `PlayerController` construction (around line 112) from `audioEngine: DemoAudioEngine(),` to:
```dart
  final player = PlayerController(
    audioEngine: engine ?? DemoAudioEngine(),
    playbackStore: library,
    playlistLoader: (bookId) async => sync.playlistFor(bookId),
    clock: () => DateTime.fromMillisecondsSinceEpoch(0),
  );
```

Remove the now-unneeded ignore comment above the `forDemo` call (lines ~141-143) — keep the two explanatory lines but delete the `// ignore: invalid_use_of_visible_for_testing_member` line, and reword the comment to:
```dart
  // forDemo is a sanctioned production path (app-20 on-device demo); this
  // builder is its non-test caller.
  return CompanionRuntime.forDemo(
```

- [ ] **Step 4: Drop `@visibleForTesting` on `forDemo`**

In `apps/android/lib/src/data/companion_runtime.dart`, remove the `@visibleForTesting` annotation on line 93 (the line directly above `factory CompanionRuntime.forDemo({`). Leave the doc comment. If this leaves `package:flutter/foundation.dart` unused, keep it (it also provides `kDebugMode`/`ChangeNotifier` elsewhere — verify with the analyzer; only remove the import if `flutter analyze` flags it unused).

If `apps/android/test/ui/library_home_screen_test.dart:105` still carries `// ignore: invalid_use_of_visible_for_testing_member`, delete that line (now stale).

- [ ] **Step 5: Run tests to verify pass + no regressions**

Run:
```bash
flutter test test/demo/demo_runtime_engine_test.dart test/demo/demo_runtime_test.dart test/ui
flutter analyze lib/src/demo/demo_runtime.dart lib/src/data/companion_runtime.dart
```
Expected: all green; analyzer clean (no unused-import / stale-ignore errors).

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/demo/demo_runtime.dart apps/android/lib/src/data/companion_runtime.dart apps/android/lib/src/data/player_controller.dart apps/android/test/demo/demo_runtime_engine_test.dart apps/android/test/ui/library_home_screen_test.dart
git commit -m "feat(app): buildDemoRuntime engine param; forDemo becomes a production path"
```

---

### Task 4: `demoMode` chrome — badge + demo-accurate settings

Thread an optional `demoMode` through `LibraryHomeScreen` → `AppSettingsScreen`: a "Demo" AppBar badge, suppress the Server section, rewrite the unpair affordance to "Exit demo."

**Files:**
- Modify: `apps/android/lib/src/ui/library_home_screen.dart:17-27` (ctor), `:299-336` (AppBar badge + pass `demoMode`)
- Modify: `apps/android/lib/src/ui/app_settings_screen.dart:11-27` (ctor), `:107-115` (`_unpair`), `:201-235` (Server section + Manage/unpair)
- Test: `apps/android/test/ui/demo_mode_chrome_test.dart`

**Interfaces:**
- Produces: `LibraryHomeScreen({..., bool demoMode})` and `AppSettingsScreen({..., bool demoMode})`, both defaulting `false`. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/ui/demo_mode_chrome_test.dart`:

```dart
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/ui/app_settings_screen.dart';
import 'package:castwright/src/ui/library_home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _server = PairedServer(
    url: 'https://demo.local', token: 't', caFingerprint: 'demo-fingerprint');

void main() {
  testWidgets('library AppBar shows the Demo badge in demoMode', (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    await tester.pumpWidget(MaterialApp(
      home: LibraryHomeScreen(
          runtime: rt, server: _server, onUnpair: () async {}, demoMode: true),
    ));
    await tester.pump();
    expect(find.byKey(const Key('demo-badge')), findsOneWidget);
    await rt.dispose();
  });

  testWidgets('settings suppresses Server section + shows Exit demo in demoMode',
      (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    await tester.pumpWidget(MaterialApp(
      home: AppSettingsScreen(
          runtime: rt,
          server: _server,
          onUnpair: () async {},
          onLibraryCleared: () {},
          demoMode: true),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Server'), findsNothing);
    expect(find.text('demo-fingerprint'), findsNothing);
    expect(find.text('Exit demo'), findsOneWidget);
    expect(find.text('Unpair device'), findsNothing);
    await rt.dispose();
  });

  testWidgets('settings keeps Server section when not in demoMode', (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    await tester.pumpWidget(MaterialApp(
      home: AppSettingsScreen(
          runtime: rt,
          server: _server,
          onUnpair: () async {},
          onLibraryCleared: () {}),
    ));
    await tester.pumpAndSettle();
    // 'Server' renders twice (section label + ListTile title); assert the
    // unique URL instead so the presence check is unambiguous.
    expect(find.text('https://demo.local'), findsOneWidget);
    expect(find.text('Unpair device'), findsOneWidget);
    await rt.dispose();
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/demo_mode_chrome_test.dart`
Expected: FAIL — `LibraryHomeScreen`/`AppSettingsScreen` have no `demoMode` named parameter.

- [ ] **Step 3: Add `demoMode` to `LibraryHomeScreen`**

In `apps/android/lib/src/ui/library_home_screen.dart`, extend the ctor (lines 17-27):
```dart
  const LibraryHomeScreen({
    super.key,
    required this.runtime,
    required this.server,
    required this.onUnpair,
    this.demoMode = false,
  });

  final CompanionRuntime runtime;
  final PairedServer server;
  final Future<void> Function() onUnpair;
  final bool demoMode;
```

In the AppBar `actions:` list (line 301, immediately after `actions: [`), add the badge first:
```dart
        actions: [
          if (widget.demoMode)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8, horizontal: 4),
              child: Chip(
                key: Key('demo-badge'),
                label: Text('Demo'),
                visualDensity: VisualDensity.compact,
              ),
            ),
```

In the `open-settings` `AppSettingsScreen(...)` construction (lines 328-333), pass `demoMode`:
```dart
              builder: (_) => AppSettingsScreen(
                runtime: widget.runtime,
                server: widget.server,
                onUnpair: widget.onUnpair,
                onLibraryCleared: _refresh,
                demoMode: widget.demoMode,
              ),
```

- [ ] **Step 4: Add `demoMode` to `AppSettingsScreen`**

In `apps/android/lib/src/ui/app_settings_screen.dart`, extend the ctor (lines 12-23):
```dart
  const AppSettingsScreen({
    super.key,
    required this.runtime,
    required this.server,
    required this.onUnpair,
    required this.onLibraryCleared,
    this.demoMode = false,
  });

  final CompanionRuntime runtime;
  final PairedServer server;
  final Future<void> Function() onUnpair;
  final VoidCallback onLibraryCleared;
  final bool demoMode;
```

Add a demo-exit handler next to `_unpair` (after line 115):
```dart
  Future<void> _exitDemo() async {
    await widget.onUnpair();
    if (mounted) Navigator.of(context).pop();
  }
```

Replace the Server section + Manage section (lines 201-235) so the Server block is gated and the unpair tile is demo-aware:
```dart
          const Divider(),
          if (!widget.demoMode) ...[
            _sectionLabel('Server'),
            ListTile(
              leading: const Icon(Icons.dns_outlined),
              title: const Text('Server'),
              subtitle: Text(widget.server.url),
            ),
            ListTile(
              leading: const Icon(Icons.verified_user_outlined),
              title: const Text('Certificate (SHA-256)'),
              subtitle: Text(widget.server.caFingerprint,
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
            ),
            ListTile(
              leading: const Icon(Icons.schedule),
              title: const Text('Paired since'),
              subtitle: Text(_pairedSince()),
            ),
            const Divider(),
          ],
          _sectionLabel(widget.demoMode ? 'Demo' : 'Manage'),
          if (!widget.demoMode)
            ListTile(
              key: const Key('delete-library'),
              leading: Icon(Icons.delete_sweep_outlined, color: scheme.error),
              title: Text('Delete downloaded library',
                  style: TextStyle(color: scheme.error)),
              subtitle: const Text('Free up space; keep the pairing'),
              onTap: _deleteLibrary,
            ),
          ListTile(
            key: const Key('unpair'),
            leading: Icon(widget.demoMode ? Icons.logout : Icons.link_off,
                color: scheme.error),
            title: Text(widget.demoMode ? 'Exit demo' : 'Unpair device',
                style: TextStyle(color: scheme.error)),
            subtitle: Text(widget.demoMode
                ? 'Leave the demo and return to pairing'
                : 'Disconnect + forget this server'),
            onTap: widget.demoMode ? _exitDemo : _unpair,
          ),
```

- [ ] **Step 5: Run tests to verify pass + no regressions**

Run: `flutter test test/ui/demo_mode_chrome_test.dart test/ui`
Expected: all green (new 3 pass; existing library/settings/marketing widget tests unaffected — `demoMode` defaults `false`).

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/ui/library_home_screen.dart apps/android/lib/src/ui/app_settings_screen.dart apps/android/test/ui/demo_mode_chrome_test.dart
git commit -m "feat(app): demoMode chrome — badge, suppressed Server section, Exit demo"
```

---

### Task 5: Entry point + `_startDemo`/`_exitDemo` wiring in `main.dart`

The shipped "Try the demo" button, injectable `path_provider`/`rootBundle`/`FileStore` seams, and the demo launch/exit lifecycle.

**Files:**
- Modify: `apps/android/lib/main.dart` (imports; `AudiobookCompanionApp` + `HomePage` injection fields; "Not paired yet" button; `_demoMode`/`_demoRoot` state; `_startDemo`/`_exitDemo`; demo render branch)
- Test: `apps/android/test/ui/demo_launch_test.dart`

**Interfaces:**
- Consumes: `buildDemoRuntime(engine:)` (Task 3), `DemoTickingAudioEngine` (Task 2), `LibraryHomeScreen(demoMode:)` (Task 4), `FileStore`/`InMemoryFileStore` (`lib/src/data/file_store.dart`).
- Produces: `AudiobookCompanionApp`/`HomePage` gain optional `demoRootResolver` / `demoFileStore` / `demoAssetLoader` (defaulted to production); consumed by the widget test.

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/ui/demo_launch_test.dart`:

```dart
import 'package:castwright/main.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// A production-shaped store: unpaired, and records whether save() was called.
class _SpyStore implements PairingStore {
  bool saved = false;
  @override
  Future<PairedServer?> load() async => null;
  @override
  Future<String?> loadCaPem() async => null;
  @override
  Future<void> save(PairedServer server) async => saved = true;
  @override
  Future<void> saveCaPem(String pem) async {}
  @override
  Future<void> clear() async {}
}

Future<List<int>> _fakeAsset(String key) async => const <int>[1, 2, 3];

void main() {
  testWidgets('Try the demo launches the four-book library offline; store untouched',
      (tester) async {
    // Book tiles live in a lazy ListView; enlarge the surface so all four
    // (incl. hollow-tide-3, which renders ~700px down) mount and are findable.
    tester.view.physicalSize = const Size(1200, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final store = _SpyStore();
    await tester.pumpWidget(AudiobookCompanionApp(
      store: store,
      deepLinks: const Stream.empty(),
      demoRootResolver: () async => '/demo-test',
      demoFileStore: InMemoryFileStore(),
      demoAssetLoader: _fakeAsset,
    ));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('try-demo')), findsOneWidget);
    await tester.tap(find.byKey(const Key('try-demo')));
    await tester.pumpAndSettle();

    // All four books render, plus the demo badge.
    expect(find.byKey(const Key('book-hollow-tide-1')), findsOneWidget);
    expect(find.byKey(const Key('book-hollow-tide-2')), findsOneWidget);
    expect(find.byKey(const Key('book-hollow-tide-3')), findsOneWidget);
    expect(find.byKey(const Key('book-coalfall-commission')), findsOneWidget);
    expect(find.byKey(const Key('demo-badge')), findsOneWidget);

    // The demo never wrote the pairing keystore.
    expect(store.saved, isFalse);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/ui/demo_launch_test.dart`
Expected: FAIL — `AudiobookCompanionApp` has no `demoRootResolver`/`demoFileStore`/`demoAssetLoader`; no `try-demo` key.

- [ ] **Step 3: Add imports + default seam functions**

In `apps/android/lib/main.dart`, add imports (with the existing `src/...` imports):
```dart
import 'package:flutter/services.dart' show rootBundle;
import 'package:path_provider/path_provider.dart';

import 'src/data/file_store.dart';
import 'src/demo/demo_runtime.dart';
import 'src/demo/demo_ticking_audio_engine.dart';
```

Add top-level default seam functions (below the imports, above `main()`):
```dart
/// Default demo root — app-private, deleted on exit. Overridden in host tests.
Future<String> _defaultDemoRoot() async =>
    '${(await getApplicationDocumentsDirectory()).path}/demo-runtime';

/// Default cover-asset loader — reads a bundled PNG. Overridden in host tests.
Future<List<int>> _defaultDemoAsset(String key) async =>
    (await rootBundle.load(key)).buffer.asUint8List();
```

- [ ] **Step 4: Thread injection fields through `AudiobookCompanionApp` → `HomePage`**

In `AudiobookCompanionApp` (ctor + fields), add three optional fields and pass them to `HomePage`:
```dart
  const AudiobookCompanionApp(
      {super.key,
      required this.store,
      this.service,
      this.audioHandler,
      this.deepLinks,
      this.runtimeOverride,
      this.themeMode = ThemeMode.system,
      this.demoRootResolver,
      this.demoFileStore,
      this.demoAssetLoader});

  // ... existing fields ...
  final Future<String> Function()? demoRootResolver;
  final FileStore? demoFileStore;
  final Future<List<int>> Function(String)? demoAssetLoader;
```
In its `build`, extend the `HomePage(...)` call with:
```dart
          runtimeOverride: runtimeOverride,
          demoRootResolver: demoRootResolver,
          demoFileStore: demoFileStore,
          demoAssetLoader: demoAssetLoader),
```
Mirror the same three optional fields on `HomePage` (ctor + final fields).

- [ ] **Step 5: Add demo state + lifecycle to `_HomePageState`**

Add state fields (near `_pairingOpen`):
```dart
  bool _demoMode = false;
  String? _demoRoot;

  static const _demoServer = PairedServer(
      url: 'https://demo.castwright.local',
      token: 'demo',
      caFingerprint: 'demo',
      pairedAt: null);
```

Add the launch + exit methods (do NOT route through `_boot`):
```dart
  Future<void> _startDemo() async {
    setState(() => _loading = true);
    final root = await (widget.demoRootResolver ?? _defaultDemoRoot)();
    final fs = widget.demoFileStore ?? const DiskFileStore();
    final loadAsset = widget.demoAssetLoader ?? _defaultDemoAsset;
    const coverIds = [
      'hollow-tide-1',
      'hollow-tide-2',
      'hollow-tide-3',
      'coalfall-commission',
    ];
    final coversDir = '$root/covers';
    for (final id in coverIds) {
      try {
        final bytes = await loadAsset('assets/demo-covers/$id.png');
        await fs.writeBytes('$coversDir/$id.png', bytes);
      } catch (_) {
        // A cover is polish; a missing one degrades to the placeholder tile.
      }
    }
    final runtime = await buildDemoRuntime(
      fs: fs,
      coversDir: coversDir,
      root: root,
      offline: false,
      engine: DemoTickingAudioEngine(),
    );
    if (!mounted) return;
    setState(() {
      _demoMode = true;
      _demoRoot = root;
      _paired = _demoServer;
      _runtime = runtime;
      _loading = false;
    });
  }

  Future<void> _exitDemo() async {
    final rt = _runtime;
    final root = _demoRoot;
    final fs = widget.demoFileStore ?? const DiskFileStore();
    if (mounted) {
      setState(() {
        _demoMode = false;
        _demoRoot = null;
        _runtime = null;
        _paired = null;
      });
    }
    await rt?.dispose();
    if (root != null) {
      try {
        await fs.deleteDir(root);
      } catch (_) {}
    }
  }
```

- [ ] **Step 6: Add the "Try the demo" button + demo render branch**

In `build`, the "Not paired yet" branch (currently the `_paired == null` Column, lines ~299-313), add the demo button after the "Pair a device" `FilledButton`:
```dart
              FilledButton(
                  onPressed: () => _openPairing(), child: const Text('Pair a device')),
              const SizedBox(height: 12),
              OutlinedButton(
                  key: const Key('try-demo'),
                  onPressed: _startDemo,
                  child: const Text('Try the demo')),
```

In the final `LibraryHomeScreen` return (lines ~350-354), make it demo-aware:
```dart
    return LibraryHomeScreen(
      runtime: _runtime!,
      server: _paired!,
      onUnpair: _demoMode ? _exitDemo : _unpair,
      demoMode: _demoMode,
    );
```

- [ ] **Step 7: Run tests to verify pass + no regressions**

Run: `flutter test test/ui/demo_launch_test.dart test/ui test/demo`
Expected: all green. Then `flutter analyze lib/main.dart` — clean.

- [ ] **Step 8: Commit**

```bash
git add apps/android/lib/main.dart apps/android/test/ui/demo_launch_test.dart
git commit -m "feat(app): Try-the-demo guest mode on the pairing screen (app-20)"
```

---

### Task 6: Regression plan + release notes + INDEX

Ship docs. (No runtime code — this task's "test" is the existing suite staying green + `flutter analyze` clean.)

**Files:**
- Create: `docs/features/NN-app-20-on-device-demo.md` (assign `NN` after scanning in-flight worktrees; expected 252)
- Modify: `docs/features/INDEX.md` (add entry under the app area)
- Modify: `docs/release-notes-next.md` (technical entry, `Refs #1575`)
- Modify: `RELEASE_NOTES.md` (brand-voice line in the in-progress version section)

- [ ] **Step 1: Pick the plan number**

Run: `ls docs/features/ | grep -oE '^[0-9]+' | sort -n | tail -3`
Use the next unused integer (expected `252`). Also scan sibling worktrees for an in-flight claim: `git worktree list`.

- [ ] **Step 2: Write the regression plan**

Create `docs/features/252-app-20-on-device-demo.md` (adjust number) from `docs/features/TEMPLATE.md`, with `status: active`, summarizing: the guest-mode entry, the leak-safety invariants (in-memory Drift + keystore never written + demo-root `deleteDir` on exit), the `offline:false`/four-books invariant, and the **on-device acceptance walkthrough** (the six steps from the spec's "On-device acceptance" section, driven via adb `input tap`).

- [ ] **Step 3: Update INDEX + release notes**

Add the plan to `docs/features/INDEX.md` under the app/companion area.

Append to `docs/release-notes-next.md`:
```markdown
- **Companion: on-device demo / guest mode.** A "Try the demo" entry on the pairing
  screen runs the whole app against a self-contained sample library with no server and
  no network (airplane-mode safe) — unblocking the Google Play "Sign-in details" review
  for the Open-testing promotion. Refs #1575.
```

Add a brand-voice line to the top (in-progress) version section of `RELEASE_NOTES.md`:
```markdown
- **Take Castwright for a spin — no setup.** Tap **Try the demo** on the companion app's
  pairing screen to explore a sample library, browse, and play, all on your device.
```

- [ ] **Step 4: Verify + commit**

Run (from `apps/android/`): `flutter analyze` (clean).
```bash
git add docs/features/252-app-20-on-device-demo.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): app-20 regression plan + release notes"
```

---

## Self-Review

**Spec coverage:**
- Entry point on "Not paired yet" + `_startDemo`/`_exitDemo` (not via `_boot`) → Task 5. ✓
- Leak-safety (in-memory Drift, keystore never written, demo-root deleteDir) → Task 5 (`_exitDemo`), asserted by `demo_launch_test` (store untouched) + Task 6 plan. ✓
- `offline:false` + four books → Task 5 `_startDemo`, asserted by `demo_launch_test`. ✓
- `DemoTickingAudioEngine` broadcast + dispose-cancels-timer → Task 2. ✓
- `buildDemoRuntime` engine param (default posed) → Task 3. ✓
- Covers: committed downscaled assets → Task 1; extracted in `_startDemo` (not a buildDemoRuntime cover selector) → Task 5. ✓
- `demoMode` badge + Server-section suppression + "Exit demo" copy → Task 4. ✓
- Drop `@visibleForTesting` on `forDemo` + tidy stale ignore → Task 3. ✓
- Docs/ship (plan, INDEX, release notes) → Task 6; Play runbook note is a manual ship step tracked outside the branch. ✓
- Host-testability seams (root/fs/asset injection) → Task 5. ✓

**Placeholder scan:** No TBD/TODO; every code step carries complete code. The one deferred value is the plan number `NN` in Task 6, resolved by its Step 1. ✓

**Type consistency:** `buildDemoRuntime({..., AudioEngine? engine})` (Task 3) consumed with `engine: DemoTickingAudioEngine()` (Task 5). `LibraryHomeScreen({..., bool demoMode})` / `AppSettingsScreen({..., bool demoMode})` (Task 4) consumed in Task 5. Injection fields `demoRootResolver`/`demoFileStore`/`demoAssetLoader` defined on `AudiobookCompanionApp` + `HomePage` (Task 5) and used by `demo_launch_test`. `PlayerController.audioEngine` getter flagged for verification in Task 3 Step 1. ✓

**Open risk carried into execution:** Task 3 Step 1 assumes `PlayerController` exposes `audioEngine`; if it's private, the task adds a `@visibleForTesting` getter (noted inline). Task 5's cover extraction relies on the real assets existing (Task 1) but degrades gracefully if absent.
