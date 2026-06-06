import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/auto_sync_service.dart';
import 'package:audiobook_companion/src/domain/app_settings.dart';
import 'package:audiobook_companion/src/domain/sync_gate.dart';

void main() {
  group('AutoSyncService.maybeSync', () {
    late int probes;
    late int syncs;

    AutoSyncService make({
      AppSettings? settings,
      NetworkType network = NetworkType.wifiUnmetered,
      bool reachable = true,
    }) {
      probes = 0;
      syncs = 0;
      return AutoSyncService(
        loadSettings: () async => settings ?? AppSettings.defaults,
        currentNetwork: () async => network,
        probeReachable: () async {
          probes++;
          return reachable;
        },
        runSync: () async => syncs++,
      );
    }

    test('syncs on unmetered wifi when reachable', () async {
      final svc = make();
      expect(await svc.maybeSync(), isTrue);
      expect(syncs, 1);
      expect(probes, 1);
    });

    test('does nothing (no probe) when auto-sync is disabled', () async {
      final svc = make(
          settings: AppSettings.defaults.copyWith(autoSyncOnReconnect: false));
      expect(await svc.maybeSync(), isFalse);
      expect(probes, 0);
      expect(syncs, 0);
    });

    test('does nothing (no probe) on mobile data', () async {
      final svc = make(network: NetworkType.mobile);
      expect(await svc.maybeSync(), isFalse);
      expect(probes, 0); // never even probes off-LAN -> no token leak risk
      expect(syncs, 0);
    });

    test('does nothing (no probe) on metered wifi when unmetered-only', () async {
      final svc = make(network: NetworkType.wifiMetered);
      expect(await svc.maybeSync(), isFalse);
      expect(probes, 0);
      expect(syncs, 0);
    });

    test('probes but does not sync when the server is unreachable', () async {
      final svc = make(reachable: false);
      expect(await svc.maybeSync(), isFalse);
      expect(probes, 1);
      expect(syncs, 0);
    });
  });
}
