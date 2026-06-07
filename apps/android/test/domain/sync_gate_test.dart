import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/sync_gate.dart';

void main() {
  group('shouldAutoSync', () {
    bool gate({
      bool enabled = true,
      NetworkType network = NetworkType.wifiUnmetered,
      bool unmeteredOnly = true,
      bool reachable = true,
    }) =>
        shouldAutoSync(
          autoSyncEnabled: enabled,
          network: network,
          unmeteredOnly: unmeteredOnly,
          serverReachable: reachable,
        );

    test('allows on unmetered wifi when enabled + reachable', () {
      expect(gate(), isTrue);
    });

    test('blocks when auto-sync is disabled', () {
      expect(gate(enabled: false), isFalse);
    });

    test('blocks when the paired server is unreachable', () {
      expect(gate(reachable: false), isFalse);
    });

    test('blocks when offline', () {
      expect(gate(network: NetworkType.offline), isFalse);
    });

    test('never syncs on mobile data (cost + token-leak safety)', () {
      expect(gate(network: NetworkType.mobile), isFalse);
    });

    test('blocks metered wifi when unmetered-only is on', () {
      expect(gate(network: NetworkType.wifiMetered, unmeteredOnly: true), isFalse);
    });

    test('allows metered wifi when unmetered-only is off', () {
      expect(gate(network: NetworkType.wifiMetered, unmeteredOnly: false), isTrue);
    });
  });
}
