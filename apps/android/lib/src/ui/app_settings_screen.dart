import 'package:flutter/material.dart';

import '../data/companion_runtime.dart';
import '../domain/app_settings.dart';
import '../domain/paired_server.dart';
import '../domain/skip_behavior.dart';

/// App settings + device management: the volume-boost control, the paired-server
/// info (URL, certificate fingerprint, paired-since — never the token), and the
/// unpair / delete-library actions.
class AppSettingsScreen extends StatefulWidget {
  const AppSettingsScreen({
    super.key,
    required this.runtime,
    required this.server,
    required this.onUnpair,
    required this.onLibraryCleared,
  });

  final CompanionRuntime runtime;
  final PairedServer server;
  final Future<void> Function() onUnpair;
  final VoidCallback onLibraryCleared;

  @override
  State<AppSettingsScreen> createState() => _AppSettingsScreenState();
}

class _AppSettingsScreenState extends State<AppSettingsScreen> {
  late double _boost = widget.runtime.settings.volumeBoostDb;

  AppSettings get _s => widget.runtime.settings;

  Future<void> _commitBoost(double db) => widget.runtime.updateSettings(
      widget.runtime.settings.copyWith(volumeBoostDb: db));

  Future<void> _update(AppSettings next) async {
    await widget.runtime.updateSettings(next);
    if (mounted) setState(() {});
  }

  Widget _secondsDropdown(int value, void Function(int) onChanged) {
    const opts = [5, 10, 15, 30, 45, 60];
    final v = opts.contains(value) ? value : 30;
    return DropdownButton<int>(
      value: v,
      items: [
        for (final s in opts) DropdownMenuItem(value: s, child: Text('${s}s')),
      ],
      onChanged: (x) => x == null ? null : onChanged(x),
    );
  }

  Widget _sleepMenu() => PopupMenuButton<int>(
        key: const Key('sleep-menu'),
        child: const Padding(
          padding: EdgeInsets.all(8),
          child: Icon(Icons.more_time),
        ),
        onSelected: (m) {
          if (m == 0) {
            widget.runtime.sleepTimer.cancel();
          } else {
            widget.runtime.sleepTimer.start(Duration(minutes: m));
          }
          setState(() {});
        },
        itemBuilder: (_) => [
          const PopupMenuItem(value: 0, child: Text('Off')),
          for (final m in const [5, 10, 15, 30, 45, 60])
            PopupMenuItem(value: m, child: Text('$m min')),
        ],
      );

  Future<bool> _confirm(String title, String message, String action) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true), child: Text(action)),
        ],
      ),
    );
    return ok ?? false;
  }

  Future<void> _deleteLibrary() async {
    if (!await _confirm('Delete library?',
        'Removes all downloaded audio from this device. You can re-download later.',
        'Delete')) {
      return;
    }
    await widget.runtime.library.clearAllBooks();
    widget.onLibraryCleared();
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Downloaded library deleted.')));
    }
  }

  Future<void> _unpair() async {
    if (!await _confirm('Unpair this device?',
        'Disconnects from the server and removes the saved certificate + downloaded library.',
        'Unpair')) {
      return;
    }
    await widget.onUnpair();
    if (mounted) Navigator.of(context).pop();
  }

  String _pairedSince() {
    final raw = widget.server.pairedAt;
    if (raw == null) return 'unknown';
    final dt = DateTime.tryParse(raw);
    if (dt == null) return raw;
    final l = dt.toLocal();
    final d = '${l.year}-${l.month.toString().padLeft(2, '0')}-${l.day.toString().padLeft(2, '0')}';
    final t = '${l.hour.toString().padLeft(2, '0')}:${l.minute.toString().padLeft(2, '0')}';
    return '$d $t';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        children: [
          _sectionLabel('Playback'),
          ListTile(
            title: const Text('Volume boost'),
            subtitle: Text(_boost <= 0
                ? 'Off — plays the master at full strength'
                : 'Boosted +${_boost.toStringAsFixed(0)} dB'),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Slider(
              key: const Key('boost-slider'),
              value: _boost,
              min: 0,
              max: 12,
              divisions: 12,
              label: '+${_boost.toStringAsFixed(0)} dB',
              onChanged: (v) => setState(() => _boost = v),
              onChangeEnd: _commitBoost,
            ),
          ),
          SwitchListTile(
            key: const Key('skip-chapter-mode'),
            title: const Text('Skip buttons change chapter'),
            subtitle: const Text('Off: jump ±seconds · On: previous/next chapter'),
            value: _s.skipButtonBehavior == SkipButtonBehavior.chapter,
            onChanged: (v) => _update(_s.copyWith(
                skipButtonBehavior:
                    v ? SkipButtonBehavior.chapter : SkipButtonBehavior.seek)),
          ),
          ListTile(
            title: const Text('Skip forward'),
            trailing: _secondsDropdown(_s.skipForwardSeconds,
                (v) => _update(_s.copyWith(skipForwardSeconds: v))),
          ),
          ListTile(
            title: const Text('Skip back'),
            trailing: _secondsDropdown(_s.skipBackwardSeconds,
                (v) => _update(_s.copyWith(skipBackwardSeconds: v))),
          ),
          ListTile(
            key: const Key('sleep-timer'),
            leading: const Icon(Icons.bedtime_outlined),
            title: const Text('Sleep timer'),
            subtitle: Text(
                widget.runtime.sleepTimer.isActive ? 'On' : 'Off — pauses playback'),
            trailing: _sleepMenu(),
          ),
          const Divider(),
          _sectionLabel('Sync & downloads'),
          SwitchListTile(
            title: const Text('Only on un-metered Wi-Fi'),
            subtitle: const Text('Never sync/download on mobile data'),
            value: _s.unmeteredWifiOnly,
            onChanged: (v) => _update(_s.copyWith(unmeteredWifiOnly: v)),
          ),
          SwitchListTile(
            key: const Key('auto-sync'),
            title: const Text('Auto-sync on reconnect'),
            value: _s.autoSyncOnReconnect,
            onChanged: (v) => _update(_s.copyWith(autoSyncOnReconnect: v)),
          ),
          SwitchListTile(
            title: const Text('Auto-download in-progress books'),
            value: _s.autoDownloadInProgress,
            onChanged: (v) => _update(_s.copyWith(autoDownloadInProgress: v)),
          ),
          const Divider(),
          _sectionLabel('Server'),
          ListTile(
            leading: const Icon(Icons.dns_outlined),
            title: const Text('Server'),
            subtitle: Text(widget.server.url),
          ),
          ListTile(
            leading: const Icon(Icons.verified_user_outlined),
            title: const Text('Certificate (SHA-256)'),
            subtitle: Text(widget.server.caFingerprint,
                style: const TextStyle(fontFamily: 'monospace', fontSize: 11)),
          ),
          ListTile(
            leading: const Icon(Icons.schedule),
            title: const Text('Paired since'),
            subtitle: Text(_pairedSince()),
          ),
          const Divider(),
          _sectionLabel('Manage'),
          ListTile(
            key: const Key('delete-library'),
            leading: Icon(Icons.delete_sweep_outlined, color: scheme.error),
            title: Text('Delete downloaded library',
                style: TextStyle(color: scheme.error)),
            subtitle: const Text('Free up space; keep the pairing'),
            onTap: _deleteLibrary,
          ),
          ListTile(
            key: const Key('unpair'),
            leading: Icon(Icons.link_off, color: scheme.error),
            title: Text('Unpair device', style: TextStyle(color: scheme.error)),
            subtitle: const Text('Disconnect + forget this server'),
            onTap: _unpair,
          ),
        ],
      ),
    );
  }

  Widget _sectionLabel(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Text(text,
            style: Theme.of(context)
                .textTheme
                .labelLarge
                ?.copyWith(color: Theme.of(context).colorScheme.primary)),
      );
}
