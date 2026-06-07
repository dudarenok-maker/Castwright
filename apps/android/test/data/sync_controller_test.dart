import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/chapter_downloader.dart';
import 'package:audiobook_companion/src/data/drift_local_library.dart';
import 'package:audiobook_companion/src/data/file_store.dart';
import 'package:audiobook_companion/src/data/library_database.dart';
import 'package:audiobook_companion/src/data/sync_controller.dart';
import 'package:audiobook_companion/src/data/sync_engine.dart';
import 'package:audiobook_companion/src/domain/sync_manifest.dart';

class _FakeApi implements ManifestApi {
  _FakeApi(this.indexValue, this.details);
  final SyncManifestIndex indexValue;
  final Map<String, SyncManifestBookDetail> details;
  @override
  Future<SyncManifestIndex> index({String? since}) async => indexValue;
  @override
  Future<SyncManifestBookDetail> bookDetail(String bookId) async =>
      details[bookId]!;
}

SyncManifestIndexBook idx(String id, String title) => SyncManifestIndexBook(
    bookId: id, updatedAt: 't', title: title, author: 'A', series: 'S',
    seriesPosition: 1, chapterCount: 1);

SyncManifestChapter ch(String book, String uuid, int id, String fp) =>
    SyncManifestChapter(
      uuid: uuid, id: id, title: 'ch$id', fingerprint: fp,
      urlSuffix: 'audio.mp3', audioUrl: '/api/books/$book/chapters/$id/audio.mp3');

void main() {
  late InMemoryFileStore fs;
  late DriftLocalLibrary lib;

  SyncController make(_FakeApi api, Map<String, List<int>> serverBytes) {
    final downloader = ChapterDownloader(
      (url, headers) async =>
          RangeResponse(statusCode: 200, body: Stream.value(serverBytes[url.path]!)),
      fs,
      delay: (_) async {},
    );
    return SyncController(
      manifestApi: api,
      localLibrary: lib,
      chapterDownloader: downloader,
      urlResolver: (p) => Uri.parse('https://s$p'),
    );
  }

  setUp(() {
    fs = InMemoryFileStore();
    lib = DriftLocalLibrary(LibraryDatabase(NativeDatabase.memory()), fs, root: '/d');
  });

  test('loadIndex records book metadata for the library (no downloads)', () async {
    final api = _FakeApi(
      SyncManifestIndex(schemaVersion: 1, books: [idx('b1', 'Book One')], activeBookIds: ['b1']),
      const {},
    );
    final books = await make(api, {}).loadIndex();
    expect(books.single.title, 'Book One');
    final listed = await lib.listBooks();
    expect(listed.single.title, 'Book One');
    // no chapters downloaded
    expect(await lib.chapterFingerprints('b1'), isEmpty);
  });

  test('downloadBook pulls the book\'s chapters and records them', () async {
    final api = _FakeApi(
      SyncManifestIndex(schemaVersion: 1, books: [idx('b1', 'B')], activeBookIds: ['b1']),
      {
        'b1': SyncManifestBookDetail(
          schemaVersion: 1, bookId: 'b1', updatedAt: 't',
          chapters: [ch('b1', 'u1', 1, 'fp1|3'), ch('b1', 'u2', 2, 'fp2|2')],
          activeChapterUuids: ['u1', 'u2'],
        ),
      },
    );
    final c = make(api, {
      '/api/books/b1/chapters/1/audio.mp3': [1, 2, 3],
      '/api/books/b1/chapters/2/audio.mp3': [4, 5],
    });
    final progress = <String>[];
    await c.downloadBook('b1', onProgress: (d, t) => progress.add('$d/$t'));

    expect(await fs.read('/d/books/b1/u1/audio.mp3'), [1, 2, 3]);
    expect(await lib.chapterFingerprints('b1'), {'u1': 'fp1|3', 'u2': 'fp2|2'});
    expect(progress.last, '2/2');
    expect(await c.isBookDownloaded('b1'), isTrue);
  });

  test('re-downloading after a regen pulls only the changed chapter', () async {
    // First sync.
    final api1 = _FakeApi(
      SyncManifestIndex(schemaVersion: 1, books: [idx('b1', 'B')], activeBookIds: ['b1']),
      {
        'b1': SyncManifestBookDetail(
          schemaVersion: 1, bookId: 'b1', updatedAt: 't1',
          chapters: [ch('b1', 'u1', 1, 'fp1|3'), ch('b1', 'u2', 2, 'fp2|2')],
          activeChapterUuids: ['u1', 'u2']),
      },
    );
    await make(api1, {
      '/api/books/b1/chapters/1/audio.mp3': [1, 2, 3],
      '/api/books/b1/chapters/2/audio.mp3': [4, 5],
    }).downloadBook('b1');

    // ch1 regenerated (fp changed); ch2 unchanged.
    final api2 = _FakeApi(
      api1.indexValue,
      {
        'b1': SyncManifestBookDetail(
          schemaVersion: 1, bookId: 'b1', updatedAt: 't2',
          chapters: [ch('b1', 'u1', 1, 'fp1b|4'), ch('b1', 'u2', 2, 'fp2|2')],
          activeChapterUuids: ['u1', 'u2']),
      },
    );
    var downloaded = 0;
    await make(api2, {'/api/books/b1/chapters/1/audio.mp3': [9, 9, 9, 9]})
        .downloadBook('b1', onProgress: (d, t) => downloaded = t);
    expect(downloaded, 1); // only the changed chapter
    expect(await fs.read('/d/books/b1/u1/audio.mp3'), [9, 9, 9, 9]);
  });
}
