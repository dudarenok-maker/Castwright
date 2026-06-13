import '../domain/app_settings.dart';
import '../domain/sync_gate.dart';

/// Auto-sync on reconnect (`app-8`): when the device returns to a usable
/// network, gate on settings + network + paired-server reachability, and (only
/// if allowed) run a delta sync + resume flush. Pure orchestration over
/// injectable seams; the native reachability/connectivity wiring is the host's.
///
/// Crucially it only **probes** the paired server when the network + settings
/// could permit a sync — never on mobile/offline — so the token is never sent
/// off the home LAN.
class AutoSyncService {
  AutoSyncService({
    required Future<AppSettings> Function() loadSettings,
    required Future<NetworkType> Function() currentNetwork,
    required Future<bool> Function() probeReachable,
    required Future<void> Function() runSync,
    // fs-16: flush buffered listen-stats on reconnect; null = no-op.
    this._flushStats,
  })  : _settingsLoader = loadSettings,
        _networkProbe = currentNetwork,
        _reachabilityProbe = probeReachable,
        _syncRunner = runSync;

  final Future<AppSettings> Function() _settingsLoader;
  final Future<NetworkType> Function() _networkProbe;
  final Future<bool> Function() _reachabilityProbe;
  final Future<void> Function() _syncRunner;
  final Future<void> Function()? _flushStats;

  /// Returns true iff a sync was actually started.
  Future<bool> maybeSync() async {
    final settings = await _settingsLoader();
    if (!settings.autoSyncOnReconnect) return false;

    final network = await _networkProbe();
    // Pre-gate assuming reachable=true to avoid probing (and leaking the token)
    // on networks/settings that could never permit a sync.
    final couldSync = shouldAutoSync(
      autoSyncEnabled: true,
      network: network,
      unmeteredOnly: settings.unmeteredWifiOnly,
      serverReachable: true,
    );
    if (!couldSync) return false;

    final reachable = await _reachabilityProbe();
    final allowed = shouldAutoSync(
      autoSyncEnabled: true,
      network: network,
      unmeteredOnly: settings.unmeteredWifiOnly,
      serverReachable: reachable,
    );
    if (!allowed) return false;

    await _syncRunner();
    // fs-16: flush buffered listen-stats now that we know the server is reachable.
    await _flushStats?.call();
    return true;
  }
}
