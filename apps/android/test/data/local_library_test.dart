import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/file_store.dart';
import 'package:audiobook_companion/src/data/local_library.dart';

void main() {
  group('FileLocalLibrary', () {
    test('reports empty state for a fresh store', () async {
      final lib = FileLocalLibrary(InMemoryFileStore(), root: '/data');
      expect(await lib.syncedBookUpdatedAt(), isEmpty);
      expect(await lib.chapterFingerprints('b1'), isEmpty);
    });

    test('records a chapter + book updatedAt and reads them back', () async {
      final lib = FileLocalLibrary(InMemoryFileStore(), root: '/data');
      await lib.setBookUpdatedAt('b1', '2026-06-06T10:00:00Z');
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');
      await lib.recordChapter('b1', 'u2', 'fp2', 'audio.m4a');

      expect(await lib.syncedBookUpdatedAt(), {'b1': '2026-06-06T10:00:00Z'});
      expect(await lib.chapterFingerprints('b1'), {'u1': 'fp1', 'u2': 'fp2'});
    });

    test('persists across instances backed by the same store (durability)', () async {
      final fs = InMemoryFileStore();
      final a = FileLocalLibrary(fs, root: '/data');
      await a.setBookUpdatedAt('b1', 't');
      await a.recordChapter('b1', 'u1', 'fp1', 'audio.ogg');

      final b = FileLocalLibrary(fs, root: '/data');
      expect(await b.syncedBookUpdatedAt(), {'b1': 't'});
      expect(await b.chapterFingerprints('b1'), {'u1': 'fp1'});
    });

    test('audioPath derives the on-disk path from uuid + urlSuffix', () {
      final lib = FileLocalLibrary(InMemoryFileStore(), root: '/data');
      expect(lib.audioPath('b1', 'u1', 'audio.m4a'), '/data/books/b1/u1/audio.m4a');
    });

    test('evictChapter drops the metadata and deletes the chapter files', () async {
      final fs = InMemoryFileStore();
      final lib = FileLocalLibrary(fs, root: '/data');
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1, 2, 3]);

      await lib.evictChapter('b1', 'u1');

      expect(await lib.chapterFingerprints('b1'), isEmpty);
      expect(await fs.exists('/data/books/b1/u1/audio.mp3'), isFalse);
    });

    test('evictBook drops the metadata and deletes all the book files', () async {
      final fs = InMemoryFileStore();
      final lib = FileLocalLibrary(fs, root: '/data');
      await lib.setBookUpdatedAt('b1', 't');
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);

      await lib.evictBook('b1');

      expect(await lib.syncedBookUpdatedAt(), isEmpty);
      expect(await lib.chapterFingerprints('b1'), isEmpty);
      expect(await fs.exists('/data/books/b1/u1/audio.mp3'), isFalse);
    });
  });
}
