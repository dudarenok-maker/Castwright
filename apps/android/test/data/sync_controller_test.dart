import 'dart:io';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/chapter_downloader.dart';
import 'package:castwright/src/data/drift_local_library.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/library_database.dart';
import 'package:castwright/src/data/sync_controller.dart';
import 'package:castwright/src/data/sync_engine.dart';
import 'package:castwright/src/domain/sync_manifest.dart';

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

/// Simulates an unreachable server (offline).
class _ThrowingApi implements ManifestApi {
  @override
  Future<SyncManifestIndex> index({String? since}) async =>
      throw Exception('offline');
  @override
  Future<SyncManifestBookDetail> bookDetail(String bookId) async =>
      throw Exception('offline');
}

SyncManifestIndexBook idx(String id, String title) => SyncManifestIndexBook(
    bookId: id, updatedAt: 't', title: title, author: 'A', series: 'S',
    seriesPosition: 1, chapterCount: 1);

SyncManifestChapter ch(String book, String uuid, int id, String fp,
        {double? dur}) =>
    SyncManifestChapter(
      uuid: uuid, id: id, title: 'ch$id', fingerprint: fp, durationSec: dur,
      urlSuffix: 'audio.mp3', audioUrl: '/api/books/$book/chapters/$id/audio.mp3');

void main() {
  late InMemoryFileStore fs;
  late DriftLocalLibrary lib;

  SyncController make(
    ManifestApi api,
    Map<String, List<int>> serverBytes, {
    Future<List<double>> Function(String bookId, int chapterId)? peaksFetcher,
  }) {
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
      peaksFetcher: peaksFetcher,
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

  test('OFFLINE: ensureDetail synthesizes from the drift store + playlist works',
      () async {
    // Download online (records chapter id/title/duration in drift).
    final online = _FakeApi(
      SyncManifestIndex(schemaVersion: 1, books: [idx('b1', 'B')], activeBookIds: ['b1']),
      {
        'b1': SyncManifestBookDetail(
          schemaVersion: 1, bookId: 'b1', updatedAt: 't',
          chapters: [ch('b1', 'u1', 1, 'fp1|3', dur: 30)],
          activeChapterUuids: ['u1']),
      },
    );
    await make(online, {'/api/books/b1/chapters/1/audio.mp3': [1, 2, 3]})
        .downloadBook('b1');

    // New controller, server unreachable.
    final offline = make(_ThrowingApi(), {});
    await offline.ensureDetail('b1');
    final chs = offline.chaptersOf('b1');
    expect(chs.single.uuid, 'u1');
    expect(chs.single.title, 'ch1');
    expect(chs.single.durationSec, 30.0);
    expect(chs.single.hasAudio, isTrue);
    expect(offline.playlistFor('b1').single.path, '/d/books/b1/u1/audio.mp3');
  });

  test('OFFLINE: loadLocalLibrary lists downloaded books, all marked downloaded',
      () async {
    final online = _FakeApi(
      SyncManifestIndex(schemaVersion: 1, books: [idx('b1', 'B')], activeBookIds: ['b1']),
      {
        'b1': SyncManifestBookDetail(
          schemaVersion: 1, bookId: 'b1', updatedAt: 't',
          chapters: [ch('b1', 'u1', 1, 'fp1|3', dur: 30)],
          activeChapterUuids: ['u1']),
      },
    );
    final c = make(online, {'/api/books/b1/chapters/1/audio.mp3': [1, 2, 3]});
    await c.loadIndex(); // records book meta
    await c.downloadBook('b1');

    final local = await make(_ThrowingApi(), {}).loadLocalLibrary();
    expect(local.single.bookId, 'b1');
    expect(local.single.title, 'B');
  });

  // NOTE: this file's setUp builds `lib` at FS root '/d' (not '/data'), and
  // recordChapterMeta tolerates a missing audio file (bytes → 0). The peaks
  // policy doesn't depend on bytes, so these tests deliberately skip writing
  // audio fixtures.
  group('peaks policy', () {
    test('peaksFor returns persisted peaks without fetching', () async {
      var fetches = 0;
      final c = make(_ThrowingApi(), {}, peaksFetcher: (b, id) async {
        fetches++;
        return const [];
      });
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      await lib.savePeaks('u1', [0.25, 0.75]);

      expect(await c.peaksFor('b1', 'u1', 1), [0.25, 0.75]);
      expect(fetches, 0); // local hit → no server call
    });

    test('peaksFor fetches + persists when not local, then returns them', () async {
      final c = make(_ThrowingApi(), {},
          peaksFetcher: (b, id) async => [0.1, 0.2, 0.3]);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);

      expect(await c.peaksFor('b1', 'u1', 1), [0.1, 0.2, 0.3]);
      expect(await lib.loadPeaks('u1'), [0.1, 0.2, 0.3]); // persisted for next time
    });

    test('peaksFor returns empty when the fetcher throws (offline), never rethrows',
        () async {
      final c = make(_ThrowingApi(), {},
          peaksFetcher: (b, id) async => throw SocketException('offline'));
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      expect(await c.peaksFor('b1', 'u1', 1), isEmpty);
    });

    test('backfillMissingPeaks tolerates a throwing fetcher (offline) → 0, no throw',
        () async {
      final c = make(_ThrowingApi(), {},
          peaksFetcher: (b, id) async => throw SocketException('offline'));
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      expect(await c.backfillMissingPeaks(), 0);
    });

    test('downloadBook persists peaks for each downloaded chapter', () async {
      final detail = SyncManifestBookDetail(
        schemaVersion: 1, bookId: 'b1', updatedAt: 't1',
        chapters: [ch('b1', 'u1', 1, 'fp1', dur: 10)],
        activeChapterUuids: const ['u1'],
      );
      final api = _FakeApi(SyncManifestIndex(schemaVersion: 1, books: const [],
          activeBookIds: const ['b1']), {'b1': detail});
      final c = make(api, {'/api/books/b1/chapters/1/audio.mp3': [1, 2, 3]},
          peaksFetcher: (b, id) async => [0.4, 0.6]);

      await c.downloadBook('b1');
      expect(await lib.loadPeaks('u1'), [0.4, 0.6]);
    });

    test('backfillMissingPeaks fills missing, skips empties, returns count', () async {
      var calls = <int>[];
      final c = make(_ThrowingApi(), {}, peaksFetcher: (b, id) async {
        calls.add(id);
        return id == 1 ? [1.0, 0.5] : const []; // ch1 has peaks, ch2 doesn't
      });
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u2', chapterId: 2, title: 'Two',
          fingerprint: 'fp2', urlSuffix: 'audio.mp3', durationSec: 10);

      final filled = await c.backfillMissingPeaks();
      expect(filled, 1);
      expect(calls..sort(), [1, 2]); // both attempted
      expect(await lib.loadPeaks('u1'), [1.0, 0.5]);
      expect(await lib.loadPeaks('u2'), isNull);
      // second pass is a no-op: u1 now has peaks, u2 still returns empty
      expect(await c.backfillMissingPeaks(), 0);
    });

    test('backfillMissingPeaks is re-entrancy guarded (concurrent call is a no-op)',
        () async {
      var fetchCalls = 0;
      final c = make(_ThrowingApi(), {}, peaksFetcher: (b, id) async {
        fetchCalls++;
        return [0.5];
      });
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);

      // A Dart async body runs synchronously up to its first await, so `first`
      // claims the guard before `second` is invoked — deterministic, no timers.
      final first = c.backfillMissingPeaks();
      final second = await c.backfillMissingPeaks(); // guarded → no-op
      expect(second, 0);
      expect(await first, 1);
      expect(fetchCalls, 1); // only the first sweep actually fetched
    });
  });
}
