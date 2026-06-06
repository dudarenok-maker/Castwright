/// User playback & download settings (`app-13`). Pure value type — drives
/// `app-5` (skip-button behaviour), `app-4` (storage cap + eviction policy), and
/// `app-8` (auto-sync gating). Persisted by `SettingsStore`.
library;

import 'skip_behavior.dart';

class AppSettings {
  const AppSettings({
    this.sleepTimerMinutes = 0,
    this.defaultSpeed = 1.0,
    this.skipSilence = false,
    this.skipButtonBehavior = SkipButtonBehavior.seek,
    this.skipForwardSeconds = 30,
    this.skipBackwardSeconds = 15,
    this.unmeteredWifiOnly = true,
    this.storageCapBytes = 5 * 1024 * 1024 * 1024, // 5 GB
    this.autoDeleteFinished = false,
    this.keepRecentBooks = 3,
    this.autoSyncOnReconnect = true,
    this.autoDownloadInProgress = true,
  });

  /// 0 = off.
  final int sleepTimerMinutes;
  final double defaultSpeed;
  final bool skipSilence;

  /// Bluetooth/notification skip-button behaviour (drives `app-5`).
  final SkipButtonBehavior skipButtonBehavior;
  final int skipForwardSeconds;
  final int skipBackwardSeconds;

  /// Restrict downloads/sync to unmetered Wi-Fi (drives `app-8`).
  final bool unmeteredWifiOnly;

  /// Storage cap + eviction policy (drive `app-4`).
  final int storageCapBytes;
  final bool autoDeleteFinished;
  final int keepRecentBooks;

  /// Auto-sync deltas + flush resume on reconnect (drives `app-8`).
  final bool autoSyncOnReconnect;
  final bool autoDownloadInProgress;

  static const AppSettings defaults = AppSettings();

  AppSettings copyWith({
    int? sleepTimerMinutes,
    double? defaultSpeed,
    bool? skipSilence,
    SkipButtonBehavior? skipButtonBehavior,
    int? skipForwardSeconds,
    int? skipBackwardSeconds,
    bool? unmeteredWifiOnly,
    int? storageCapBytes,
    bool? autoDeleteFinished,
    int? keepRecentBooks,
    bool? autoSyncOnReconnect,
    bool? autoDownloadInProgress,
  }) {
    return AppSettings(
      sleepTimerMinutes: sleepTimerMinutes ?? this.sleepTimerMinutes,
      defaultSpeed: defaultSpeed ?? this.defaultSpeed,
      skipSilence: skipSilence ?? this.skipSilence,
      skipButtonBehavior: skipButtonBehavior ?? this.skipButtonBehavior,
      skipForwardSeconds: skipForwardSeconds ?? this.skipForwardSeconds,
      skipBackwardSeconds: skipBackwardSeconds ?? this.skipBackwardSeconds,
      unmeteredWifiOnly: unmeteredWifiOnly ?? this.unmeteredWifiOnly,
      storageCapBytes: storageCapBytes ?? this.storageCapBytes,
      autoDeleteFinished: autoDeleteFinished ?? this.autoDeleteFinished,
      keepRecentBooks: keepRecentBooks ?? this.keepRecentBooks,
      autoSyncOnReconnect: autoSyncOnReconnect ?? this.autoSyncOnReconnect,
      autoDownloadInProgress:
          autoDownloadInProgress ?? this.autoDownloadInProgress,
    );
  }

  Map<String, dynamic> toJson() => {
        'sleepTimerMinutes': sleepTimerMinutes,
        'defaultSpeed': defaultSpeed,
        'skipSilence': skipSilence,
        'skipButtonBehavior': skipButtonBehavior.name,
        'skipForwardSeconds': skipForwardSeconds,
        'skipBackwardSeconds': skipBackwardSeconds,
        'unmeteredWifiOnly': unmeteredWifiOnly,
        'storageCapBytes': storageCapBytes,
        'autoDeleteFinished': autoDeleteFinished,
        'keepRecentBooks': keepRecentBooks,
        'autoSyncOnReconnect': autoSyncOnReconnect,
        'autoDownloadInProgress': autoDownloadInProgress,
      };

  factory AppSettings.fromJson(Map<String, dynamic> json) {
    const d = AppSettings.defaults;
    return AppSettings(
      sleepTimerMinutes:
          (json['sleepTimerMinutes'] as num?)?.toInt() ?? d.sleepTimerMinutes,
      defaultSpeed: (json['defaultSpeed'] as num?)?.toDouble() ?? d.defaultSpeed,
      skipSilence: json['skipSilence'] as bool? ?? d.skipSilence,
      skipButtonBehavior: _behaviorFromName(json['skipButtonBehavior'] as String?),
      skipForwardSeconds:
          (json['skipForwardSeconds'] as num?)?.toInt() ?? d.skipForwardSeconds,
      skipBackwardSeconds: (json['skipBackwardSeconds'] as num?)?.toInt() ??
          d.skipBackwardSeconds,
      unmeteredWifiOnly: json['unmeteredWifiOnly'] as bool? ?? d.unmeteredWifiOnly,
      storageCapBytes:
          (json['storageCapBytes'] as num?)?.toInt() ?? d.storageCapBytes,
      autoDeleteFinished:
          json['autoDeleteFinished'] as bool? ?? d.autoDeleteFinished,
      keepRecentBooks:
          (json['keepRecentBooks'] as num?)?.toInt() ?? d.keepRecentBooks,
      autoSyncOnReconnect:
          json['autoSyncOnReconnect'] as bool? ?? d.autoSyncOnReconnect,
      autoDownloadInProgress:
          json['autoDownloadInProgress'] as bool? ?? d.autoDownloadInProgress,
    );
  }

  static SkipButtonBehavior _behaviorFromName(String? name) {
    for (final b in SkipButtonBehavior.values) {
      if (b.name == name) return b;
    }
    return SkipButtonBehavior.seek;
  }
}
