import 'dart:async';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/drift_local_library.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/library_database.dart';

void main() {
  group('companion_runtime book-completed wiring', () {
    test('book-completed marks the book finished (ticks all + hides)', () async {
      // Arrange: a DriftLocalLibrary (memory) with book 'b1' + 2 chapters.
      final library = DriftLocalLibrary(
          LibraryDatabase(NativeDatabase.memory()), InMemoryFileStore(),
          root: '/t');
      await library.upsertBookMeta(
          bookId: 'b1',
          title: 'T',
          author: 'A',
          series: '',
          seriesPosition: null);
      await library.recordChapterMeta(
          bookId: 'b1',
          uuid: 'u1',
          chapterId: 1,
          title: 'One',
          fingerprint: 'fp',
          urlSuffix: 'audio.mp3',
          durationSec: 10);
      await library.recordChapterMeta(
          bookId: 'b1',
          uuid: 'u2',
          chapterId: 2,
          title: 'Two',
          fingerprint: 'fp',
          urlSuffix: 'audio.mp3',
          durationSec: 10);

      // Act: the exact listener body used in companion_runtime.
      final completed = StreamController<String>.broadcast();
      final sub = completed.stream
          .listen((bookId) => library.markBookFinished(bookId));
      completed.add('b1');
      await Future<void>.delayed(Duration.zero);

      // Assert: the book is hidden and both chapters are ticked.
      expect((await library.listBooks()).single.hidden, isTrue);
      expect((await library.finishedChapterUuids('b1')).length, 2);

      await sub.cancel();
      await completed.close();
      await library.close();
    });
  });
}
