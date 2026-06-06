import 'dart:async';

import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'sync_engine.dart';

/// Platform seam for an OS foreground service that keeps a long download alive
/// (a persistent progress notification) so Android doesn't kill the process
/// mid-sync. Injectable so the runner logic unit-tests without the plugin.
abstract class ForegroundController {
  Future<void> start(String title, String text);
  Future<void> update(String text);
  Future<void> stop();
}

/// Runs a sync under a foreground service: starts the service, mirrors each
/// [SyncProgress] tick into the notification text, and always stops the service
/// when the work finishes (or fails). The runner is pure orchestration — the
/// native plugin lives behind [ForegroundController].
class SyncForegroundRunner {
  SyncForegroundRunner(
    this._controller, {
    String Function(SyncProgress progress)? describe,
  }) : _describe = describe ?? describeSyncProgress;

  final ForegroundController _controller;
  final String Function(SyncProgress progress) _describe;

  Future<SyncResult> run({
    required Stream<SyncProgress> progress,
    required Future<SyncResult> Function() task,
  }) async {
    await _controller.start('Syncing library', 'Starting…');
    final sub = progress.listen((p) => _controller.update(_describe(p)));
    try {
      return await task();
    } finally {
      await sub.cancel();
      await _controller.stop();
    }
  }
}

/// Real [ForegroundController] backed by `flutter_foreground_task` — keeps the
/// app process foreground-priority (a sticky `dataSync` notification) so Android
/// doesn't kill a multi-book download. The actual downloading runs in the app
/// isolate (where the pinned TLS client lives); this service only keeps the
/// process alive and renders progress. Exercised on a device, not in unit tests.
class FlutterForegroundController implements ForegroundController {
  bool _initialized = false;

  void _ensureInitialized() {
    if (_initialized) return;
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'audiobook_sync',
        channelName: 'Library sync',
        channelDescription: 'Downloading audiobook chapters',
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
        onlyAlertOnce: true,
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.nothing(),
        autoRunOnBoot: false,
        allowWifiLock: true,
      ),
    );
    _initialized = true;
  }

  @override
  Future<void> start(String title, String text) async {
    _ensureInitialized();
    await FlutterForegroundTask.requestNotificationPermission();
    await FlutterForegroundTask.startService(
      serviceId: 7341,
      serviceTypes: const [ForegroundServiceTypes.dataSync],
      notificationTitle: title,
      notificationText: text,
    );
  }

  @override
  Future<void> update(String text) async {
    await FlutterForegroundTask.updateService(notificationText: text);
  }

  @override
  Future<void> stop() async {
    await FlutterForegroundTask.stopService();
  }
}

/// Default notification copy for a progress tick, e.g.
/// "Downloading b1 — ch 3/12".
String describeSyncProgress(SyncProgress p) {
  switch (p.phase) {
    case SyncPhase.indexing:
      return 'Checking for updates…';
    case SyncPhase.book:
      return 'Syncing ${p.bookId ?? ''}…';
    case SyncPhase.chapter:
      return 'Downloading ${p.bookId ?? ''} — ch ${p.chaptersDone + 1}/${p.chaptersTotal}';
    case SyncPhase.done:
      return 'Up to date';
  }
}
