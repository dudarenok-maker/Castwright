import 'package:flutter/material.dart';

import '../domain/app_settings.dart';
import '../domain/skip_behavior.dart';

/// Playback & download settings (`app-13`). Presentational — driven by
/// [settings] + [onChanged] (the host persists via `SettingsStore`), so it
/// widget-tests without IO. Emits a new [AppSettings] on every change.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({
    super.key,
    required this.settings,
    required this.onChanged,
  });

  final AppSettings settings;
  final void Function(AppSettings) onChanged;

  static const _sleepOptions = [0, 10, 15, 30, 45, 60];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          const _SectionHeader('Playback'),
          ListTile(
            title: const Text('Sleep timer'),
            trailing: DropdownButton<int>(
              key: const Key('sleep-timer'),
              value: settings.sleepTimerMinutes,
              items: [
                for (final m in _sleepOptions)
                  DropdownMenuItem(
                      value: m, child: Text(m == 0 ? 'Off' : '$m min')),
              ],
              onChanged: (v) =>
                  onChanged(settings.copyWith(sleepTimerMinutes: v ?? 0)),
            ),
          ),
          SwitchListTile(
            key: const Key('skip-silence'),
            title: const Text('Skip silence'),
            value: settings.skipSilence,
            onChanged: (v) => onChanged(settings.copyWith(skipSilence: v)),
          ),
          SwitchListTile(
            key: const Key('skip-chapter-mode'),
            title: const Text('Skip buttons jump a whole chapter'),
            subtitle: const Text('Off = seek ±30s / ±15s (safer for car keys)'),
            value: settings.skipButtonBehavior == SkipButtonBehavior.chapter,
            onChanged: (v) => onChanged(settings.copyWith(
                skipButtonBehavior:
                    v ? SkipButtonBehavior.chapter : SkipButtonBehavior.seek)),
          ),
          const _SectionHeader('Downloads & sync'),
          SwitchListTile(
            key: const Key('unmetered-wifi-only'),
            title: const Text('Unmetered Wi-Fi only'),
            subtitle: const Text("Don't sync on a metered hotspot"),
            value: settings.unmeteredWifiOnly,
            onChanged: (v) => onChanged(settings.copyWith(unmeteredWifiOnly: v)),
          ),
          SwitchListTile(
            key: const Key('auto-sync-on-reconnect'),
            title: const Text('Auto-sync on reconnect'),
            value: settings.autoSyncOnReconnect,
            onChanged: (v) =>
                onChanged(settings.copyWith(autoSyncOnReconnect: v)),
          ),
          SwitchListTile(
            key: const Key('stream-over-lan'),
            title: const Text('Stream over LAN'),
            subtitle: const Text('Play an undownloaded chapter instantly at home'),
            value: settings.streamOverLan,
            onChanged: (v) => onChanged(settings.copyWith(streamOverLan: v)),
          ),
          const _SectionHeader('Storage'),
          SwitchListTile(
            key: const Key('auto-delete-finished'),
            title: const Text('Auto-delete finished chapters'),
            subtitle: const Text('Keeps progress; frees space'),
            value: settings.autoDeleteFinished,
            onChanged: (v) => onChanged(settings.copyWith(autoDeleteFinished: v)),
          ),
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.label);
  final String label;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text(label, style: Theme.of(context).textTheme.titleSmall),
      );
}
