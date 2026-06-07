import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/chapter_downloader.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/local_library.dart';
import 'package:castwright/src/data/sync_engine.dart';
import 'package:castwright/src/domain/sync_manifest.dart';

/// Fake manifest API: canned index + per-book detail, with a per-book throw to
/// exercise failure isolation.
class _FakeApi implements ManifestApi {
  _FakeApi({required this.indexValue, required this.details, this.throwForBook});
  final SyncManifestIndex indexValue;
  final Map<String, SyncManifestBookDetail> details;
  final String? throwForBook;

  @override
  Future<SyncManifestIndex> index({String? since}) async => indexValue;

  @override
  Future<SyncManifestBookDetail> bookDetail(String bookId) async {
    if (bookId == throwForBook) throw Exception('detail boom for $bookId');
    return details[bookId]!;
  }
}

/// Fake byte server keyed by URL path.
RangeFetch fetchFrom(Map<String, List<int>> byPath) =>
    (Uri url, Map<String, String> headers) async =>
        RangeResponse(statusCode: 200, body: Stream.value(byPath[url.path]!));

SyncManifestIndexBook idxBook(String id, String updatedAt) =>
    SyncManifestIndexBook(
      bookId: id,
      updatedAt: updatedAt,
      title: id,
      author: '',
      series: '',
      seriesPosition: null,
      chapterCount: 0,
    );

SyncManifestChapter ch(String bookId, String uuid, int id, String fp, int size) =>
    SyncManifestChapter(
      uuid: uuid,
      id: id,
      title: 'ch$id',
      fingerprint: fp,
      urlSuffix: 'audio.mp3',
      audioUrl: '/api/books/$bookId/chapters/$id/audio.mp3',
    );

SyncManifestBookDetail bookDetail(
        String bookId, String updatedAt, List<SyncManifestChapter> chapters) =>
    SyncManifestBookDetail(
      schemaVersion: 1,
      bookId: bookId,
      updatedAt: updatedAt,
      chapters: chapters,
      activeChapterUuids: chapters.map((c) => c.uuid).toList(),
    );

SyncEngine engine(
  ManifestApi api,
  FileStore fs,
  LocalLibrary lib,
  Map<String, List<int>> bytes, {
  bool Function(String uuid)? isInUse,
}) {
  final downloader = ChapterDownloader(fetchFrom(bytes), fs, delay: (_) async {});
  return SyncEngine(
    api: api,
    library: lib,
    downloader: downloader,
    resolveUrl: (p) => Uri.parse('https://s$p'),
    isInUse: isInUse,
  );
}

void main() {
  group('SyncEngine', () {
    test('fresh sync downloads every chapter and records state', () async {
      final fs = InMemoryFileStore();
      final lib = FileLocalLibrary(fs, root: '/data');
      final api = _FakeApi(
        indexValue: SyncManifestIndex(
          schemaVersion: 1,
          books: [idxBook('b1', 't1')],
          activeBookIds: ['b1'],
        ),
        details: {
          'b1': bookDetail('b1', 't1', [
            ch('b1', 'u1', 1, 'fp1', 3),
            ch('b1', 'u2', 2, 'fp2', 2),
          ]),
        },
      );
      final bytes = {
        '/api/books/b1/chapters/1/audio.mp3': [1, 2, 3],
        '/api/books/b1/chapters/2/audio.mp3': [4, 5],
      };

      final result = await engine(api, fs, lib, bytes).sync();

      expect(result.chaptersDownloaded, 2);
      expect(result.errors, isEmpty);
      expect(await fs.read('/data/books/b1/u1/audio.mp3'), [1, 2, 3]);
      expect(await fs.read('/data/books/b1/u2/audio.mp3'), [4, 5]);
      expect(await lib.syncedBookUpdatedAt(), {'b1': 't1'});
      expect(await lib.chapterFingerprints('b1'), {'u1': 'fp1', 'u2': 'fp2'});
    });

    test('re-sync after a regen pulls ONLY the one changed chapter', () async {
      final fs = InMemoryFileStore();
      final lib = FileLocalLibrary(fs, root: '/data');
      // Local state from a prior sync: both chapters present.
      await lib.setBookUpdatedAt('b1', 't1');
      await lib.recordChapter('b1', 'u1', 'fp1', 'audio.mp3');
      await lib.recordChapter('b1', 'u2', 'fp2', 'audio.mp3');
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1, 2, 3]);
      await fs.writeBytes('/data/books/b1/u2/audio.mp3', [4, 5]);

      // Server regenerated chapter 1 (fp1 -> fp1b); chapter 2 unchanged.
      final api = _FakeApi(
        indexValue: SyncManifestIndex(
          schemaVersion: 1,
          books: [idxBook('b1', 't2')],
          activeBookIds: ['b1'],
        ),
        details: {
          'b1': bookDetail('b1', 't2', [
            ch('b1', 'u1', 1, 'fp1b', 4),
            ch('b1', 'u2', 2, 'fp2', 2),
          ]),
        },
      );
      final bytes = {
        '/api/books/b1/chapters/1/audio.mp3': [9, 9, 9, 9],
      };

      final result = await engine(api, fs, lib, bytes).sync();

      expect(result.chaptersDownloaded, 1); // ONLY the changed chapter
      expect(await fs.read('/data/books/b1/u1/audio.mp3'), [9, 9, 9, 9]);
      expect(await lib.chapterFingerprints('b1'), {'u1': 'fp1b', 'u2': 'fp2'});
    });

    test('evicts a book deleted server-side via the active-id diff', () async {
      final fs = InMemoryFileStore();
      final lib = FileLocalLibrary(fs, root: '/data');
      await lib.setBookUpdatedAt('b1', 't1');
      await lib.setBookUpdatedAt('b2', 't1');
      await lib.recordChapter('b2', 'u9', 'fp', 'audio.mp3');
      await fs.writeBytes('/data/books/b2/u9/audio.mp3', [1]);

      final api = _FakeApi(
        indexValue: SyncManifestIndex(
          schemaVersion: 1,
          books: const [], // nothing changed
          activeBookIds: ['b1'], // b2 is gone
        ),
        details: const {},
      );

      final result = await engine(api, fs, lib, {}).sync();

      expect(result.booksEvicted, 1);
      expect((await lib.syncedBookUpdatedAt()).keys, ['b1']);
      expect(await fs.exists('/data/books/b2/u9/audio.mp3'), isFalse);
    });

    test('defers the swap when the chapter file is in use (player open)', () async {
      final fs = InMemoryFileStore();
      final lib = FileLocalLibrary(fs, root: '/data');
      final api = _FakeApi(
        indexValue: SyncManifestIndex(
          schemaVersion: 1,
          books: [idxBook('b1', 't1')],
          activeBookIds: ['b1'],
        ),
        details: {
          'b1': bookDetail('b1', 't1', [ch('b1', 'u1', 1, 'fp1', 3)]),
        },
      );
      final bytes = {
        '/api/books/b1/chapters/1/audio.mp3': [1, 2, 3],
      };

      final result =
          await engine(api, fs, lib, bytes, isInUse: (u) => u == 'u1').sync();

      expect(result.chaptersDeferred, 1);
      expect(result.chaptersDownloaded, 0);
      // Verified bytes wait in the .tmp; the live file is untouched.
      expect(await fs.read('/data/books/b1/u1/audio.mp3.tmp'), [1, 2, 3]);
      expect(await fs.exists('/data/books/b1/u1/audio.mp3'), isFalse);
      // Not recorded + book not marked synced, so a later sync re-applies it.
      expect(await lib.chapterFingerprints('b1'), isEmpty);
      expect(await lib.syncedBookUpdatedAt(), isEmpty);
    });

    test('isolates a per-book failure and still syncs the other books', () async {
      final fs = InMemoryFileStore();
      final lib = FileLocalLibrary(fs, root: '/data');
      final api = _FakeApi(
        indexValue: SyncManifestIndex(
          schemaVersion: 1,
          books: [idxBook('b1', 't1'), idxBook('b2', 't1')],
          activeBookIds: ['b1', 'b2'],
        ),
        details: {
          'b2': bookDetail('b2', 't1', [ch('b2', 'u1', 1, 'fp1', 1)]),
        },
        throwForBook: 'b1',
      );
      final bytes = {
        '/api/books/b2/chapters/1/audio.mp3': [7],
      };

      final result = await engine(api, fs, lib, bytes).sync();

      expect(result.errors.keys, contains('b1'));
      expect(result.chaptersDownloaded, 1); // b2 still synced
      expect(await lib.chapterFingerprints('b2'), {'u1': 'fp1'});
      expect((await lib.syncedBookUpdatedAt()).containsKey('b1'), isFalse);
    });

    test('emits progress events ending with a done phase', () async {
      final fs = InMemoryFileStore();
      final lib = FileLocalLibrary(fs, root: '/data');
      final api = _FakeApi(
        indexValue: SyncManifestIndex(
          schemaVersion: 1,
          books: [idxBook('b1', 't1')],
          activeBookIds: ['b1'],
        ),
        details: {
          'b1': bookDetail('b1', 't1', [ch('b1', 'u1', 1, 'fp1', 1)]),
        },
      );
      final eng = engine(api, fs, lib, {
        '/api/books/b1/chapters/1/audio.mp3': [1],
      });
      final events = <SyncProgress>[];
      final sub = eng.progress.listen(events.add);

      await eng.sync();
      await Future<void>.delayed(Duration.zero);
      await sub.cancel();

      expect(events, isNotEmpty);
      expect(events.last.phase, SyncPhase.done);
    });
  });
}
