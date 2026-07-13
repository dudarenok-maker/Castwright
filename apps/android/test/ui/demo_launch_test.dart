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
