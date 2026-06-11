# Companion Pairing — ML Kit Decoder + Deep-Link Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Android companion app pair on a real Android 16 device by replacing the broken `flutter_zxing` decoder with Google ML Kit still-image decoding, and ship the app fully deep-link-ready (URL parser + `app_links` handler + `autoVerify` intent-filter) plus a stable release-signing key — without changing the live `CWP1` QR.

**Architecture:** `flutter_zxing`'s live/FFI decoder is removed. A new `QrScanScreen` takes a still image (camera capture or gallery pick via `image_picker`) and decodes it with `google_mlkit_barcode_scanning`. Both the image source and the decoder are injected behind typedefs so the screen logic is unit-testable and a decoder pivot is a one-file change. `PairingQr` learns to parse the future `https://castwright.ai/pair?h=&c=&f=` URL in addition to today's `CWP1*…`. An `app_links` listener in `HomePage` routes an incoming pair URL into a pre-filled `PairingScreen`. A manifest `autoVerify` App Link intent-filter and a stable release keystore make the deep-link a pure ops flip at launch (tracked as app-17 / #729).

**Tech Stack:** Flutter 3.44 / Dart 3.12, `google_mlkit_barcode_scanning`, `image_picker`, `app_links`, Android Gradle (Kotlin DSL), `flutter_test`.

---

## File Structure

- `apps/android/pubspec.yaml` — swap deps: remove `flutter_zxing`; add `google_mlkit_barcode_scanning`, `image_picker`, `app_links`.
- `apps/android/lib/src/domain/pairing_qr.dart` — add URL parsing alongside `CWP1`.
- `apps/android/lib/src/ui/qr_scan_screen.dart` — rewrite: still-image decode, injected `PickImage` + `BarcodeDecoder`.
- `apps/android/lib/src/ui/pairing_screen.dart` — add optional `initialQr` to pre-fill fields (used by the deep link).
- `apps/android/lib/main.dart` — `HomePage` listens to an injectable deep-link `Stream<Uri>` and opens a pre-filled `PairingScreen`.
- `apps/android/android/app/src/main/AndroidManifest.xml` — add the `autoVerify` App Link intent-filter.
- `apps/android/android/key.properties` (git-ignored, **user-created**) + release build — stable signing.
- Tests: `test/domain/pairing_qr_test.dart` (extend), `test/ui/qr_scan_screen_test.dart` (new), `test/ui/pairing_screen_initial_qr_test.dart` (new), `test/main_deep_link_test.dart` (new).
- `docs/features/208-pairing-qr-mlkit-decoder.md` — regression plan; `docs/features/INDEX.md` — entry.

> **Note on the `app/` scope & worktree:** all code changes are under `apps/android`. The branch `fix/app-pairing-mlkit-decoder` already exists and holds the spec. Implement on that branch.

---

## Task 1: Swap the scanner dependencies

**Files:**
- Modify: `apps/android/pubspec.yaml`

- [ ] **Step 1: Remove `flutter_zxing`, add the ML Kit + picker + deep-link deps**

In `apps/android/pubspec.yaml`, delete the `flutter_zxing` block (the lines with the long `# app-2 — … flutter_zxing` comment and `flutter_zxing: ^2.3.0`) and replace with:

```yaml
  # app-2 — scan the server pairing QR. zxing-cpp (flutter_zxing) could not decode
  # the QR on a real Android 16 device (confirmed 2026-06-11: valid QR, native lib
  # bundled, still 0 decodes). Decode a STILL image with Google ML Kit instead —
  # never the live-camera widget whose ML Kit lifecycle NPE'd on API 36.
  google_mlkit_barcode_scanning: ^0.14.1
  image_picker: ^1.1.2
  # app-2 (deep-link readiness) — receive the future https://castwright.ai/pair App Link.
  app_links: ^6.3.2
```

- [ ] **Step 2: Resolve dependencies**

Run: `cd apps/android && flutter pub get`
Expected: resolves with no version-conflict error. If a constraint conflicts, run `flutter pub get` output and pin the nearest compatible versions (do not change other deps).

- [ ] **Step 3: Confirm the old decoder is gone**

Run: `cd apps/android && grep -rn "flutter_zxing" lib pubspec.yaml || echo "clean"`
Expected: `clean` (no references remain; `qr_scan_screen.dart` is rewritten in Task 3).
Note: `lib` will not compile until Task 3 removes the `flutter_zxing` import — that is expected; do not build yet.

- [ ] **Step 4: Commit**

```bash
git add apps/android/pubspec.yaml apps/android/pubspec.lock
git commit -m "build(app): swap flutter_zxing for ML Kit + image_picker + app_links"
```

---

## Task 2: `PairingQr` parses the deep-link URL (keep `CWP1`)

**Files:**
- Modify: `apps/android/lib/src/domain/pairing_qr.dart`
- Test: `apps/android/test/domain/pairing_qr_test.dart`

- [ ] **Step 1: Add failing tests for URL parsing**

Append these tests inside `main()` in `test/domain/pairing_qr_test.dart`:

```dart
  test('parses the deep-link URL form (raw colon)', () {
    final qr = PairingQr.parse(
        'https://castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R');
    expect(qr.hostPort, '192.168.1.5:8443');
    expect(qr.baseUrl, 'https://192.168.1.5:8443');
    expect(qr.code, 'K7QF3M2P');
    expect(qr.fpTag, 'J4XQ2A7BWZ9K3M5R');
  });

  test('parses the deep-link URL form (percent-encoded colon)', () {
    final qr = PairingQr.parse(
        'https://castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R');
    expect(qr.hostPort, '192.168.1.5:8443');
  });

  test('rejects a URL missing a pairing field', () {
    expect(
        () => PairingQr.parse('https://castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P'),
        throwsFormatException);
  });

  test('rejects a non-pairing URL', () {
    expect(() => PairingQr.parse('https://example.com/'), throwsFormatException);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/android && flutter test test/domain/pairing_qr_test.dart`
Expected: the four new tests FAIL (current `parse` treats `https://…` as a non-`CWP1` string and throws on arity, or returns wrong fields).

- [ ] **Step 3: Implement URL parsing**

Replace the `factory PairingQr.parse` in `lib/src/domain/pairing_qr.dart` with a dispatcher that handles both forms:

```dart
  factory PairingQr.parse(String raw) {
    final trimmed = raw.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return PairingQr._fromUrl(trimmed);
    }
    return PairingQr._fromCwp1(trimmed);
  }

  /// Legacy/compact form: `CWP1*host:port*code*fpTag`.
  factory PairingQr._fromCwp1(String raw) {
    final parts = raw.split('*');
    if (parts.length != 4 || parts[0] != 'CWP1') {
      throw const FormatException('not a CWP1 pairing payload');
    }
    return PairingQr._checked(parts[1], parts[2], parts[3]);
  }

  /// Deep-link form: `https://castwright.ai/pair?h=host:port&c=code&f=fpTag`.
  factory PairingQr._fromUrl(String raw) {
    final uri = Uri.tryParse(raw);
    if (uri == null) throw const FormatException('unparseable pairing URL');
    final q = uri.queryParameters;
    return PairingQr._checked(q['h'] ?? '', q['c'] ?? '', q['f'] ?? '');
  }

  factory PairingQr._checked(String hostPort, String code, String fpTag) {
    if (hostPort.isEmpty || code.isEmpty || fpTag.isEmpty) {
      throw const FormatException('pairing payload has an empty field');
    }
    return PairingQr(hostPort: hostPort, code: code, fpTag: fpTag);
  }
```

(Keep the existing fields/constructor and `baseUrl` getter unchanged.)

- [ ] **Step 4: Run the full pairing-qr suite**

Run: `cd apps/android && flutter test test/domain/pairing_qr_test.dart`
Expected: PASS — both the original `CWP1` tests and the four new URL tests.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/pairing_qr.dart apps/android/test/domain/pairing_qr_test.dart
git commit -m "feat(app): parse the deep-link pairing URL alongside CWP1"
```

---

## Task 3: Rewrite `QrScanScreen` to decode a still image via ML Kit

**Files:**
- Modify (full rewrite): `apps/android/lib/src/ui/qr_scan_screen.dart`
- Test: `apps/android/test/ui/qr_scan_screen_test.dart`

- [ ] **Step 1: Write the rewritten screen with injected seams**

Replace the entire contents of `lib/src/ui/qr_scan_screen.dart` with:

```dart
import 'package:flutter/material.dart';
import 'package:google_mlkit_barcode_scanning/google_mlkit_barcode_scanning.dart';
import 'package:image_picker/image_picker.dart';

import '../domain/pairing_qr.dart';

/// Returns the decoded barcode strings found in the image at [imagePath].
typedef BarcodeDecoder = Future<List<String>> Function(String imagePath);

/// Returns a captured/selected image path, or null if the user cancelled.
typedef PickImage = Future<String?> Function(ImageSource source);

/// Scans the desktop pairing QR from a STILL image (app-2). zxing-cpp could not
/// decode the QR on a real Android 16 device; ML Kit can, and a still image
/// avoids the live-camera ML Kit lifecycle that NPE'd on API 36. Both the image
/// source and the decoder are injected so the screen logic is unit-testable and
/// the decoder is swappable in one place.
class QrScanScreen extends StatefulWidget {
  QrScanScreen({super.key, BarcodeDecoder? decode, PickImage? pickImage})
      : decode = decode ?? mlkitDecodeQr,
        pickImage = pickImage ?? _defaultPickImage;

  final BarcodeDecoder decode;
  final PickImage pickImage;

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _scanFrom(ImageSource source) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final path = await widget.pickImage(source);
      if (path == null) {
        if (mounted) setState(() => _busy = false); // cancelled
        return;
      }
      final raws = await widget.decode(path);
      for (final raw in raws) {
        try {
          final qr = PairingQr.parse(raw);
          if (mounted) Navigator.of(context).pop(qr);
          return;
        } on FormatException {
          // a barcode, but not a pairing payload — try the next one
        }
      }
      if (mounted) {
        setState(() {
          _busy = false;
          _error = 'No Castwright pairing code found in that image. '
              'Try again, or enter the code manually.';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = "Couldn't read that image ($e). "
              'Try again, or enter the code manually.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan pairing code')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Point your phone at the QR on the desktop and take a photo, '
              'or pick a screenshot of it.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              key: const Key('scan-camera'),
              onPressed: _busy ? null : () => _scanFrom(ImageSource.camera),
              icon: const Icon(Icons.photo_camera),
              label: const Text('Take a photo of the QR'),
              style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(48)),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              key: const Key('scan-gallery'),
              onPressed: _busy ? null : () => _scanFrom(ImageSource.gallery),
              icon: const Icon(Icons.image),
              label: const Text('Choose a screenshot'),
              style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(48)),
            ),
            const SizedBox(height: 16),
            if (_busy) const Center(child: CircularProgressIndicator()),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _error!,
                  key: const Key('scan-error'),
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Default decoder: Google ML Kit, QR format only, on a still image file.
Future<List<String>> mlkitDecodeQr(String imagePath) async {
  final scanner = BarcodeScanner(formats: [BarcodeFormat.qrCode]);
  try {
    final barcodes =
        await scanner.processImage(InputImage.fromFilePath(imagePath));
    return [for (final b in barcodes) b.rawValue]
        .whereType<String>()
        .toList();
  } finally {
    await scanner.close();
  }
}

Future<String?> _defaultPickImage(ImageSource source) async {
  final x = await ImagePicker().pickImage(source: source);
  return x?.path;
}
```

- [ ] **Step 2: Write the screen-logic tests (fake picker + decoder)**

Create `apps/android/test/ui/qr_scan_screen_test.dart`:

```dart
import 'package:castwright/src/domain/pairing_qr.dart';
import 'package:castwright/src/ui/qr_scan_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';

/// Pumps QrScanScreen behind a launcher button and captures the popped result.
Future<void> _pumpScanner(
  WidgetTester tester, {
  required PickImage pickImage,
  required BarcodeDecoder decode,
  required void Function(PairingQr?) onResult,
}) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            child: const Text('open'),
            onPressed: () async {
              final qr = await Navigator.of(context).push<PairingQr>(
                MaterialPageRoute(
                  builder: (_) =>
                      QrScanScreen(pickImage: pickImage, decode: decode),
                ),
              );
              onResult(qr);
            },
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('valid QR pops a PairingQr', (tester) async {
    PairingQr? result;
    var resolved = false;
    await _pumpScanner(
      tester,
      pickImage: (_) async => '/fake/qr.png',
      decode: (_) async =>
          ['CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R'],
      onResult: (qr) {
        result = qr;
        resolved = true;
      },
    );
    await tester.tap(find.byKey(const Key('scan-camera')));
    await tester.pumpAndSettle();
    expect(resolved, isTrue);
    expect(result?.code, 'K7QF3M2P');
  });

  testWidgets('a non-pairing barcode shows an error and stays open',
      (tester) async {
    await _pumpScanner(
      tester,
      pickImage: (_) async => '/fake/qr.png',
      decode: (_) async => ['https://example.com/not-a-pair'],
      onResult: (_) {},
    );
    await tester.tap(find.byKey(const Key('scan-camera')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scan-error')), findsOneWidget);
    expect(find.byKey(const Key('scan-camera')), findsOneWidget); // still open
  });

  testWidgets('no barcode in the image shows an error', (tester) async {
    await _pumpScanner(
      tester,
      pickImage: (_) async => '/fake/qr.png',
      decode: (_) async => <String>[],
      onResult: (_) {},
    );
    await tester.tap(find.byKey(const Key('scan-camera')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scan-error')), findsOneWidget);
  });

  testWidgets('cancelling the picker is a no-op (no error)', (tester) async {
    await _pumpScanner(
      tester,
      pickImage: (_) async => null,
      decode: (_) async => <String>[],
      onResult: (_) {},
    );
    await tester.tap(find.byKey(const Key('scan-camera')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scan-error')), findsNothing);
  });
}
```

- [ ] **Step 3: Run the scanner tests**

Run: `cd apps/android && flutter test test/ui/qr_scan_screen_test.dart`
Expected: PASS (4 tests). If `castwright` package name differs, match the import prefix used by the existing `test/domain/pairing_qr_test.dart` (it imports `package:castwright/...`).

- [ ] **Step 4: Fix the now-stale `const QrScanScreen()` call site**

`QrScanScreen`'s constructor is no longer `const` (it assigns `?? mlkitDecodeQr`/`?? _defaultPickImage`). In `lib/src/ui/pairing_screen.dart`, the `_scan()` method pushes `const QrScanScreen()` — remove the `const`:

```dart
      MaterialPageRoute(builder: (_) => QrScanScreen()),
```

- [ ] **Step 5: Run the scanner tests + analyzer**

Run: `cd apps/android && flutter test test/ui/qr_scan_screen_test.dart && flutter analyze lib/src/ui/pairing_screen.dart`
Expected: tests PASS; no analyzer error about `const` on a non-const constructor.

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/ui/qr_scan_screen.dart apps/android/lib/src/ui/pairing_screen.dart apps/android/test/ui/qr_scan_screen_test.dart
git commit -m "feat(app): decode pairing QR from a still image via ML Kit"
```

---

## Task 4: `PairingScreen` accepts an `initialQr` to pre-fill fields

**Files:**
- Modify: `apps/android/lib/src/ui/pairing_screen.dart`
- Test: `apps/android/test/ui/pairing_screen_initial_qr_test.dart`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/ui/pairing_screen_initial_qr_test.dart`:

```dart
import 'package:castwright/src/domain/pairing_qr.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/ui/pairing_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _NoopStore implements PairingStore {
  @override
  Future<void> clear() async {}
  @override
  Future<PairedServer?> load() async => null;
  @override
  Future<String?> loadCaPem() async => null;
  @override
  Future<void> save(PairedServer server) async {}
  @override
  Future<void> saveCaPem(String caPem) async {}
}

void main() {
  testWidgets('initialQr pre-fills the host/code/fingerprint fields',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: PairingScreen(
        service: PairingService(),
        store: _NoopStore(),
        initialQr: const PairingQr(
            hostPort: '192.168.1.5:8443',
            code: 'K7QF3M2P',
            fpTag: 'J4XQ2A7BWZ9K3M5R'),
      ),
    ));
    expect(find.text('192.168.1.5:8443'), findsOneWidget);
    expect(find.text('K7QF3M2P'), findsOneWidget);
    expect(find.text('J4XQ2A7BWZ9K3M5R'), findsOneWidget);
  });
}
```

> If `PairingStore` is an abstract class with a different member set, mirror its actual interface in `_NoopStore` (open `lib/src/data/pairing_store.dart` to confirm). The point is a no-op store.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/android && flutter test test/ui/pairing_screen_initial_qr_test.dart`
Expected: FAIL — `PairingScreen` has no `initialQr` parameter (compile error).

- [ ] **Step 3: Add the `initialQr` parameter and pre-fill in `initState`**

In `lib/src/ui/pairing_screen.dart`:

1. Add the field + constructor param:
```dart
class PairingScreen extends StatefulWidget {
  const PairingScreen(
      {super.key, required this.service, required this.store, this.initialQr});

  final PairingService service;
  final PairingStore store;

  /// When opened from a deep link, pre-fills the form for review before pairing.
  final PairingQr? initialQr;
```
2. Add `initState` to the state class (it currently has none) to seed the controllers:
```dart
  @override
  void initState() {
    super.initState();
    final qr = widget.initialQr;
    if (qr != null) {
      _host.text = qr.hostPort;
      _code.text = qr.code;
      _fpTag.text = qr.fpTag;
    }
  }
```
(`import '../domain/pairing_qr.dart';` is already present.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd apps/android && flutter test test/ui/pairing_screen_initial_qr_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/ui/pairing_screen.dart apps/android/test/ui/pairing_screen_initial_qr_test.dart
git commit -m "feat(app): pre-fill PairingScreen from an initialQr"
```

---

## Task 5: Route an incoming deep link into a pre-filled `PairingScreen`

**Files:**
- Modify: `apps/android/lib/main.dart`
- Test: `apps/android/test/main_deep_link_test.dart`

- [ ] **Step 1: Make the deep-link source injectable on `HomePage`**

In `lib/main.dart`:

1. Add the import:
```dart
import 'package:app_links/app_links.dart';
import 'src/domain/pairing_qr.dart';
```
2. Add an injectable `Stream<Uri>` to `AudiobookCompanionApp` and `HomePage` (defaulting to `AppLinks().uriLinkStream`), threading it through `build`:
```dart
class AudiobookCompanionApp extends StatelessWidget {
  const AudiobookCompanionApp(
      {super.key,
      required this.store,
      this.service,
      this.audioHandler,
      this.deepLinks});

  final PairingStore store;
  final PairingService? service;
  final CompanionAudioHandler? audioHandler;

  /// Injectable so widget tests can drive App Links without the platform channel.
  final Stream<Uri>? deepLinks;
```
In `build`, pass `deepLinks: deepLinks` to `HomePage(...)`.
```dart
class HomePage extends StatefulWidget {
  const HomePage(
      {super.key,
      required this.store,
      required this.service,
      this.audioHandler,
      this.deepLinks});

  final PairingStore store;
  final PairingService service;
  final CompanionAudioHandler? audioHandler;
  final Stream<Uri>? deepLinks;
```

- [ ] **Step 2: Subscribe in `initState` and open the pre-filled pairing screen**

Add to `_HomePageState` (and cancel the subscription in `dispose`). The default
platform stream merges the **cold-start** initial link (app launched *by* the App
Link) with the **warm** stream, so both paths flow through one subscription:

```dart
  StreamSubscription<Uri>? _deepLinkSub;

  /// Cold-start initial link first, then the live warm stream. Injected in tests.
  Stream<Uri> _platformDeepLinks() async* {
    final appLinks = AppLinks();
    final initial = await appLinks.getInitialLink();
    if (initial != null) yield initial;
    yield* appLinks.uriLinkStream;
  }

  void _listenDeepLinks() {
    final stream = widget.deepLinks ?? _platformDeepLinks();
    _deepLinkSub = stream.listen(_handleDeepLink, onError: (_) {});
  }

  void _handleDeepLink(Uri uri) {
    final PairingQr qr;
    try {
      qr = PairingQr.parse(uri.toString());
    } on FormatException {
      return; // not a pairing link — ignore
    }
    _openPairing(initialQr: qr);
  }
```

Wire it in `initState`:
```dart
  @override
  void initState() {
    super.initState();
    _boot();
    _listenDeepLinks();
  }

  @override
  void dispose() {
    _deepLinkSub?.cancel();
    super.dispose();
  }
```

Add `import 'dart:async';` at the top of `main.dart`.

- [ ] **Step 3: Make `_openPairing` accept an optional `initialQr`**

Change the existing `_openPairing` signature + push:
```dart
  Future<void> _openPairing({PairingQr? initialQr}) async {
    final result = await Navigator.of(context).push<PairedServer>(
      MaterialPageRoute(
        builder: (_) => PairingScreen(
            service: widget.service,
            store: widget.store,
            initialQr: initialQr),
      ),
    );
    if (result != null && mounted) {
      _paired = result;
      await _boot();
    }
  }
```
(The existing `onPressed: _openPairing` button reference still type-checks because all params are optional — but Flutter passes the tap's bool; change it to `onPressed: () => _openPairing()` to avoid passing an argument.)

- [ ] **Step 4: Write the deep-link routing test**

Create `apps/android/test/main_deep_link_test.dart`:

```dart
import 'dart:async';

import 'package:castwright/main.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _NoopStore implements PairingStore {
  @override
  Future<void> clear() async {}
  @override
  Future<PairedServer?> load() async => null;
  @override
  Future<String?> loadCaPem() async => null;
  @override
  Future<void> save(PairedServer server) async {}
  @override
  Future<void> saveCaPem(String caPem) async {}
}

void main() {
  testWidgets('a pair deep link opens a pre-filled pairing screen',
      (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _NoopStore(),
      service: PairingService(),
      deepLinks: links.stream,
    ));
    await tester.pumpAndSettle(); // boots to "Not paired yet"

    links.add(Uri.parse(
        'https://castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'));
    await tester.pumpAndSettle();

    // The pairing screen is now on top with the fields pre-filled.
    expect(find.text('192.168.1.5:8443'), findsOneWidget);
    expect(find.text('K7QF3M2P'), findsOneWidget);
  });

  testWidgets('a non-pairing deep link is ignored', (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _NoopStore(),
      service: PairingService(),
      deepLinks: links.stream,
    ));
    await tester.pumpAndSettle();

    links.add(Uri.parse('https://example.com/'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('home-status')), findsOneWidget); // still home
    expect(find.text('192.168.1.5:8443'), findsNothing);
  });
}
```

- [ ] **Step 5: Run the deep-link tests**

Run: `cd apps/android && flutter test test/main_deep_link_test.dart`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the whole Dart test suite**

Run: `cd apps/android && flutter test`
Expected: PASS — all existing + new tests green.

- [ ] **Step 7: Commit**

```bash
git add apps/android/lib/main.dart apps/android/test/main_deep_link_test.dart
git commit -m "feat(app): route an incoming pair deep link into a pre-filled pairing screen"
```

---

## Task 6: Declare the App Link intent-filter (dormant until launch)

**Files:**
- Modify: `apps/android/android/app/src/main/AndroidManifest.xml`

- [ ] **Step 1: Add the `autoVerify` intent-filter to `MainActivity`**

Inside the `<activity android:name=".MainActivity" …>` element, after the existing `MAIN`/`LAUNCHER` `<intent-filter>`, add:

```xml
            <!-- app-2 deep-link readiness (app-17 lights it up at launch): the
                 phone's stock camera auto-opens the app from the pairing QR once
                 https://castwright.ai/.well-known/assetlinks.json pins this app's
                 release-signing SHA-256. Dormant (no auto-verify) until then. -->
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW"/>
                <category android:name="android.intent.category.DEFAULT"/>
                <category android:name="android.intent.category.BROWSABLE"/>
                <data android:scheme="https"
                      android:host="castwright.ai"
                      android:pathPrefix="/pair"/>
            </intent-filter>
```

- [ ] **Step 2: Verify the manifest still parses (debug build)**

Run: `cd apps/android && flutter build apk --debug`
Expected: BUILD SUCCESSFUL (manifest merges cleanly). If the build box can't build Android, defer this verification to Task 8's build gate and note it.

- [ ] **Step 3: Commit**

```bash
git add apps/android/android/app/src/main/AndroidManifest.xml
git commit -m "feat(app): declare autoVerify App Link intent-filter for castwright.ai/pair"
```

---

## Task 7: Establish stable release signing (operational — user-run)

**Files:**
- Create (user, git-ignored): `apps/android/android/key.properties`
- Create (user, git-ignored, stored securely OUTSIDE the repo): the keystore `.jks`

> The Gradle wiring already exists (`build.gradle.kts` reads `android/key.properties`,
> falls back to debug otherwise; `android/.gitignore` already ignores `key.properties`,
> `*.jks`, `*.keystore`). This task only creates the secrets and records the SHA. **The
> assistant must NOT generate or store these secrets** — hand the commands to the user.

- [ ] **Step 1: User generates the upload keystore**

Ask the user to run (PowerShell, in their own terminal — choose a path OUTSIDE the repo, e.g. `C:\Users\dudar\.castwright-keys\`):

```
keytool -genkeypair -v -keystore C:\Users\dudar\.castwright-keys\castwright-upload.jks `
  -keyalg RSA -keysize 4096 -validity 10000 -alias castwright
```
They choose + record the store/key passwords in their password manager.

- [ ] **Step 2: User creates `apps/android/android/key.properties`** (git-ignored)

```properties
storePassword=<store password>
keyPassword=<key password>
keyAlias=castwright
storeFile=C:/Users/dudar/.castwright-keys/castwright-upload.jks
```

- [ ] **Step 3: Build a release-signed APK and confirm it is NOT debug-signed**

Run: `cd apps/android && flutter build apk --release`
Then verify the signer:
```
keytool -printcert -jarfile build/app/outputs/flutter-apk/app-release.apk
```
Expected: the certificate `Owner`/`SHA256` is the new `castwright` key — **not** `CN=Android Debug`.

- [ ] **Step 4: Record the SHA-256 into app-17 (#729)**

Copy the `SHA256:` line from Step 3. Add it to issue #729 as the value to pin in
`assetlinks.json` (format ML Kit/Play wants — colon-separated hex). Comment on the issue:

```bash
gh issue comment 729 --body "Release-signing SHA-256 to pin in assetlinks.json (package ai.castwright): <SHA256 hex>"
```

- [ ] **Step 5: Commit (no secrets — only confirm none leaked)**

```bash
git status --porcelain apps/android/android
# MUST show nothing under key.properties / *.jks (they are git-ignored).
git commit --allow-empty -m "chore(app): release signing established (keystore held off-repo; SHA recorded in #729)"
```

---

## Task 8: Platform gates — alignment, plugin compat, build, size

**Files:** none (verification task). Record findings in the regression plan (Task 9).

- [ ] **Step 1: Build the release APK (full plugin set)**

Run: `cd apps/android && flutter build apk --release`
Expected: BUILD SUCCESSFUL. If ML Kit bumps AGP/Play Services and conflicts with `drift`/`audio_service`/`flutter_foreground_task`, resolve by pinning compatible plugin versions (smallest change) and re-run.

- [ ] **Step 2: Verify 16 KB page alignment of the new native libs**

Run (lists the ELF alignment of bundled `.so` files):
```bash
cd apps/android && unzip -l build/app/outputs/flutter-apk/app-release.apk | grep -E "lib/arm64-v8a/.*\.so"
```
Then for the ML Kit lib specifically, confirm 16 KB alignment with the NDK tool if available:
```bash
# Requires Android NDK on PATH; otherwise note as a manual on-device check.
# zipalign -c -P 16 -v 4 build/app/outputs/flutter-apk/app-release.apk
```
Expected: app loads on the Android 16 device in Task 9 with no `UnsatisfiedLinkError`. If alignment fails, bump `google_mlkit_barcode_scanning` to the latest patch (newer releases ship 16 KB-aligned libs) and re-build.

- [ ] **Step 3: Note the APK size delta**

Run: `ls -la apps/android/build/app/outputs/flutter-apk/app-release.apk`
Record the size vs. the pre-change 71,930,031 bytes for the regression plan.

- [ ] **Step 4: Copy the verified APK to `companion/`**

```bash
cp apps/android/build/app/outputs/flutter-apk/app-release.apk companion/castwright-companion.apk
```

- [ ] **Step 5: Commit the refreshed companion APK**

```bash
git add companion/castwright-companion.apk companion/castwright-companion.apk.sha1 2>/dev/null || git add companion/castwright-companion.apk
git commit -m "build(app): refresh companion APK with the ML Kit pairing decoder"
```

---

## Task 9: On-device acceptance — the hard gate

**Files:** none (manual, recorded in the regression plan).

> This is the step the original bug existed for lack of. Do NOT mark the work done
> until every check here is green on the real Android 16 device.

- [ ] **Step 1: Install the release-signed APK**

With the phone on USB (`adb devices` shows it):
```bash
adb install -r companion/castwright-companion.apk
```
Expected: `Success`. If `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (signer changed from the old debug key), `adb uninstall ai.castwright` first, then re-install.

- [ ] **Step 2: In-app scan pairs end-to-end (the fix)**

On the desktop, open *Pair a device* (LAN HTTPS running). In the app: *Pair a device → Scan QR → Take a photo* of the desktop QR (or *Choose a screenshot*).
Expected: the form pre-fills, *Pair* succeeds, the app reaches the library. This is the acceptance the merged redesign never got.

- [ ] **Step 3: ML Kit did not crash**

While Step 2 runs: `adb logcat | grep -iE "mlkit|barcode|FATAL|AndroidRuntime"`
Expected: no `FATAL`/NPE from ML Kit. If it NPEs → **pivot:** swap `mlkitDecodeQr` for a `zxing2` (pure-Dart) implementation behind the same `BarcodeDecoder` typedef (one-file change in `qr_scan_screen.dart`), rebuild, retry. Manual entry remains available throughout.

- [ ] **Step 4: Deep-link handler works (pre-hosting, simulated)**

```bash
adb shell am start -W -a android.intent.action.VIEW \
  -d "https://castwright.ai/pair?h=<lan-ip>:8443&c=<fresh-code>&f=<fpTag>" ai.castwright
```
Expected: the app opens the pairing screen pre-filled; pairing with a fresh code succeeds. (Stock-camera auto-open is verified later under app-17 once `assetlinks.json` is hosted.)

- [ ] **Step 5: Record results in the regression plan** (Task 10), including the logcat snippet and APK size.

---

## Task 10: Regression plan + index + PR

**Files:**
- Create: `docs/features/208-pairing-qr-mlkit-decoder.md`
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: Write the regression plan**

Create `docs/features/208-pairing-qr-mlkit-decoder.md` from `docs/features/TEMPLATE.md`, with: the root-cause summary (zxing can't decode on Android 16 — evidence), the ML Kit still-image fix, the deep-link readiness (dormant until app-17), the release-signing setup, and a **Manual acceptance walkthrough** mirroring Task 9 (record the on-device result + logcat + APK size delta). Add frontmatter `status: active`. Link the spec `docs/superpowers/specs/2026-06-11-pairing-qr-mlkit-decoder-design.md` and app-17 (#729).

- [ ] **Step 2: Add the INDEX entry**

In `docs/features/INDEX.md`, add `208-pairing-qr-mlkit-decoder.md` under the companion-app (app-*) area.

- [ ] **Step 3: Commit**

```bash
git add docs/features/208-pairing-qr-mlkit-decoder.md docs/features/INDEX.md
git commit -m "docs(app): regression plan for the ML Kit pairing decoder"
```

- [ ] **Step 4: Open a draft PR**

```bash
gh pr create --draft \
  --title "fix(app): pair via ML Kit still-image decode + deep-link readiness" \
  --body "$(cat <<'EOF'
## Summary
zxing-cpp could not decode the pairing QR on a real Android 16 device (confirmed:
valid QR, current APK, native lib bundled). Replace the decoder with Google ML Kit
still-image decode (camera capture / gallery), behind an injectable seam. Ship the
app fully deep-link-ready (URL `PairingQr` parser + `app_links` handler + `autoVerify`
intent-filter) and establish stable release signing. The live `CWP1` QR is unchanged;
the server payload flip + `assetlinks.json` hosting are the launch flip tracked in app-17 (#729).

## Test plan
- `cd apps/android && flutter test` — all green (pairing_qr URL+CWP1, scanner logic, initialQr, deep-link routing).
- On-device acceptance (Android 16): in-app scan pairs end-to-end; no ML Kit NPE (logcat); adb-simulated deep-link intent pairs.

Refs #729. Spec: docs/superpowers/specs/2026-06-11-pairing-qr-mlkit-decoder-design.md
Regression plan: docs/features/208-pairing-qr-mlkit-decoder.md
EOF
)"
```

- [ ] **Step 5: Verify + promote when green**

Run the on-device gate (Task 9). When green and `flutter test` passes, `gh pr ready <n>`.

---

## Self-Review notes (for the implementer)

- **Spec coverage:** decoder swap (T1,T3), URL parser keeping CWP1 (T2), deep-link handler + intent-filter (T5,T6), release signing (T7), 16 KB/compat/size gates (T8), on-device hard gate (T9), docs (T10). app-17 (server flip + hosting) intentionally NOT here.
- **Decoder pivot insurance:** every native decode path is behind `BarcodeDecoder` (T3) — a `zxing2` swap is one function (T9 Step 3).
- **Naming consistency:** `BarcodeDecoder`, `PickImage`, `mlkitDecodeQr`, `initialQr`, `deepLinks` are used identically across tasks.
- **No server/frontend changes** in this plan by design (decision: app-only).
</content>
