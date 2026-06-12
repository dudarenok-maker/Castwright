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
