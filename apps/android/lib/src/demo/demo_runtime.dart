import 'package:drift/native.dart';

import '../data/api_client.dart';
import '../data/chapter_downloader.dart';
import '../data/companion_runtime.dart';
import '../data/cover_thumbnails.dart';
import '../data/drift_local_library.dart';
import '../data/file_store.dart';
import '../data/library_database.dart';
import '../data/pairing_service.dart' show Connection;
import '../data/player_controller.dart';
import '../data/resume_sync_service.dart';
import '../data/settings_store.dart';
import '../data/sync_controller.dart';
import '../domain/app_settings.dart';
import '../domain/paired_server.dart';
import '../domain/sleep_timer.dart';
import 'demo_audio_engine.dart';
import 'demo_data.dart';
import 'demo_http_send.dart';

/// A [ListenProgressApi] that does nothing — the demo never syncs resume to a
/// server (and must never build a SecurityContext from the placeholder caPem).
class _NoopProgressApi implements ListenProgressApi {
  @override
  Future<RemoteProgress?> getListenProgress(String bookId) async => null;
  @override
  Future<void> putListenProgress(String bookId,
      {required int chapterId,
      required double currentSec,
      required String listenedAt}) async {}
}

/// Build a fully-posed [CompanionRuntime] for marketing capture: a fake-HTTP
/// [ApiClient], an in-memory Drift store seeded from [demoBooks], a
/// [ThumbnailCache] reading pushed covers from [coversDir], and a
/// [DemoAudioEngine]. No network, no TLS, no native audio.
///
/// [fs] + [coversDir] are injectable so widget tests run on the host with an
/// [InMemoryFileStore]; the capture harness passes a [DiskFileStore] +
/// `getExternalStorageDirectory()`.
Future<CompanionRuntime> buildDemoRuntime({
  bool offline = false,
  FileStore? fs,
  String coversDir = '',
  String root = '/demo',
}) async {
  final fileStore = fs ?? const DiskFileStore();

  const connection = Connection(
    server: PairedServer(
        url: 'https://studio.local:8443', token: 'demo-token', caFingerprint: 'f'),
    caPem: 'demo-placeholder-ca-pem',
  );
  final api = ApiClient(connection, send: demoHttpSend(offline: offline));

  final library = DriftLocalLibrary(LibraryDatabase(NativeDatabase.memory()), fileStore,
      root: root);

  // Seed ONLY downloaded books into Drift. A not-downloaded book lives solely in
  // the manifest — so online it shows "Not downloaded", and it is correctly
  // ABSENT from the offline shelf (`loadLocalLibrary` returns every `books` row,
  // so seeding its metadata would wrongly surface it — and with an empty title).
  for (final b in demoBooks) {
    if (!b.downloaded) continue;
    await library.upsertBookMeta(
      bookId: b.bookId,
      title: b.title,
      author: b.author,
      series: b.series,
      seriesPosition: b.seriesPosition?.toInt(),
    );
    if (coversDir.isNotEmpty) {
      await library.setCoverThumbPath(b.bookId, '$coversDir/${b.bookId}.png');
    }
    for (final c in b.chapters) {
      await library.recordChapterMeta(
        bookId: b.bookId,
        uuid: c.uuid,
        chapterId: c.id,
        title: c.title,
        fingerprint: c.fingerprint,
        urlSuffix: c.urlSuffix,
        durationSec: c.durationSec,
      );
    }
    // Stamp the synced updatedAt: equal to the manifest = "downloaded";
    // older = "update available".
    await library.setBookUpdatedAt(
        b.bookId, b.updateAvailable ? '2000-01-01T00:00:00Z' : b.updatedAt);
    if (b.resume != null) {
      await library.savePlayback(b.bookId, b.resume!.chapterUuid,
          b.resume!.positionMs, b.resume!.lastPlayedAt);
      await library.markPlayed(b.bookId, b.resume!.lastPlayedAt);
    }
  }

  final sync = SyncController(
    manifestApi: api.manifestApi,
    localLibrary: library,
    // The demo never downloads (every book is pre-seeded). A range-fetch that
    // throws if ever called documents that — and avoids the TLS-building
    // `api.pinnedRangeFetch()`.
    chapterDownloader: ChapterDownloader(
      (Uri url, Map<String, String> headers) async =>
          throw const DownloadException('demo runtime never downloads'),
      fileStore,
    ),
    urlResolver: (path) => Uri.parse('${connection.server.url}$path'),
  );

  final player = PlayerController(
    audioEngine: DemoAudioEngine(),
    playbackStore: library,
    playlistLoader: (bookId) async => sync.playlistFor(bookId),
    clock: () => DateTime.fromMillisecondsSinceEpoch(0),
  );

  final thumbnails = ThumbnailCache(
    fs: fileStore,
    store: library,
    fetch: (bookId) async {
      final bytes = await fileStore.read('$coversDir/$bookId.png');
      if (bytes == null) throw StateError('no demo cover for $bookId');
      return bytes;
    },
    root: root,
  );

  final settingsStore = SettingsStore(fileStore, path: '$root/settings.json');
  const settings = AppSettings.defaults;

  final resumeSync = ResumeSyncService(
    progressApi: _NoopProgressApi(),
    playbackStore: library,
    chapterIdResolver: (bookId, uuid) async => null,
  );

  final sleepTimer = SleepTimer(onExpire: () {});

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
