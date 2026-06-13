import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../domain/app_settings.dart';
import '../domain/sleep_timer.dart';
import '../domain/storage_policy.dart';
import 'api_client.dart';
import 'car_browse.dart';
import 'auto_sync_service.dart';
import 'listen_stats_service.dart';
import 'chapter_downloader.dart';
import 'companion_audio_handler.dart';
import 'download_foreground_service.dart';
import 'network_info.dart';
import 'cover_thumbnails.dart';
import 'drift_local_library.dart';
import 'file_store.dart';
import 'just_audio_engine.dart';
import 'library_database.dart';
import 'pairing_service.dart' show Connection;
import 'player_controller.dart';
import 'resume_sync_service.dart';
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
    this.resumeSync,
    this.sleepTimer,
    this.audioHandler,
    this._subs,
  );

  /// Marketing-capture / test factory: build a runtime from already-constructed
  /// (fake) parts, bypassing the network/TLS wiring of [forConnection].
  @visibleForTesting
  factory CompanionRuntime.forDemo({
    required ApiClient api,
    required DriftLocalLibrary library,
    required SyncController sync,
    required PlayerController player,
    required ThumbnailCache thumbnails,
    required SettingsStore settingsStore,
    required AppSettings settings,
    required ResumeSyncService resumeSync,
    required SleepTimer sleepTimer,
  }) =>
      CompanionRuntime._(api, library, sync, player, thumbnails, settingsStore,
          settings, resumeSync, sleepTimer, null, const []);

  final ApiClient api;
  final DriftLocalLibrary library;
  final SyncController sync;
  final PlayerController player;
  final ThumbnailCache thumbnails;
  final SettingsStore settingsStore;

  /// Two-way resume sync (app-6): push local position / pull the server's.
  final ResumeSyncService resumeSync;

  /// Bedtime sleep timer (app-13) — pauses the player on expire.
  final SleepTimer sleepTimer;

  /// app-3: foreground service that keeps long downloads alive when backgrounded.
  final ForegroundController foreground = FlutterForegroundController();

  /// Background stream subscriptions (app-8 connectivity, app-4 finished-track).
  final List<StreamSubscription<Object?>> _subs;

  /// Current device settings (mutable — updated via [updateSettings]).
  AppSettings settings;

  /// The media-session handler (lock-screen/Bluetooth/car), null in tests.
  final CompanionAudioHandler? audioHandler;

  static Future<CompanionRuntime> forConnection(
    Connection connection, {
    CompanionAudioHandler? handler,
  }) async {
    final docs = await getApplicationDocumentsDirectory();
    final root = '${docs.path}/companion';

    final api = ApiClient(connection);
    final fs = const DiskFileStore();
    final db = LibraryDatabase.open();
    final library = DriftLocalLibrary(db, fs, root: root);
    final downloader = ChapterDownloader(api.pinnedRangeFetch(), fs);

    Uri resolve(String path) => Uri.parse('${connection.server.url}$path');

    final sync = SyncController(
      manifestApi: api.manifestApi,
      localLibrary: library,
      chapterDownloader: downloader,
      urlResolver: resolve,
    );

    // fs-16: per-app-launch session id — a compact ms-epoch string, stable for
    // the process lifetime. Injected into the player so tests can override it.
    final sessionId =
        DateTime.now().millisecondsSinceEpoch.toRadixString(36).toUpperCase();

    final player = PlayerController(
      audioEngine: JustAudioEngine(),
      playbackStore: library,
      playlistLoader: (bookId) async => sync.playlistFor(bookId),
      clock: DateTime.now,
      statsDb: db,
      sessionId: sessionId,
      localDate: () {
        final n = DateTime.now();
        return '${n.year.toString().padLeft(4, '0')}-'
            '${n.month.toString().padLeft(2, '0')}-'
            '${n.day.toString().padLeft(2, '0')}';
      },
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
    player.skipBehavior_ = settings.skipButtonBehavior;
    player.skipForwardSeconds_ = settings.skipForwardSeconds;
    player.skipBackwardSeconds_ = settings.skipBackwardSeconds;

    final sleepTimer = SleepTimer(onExpire: () => player.pause());

    final resumeSync = ResumeSyncService(
      progressApi: api.listenProgressApi,
      playbackStore: library,
      chapterIdResolver: (bookId, uuid) async {
        for (final c in await library.chaptersForBook(bookId)) {
          if (c.uuid == uuid) return c.chapterId;
        }
        return null;
      },
    );

    // fs-16: listen-stats flush service — PUTs buffered absolutes to the server.
    final statsFlush = ListenStatsFlushService(api: api.listenStatsApi, db: db);

    // app-8: auto-sync on reconnect — flush resume for all local books when the
    // device returns to a usable, reachable network (gated; token stays on LAN).
    final autoSync = AutoSyncService(
      loadSettings: settingsStore.load,
      currentNetwork: currentNetwork,
      probeReachable: () async {
        try {
          await api.getJson('/api/info');
          return true;
        } catch (_) {
          return false;
        }
      },
      runSync: () async {
        final books = await library.listBooks();
        await resumeSync.syncAll([for (final b in books) b.bookId]);
      },
      flushStats: statsFlush.flush,
    );
    final connectivitySub =
        Connectivity().onConnectivityChanged.listen((_) => autoSync.maybeSync());

    // app-4: mark a chapter finished when it plays to its end.
    final completedSub = player.chapterCompletedStream
        .listen((uuid) => library.setChapterFinished(uuid, true));

    // app-5/app-9: connect the media session (lock-screen / Bluetooth / car) to
    // the live player + a downloaded-only, 2-tab car browse tree (CarBrowse).
    // "current book" = the live player's book, else the most-recently-played one.
    final carBrowse = CarBrowse(
      allBooks: library.listBooks,
      chaptersForBook: library.chaptersForBook,
      current: () async {
        final bid =
            player.currentBookId ?? await library.mostRecentlyPlayedBookId();
        if (bid == null) return const CarCurrent();
        final uuid = player.currentChapterUuid ??
            (await library.loadPlayback(bid))?.chapterUuid;
        return CarCurrent(bookId: bid, chapterUuid: uuid);
      },
      play: (bookId, uuid) async {
        BookSummary? meta;
        for (final b in await library.listBooks()) {
          if (b.bookId == bookId) meta = b;
        }
        await player.openBook(bookId,
            bookTitle: meta?.title ?? '', artPath: meta?.coverThumbPath);
        await player.playChapter(uuid);
      },
    );
    handler?.attach(
      player,
      childrenProvider: carBrowse.getChildren,
      onPlayMediaId: carBrowse.playFromMediaId,
    );

    return CompanionRuntime._(api, library, sync, player, thumbnails,
        settingsStore, settings, resumeSync, sleepTimer, handler,
        [connectivitySub, completedSub]);
  }

  /// app-4: enforce the storage cap (auto-delete finished + LRU book eviction).
  /// Call after a download lands.
  Future<void> enforceStorageCap() async {
    final plan = planStorageEviction(
      books: await library.bookUsages(),
      capBytes: settings.storageCapBytes,
      autoDeleteFinished: settings.autoDeleteFinished,
      keepRecentBooks: settings.keepRecentBooks,
    );
    await library.applyEviction(plan);
  }

  /// Persist new settings and apply the playback-affecting ones immediately.
  Future<void> updateSettings(AppSettings next) async {
    settings = next;
    await settingsStore.save(next);
    await player.setVolumeBoost(next.volumeBoostDb);
    await player.setSpeed(next.defaultSpeed);
    player.skipBehavior_ = next.skipButtonBehavior;
    player.skipForwardSeconds_ = next.skipForwardSeconds;
    player.skipBackwardSeconds_ = next.skipBackwardSeconds;
  }

  Future<void> dispose() async {
    for (final s in _subs) {
      await s.cancel();
    }
    audioHandler?.detach();
    await player.dispose();
    await library.close();
  }
}
