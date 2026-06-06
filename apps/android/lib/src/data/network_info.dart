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
