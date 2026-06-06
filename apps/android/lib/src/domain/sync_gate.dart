/// Pure auto-sync gating (`app-8`). Decides whether a background sync may run
/// right now — never on mobile data (cost + the token must not leak off the home
/// LAN), only when the paired server is actually reachable, and only on
/// unmetered Wi-Fi unless the user opted into metered.
library;

enum NetworkType { offline, mobile, wifiMetered, wifiUnmetered }

bool shouldAutoSync({
  required bool autoSyncEnabled,
  required NetworkType network,
  required bool unmeteredOnly,
  required bool serverReachable,
}) {
  if (!autoSyncEnabled) return false;
  if (!serverReachable) return false;
  switch (network) {
    case NetworkType.offline:
    case NetworkType.mobile:
      return false;
    case NetworkType.wifiMetered:
      return !unmeteredOnly;
    case NetworkType.wifiUnmetered:
      return true;
  }
}
