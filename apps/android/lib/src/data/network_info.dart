import 'package:connectivity_plus/connectivity_plus.dart';

import '../domain/sync_gate.dart';

/// Map connectivity results to the gating [NetworkType]. Pure (unit-tested).
///
/// Wi-Fi/Ethernet map to `wifiUnmetered` as a best effort — connectivity_plus
/// can't report the metered flag directly, but the auto-sync reachability probe
/// only succeeds on the home LAN (the paired server isn't reachable elsewhere),
/// so off-LAN networks never sync regardless.
NetworkType networkTypeFromConnectivity(List<ConnectivityResult> results) {
  if (results.contains(ConnectivityResult.wifi) ||
      results.contains(ConnectivityResult.ethernet)) {
    return NetworkType.wifiUnmetered;
  }
  if (results.contains(ConnectivityResult.mobile)) return NetworkType.mobile;
  return NetworkType.offline;
}

/// Real current-network resolver (device-tested glue) — the `app-8`
/// `currentNetwork` seam.
Future<NetworkType> currentNetwork() async =>
    networkTypeFromConnectivity(await Connectivity().checkConnectivity());

/// The current-network resolver seam (injectable for tests).
typedef CurrentNetwork = Future<NetworkType> Function();

/// Answers "is the paired server plausibly reachable on THIS network?" for the
/// `app-10` streaming decision. True on any Wi-Fi/Ethernet (metered or not),
/// false on mobile AND offline. Deliberately NOT `network != mobile` — that is
/// true when offline, which would route an offline tap to a doomed LAN stream.
class Reachability {
  const Reachability(this._currentNetwork);
  final CurrentNetwork _currentNetwork;

  Future<bool> onHomeLan() async {
    final n = await _currentNetwork();
    return n == NetworkType.wifiUnmetered || n == NetworkType.wifiMetered;
  }
}
