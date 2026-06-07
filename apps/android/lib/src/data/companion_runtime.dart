import 'package:path_provider/path_provider.dart';

import '../domain/app_settings.dart';
import 'api_client.dart';
import 'chapter_downloader.dart';
import 'cover_thumbnails.dart';
import 'drift_local_library.dart';
import 'file_store.dart';
import 'just_audio_engine.dart';
import 'library_database.dart';
import 'pairing_service.dart' show Connection;
import 'player_controller.dart';
import 'settings_store.dart';
import 'sync_controller.dart';

/// The wired runtime for a paired server (app-shell integration): builds the
/// cert-pinned [ApiClient], the on-device drift store, the [SyncController]
/// (index + per-book download), the [PlayerController] over `just_audio`, and
/// loads/applies device [AppSettings]. Device glue — exercised on a device, not
/// in unit tests (each piece it wires is unit-tested on its own).
class CompanionRuntime {
  CompanionRuntime._(
    this.api,
    this.library,
    this.sync,
    this.player,
    this.thumbnails,
    this.settingsStore,
    this.settings,
  );

  final ApiClient api;
  final DriftLocalLibrary library;
  final SyncController sync;
  final PlayerController player;
  final ThumbnailCache thumbnails;
  final SettingsStore settingsStore;

  /// Current device settings (mutable — updated via [updateSettings]).
  AppSettings settings;

  static Future<CompanionRuntime> forConnection(Connection connection) async {
    final docs = await getApplicationDocumentsDirectory();
    final root = '${docs.path}/companion';

    final api = ApiClient(connection);
    final fs = const DiskFileStore();
    final library = DriftLocalLibrary(LibraryDatabase.open(), fs, root: root);
    final downloader = ChapterDownloader(api.pinnedRangeFetch(), fs);

    Uri resolve(String path) => Uri.parse('${connection.server.url}$path');

    final sync = SyncController(
      manifestApi: api.manifestApi,
      localLibrary: library,
      chapterDownloader: downloader,
      urlResolver: resolve,
    );

    final player = PlayerController(
      audioEngine: JustAudioEngine(),
      playbackStore: library,
      playlistLoader: (bookId) async => sync.playlistFor(bookId),
      clock: DateTime.now,
    );

    final thumbnails = ThumbnailCache(
      fs: fs,
      store: library,
      fetch: (bookId) => api.getBytes('/api/books/$bookId/cover'),
      root: root,
    );

    final settingsStore = SettingsStore(fs, path: '$root/settings.json');
    final settings = await settingsStore.load();
    await player.setSpeed(settings.defaultSpeed);
    await player.setVolumeBoost(settings.volumeBoostDb);

    return CompanionRuntime._(
        api, library, sync, player, thumbnails, settingsStore, settings);
  }

  /// Persist new settings and apply the playback-affecting ones immediately.
  Future<void> updateSettings(AppSettings next) async {
    settings = next;
    await settingsStore.save(next);
    await player.setVolumeBoost(next.volumeBoostDb);
    await player.setSpeed(next.defaultSpeed);
  }

  Future<void> dispose() async {
    await player.dispose();
    await library.close();
  }
}
