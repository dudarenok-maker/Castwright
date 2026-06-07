import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/network_info.dart';
import 'package:castwright/src/domain/sync_gate.dart';

void main() {
  group('networkTypeFromConnectivity', () {
    test('wifi -> wifiUnmetered', () {
      expect(networkTypeFromConnectivity([ConnectivityResult.wifi]),
          NetworkType.wifiUnmetered);
    });
    test('ethernet -> wifiUnmetered', () {
      expect(networkTypeFromConnectivity([ConnectivityResult.ethernet]),
          NetworkType.wifiUnmetered);
    });
    test('mobile -> mobile', () {
      expect(networkTypeFromConnectivity([ConnectivityResult.mobile]),
          NetworkType.mobile);
    });
    test('none / empty -> offline', () {
      expect(networkTypeFromConnectivity([ConnectivityResult.none]),
          NetworkType.offline);
      expect(networkTypeFromConnectivity([]), NetworkType.offline);
    });
    test('wifi + mobile prefers wifi', () {
      expect(
        networkTypeFromConnectivity(
            [ConnectivityResult.mobile, ConnectivityResult.wifi]),
        NetworkType.wifiUnmetered,
      );
    });
  });
}
