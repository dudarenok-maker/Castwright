import 'dart:convert';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/drift_local_library.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/library_database.dart';
import 'package:castwright/src/domain/storage_policy.dart';

DriftLocalLibrary makeLib(FileStore fs) =>
    DriftLocalLibrary(LibraryDatabase(NativeDatabase.memory()), fs, root: '/data');

void main() {
  group('DriftLocalLibrary (LocalLibrary port)', () {
    test('records chapters + book updatedAt and reads them back', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      // The downloaded file exists on disk before recording.
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1, 2, 3]);
      await lib.setBookUpdatedAt('b1', '2026-06-06T10:00:00Z');
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');

      expect(await lib.syncedBookUpdatedAt(), {'b1': '2026-06-06T10:00:00Z'});
      expect(await lib.chapterFingerprints('b1'), {'u1': 'fp1'});
      await lib.close();
    });

    test('recordChapterMeta persists id/title/duration for offline + orders by id', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u2/audio.mp3', [1, 2]);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [3, 4]);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u2', chapterId: 2, title: 'Two',
          fingerprint: 'fp2', urlSuffix: 'audio.mp3', durationSec: 120.5);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 60.0);

      final chs = await lib.chaptersForBook('b1');
      expect(chs.map((c) => c.uuid), ['u1', 'u2']); // ordered by chapterId
      expect(chs.first.title, 'One');
      expect(chs.last.durationSec, 120.5);
      await lib.close();
    });

    test('recordChapterMeta preserves the finished flag on re-download', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      await lib.setChapterFinished('u1', true);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1b', urlSuffix: 'audio.mp3', durationSec: 11);

      final usage = await lib.bookUsages();
      expect(usage.single.chapters.single.finished, isTrue);
      await lib.close();
    });

    test('clearAllBooks evicts every book + its files', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);
      await fs.writeBytes('/data/books/b2/u1/audio.mp3', [2]);
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');
      await lib.recordChapter('b2', 'u1', 'fp2', 'audio.mp3');
      expect((await lib.listBooks()).length, 2);

      await lib.clearAllBooks();
      expect(await lib.listBooks(), isEmpty);
      expect(await fs.read('/data/books/b1/u1/audio.mp3'), isNull);
      await lib.close();
    });

    test('recordChapter stats the on-disk file for byte accounting', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', List.filled(500, 7));
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');

      final usages = await lib.bookUsages();
      expect(usages.single.chapters.single.bytes, 500);
      await lib.close();
    });

    test('audioPath matches the app-3 path scheme', () async {
      final lib = makeLib(InMemoryFileStore());
      expect(lib.audioPath('b1', 'u1', 'audio.m4a'), '/data/books/b1/u1/audio.m4a');
      await lib.close();
    });

    test('evictChapter deletes the file and forgets the chapter', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');

      await lib.evictChapter('b1', 'u1');
      expect(await lib.chapterFingerprints('b1'), isEmpty);
      expect(await fs.exists('/data/books/b1/u1/audio.mp3'), isFalse);
      await lib.close();
    });

    test('evictBook deletes all files and forgets the book + chapters', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await lib.setBookUpdatedAt('b1', 't');
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');

      await lib.evictBook('b1');
      expect(await lib.syncedBookUpdatedAt(), isEmpty);
      expect(await lib.chapterFingerprints('b1'), isEmpty);
      expect(await fs.exists('/data/books/b1/u1/audio.mp3'), isFalse);
      await lib.close();
    });

    test('savePeaks + loadPeaks round-trips; loadPeaks is null when unsaved', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);

      expect(await lib.loadPeaks('u1'), isNull); // nothing saved yet
      await lib.savePeaks('u1', [0.0, 0.5, 1.0]);
      expect(await lib.loadPeaks('u1'), [0.0, 0.5, 1.0]);
      await lib.close();
    });

    test('chaptersMissingPeaks returns only audio chapters (chapterId>0) lacking peaks', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);
      await fs.writeBytes('/data/books/b1/u2/audio.mp3', [2]);
      // u1: has audio, no peaks → SHOULD appear.
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      // u2: has audio + peaks already → SHOULD NOT appear.
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u2', chapterId: 2, title: 'Two',
          fingerprint: 'fp2', urlSuffix: 'audio.mp3', durationSec: 10);
      await lib.savePeaks('u2', [1.0]);
      // u3: legacy/sync-engine row with chapterId 0 (no usable peaks URL) →
      // SHOULD NOT appear (excluded by the chapterId > 0 filter).
      await fs.writeBytes('/data/books/b1/u3/audio.mp3', [3]);
      await lib.recordChapter('b1', 'u3', 'fp3', 'audio.mp3'); // chapterId 0

      final missing = await lib.chaptersMissingPeaks();
      expect(missing.map((c) => c.uuid), ['u1']);
      expect(missing.single.bookId, 'b1');
      expect(missing.single.chapterId, 1);
      await lib.close();
    });
  });

  group('DriftLocalLibrary (app-4 store)', () {
    test('markPlayed and setChapterFinished surface in bookUsages', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1, 2]);
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');
      await lib.markPlayed('b1', '2026-06-06T12:00:00Z');
      await lib.setChapterFinished('u1', true);

      final usage = (await lib.bookUsages()).single;
      expect(usage.lastPlayedAt, '2026-06-06T12:00:00Z');
      expect(usage.chapters.single.finished, isTrue);
      await lib.close();
    });

    test('applyEviction drops a chapter file (keeps row) and evicts a book', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1, 2, 3]);
      await fs.writeBytes('/data/books/b2/u9/audio.mp3', [9]);
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');
      await lib.setBookUpdatedAt('b1', 't');
      await lib.recordChapter('b2', 'u9', 'fp9', 'audio.mp3');
      await lib.setBookUpdatedAt('b2', 't');

      await lib.applyEviction(const EvictionPlan(
        chapterFilesToDrop: [ChapterRef('b1', 'u1')],
        booksToEvict: ['b2'],
      ));

      // b1/u1 file gone but the row stays (fingerprint cleared, bytes 0).
      expect(await fs.exists('/data/books/b1/u1/audio.mp3'), isFalse);
      expect(await lib.chapterFingerprints('b1'), {'u1': ''});
      final b1 = (await lib.bookUsages()).firstWhere((b) => b.bookId == 'b1');
      expect(b1.chapters.single.bytes, 0);
      // b2 fully gone.
      expect(await fs.exists('/data/books/b2/u9/audio.mp3'), isFalse);
      expect((await lib.syncedBookUpdatedAt()).containsKey('b2'), isFalse);
      await lib.close();
    });

    test('listBooks returns display metadata set via upsertBookMeta', () async {
      final lib = makeLib(InMemoryFileStore());
      await lib.upsertBookMeta(
        bookId: 'b1',
        title: 'Title',
        author: 'Author',
        series: 'Saga',
        seriesPosition: 3,
      );
      final books = await lib.listBooks();
      expect(books.single.bookId, 'b1');
      expect(books.single.title, 'Title');
      expect(books.single.author, 'Author');
      expect(books.single.series, 'Saga');
      expect(books.single.seriesPosition, 3);
      await lib.close();
    });

    test('cover thumbnail path round-trips', () async {
      final lib = makeLib(InMemoryFileStore());
      await lib.setBookUpdatedAt('b1', 't');
      await lib.setCoverThumbPath('b1', '/data/thumbs/b1.jpg');
      expect(await lib.coverThumbPath('b1'), '/data/thumbs/b1.jpg');
      await lib.close();
    });

    test('totalBytes sums all chapter bytes', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', List.filled(100, 1));
      await fs.writeBytes('/data/books/b2/u2/audio.mp3', List.filled(250, 1));
      await lib.recordChapter('b1', 'u1', 'fp', 'audio.mp3');
      await lib.recordChapter('b2', 'u2', 'fp', 'audio.mp3');
      expect(await lib.totalBytes(), 350);
      await lib.close();
    });
  });

  group('DriftLocalLibrary (Android Auto browse support)', () {
    test('mostRecentlyPlayedBookId returns the book with the latest playback updatedAt',
        () async {
      final lib = makeLib(InMemoryFileStore());
      await lib.savePlayback('b1', 'u1', 1000, '2026-06-10T10:00:00Z');
      await lib.savePlayback('b2', 'u2', 2000, '2026-06-12T09:00:00Z');
      await lib.savePlayback('b3', 'u3', 500, '2026-06-11T08:00:00Z');

      expect(await lib.mostRecentlyPlayedBookId(), 'b2');
      await lib.close();
    });

    test('mostRecentlyPlayedBookId is null when nothing has been played', () async {
      final lib = makeLib(InMemoryFileStore());
      expect(await lib.mostRecentlyPlayedBookId(), isNull);
      await lib.close();
    });

    test('chaptersForBook exposes downloaded bytes — 0 after a file is evicted',
        () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', List.filled(300, 1));
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp', urlSuffix: 'audio.mp3');

      expect((await lib.chaptersForBook('b1')).single.bytes, 300);

      // Eviction drops the file but keeps the row at bytes=0 — must read as 0.
      await lib.applyEviction(const EvictionPlan(
        chapterFilesToDrop: [ChapterRef('b1', 'u1')],
        booksToEvict: [],
      ));
      expect((await lib.chaptersForBook('b1')).single.bytes, 0);
      await lib.close();
    });
  });

  group('DriftLocalLibrary (player cues)', () {
    test('finishedChapterUuids returns only chapters flagged finished', () async {
      final lib = DriftLocalLibrary(
          LibraryDatabase(NativeDatabase.memory()), InMemoryFileStore(),
          root: '/t');
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'demo|10', urlSuffix: 'audio.mp3', durationSec: 100);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u2', chapterId: 2, title: 'Two',
          fingerprint: 'demo|10', urlSuffix: 'audio.mp3', durationSec: 100);
      await lib.recordChapterMeta(
          bookId: 'b2', uuid: 'u3', chapterId: 1, title: 'Other',
          fingerprint: 'demo|10', urlSuffix: 'audio.mp3', durationSec: 100);

      await lib.setChapterFinished('u1', true);
      await lib.setChapterFinished('u3', true); // different book

      expect(await lib.finishedChapterUuids('b1'), {'u1'});
    });
  });

  group('DriftLocalLibrary legacy JSON import', () {
    test('imports an app-3 sync-state.json then deletes it', () async {
      final fs = InMemoryFileStore();
      // Seed the app-3 JSON snapshot shape.
      final legacy = {
        'books': {
          'b1': {
            'updatedAt': '2026-06-06T10:00:00Z',
            'chapters': {
              'u1': {'fingerprint': 'fp1', 'urlSuffix': 'audio.mp3'},
            },
          },
        },
      };
      await fs.writeBytes('/data/sync-state.json', utf8.encode(jsonEncode(legacy)));
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1, 2, 3, 4]);

      final lib = makeLib(fs);
      await lib.importLegacyJsonIfPresent();

      expect(await lib.syncedBookUpdatedAt(), {'b1': '2026-06-06T10:00:00Z'});
      expect(await lib.chapterFingerprints('b1'), {'u1': 'fp1'});
      // bytes picked up from the on-disk file.
      expect((await lib.bookUsages()).single.chapters.single.bytes, 4);
      // The legacy file is removed so the import runs once.
      expect(await fs.exists('/data/sync-state.json'), isFalse);
      await lib.close();
    });

    test('is a no-op when there is no legacy file', () async {
      final lib = makeLib(InMemoryFileStore());
      await lib.importLegacyJsonIfPresent(); // must not throw
      expect(await lib.syncedBookUpdatedAt(), isEmpty);
      await lib.close();
    });
  });
}
