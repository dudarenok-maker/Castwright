import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/chapter_downloader.dart';
import 'package:castwright/src/data/companion_runtime.dart';
import 'package:castwright/src/data/cover_thumbnails.dart';
import 'package:castwright/src/data/drift_local_library.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/library_database.dart';
import 'package:castwright/src/data/player_controller.dart';
import 'package:castwright/src/data/resume_sync_service.dart';
import 'package:castwright/src/data/settings_store.dart';
import 'package:castwright/src/data/sync_controller.dart';
import 'package:castwright/src/demo/demo_audio_engine.dart';
import 'package:castwright/src/demo/demo_http_send.dart';
import 'package:castwright/src/domain/app_settings.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/domain/sleep_timer.dart';
import 'package:castwright/src/ui/library_home_screen.dart';
import 'package:castwright/src/data/pairing_service.dart' show Connection;

/// A [ListenProgressApi] that does nothing — no server in tests.
class _NoopProgressApi implements ListenProgressApi {
  @override
  Future<RemoteProgress?> getListenProgress(String bookId) async => null;
  @override
  Future<void> putListenProgress(String bookId,
      {required int chapterId,
      required double currentSec,
      required String listenedAt}) async {}
}

/// Build a minimal [CompanionRuntime] backed by the given in-memory library.
/// The sync is configured offline (manifest returns 503) so [loadLibrary]
/// throws and the screen falls back to local data — no real network needed.
Future<CompanionRuntime> _buildTestRuntime(DriftLocalLibrary library) async {
  const connection = Connection(
    server: PairedServer(
        url: 'https://studio.local:8443', token: 'demo-token', caFingerprint: 'f'),
    caPem: 'demo-placeholder-ca-pem',
  );
  // offline: true → manifest endpoint returns 503 → loadLibrary throws.
  final api = ApiClient(connection, send: demoHttpSend(offline: true));
  final fs = InMemoryFileStore();

  final sync = SyncController(
    manifestApi: api.manifestApi,
    localLibrary: library,
    chapterDownloader: ChapterDownloader(
      (Uri url, Map<String, String> headers) async =>
          throw const DownloadException('test runtime never downloads'),
      fs,
    ),
    urlResolver: (path) => Uri.parse('${connection.server.url}$path'),
  );

  final player = PlayerController(
    audioEngine: DemoAudioEngine(),
    playbackStore: library,
    playlistLoader: (bookId) async => sync.playlistFor(bookId),
    clock: () => DateTime.fromMillisecondsSinceEpoch(0),
  );

  // ThumbnailCache with a throwing fetcher — _loadCovers in the screen catches
  // all errors, so a missing cover just shows the placeholder icon.
  final thumbnails = ThumbnailCache(
    fs: fs,
    store: library,
    fetch: (bookId) async => throw StateError('no cover in test'),
    root: '/t',
  );

  final settingsStore = SettingsStore(fs, path: '/t/settings.json');
  const settings = AppSettings.defaults;

  final resumeSync = ResumeSyncService(
    progressApi: _NoopProgressApi(),
    playbackStore: library,
    chapterIdResolver: (bookId, uuid) async => null,
  );

  final sleepTimer = SleepTimer(onExpire: () {});

  // ignore: invalid_use_of_visible_for_testing_member
  return CompanionRuntime.forDemo(
    api: api,
    library: library,
    sync: sync,
    player: player,
    thumbnails: thumbnails,
    settingsStore: settingsStore,
    settings: settings,
    resumeSync: resumeSync,
    sleepTimer: sleepTimer,
  );
}

const _server = PairedServer(
    url: 'https://studio.local:8443', token: 'demo-token', caFingerprint: 'f');

void main() {
  testWidgets('long-press shelf card removes the book from Continue listening',
      (tester) async {
    // Build an in-memory library seeded with one book that has lastPlayedAt set
    // so it appears in the "Continue listening" rail.
    final library = DriftLocalLibrary(
        LibraryDatabase(NativeDatabase.memory()), InMemoryFileStore(),
        root: '/t');

    await library.upsertBookMeta(
        bookId: 'b1',
        title: 'Test Book',
        author: 'Author A',
        series: '',
        seriesPosition: null);

    // markPlayed sets lastPlayedAt → makes the book appear in the Continue rail.
    await library.markPlayed('b1', '2026-06-20T12:00:00Z');

    final rt = await _buildTestRuntime(library);
    addTearDown(rt.dispose);

    await tester.pumpWidget(MaterialApp(
      home: LibraryHomeScreen(
        runtime: rt,
        server: _server,
        onUnpair: () async {},
      ),
    ));
    await tester.pumpAndSettle();

    // The Continue rail must show the shelf card for b1.
    expect(find.byKey(const Key('continue-b1')), findsOneWidget);

    // Long-press the card → the bottom sheet appears.
    await tester.longPress(find.byKey(const Key('continue-b1')));
    await tester.pumpAndSettle();

    // Tap the remove action in the bottom sheet.
    await tester.tap(find.text('Remove from Continue listening'));
    await tester.pumpAndSettle();

    // The book must be hidden in the library and the card must be gone from the
    // UI after _refresh() rebuilds the Continue rail.
    expect((await rt.library.listBooks()).single.hidden, isTrue);
    expect(find.byKey(const Key('continue-b1')), findsNothing);

    await library.close();
  });
}
