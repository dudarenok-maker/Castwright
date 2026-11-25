import 'dart:io';

import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/chapter_downloader.dart';
import 'package:castwright/src/data/companion_runtime.dart'
    show probeServerReachable;
import 'package:castwright/src/data/drift_local_library.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/library_database.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/data/sync_controller.dart';
import 'package:castwright/src/data/sync_engine.dart' show ManifestApi;
import 'package:castwright/src/data/listen_stats_service.dart' show StatDay;
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/domain/sync_manifest.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

/// Offline manifest transport: forces [SyncController.ensureDetail] onto its
/// local-library fallback, whose synthesized `audioUrl` is the only Dart-side
/// statement of the chapter-audio shape (row 5).
class _OfflineApi implements ManifestApi {
  @override
  Future<SyncManifestIndex> index({String? since}) async =>
      throw Exception('offline');
  @override
  Future<SyncManifestBookDetail> bookDetail(String bookId) async =>
      throw Exception('offline');
}

const _bookId = 'book-1';
const _chapterId = 7;

/// #898 PR A (plan Task A-T4, R2 / the Dart half of M2): the device-scoped token
/// is only honoured on nine `(method, path-shape)` pairs. This drives the
/// companion call sites it lists against a recording transport and pins exactly
/// those nine, so a renamed path or a changed method on one of those call sites
/// goes red here instead of 403ing on the phone. It does NOT discover new
/// endpoints: a new `ApiClient` method or `getJson('/api/...')` caller is never
/// exercised, so adding one stays green until it is listed here by hand.
void main() {
  late HttpServer server;
  late List<String> recorded; // 'METHOD /normalised/path'

  String shape(String method, String path) {
    final p = path
        .replaceAll(_bookId, '{id}')
        .replaceAll('/chapters/$_chapterId/', '/chapters/{cid}/');
    return '$method $p';
  }

  /// Hook the recorder reads. No test swaps it; the `hasLength(9)` floor below
  /// is what fails if it silently discards (verified by hand, not in the suite).
  void Function(String method, String path) record = (m, p) {};

  setUp(() async {
    recorded = [];
    record = (m, p) => recorded.add(shape(m, p));
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      record(req.method, req.uri.path);
      await req.drain<void>();
      final res = req.response;
      res.statusCode = 200;
      res.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
      res.write('{}');
      await res.close();
    });
  });

  tearDown(() async => server.close(force: true));

  Connection conn() => Connection(
        server: PairedServer(
            url: 'http://127.0.0.1:${server.port}',
            token: 'tok',
            caFingerprint: 'f'),
        caPem: 'PEM',
      );

  Future<void> swallow(Future<void> Function() f) async {
    try {
      await f();
    } catch (_) {
      // Bodies are `{}`: parse failures are irrelevant, only the request is.
    }
  }

  test('the companion calls exactly the nine endpoints the server allowlist mirrors',
      () async {
    // Rows 1, 2, 4, 6: JSON GETs through an injected `send:` recorder.
    final sendApi = ApiClient(conn(), send: (method, url, headers) async {
      record(method, url.path);
      return const HttpResult(200, '{}');
    });
    // Rows 3, 5, 7, 8, 9: the real dart:io transports, against a plaintext
    // loopback server that records what actually hit the wire.
    final httpApi =
        ApiClient(conn(), httpClientFactory: (_) => HttpClient());

    // 1. GET /api/info (the live caller is the AutoSync probe, not info()).
    await probeServerReachable(sendApi, onRepairNeeded: () {});
    // 2. GET /api/library/sync-manifest (index and per-book detail; one shape).
    await swallow(() => sendApi.syncManifestIndex());
    await swallow(() => sendApi.syncManifestBookDetail(_bookId));
    // 3. GET /api/books/{id}/cover. The path is typed here and mirrors the
    //    `ThumbnailCache.fetch` closure in `CompanionRuntime.forConnection`;
    //    that closure is not reachable from a test (forConnection needs
    //    path_provider, the audio engine and a real database), so a path change
    //    there is NOT caught by this row.
    await swallow(() => httpApi.getBytes('/api/books/$_bookId/cover'));
    // 4. GET /api/books/{id}/chapters/{cid}/audio (waveform peaks JSON).
    await sendApi.getChapterPeaks(_bookId, _chapterId);
    // 5. GET /api/books/{id}/chapters/{cid}/audio.<ext>: the URL comes from the
    //    REAL offline fallback in SyncController.ensureDetail (not typed here),
    //    then is fetched with the real download transport.
    final fs = InMemoryFileStore();
    final lib = DriftLocalLibrary(
        LibraryDatabase(NativeDatabase.memory()), fs,
        root: '/d');
    await lib.recordChapterMeta(
      bookId: _bookId,
      uuid: 'u1',
      chapterId: _chapterId,
      title: 'ch',
      fingerprint: 'fp',
      urlSuffix: 'audio.mp3',
    );
    final sync = SyncController(
      manifestApi: _OfflineApi(),
      localLibrary: lib,
      chapterDownloader: ChapterDownloader(
          (url, headers) async =>
              RangeResponse(statusCode: 200, body: const Stream.empty()),
          fs,
          delay: (_) async {}),
      urlResolver: (p) => Uri.parse('${conn().server.url}$p'),
    );
    await sync.ensureDetail(_bookId);
    final audioPath = sync.chaptersOf(_bookId).single.audioUrl!;
    final res = await httpApi.pinnedRangeFetch()(
        Uri.parse('${conn().server.url}$audioPath'), const {});
    await res.body.drain<void>();
    // 6. GET /api/books/{id}/listen-progress
    await swallow(() => httpApi.getListenProgress(_bookId));
    await swallow(() => sendApi.getListenProgress(_bookId));
    // 7. PUT /api/books/{id}/listen-progress
    await httpApi.putListenProgress(_bookId,
        chapterId: _chapterId, currentSec: 1.5, listenedAt: 't');
    // 8. PUT /api/books/{id}/listen-stats
    await httpApi.putListenStats(_bookId,
        sessionId: 's', days: [StatDay(date: '2026-01-01', seconds: 5)]);
    // 9. POST /api/books/{id}/shelf-status (the only id that is URL-encoded)
    await httpApi.setShelfStatus(_bookId, finished: true);

    final distinctShapes = recorded.toSet();

    // Anti-vacuity floor: exactly nine distinct shapes, no extra, none missing.
    expect(distinctShapes, hasLength(9),
        reason: 'the recorder must see exactly the nine allowlisted shapes');

    // Coupled to server/src/device-scope.ts (arrives with PR B, chain B), the
    // exact-equality nine-row allowlist; the two lists are coupled by review.
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('GET /api/info'),
        reason: 'row 1');
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('GET /api/library/sync-manifest'),
        reason: 'row 2');
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('GET /api/books/{id}/cover'),
        reason: 'row 3');
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('GET /api/books/{id}/chapters/{cid}/audio'),
        reason: 'row 4');
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('GET /api/books/{id}/chapters/{cid}/audio.mp3'),
        reason: 'row 5');
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('GET /api/books/{id}/listen-progress'),
        reason: 'row 6');
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('PUT /api/books/{id}/listen-progress'),
        reason: 'row 7');
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('PUT /api/books/{id}/listen-stats'),
        reason: 'row 8');
    // Coupled to server/src/device-scope.ts — change both or the phone 403s.
    expect(distinctShapes, contains('POST /api/books/{id}/shelf-status'),
        reason: 'row 9');

    await sendApi.dispose();
    await httpApi.dispose();
  });
}
