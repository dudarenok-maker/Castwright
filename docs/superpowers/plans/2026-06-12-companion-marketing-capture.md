# Companion Marketing Screenshot Capture (piece #1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A canonical, repeatable recipe that produces 10 on-brand marketing PNGs (5 screens × light/dark) of the Android companion app from posed demo data — no paired server, no network, no real audio.

**Architecture:** Additive demo seam — a fake `HttpSend` injected into `ApiClient` drives the manifest, book details and waveform peaks; an in-memory Drift store is seeded for the library; a `DemoAudioEngine` poses the player. A new `@visibleForTesting` `CompanionRuntime.forDemo()` factory wires these, injected through a new `HomePage.runtimeOverride`. A `flutter drive` + `integration_test` harness pumps each scene × theme and writes screenshots. A real `darkTheme` is wired as a shippable feature.

**Tech Stack:** Flutter / Dart, drift (`NativeDatabase.memory()`), `integration_test`, `flutter drive`, Node orchestrator (`scripts/capture-companion.mjs`), `adb`.

**Spec:** `docs/superpowers/specs/2026-06-12-companion-marketing-capture-design.md`
**Branch:** `feat/app-companion-marketing-capture` (already cut)
**Package name:** `castwright` (imports use `package:castwright/...`)
**Commit scope:** `app` (e.g. `feat(app): …`, `test(app): …`). The spec doc lives under `docs/` → `docs(docs): …`.

**Conventions for every task:**
- Dart/Flutter commands run **from `apps/android/`**. `git` commands run from the repo root with root-relative paths.
- Pre-commit runs `verify:fast:scoped`; Dart files are out of its JS scope, so it skips — Dart correctness is gated by the `flutter test` step in each task. Do **not** use `--no-verify`.
- After each task's tests pass, commit.

**Subagent-driven execution notes (controller):**
- Run **one subagent per task, strictly sequential** (1 → 9). Do **not** parallelize — Tasks 1 and 6 both edit `main.dart`, and 5→6→7 form a chain.
- Each task is self-contained: paste the task's full text **plus** the "Conventions for every task" block above into the dispatch. No task requires the agent to have done a prior task in its own context — prior tasks' code is already on disk and committed.
- **Scene-setting per task:** tell the agent the package is `castwright`, the working dir is `apps/android/`, and that it must only touch the files in that task's **Files** list. Most tasks add new files; the two `main.dart` edits (Tasks 1, 6) are additive and disjoint (Task 1 = `AudiobookCompanionApp` theme only; Task 6 = the `runtimeOverride` seam).
- **Model guidance:** Tasks 2–5, 7 are mechanical (clear spec, 1–3 files) → cheap/standard model. Tasks 1, 6, 8 touch integration seams/scripts → standard model.
- **Gate:** after Task 6, the agent runs the FULL `flutter test` (Task 6 Step 5) — treat a red run there as a blocker before Task 7.
- Spec-compliance review each task against the design doc `docs/superpowers/specs/2026-06-12-companion-marketing-capture-design.md`; then code-quality review. The capture run itself (Task 8) is operator-executed on an emulator, so its "verify" is `flutter analyze` + the guard smoke test, not a live capture.

---

## File Structure

**New (under `apps/android/`):**
- `lib/src/demo/demo_data.dart` — the canonical demo content: a `demoBooks` list (Hollow Tide ×3 + Coalfall) + derived manifest JSON (`demoIndexJson`, `demoDetailJson`) + `demoPeaks`.
- `lib/src/demo/demo_http_send.dart` — `HttpSend demoHttpSend({bool offline})`, the fake transport.
- `lib/src/demo/demo_audio_engine.dart` — `DemoAudioEngine implements AudioEngine`, posed player.
- `lib/src/demo/demo_pairing_store.dart` — `DemoPairingStore implements PairingStore`, canned paired server.
- `lib/src/demo/demo_runtime.dart` — `buildDemoRuntime(...)` wiring the fakes + seeded in-memory Drift.
- `integration_test/marketing/scenes.dart` — scene registry.
- `integration_test/marketing_capture_test.dart` — the driven capture test.
- `test_driver/integration_test.dart` — the `flutter drive` driver that writes PNGs.
- `integration_test/marketing/README.md` — the recipe.
- Tests: `test/ui/dark_theme_test.dart`, `test/demo/demo_http_send_test.dart`, `test/demo/demo_audio_engine_test.dart`, `test/demo/demo_pairing_store_test.dart`, `test/demo/demo_runtime_test.dart`, `test/ui/runtime_override_test.dart`.

**New (repo root):**
- `scripts/capture-companion.mjs` — orchestrator behind `npm run capture:companion`.

**Modified:**
- `apps/android/lib/main.dart` — `darkTheme` + `themeMode` on `AudiobookCompanionApp`; `runtimeOverride` on `HomePage`.
- `apps/android/lib/src/data/companion_runtime.dart` — add `@visibleForTesting CompanionRuntime.forDemo(...)` factory.
- `apps/android/pubspec.yaml` — add `integration_test` dev-dependency.
- `package.json` (root) — add `capture:companion` script.
- `.gitignore` — confirm `mockups/` covers the companion shots; no cover art tracked.

---

## Task 1: Real dark theme + `themeMode` on `AudiobookCompanionApp`

**Files:**
- Modify: `apps/android/lib/main.dart`
- Test: `apps/android/test/ui/dark_theme_test.dart`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/ui/dark_theme_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/main.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/domain/paired_server.dart';

/// A store that reports "not paired" so the app settles on the on-ramp Scaffold
/// — enough to read the resolved theme brightness off a real BuildContext.
class _UnpairedStore implements PairingStore {
  @override
  Future<PairedServer?> load() async => null;
  @override
  Future<String?> loadCaPem() async => null;
  @override
  Future<void> save(PairedServer server) async {}
  @override
  Future<void> saveCaPem(String pem) async {}
  @override
  Future<void> clear() async {}
}

void main() {
  testWidgets('themeMode dark resolves a dark color scheme', (tester) async {
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _UnpairedStore(),
      deepLinks: const Stream.empty(),
      themeMode: ThemeMode.dark,
    ));
    await tester.pumpAndSettle();

    final ctx = tester.element(find.text('Not paired yet'));
    expect(Theme.of(ctx).colorScheme.brightness, Brightness.dark);
  });

  testWidgets('themeMode light resolves a light color scheme', (tester) async {
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _UnpairedStore(),
      deepLinks: const Stream.empty(),
      themeMode: ThemeMode.light,
    ));
    await tester.pumpAndSettle();

    final ctx = tester.element(find.text('Not paired yet'));
    expect(Theme.of(ctx).colorScheme.brightness, Brightness.light);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

From `apps/android/`:
```
flutter test test/ui/dark_theme_test.dart
```
Expected: FAIL — `AudiobookCompanionApp` has no `themeMode` parameter (compile error).

- [ ] **Step 3: Add `darkTheme` + `themeMode` to `AudiobookCompanionApp`**

In `apps/android/lib/main.dart`, replace the `AudiobookCompanionApp` class constructor + `build` theme wiring with:

```dart
class AudiobookCompanionApp extends StatelessWidget {
  const AudiobookCompanionApp(
      {super.key,
      required this.store,
      this.service,
      this.audioHandler,
      this.deepLinks,
      this.themeMode = ThemeMode.system});

  final PairingStore store;

  /// Injectable so widget tests can drive pairing without real network/TLS.
  final PairingService? service;

  /// The media-session handler (null in widget tests).
  final CompanionAudioHandler? audioHandler;

  /// Injectable deep-link stream (null in production — uses App Links platform channel).
  final Stream<Uri>? deepLinks;

  /// Light/dark selection. Defaults to following the system; the capture harness
  /// forces a value per pass.
  final ThemeMode themeMode;

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFFA43C6C);
    return MaterialApp(
      title: 'Castwright',
      debugShowCheckedModeBanner: false,
      themeMode: themeMode,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: seed),
        useMaterial3: true,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark),
        useMaterial3: true,
      ),
      home: HomePage(
          store: store,
          service: service ?? PairingService(),
          audioHandler: audioHandler,
          deepLinks: deepLinks),
    );
  }
}
```

> Task 1 touches **only** `AudiobookCompanionApp` (theme). Leave `HomePage` and
> `_boot()` untouched — the `runtimeOverride` seam lands atomically in Task 6.

- [ ] **Step 4: Run the test to verify it passes**

From `apps/android/`:
```
flutter test test/ui/dark_theme_test.dart
```
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/main.dart apps/android/test/ui/dark_theme_test.dart
git commit -m "feat(app): wire a real dark theme + themeMode on the companion app"
```

---

## Task 2: Demo content + fake `HttpSend`

**Files:**
- Create: `apps/android/lib/src/demo/demo_data.dart`
- Create: `apps/android/lib/src/demo/demo_http_send.dart`
- Test: `apps/android/test/demo/demo_http_send_test.dart`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/demo/demo_http_send_test.dart`:

```dart
import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/pairing_service.dart' show Connection;
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/demo/demo_http_send.dart';
import 'package:flutter_test/flutter_test.dart';

ApiClient client({bool offline = false}) => ApiClient(
      const Connection(
        server: PairedServer(
            url: 'https://demo.local', token: 't', caFingerprint: 'f'),
        caPem: 'placeholder-not-a-real-cert',
      ),
      send: demoHttpSend(offline: offline),
    );

void main() {
  test('serves a non-empty manifest index', () async {
    final index = await client().syncManifestIndex();
    expect(index.books, isNotEmpty);
    expect(index.activeBookIds, isNotEmpty);
  });

  test('every index book resolves a detail with chapters', () async {
    final api = client();
    final index = await api.syncManifestIndex();
    for (final b in index.books) {
      final detail = await api.syncManifestBookDetail(b.bookId);
      expect(detail.bookId, b.bookId);
      expect(detail.chapters, isNotEmpty);
    }
  });

  test('chapter audio endpoint returns waveform peaks', () async {
    final api = client();
    final index = await api.syncManifestIndex();
    final detail = await api.syncManifestBookDetail(index.books.first.bookId);
    final peaks = await api.getChapterPeaks(detail.bookId, detail.chapters.first.id);
    expect(peaks, isNotEmpty);
  });

  test('listen-progress is 404 (null)', () async {
    expect(await client().getListenProgress('any'), isNull);
  });

  test('offline makes the manifest paths throw ApiException', () async {
    expect(() => client(offline: true).syncManifestIndex(),
        throwsA(isA<ApiException>()));
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

From `apps/android/`:
```
flutter test test/demo/demo_http_send_test.dart
```
Expected: FAIL — `demo_http_send.dart` / `demo_data.dart` do not exist.

- [ ] **Step 3: Create the demo content**

Create `apps/android/lib/src/demo/demo_data.dart`:

```dart
/// Canonical companion marketing demo content (piece #1b). Mirrors the web
/// fixtures' fictional "The Hollow Tide" series + the real "The Coalfall
/// Commission" — deliberate duplication, Dart can't import the TS fixtures.
/// One source list drives both the fake-server JSON and the Drift seed.
library;

import 'dart:math' as math;

/// One chapter of a demo book.
class DemoChapter {
  const DemoChapter({
    required this.uuid,
    required this.id,
    required this.title,
    required this.durationSec,
  });
  final String uuid;
  final int id;
  final String title;
  final double durationSec;

  /// Synthetic fingerprint (`renderedAt|size`) — any non-empty value marks the
  /// chapter as "downloaded" in the seeded store.
  String get fingerprint => 'demo|1024';
  String get urlSuffix => 'audio.mp3';
}

/// A resume point for the Continue-listening rail + progress bar.
class DemoResume {
  const DemoResume({
    required this.chapterUuid,
    required this.positionMs,
    required this.lastPlayedAt,
  });
  final String chapterUuid;
  final int positionMs;
  final String lastPlayedAt;
}

/// One demo book: manifest metadata + chapters + optional download/resume state.
class DemoBook {
  const DemoBook({
    required this.bookId,
    required this.title,
    required this.author,
    required this.series,
    required this.seriesPosition,
    required this.updatedAt,
    required this.chapters,
    this.downloaded = true,
    this.updateAvailable = false,
    this.resume,
  });
  final String bookId;
  final String title;
  final String author;
  final String series;
  final double? seriesPosition;
  final String updatedAt;
  final List<DemoChapter> chapters;

  /// Seed chapters into Drift (→ "downloaded"); false = "not downloaded".
  final bool downloaded;

  /// Seed the local `updatedAt` OLDER than [updatedAt] so it reads as
  /// "update available".
  final bool updateAvailable;
  final DemoResume? resume;
}

// Each book's chapters carry UNIQUE uuids (uuid is the Drift Chapters primary
// key — sharing a list across books would collide and steal rows).
const _ht1Chapters = [
  DemoChapter(uuid: 'ht1-c1', id: 1, title: 'The Tide Comes In', durationSec: 1420),
  DemoChapter(uuid: 'ht1-c2', id: 2, title: 'Bells Beneath', durationSec: 1675),
  DemoChapter(uuid: 'ht1-c3', id: 3, title: 'The Drowned Quarter', durationSec: 1510),
];

const _ht2Chapters = [
  DemoChapter(uuid: 'ht2-c1', id: 1, title: 'Low Water', durationSec: 1380),
  DemoChapter(uuid: 'ht2-c2', id: 2, title: 'The Oathstone', durationSec: 1605),
  DemoChapter(uuid: 'ht2-c3', id: 3, title: 'Saltlight', durationSec: 1490),
];

const _ht3Chapters = [
  DemoChapter(uuid: 'ht3-c1', id: 1, title: 'The Grave Tide', durationSec: 1450),
  DemoChapter(uuid: 'ht3-c2', id: 2, title: 'Underforth', durationSec: 1700),
  DemoChapter(uuid: 'ht3-c3', id: 3, title: 'The Last Bell', durationSec: 1525),
];

const _coalfallChapters = [
  DemoChapter(uuid: 'cf-c3', id: 3, title: 'Chapter One — The Knock', durationSec: 1980),
  DemoChapter(uuid: 'cf-c4', id: 4, title: 'Chapter Two — The Pour', durationSec: 2120),
];

/// The demo library. States are mixed on purpose so the library shot shows the
/// full range of affordances.
const demoBooks = <DemoBook>[
  DemoBook(
    bookId: 'hollow-tide-1',
    title: 'The Drowning Bell',
    author: 'Marin Vale',
    series: 'The Hollow Tide',
    seriesPosition: 1,
    updatedAt: '2026-05-01T10:00:00Z',
    chapters: _ht1Chapters,
    downloaded: true,
    resume: DemoResume(
        chapterUuid: 'ht1-c2', positionMs: 540000, lastPlayedAt: '2026-06-10T20:00:00Z'),
  ),
  DemoBook(
    bookId: 'hollow-tide-2',
    title: "The Tidewatcher's Oath",
    author: 'Marin Vale',
    series: 'The Hollow Tide',
    seriesPosition: 2,
    updatedAt: '2026-05-20T10:00:00Z',
    chapters: _ht2Chapters,
    downloaded: true,
    updateAvailable: true,
  ),
  DemoBook(
    bookId: 'hollow-tide-3',
    title: 'Saltgrave',
    author: 'Marin Vale',
    series: 'The Hollow Tide',
    seriesPosition: 3,
    updatedAt: '2026-05-28T10:00:00Z',
    chapters: _ht3Chapters,
    downloaded: false,
  ),
  DemoBook(
    bookId: 'coalfall-commission',
    title: 'The Coalfall Commission',
    author: 'Castwright',
    series: 'Standalones',
    seriesPosition: null,
    updatedAt: '2026-05-15T10:00:00Z',
    chapters: _coalfallChapters,
    downloaded: true,
    resume: DemoResume(
        chapterUuid: 'cf-c3', positionMs: 300000, lastPlayedAt: '2026-06-11T09:00:00Z'),
  ),
];

/// 240 normalized RMS bins for the player waveform (a smooth pseudo-random
/// envelope — deterministic, no RNG).
final List<double> demoPeaks = List<double>.generate(240, (i) {
  final a = 0.5 + 0.4 * math.sin(i * 0.20);
  final b = 0.2 * math.sin(i * 0.07);
  final v = a + b;
  return v < 0.05 ? 0.05 : (v > 1.0 ? 1.0 : v);
});

/// The fake-server INDEX body.
Map<String, dynamic> demoIndexJson() => {
      'schemaVersion': 1,
      'books': [
        for (final b in demoBooks)
          {
            'bookId': b.bookId,
            'updatedAt': b.updatedAt,
            'title': b.title,
            'author': b.author,
            'series': b.series,
            'seriesPosition': b.seriesPosition,
            'chapterCount': b.chapters.length,
          },
      ],
      'activeBookIds': [for (final b in demoBooks) b.bookId],
    };

/// The fake-server DETAIL body for [bookId].
Map<String, dynamic> demoDetailJson(String bookId) {
  final book = demoBooks.firstWhere((b) => b.bookId == bookId);
  return {
    'schemaVersion': 1,
    'bookId': book.bookId,
    'updatedAt': book.updatedAt,
    'chapters': [
      for (final c in book.chapters)
        {
          'uuid': c.uuid,
          'id': c.id,
          'title': c.title,
          'fingerprint': c.fingerprint,
          'urlSuffix': c.urlSuffix,
          'audioUrl': '/api/books/${book.bookId}/chapters/${c.id}/${c.urlSuffix}',
          'durationSec': c.durationSec,
        },
    ],
    'activeChapterUuids': [for (final c in book.chapters) c.uuid],
  };
}
```

Create `apps/android/lib/src/demo/demo_http_send.dart`:

```dart
import 'dart:convert';

import '../data/api_client.dart' show HttpSend, HttpResult;
import 'demo_data.dart';

/// A fake [HttpSend] for marketing capture. Pattern-matches the request path and
/// returns canned JSON — driving the manifest index, per-book details, waveform
/// peaks, and a 404 listen-progress, with ZERO TLS. When [offline], the manifest
/// paths return 503 so the library falls back to its local store (offline scene).
HttpSend demoHttpSend({bool offline = false}) {
  return (String method, Uri url, Map<String, String> headers) async {
    final path = url.path;
    final qs = url.queryParameters;

    if (path == '/api/library/sync-manifest') {
      if (offline) return const HttpResult(503, '');
      if (qs.containsKey('bookId')) {
        return HttpResult(200, jsonEncode(demoDetailJson(qs['bookId']!)));
      }
      return HttpResult(200, jsonEncode(demoIndexJson()));
    }
    if (path.endsWith('/audio')) {
      return HttpResult(200, jsonEncode({'peaks': demoPeaks}));
    }
    if (path.endsWith('/listen-progress')) {
      return const HttpResult(404, '');
    }
    if (path == '/api/info') {
      return HttpResult(200, jsonEncode({'version': 'demo', 'name': 'Castwright'}));
    }
    return const HttpResult(404, '');
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

From `apps/android/`:
```
flutter test test/demo/demo_http_send_test.dart
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/demo/demo_data.dart apps/android/lib/src/demo/demo_http_send.dart apps/android/test/demo/demo_http_send_test.dart
git commit -m "feat(app): add demo content + fake HttpSend for marketing capture"
```

---

## Task 3: `DemoAudioEngine` (posed player)

**Files:**
- Create: `apps/android/lib/src/demo/demo_audio_engine.dart`
- Test: `apps/android/test/demo/demo_audio_engine_test.dart`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/demo/demo_audio_engine_test.dart`:

```dart
import 'package:castwright/src/demo/demo_audio_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reports a fixed playing state, position and duration', () async {
    final engine = DemoAudioEngine(
      position: const Duration(minutes: 7, seconds: 12),
      duration: const Duration(minutes: 23, seconds: 40),
    );
    expect(engine.playing, isTrue);
    expect(engine.position, const Duration(minutes: 7, seconds: 12));
    expect(engine.duration, const Duration(minutes: 23, seconds: 40));
    expect(await engine.playingStream.first, isTrue);
    expect(await engine.positionStream.first, engine.position);
    expect(await engine.durationStream.first, engine.duration);
  });

  test('control methods are no-ops that complete', () async {
    final engine = DemoAudioEngine();
    await engine.setFilePath('whatever');
    await engine.play();
    await engine.pause();
    await engine.seek(const Duration(seconds: 5));
    await engine.setSpeed(1.5);
    await engine.setVolumeBoost(3);
    await engine.dispose();
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

From `apps/android/`:
```
flutter test test/demo/demo_audio_engine_test.dart
```
Expected: FAIL — `demo_audio_engine.dart` does not exist.

- [ ] **Step 3: Implement `DemoAudioEngine`**

Create `apps/android/lib/src/demo/demo_audio_engine.dart`:

```dart
import '../data/audio_engine.dart';

/// A posed [AudioEngine] for marketing capture: no native audio, a fixed
/// "playing" state at a fixed position/duration so the player renders a static,
/// deterministic now-playing frame. All control methods are no-ops.
class DemoAudioEngine implements AudioEngine {
  DemoAudioEngine({
    Duration position = const Duration(minutes: 7, seconds: 12),
    Duration duration = const Duration(minutes: 23, seconds: 40),
  })  : _position = position,
        _duration = duration;

  final Duration _position;
  final Duration _duration;

  @override
  Duration get position => _position;
  @override
  Stream<Duration> get positionStream => Stream<Duration>.value(_position);

  @override
  Duration? get duration => _duration;
  @override
  Stream<Duration?> get durationStream => Stream<Duration?>.value(_duration);

  @override
  bool get playing => true;
  @override
  Stream<bool> get playingStream => Stream<bool>.value(true);

  @override
  Stream<void> get completionStream => const Stream<void>.empty();

  @override
  Future<void> setFilePath(String path) async {}
  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {}
  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setSpeed(double speed) async {}
  @override
  Future<void> setVolumeBoost(double db) async {}
  @override
  Future<void> dispose() async {}
}
```

- [ ] **Step 4: Run the test to verify it passes**

From `apps/android/`:
```
flutter test test/demo/demo_audio_engine_test.dart
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/demo/demo_audio_engine.dart apps/android/test/demo/demo_audio_engine_test.dart
git commit -m "feat(app): add posed DemoAudioEngine for marketing capture"
```

---

## Task 4: `DemoPairingStore`

**Files:**
- Create: `apps/android/lib/src/demo/demo_pairing_store.dart`
- Test: `apps/android/test/demo/demo_pairing_store_test.dart`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/demo/demo_pairing_store_test.dart`:

```dart
import 'package:castwright/src/demo/demo_pairing_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('returns a canned paired server + non-empty caPem', () async {
    final store = DemoPairingStore();
    final server = await store.load();
    expect(server, isNotNull);
    expect(server!.url, isNotEmpty);
    expect(await store.loadCaPem(), isNotEmpty);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

From `apps/android/`:
```
flutter test test/demo/demo_pairing_store_test.dart
```
Expected: FAIL — `demo_pairing_store.dart` does not exist.

- [ ] **Step 3: Implement `DemoPairingStore`**

Create `apps/android/lib/src/demo/demo_pairing_store.dart`:

```dart
import '../data/pairing_store.dart';
import '../domain/paired_server.dart';

/// A [PairingStore] that reports an already-paired demo server so the app boots
/// straight to the library for marketing capture. The [caPem] is a placeholder
/// and is never parsed into a SecurityContext (the demo ApiClient uses an
/// injected fake transport).
class DemoPairingStore implements PairingStore {
  static const _server = PairedServer(
    url: 'https://studio.local:8443',
    token: 'demo-token',
    caFingerprint: 'demo-fingerprint',
    pairedAt: '2026-06-01T12:00:00Z',
  );

  @override
  Future<PairedServer?> load() async => _server;
  @override
  Future<String?> loadCaPem() async => 'demo-placeholder-ca-pem';
  @override
  Future<void> save(PairedServer server) async {}
  @override
  Future<void> saveCaPem(String pem) async {}
  @override
  Future<void> clear() async {}
}
```

- [ ] **Step 4: Run the test to verify it passes**

From `apps/android/`:
```
flutter test test/demo/demo_pairing_store_test.dart
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/demo/demo_pairing_store.dart apps/android/test/demo/demo_pairing_store_test.dart
git commit -m "feat(app): add DemoPairingStore that boots straight to the library"
```

---

## Task 5: `CompanionRuntime.forDemo` factory + `buildDemoRuntime` (seeded)

**Files:**
- Modify: `apps/android/lib/src/data/companion_runtime.dart` (add `@visibleForTesting` factory)
- Create: `apps/android/lib/src/demo/demo_runtime.dart`
- Test: `apps/android/test/demo/demo_runtime_test.dart`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/demo/demo_runtime_test.dart`:

```dart
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/domain/library_tree.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('online runtime loads the full demo library from the manifest', () async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    final books = await rt.sync.loadLibrary();
    expect(books.map((b) => b.bookId),
        containsAll(['hollow-tide-1', 'hollow-tide-2', 'hollow-tide-3', 'coalfall-commission']));
    // Mixed download states are seeded.
    final byId = {for (final b in books) b.bookId: b.downloadState};
    expect(byId['hollow-tide-3'], BookDownloadState.notDownloaded);
    expect(byId['hollow-tide-2'], BookDownloadState.updateAvailable);
    expect(byId['hollow-tide-1'], BookDownloadState.downloaded);
    await rt.dispose();
  });

  test('seeds resume points for the Continue rail', () async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    final pb = await rt.library.loadPlayback('hollow-tide-1');
    expect(pb, isNotNull);
    expect(pb!.chapterUuid, 'ht1-c2');
    await rt.dispose();
  });

  test('offline runtime falls back to the local (downloaded) library', () async {
    final rt = await buildDemoRuntime(
        fs: InMemoryFileStore(), coversDir: '/covers', offline: true);
    // loadLibrary hits the manifest, which is 503 offline → throws.
    expect(() => rt.sync.loadLibrary(), throwsA(anything));
    // loadLocalLibrary reads the seeded store (downloaded books only).
    final local = await rt.sync.loadLocalLibrary();
    expect(local.map((b) => b.bookId),
        containsAll(['hollow-tide-1', 'hollow-tide-2', 'coalfall-commission']));
    expect(local.map((b) => b.bookId), isNot(contains('hollow-tide-3')));
    await rt.dispose();
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

From `apps/android/`:
```
flutter test test/demo/demo_runtime_test.dart
```
Expected: FAIL — `demo_runtime.dart` / `CompanionRuntime.forDemo` do not exist.

- [ ] **Step 3: Add the `@visibleForTesting` factory to `CompanionRuntime`**

In `apps/android/lib/src/data/companion_runtime.dart`, add `import 'package:flutter/foundation.dart';` to the imports, then add this factory right after the private `CompanionRuntime._` constructor:

```dart
  /// Marketing-capture / test factory: build a runtime from already-constructed
  /// (fake) parts, bypassing the network/TLS wiring of [forConnection].
  @visibleForTesting
  factory CompanionRuntime.forDemo({
    required ApiClient api,
    required DriftLocalLibrary library,
    required SyncController sync,
    required PlayerController player,
    required ThumbnailCache thumbnails,
    required SettingsStore settingsStore,
    required AppSettings settings,
    required ResumeSyncService resumeSync,
    required SleepTimer sleepTimer,
  }) =>
      CompanionRuntime._(api, library, sync, player, thumbnails, settingsStore,
          settings, resumeSync, sleepTimer, null, const []);
```

Confirm the imports used by the signature already exist in the file (`AppSettings` via `../domain/app_settings.dart`, `SleepTimer` via `../domain/sleep_timer.dart`, etc.) — they do; `forConnection` already references them.

- [ ] **Step 4: Implement `buildDemoRuntime`**

Create `apps/android/lib/src/demo/demo_runtime.dart`:

```dart
import 'package:drift/native.dart';

import '../data/api_client.dart';
import '../data/chapter_downloader.dart';
import '../data/companion_runtime.dart';
import '../data/cover_thumbnails.dart';
import '../data/drift_local_library.dart';
import '../data/file_store.dart';
import '../data/library_database.dart';
import '../data/pairing_service.dart' show Connection;
import '../data/player_controller.dart';
import '../data/resume_sync_service.dart';
import '../data/settings_store.dart';
import '../domain/app_settings.dart';
import '../domain/paired_server.dart';
import '../domain/sleep_timer.dart';
import 'demo_audio_engine.dart';
import 'demo_data.dart';
import 'demo_http_send.dart';

/// A [ListenProgressApi] that does nothing — the demo never syncs resume to a
/// server (and must never build a SecurityContext from the placeholder caPem).
class _NoopProgressApi implements ListenProgressApi {
  @override
  Future<RemoteProgress?> getListenProgress(String bookId) async => null;
  @override
  Future<void> putListenProgress(String bookId,
      {required int chapterId,
      required double currentSec,
      required String listenedAt}) async {}
}

/// Build a fully-posed [CompanionRuntime] for marketing capture: a fake-HTTP
/// [ApiClient], an in-memory Drift store seeded from [demoBooks], a
/// [ThumbnailCache] reading pushed covers from [coversDir], and a
/// [DemoAudioEngine]. No network, no TLS, no native audio.
///
/// [fs] + [coversDir] are injectable so widget tests run on the host with an
/// [InMemoryFileStore]; the capture harness passes a [DiskFileStore] +
/// `getExternalStorageDirectory()`.
Future<CompanionRuntime> buildDemoRuntime({
  bool offline = false,
  FileStore? fs,
  String coversDir = '',
  String root = '/demo',
}) async {
  final fileStore = fs ?? const DiskFileStore();

  const connection = Connection(
    server: PairedServer(
        url: 'https://studio.local:8443', token: 'demo-token', caFingerprint: 'f'),
    caPem: 'demo-placeholder-ca-pem',
  );
  final api = ApiClient(connection, send: demoHttpSend(offline: offline));

  final library = DriftLocalLibrary(LibraryDatabase(NativeDatabase.memory()), fileStore,
      root: root);

  // Seed ONLY downloaded books into Drift. A not-downloaded book lives solely in
  // the manifest — so online it shows "Not downloaded", and it is correctly
  // ABSENT from the offline shelf (`loadLocalLibrary` returns every `books` row,
  // so seeding its metadata would wrongly surface it — and with an empty title).
  for (final b in demoBooks) {
    if (!b.downloaded) continue;
    await library.upsertBookMeta(
      bookId: b.bookId,
      title: b.title,
      author: b.author,
      series: b.series,
      seriesPosition: b.seriesPosition?.toInt(),
    );
    if (coversDir.isNotEmpty) {
      await library.setCoverThumbPath(b.bookId, '$coversDir/${b.bookId}.png');
    }
    for (final c in b.chapters) {
      await library.recordChapterMeta(
        bookId: b.bookId,
        uuid: c.uuid,
        chapterId: c.id,
        title: c.title,
        fingerprint: c.fingerprint,
        urlSuffix: c.urlSuffix,
        durationSec: c.durationSec,
      );
    }
    // Stamp the synced updatedAt: equal to the manifest = "downloaded";
    // older = "update available".
    await library.setBookUpdatedAt(
        b.bookId, b.updateAvailable ? '2000-01-01T00:00:00Z' : b.updatedAt);
    if (b.resume != null) {
      await library.savePlayback(b.bookId, b.resume!.chapterUuid,
          b.resume!.positionMs, b.resume!.lastPlayedAt);
      await library.markPlayed(b.bookId, b.resume!.lastPlayedAt);
    }
  }

  final sync = SyncController(
    manifestApi: api.manifestApi,
    localLibrary: library,
    // The demo never downloads (every book is pre-seeded). A range-fetch that
    // throws if ever called documents that — and avoids the TLS-building
    // `api.pinnedRangeFetch()`.
    chapterDownloader: ChapterDownloader(
      (Uri url, Map<String, String> headers) async =>
          throw const DownloadException('demo runtime never downloads'),
      fileStore,
    ),
    urlResolver: (path) => Uri.parse('${connection.server.url}$path'),
  );

  final player = PlayerController(
    audioEngine: DemoAudioEngine(),
    playbackStore: library,
    playlistLoader: (bookId) async => sync.playlistFor(bookId),
    clock: () => DateTime.fromMillisecondsSinceEpoch(0),
  );

  final thumbnails = ThumbnailCache(
    fs: fileStore,
    store: library,
    fetch: (bookId) async {
      final bytes = await fileStore.read('$coversDir/$bookId.png');
      if (bytes == null) throw StateError('no demo cover for $bookId');
      return bytes;
    },
    root: root,
  );

  final settingsStore = SettingsStore(fileStore, path: '$root/settings.json');
  const settings = AppSettings.defaults;

  final resumeSync = ResumeSyncService(
    progressApi: _NoopProgressApi(),
    playbackStore: library,
    chapterIdResolver: (bookId, uuid) async => null,
  );

  final sleepTimer = SleepTimer(onExpire: () {});

  return CompanionRuntime.forDemo(
    api: api,
    library: library,
    sync: sync,
    player: player,
    thumbnails: thumbnails,
    settingsStore: settingsStore,
    settings: settings,
    resumeSync: resumeSync,
    sleepTimer: sleepTimer,
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

From `apps/android/`:
```
flutter test test/demo/demo_runtime_test.dart
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/data/companion_runtime.dart apps/android/lib/src/demo/demo_runtime.dart apps/android/test/demo/demo_runtime_test.dart
git commit -m "feat(app): add buildDemoRuntime wiring fakes + seeded in-memory store"
```

---

## Task 6: Wire `HomePage.runtimeOverride`

**Files:**
- Modify: `apps/android/lib/main.dart` (`AudiobookCompanionApp` field + pass-through, `HomePage` field, `_HomePageState._boot` short-circuit)
- Test: `apps/android/test/ui/runtime_override_test.dart`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/ui/runtime_override_test.dart`:

```dart
import 'package:castwright/main.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/demo/demo_pairing_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('runtimeOverride boots straight to the library', (tester) async {
    final fs = InMemoryFileStore();
    final rt = await buildDemoRuntime(fs: fs, coversDir: '/covers');

    await tester.pumpWidget(AudiobookCompanionApp(
      store: DemoPairingStore(),
      deepLinks: const Stream.empty(),
      runtimeOverride: rt,
    ));
    await tester.pumpAndSettle();

    // The library AppBar title proves we skipped pairing and rendered the home.
    expect(find.text('Library'), findsOneWidget);
    expect(find.text('Not paired yet'), findsNothing);
    // A seeded book tile is shown (by key — the title also appears in the
    // Continue rail, so a text matcher would find two).
    expect(find.byKey(const Key('book-hollow-tide-1')), findsOneWidget);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

From `apps/android/`:
```
flutter test test/ui/runtime_override_test.dart
```
Expected: FAIL — a compile error: `AudiobookCompanionApp` has no `runtimeOverride` parameter yet. (Step 3 adds it; once it compiles, the assertion that the library renders is what the seam must satisfy.)

- [ ] **Step 3: Add the `runtimeOverride` seam to `main.dart` (atomic)**

All three edits below live in `apps/android/lib/main.dart`. `companion_runtime.dart` is already imported there (it defines `CompanionRuntime`), so no new import is needed.

**(a)** Add the field + constructor param to `AudiobookCompanionApp` and pass it down. Change the constructor to:

```dart
  const AudiobookCompanionApp(
      {super.key,
      required this.store,
      this.service,
      this.audioHandler,
      this.deepLinks,
      this.runtimeOverride,
      this.themeMode = ThemeMode.system});
```

Add the field (next to the other fields):

```dart
  /// Injectable pre-built runtime — used by the marketing capture + widget tests
  /// to skip pairing/connection and render posed screens. Null in production.
  final CompanionRuntime? runtimeOverride;
```

And pass it to `HomePage` in `build`:

```dart
      home: HomePage(
          store: store,
          service: service ?? PairingService(),
          audioHandler: audioHandler,
          deepLinks: deepLinks,
          runtimeOverride: runtimeOverride),
```

**(b)** Add the field + constructor param to `HomePage`. Change its constructor to include `this.runtimeOverride` and add the field:

```dart
  /// Injectable pre-built runtime (capture/tests). Null in production.
  final CompanionRuntime? runtimeOverride;
```

**(c)** Short-circuit `_HomePageState._boot()` at the **very top** (before `final server = await widget.store.load();`):

```dart
    if (widget.runtimeOverride != null) {
      _paired = await widget.store.load();
      if (!mounted) return;
      setState(() {
        _runtime = widget.runtimeOverride;
        _loading = false;
      });
      return;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

From `apps/android/`:
```
flutter test test/ui/runtime_override_test.dart
```
Expected: PASS.

- [ ] **Step 5: Run the full companion test suite to confirm no regressions**

From `apps/android/`:
```
flutter test
```
Expected: PASS (all existing tests + the new demo/ui tests green).

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/main.dart apps/android/test/ui/runtime_override_test.dart
git commit -m "feat(app): boot to a posed library when runtimeOverride is injected"
```

---

## Task 7: Scene registry + capture `integration_test` + driver

**Files:**
- Create: `apps/android/integration_test/marketing/scenes.dart`
- Create: `apps/android/integration_test/marketing_capture_test.dart`
- Create: `apps/android/test_driver/integration_test.dart`
- Modify: `apps/android/pubspec.yaml` (add `integration_test`)

- [ ] **Step 1: Add the `integration_test` dev-dependency**

In `apps/android/pubspec.yaml`, under `dev_dependencies:`, add (if not present):

```yaml
  integration_test:
    sdk: flutter
```

Then from `apps/android/`:
```
flutter pub get
```
Expected: resolves without error.

- [ ] **Step 2: Create the scene registry**

Create `apps/android/integration_test/marketing/scenes.dart`:

```dart
/// The marketing capture scene registry — one entry per screenshot, mirroring
/// the web harness's `e2e/marketing/scenes.ts`. Adding a scene = one entry here.
enum SceneNav { library, player, settings, pairing }

class Scene {
  const Scene(this.id, this.nav, {this.offline = false});

  /// Output stem: `<id>.<theme>.png`. Unique.
  final String id;
  final SceneNav nav;

  /// When true, the demo runtime is built offline (manifest 503 → offline chip).
  final bool offline;
}

const marketingScenes = <Scene>[
  Scene('library-home', SceneNav.library),
  Scene('player', SceneNav.player),
  Scene('settings', SceneNav.settings),
  Scene('library-offline', SceneNav.library, offline: true),
  Scene('pairing', SceneNav.pairing),
];
```

- [ ] **Step 3: Create the capture test**

Create `apps/android/integration_test/marketing_capture_test.dart`:

```dart
import 'package:castwright/main.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/demo/demo_pairing_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/domain/pairing_qr.dart';
import 'package:castwright/src/ui/pairing_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';

import 'marketing/scenes.dart';

/// Drives every marketing scene × theme and emits one screenshot each. Run via
/// `flutter drive` (see integration_test/marketing/README.md) — the driver
/// (test_driver/integration_test.dart) writes the PNG bytes to disk.
Future<void> main() async {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('capture marketing scenes', (tester) async {
    // Android: replace the live surface with an image-backed one so
    // takeScreenshot can read pixels. Done once, before the first shot.
    await binding.convertFlutterSurfaceToImage();

    final dir = await getExternalStorageDirectory();
    final coversDir = '${dir!.path}/demo-covers';

    for (final theme in [ThemeMode.light, ThemeMode.dark]) {
      final themeName = theme == ThemeMode.light ? 'light' : 'dark';
      for (final scene in marketingScenes) {
        final rt = await buildDemoRuntime(
          coversDir: coversDir,
          offline: scene.offline,
          root: '${dir.path}/demo-runtime', // writable app dir on-device
        );

        if (scene.nav == SceneNav.pairing) {
          // Pairing skips the runtime — pump the pre-filled review form directly.
          await tester.pumpWidget(MaterialApp(
            themeMode: theme,
            theme: ThemeData(
                colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFA43C6C)),
                useMaterial3: true),
            darkTheme: ThemeData(
                colorScheme: ColorScheme.fromSeed(
                    seedColor: const Color(0xFFA43C6C), brightness: Brightness.dark),
                useMaterial3: true),
            home: PairingScreen(
              service: PairingService(),
              store: DemoPairingStore(),
              initialQr: const PairingQr(
                  hostPort: 'studio.local:8443', code: '4810-6105', fpTag: 'CW7K-P2'),
            ),
          ));
          await tester.pumpAndSettle();
        } else {
          await tester.pumpWidget(AudiobookCompanionApp(
            store: DemoPairingStore(),
            deepLinks: const Stream.empty(),
            runtimeOverride: rt,
            themeMode: theme,
          ));
          await tester.pumpAndSettle();

          if (scene.nav == SceneNav.settings) {
            await tester.tap(find.byKey(const Key('open-settings')));
            await tester.pumpAndSettle();
          } else if (scene.nav == SceneNav.player) {
            // Tap the book tile by key (the title also appears in the Continue
            // rail). ensureVisible guards against it being below the fold.
            final book = find.byKey(const Key('book-hollow-tide-1'));
            await tester.ensureVisible(book);
            await tester.pumpAndSettle();
            await tester.tap(book);
            await tester.pumpAndSettle();
            // Flip the local _playing flag to the playing look.
            final chapter = find.byKey(const Key('chapter-ht1-c2'));
            if (chapter.evaluate().isNotEmpty) {
              await tester.tap(chapter);
              await tester.pumpAndSettle();
            }
          }
        }

        await binding.takeScreenshot('${scene.id}.$themeName');
        await rt.dispose();
      }
    }
  });
}
```

- [ ] **Step 4: Create the driver**

Create `apps/android/test_driver/integration_test.dart`:

```dart
import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

/// `flutter drive` runs with CWD = apps/android, so resolve the repo root
/// (../../) and write the marketing PNGs to the git-ignored mockups tree.
Future<void> main() async {
  await integrationDriver(
    onScreenshot: (String name, List<int> bytes, [Map<String, Object?>? args]) async {
      final file = File('../../mockups/marketing-screens/companion/$name.png');
      await file.create(recursive: true);
      await file.writeAsBytes(bytes);
      return true;
    },
  );
}
```

- [ ] **Step 5: Verify it compiles + analyzes clean**

From `apps/android/`:
```
flutter analyze integration_test test_driver
```
Expected: "No issues found!" (an emulator is NOT required to analyze; the actual capture run is operator-executed via Task 8's README).

- [ ] **Step 6: Commit**

```bash
git add apps/android/integration_test apps/android/test_driver apps/android/pubspec.yaml apps/android/pubspec.lock
git commit -m "feat(app): add marketing capture integration_test + scene registry + driver"
```

---

## Task 8: Orchestrator script + npm wiring + README + gitignore

**Files:**
- Create: `scripts/capture-companion.mjs`
- Create: `apps/android/integration_test/marketing/README.md`
- Modify: `package.json` (root) — `capture:companion` script
- Modify: `.gitignore` (confirm coverage)

- [ ] **Step 1: Create the orchestrator script**

Create `scripts/capture-companion.mjs`:

```js
#!/usr/bin/env node
// Companion marketing screenshot capture (piece #1b). Pushes the (operator-
// supplied, git-ignored) brand covers to the emulator, then runs flutter drive.
// The on-device ThumbnailCache downscales them, so no Node image lib is needed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = resolve(repoRoot, 'apps/android');
const APP_ID = 'ai.castwright.companion'; // confirm in apps/android/android/app/build.gradle (applicationId)
const COVERS_SRC = resolve(repoRoot, 'brand/book-covers');
const DEVICE_COVERS = `/sdcard/Android/data/${APP_ID}/files/demo-covers`;

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ ${cmd} ${args.join(' ')} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
};

// 1. An emulator/device must be up. `adb devices` prints one `<serial>\tdevice`
//    line per online device (after a header line); match that exactly.
const devices = spawnSync('adb', ['devices'], { encoding: 'utf8', shell: true }).stdout ?? '';
const online = devices.split('\n').some((line) => /\tdevice$/.test(line.trimEnd()));
if (!online) {
  console.error('✖ No running emulator/device (none shown as "device" by `adb devices`). Boot an AVD first — see integration_test/marketing/README.md.');
  process.exit(1);
}

// 2. Push the covers (operator-supplied; git-ignored).
if (!existsSync(COVERS_SRC) || readdirSync(COVERS_SRC).length === 0) {
  console.error(`✖ No covers at ${COVERS_SRC}. Provide the brand book covers (git-ignored) and retry.`);
  process.exit(1);
}
sh('adb', ['shell', 'mkdir', '-p', DEVICE_COVERS]);
sh('adb', ['push', `${COVERS_SRC}/.`, DEVICE_COVERS]);

// 3. Run flutter drive once (captures all scenes × themes).
sh('flutter', [
  'drive',
  '--driver=test_driver/integration_test.dart',
  '--target=integration_test/marketing_capture_test.dart',
], { cwd: androidDir });

console.log('\n✔ Companion shots written to mockups/marketing-screens/companion/');
```

> Before finishing, **confirm `APP_ID`** by reading `applicationId` in
> `apps/android/android/app/build.gradle` (or `build.gradle.kts`) and the cover
> filenames match the `bookId`s in `demo_data.dart` (`hollow-tide-1.png`, …,
> `coalfall-commission.png`). If the brand covers use different filenames, the
> README's "rename to `<bookId>.png`" step covers it.

- [ ] **Step 2: Add the npm script**

In the root `package.json` `"scripts"` block, add:

```json
    "capture:companion": "node scripts/capture-companion.mjs",
```

- [ ] **Step 3: Confirm gitignore coverage**

Verify `.gitignore` ignores `mockups/` (it does — piece #1). Confirm the new shots land under `mockups/marketing-screens/companion/` and are untracked:

```
git status --short mockups/
```
Expected: nothing tracked under `mockups/` (the dir is ignored).

- [ ] **Step 4: Write the recipe README**

Create `apps/android/integration_test/marketing/README.md`:

```markdown
# Companion marketing screenshot capture (piece #1b)

Produces `mockups/marketing-screens/companion/<scene>.<theme>.png` — 5 scenes
(`library-home`, `player`, `settings`, `library-offline`, `pairing`) × light+dark
= 10 PNGs. Sibling of the web capture (piece #1). Posed demo data: the fictional
"The Hollow Tide" series + the real "The Coalfall Commission". No server, no
network, no real audio.

## One-time setup

1. Flutter + Android SDK on PATH; `adb` available.
2. A booted emulator (AVD). e.g.:
   - `flutter emulators` to list, `flutter emulators --launch <id>` to boot, or
   - Android Studio → Device Manager → ▶.
   Confirm with `adb devices` (one `emulator-xxxx  device`).
3. Brand covers in `brand/book-covers/` (git-ignored). The script pushes them to
   the app's external files dir; the app downscales them on-device. Filenames
   must match the `bookId`s in `lib/src/demo/demo_data.dart`:
   `hollow-tide-1.png`, `hollow-tide-2.png`, `hollow-tide-3.png`,
   `coalfall-commission.png`. Rename copies if needed.

## Run

From the repo root:

    npm run capture:companion

This pushes the covers and runs `flutter drive` once. Shots land in
`mockups/marketing-screens/companion/`.

## When features change

Add a screen → add a `Scene` to `integration_test/marketing/scenes.dart` and (if
it needs navigation) a branch in `integration_test/marketing_capture_test.dart`.
Re-run the capture. Update the demo content in `lib/src/demo/demo_data.dart`.

## Notes / troubleshooting

- **Black screenshots:** Android replaces the live surface on
  `convertFlutterSurfaceToImage()`. If frames come back black, split the capture
  into one scene per `testWidgets` (each converts + shoots once).
- **No status bar:** by design — `takeScreenshot()` captures the Flutter surface
  only. Crop/compose externally if a device frame is wanted.
- **App ID:** the push target uses the `applicationId` from
  `android/app/build.gradle`; keep `scripts/capture-companion.mjs` in sync if it
  changes.
```

- [ ] **Step 5: Verify the script fails fast without an emulator (smoke)**

From the repo root (with NO emulator running, or accept the covers/emulator guard firing):
```
node scripts/capture-companion.mjs
```
Expected: exits non-zero with a clear `✖ No running emulator…` (or `✖ No covers…`) message — proving the guards work. (A full successful run is operator-executed on a box with an emulator + covers.)

- [ ] **Step 6: Commit**

```bash
git add scripts/capture-companion.mjs package.json apps/android/integration_test/marketing/README.md .gitignore
git commit -m "feat(app): add capture:companion orchestrator + recipe"
```

---

## Task 9: Spec status + INDEX wiring

**Files:**
- Modify: `docs/superpowers/specs/2026-06-12-companion-marketing-capture-design.md` (status)
- Modify: `docs/features/INDEX.md` (if companion marketing belongs there) — otherwise skip with a note

- [ ] **Step 1: Mark the spec delivered**

In `docs/superpowers/specs/2026-06-12-companion-marketing-capture-design.md`, change the `**Status:**` line to:
```
**Status:** delivered (2026-06-12) — see plan `docs/superpowers/plans/2026-06-12-companion-marketing-capture.md`
```

- [ ] **Step 2: INDEX placement — skip (deterministic)**

This is capture/marketing tooling (git-ignored output under `mockups/`), not a
product feature with a regression plan under `docs/features/`. Like piece #1 (the
web capture, which added no `docs/features/INDEX.md` entry), it gets **none** —
the spec + the companion test suite are its record. Do nothing in this step.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-12-companion-marketing-capture-design.md
git commit -m "docs(docs): mark companion marketing capture spec delivered"
```

---

## Final verification

- [ ] From `apps/android/`: `flutter test` → all green (existing + new demo/ui tests).
- [ ] From `apps/android/`: `flutter analyze` → no issues.
- [ ] Operator run (box with emulator + covers): `npm run capture:companion` → 10 PNGs in `mockups/marketing-screens/companion/`, visually on-brand in both themes. **Audit dark across ALL screens** (incl. pairing, QR scan, "not paired", bootstrap-error) — `themeMode: system` ships dark to dark-mode users.
- [ ] Dispatch a final code-reviewer over the whole branch before finishing.
```
