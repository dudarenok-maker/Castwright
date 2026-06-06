import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/drift_local_library.dart';
import 'package:audiobook_companion/src/data/file_store.dart';
import 'package:audiobook_companion/src/data/library_database.dart';

DriftLocalLibrary makeLib() => DriftLocalLibrary(
    LibraryDatabase(NativeDatabase.memory()), InMemoryFileStore(),
    root: '/data');

void main() {
  group('DriftLocalLibrary playback', () {
    test('saves and loads a per-book resume point', () async {
      final lib = makeLib();
      await lib.savePlayback('b1', 'u2', 5000, '2026-06-06T12:00:00Z');
      final p = await lib.loadPlayback('b1');
      expect(p, isNotNull);
      expect(p!.chapterUuid, 'u2');
      expect(p.positionMs, 5000);
      await lib.close();
    });

    test('overwrites the resume point for the same book', () async {
      final lib = makeLib();
      await lib.savePlayback('b1', 'u2', 5000, 't1');
      await lib.savePlayback('b1', 'u3', 9000, 't2');
      final p = await lib.loadPlayback('b1');
      expect(p!.chapterUuid, 'u3');
      expect(p.positionMs, 9000);
      await lib.close();
    });

    test('returns null for a book with no resume point', () async {
      final lib = makeLib();
      expect(await lib.loadPlayback('nope'), isNull);
      await lib.close();
    });
  });
}
