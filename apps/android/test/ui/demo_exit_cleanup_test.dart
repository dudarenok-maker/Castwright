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

/// A [FileStore] whose [deleteDir] always throws — proves cleanup swallows a
/// failing delete rather than propagating out of exit.
class _ThrowingFileStore extends InMemoryFileStore {
  @override
  Future<void> deleteDir(String path) async => throw StateError('boom');
}

void main() {
  // The cleanup half of `_exitDemo`. A full widget-driven exit deadlocks on
  // runtime dispose while LibraryHomeScreen is mounted (see the reference note),
  // so the leak-cleanup invariant is exercised through the extracted
  // `deleteDemoRoot` seam — the same helper `_exitDemo` calls.
  testWidgets('the demo leaves an on-disk root that cleanup removes; store untouched',
      (tester) async {
    const root = '/demo-test';
    final store = _SpyStore();
    final fs = InMemoryFileStore();

    await tester.pumpWidget(AudiobookCompanionApp(
      store: store,
      deepLinks: const Stream.empty(),
      demoRootResolver: () async => root,
      demoFileStore: fs,
      demoAssetLoader: _fakeAsset,
    ));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('try-demo')));
    await tester.pumpAndSettle();

    // The demo actually wrote its covers under the demo root — a real footprint.
    expect(await fs.exists('$root/covers/hollow-tide-1.png'), isTrue);

    // Cleanup removes everything under the root.
    await deleteDemoRoot(fs, root);
    expect(await fs.exists('$root/covers/hollow-tide-1.png'), isFalse);
    expect(await fs.exists('$root/covers/coalfall-commission.png'), isFalse);

    // Exiting never wrote the pairing keystore — the demo leaves no trace there.
    expect(store.saved, isFalse);
  });

  test('deleteDemoRoot is a no-op when the demo never started (null root)', () async {
    final fs = InMemoryFileStore();
    await fs.writeBytes('/keep/me.txt', const [1]);
    await deleteDemoRoot(fs, null);
    expect(await fs.exists('/keep/me.txt'), isTrue);
  });

  test('deleteDemoRoot swallows a failing deleteDir', () async {
    // A throwing delete must not propagate out of exit.
    await expectLater(deleteDemoRoot(_ThrowingFileStore(), '/demo-test'), completes);
  });
}
