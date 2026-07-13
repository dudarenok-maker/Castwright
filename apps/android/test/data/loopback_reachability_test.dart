import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/network_info.dart';
import 'package:castwright/src/domain/sync_gate.dart';

void main() {
  Reachability r(NetworkType n) => Reachability(() async => n);

  test('onHomeLan true on unmetered + metered Wi-Fi', () async {
    expect(await r(NetworkType.wifiUnmetered).onHomeLan(), isTrue);
    expect(await r(NetworkType.wifiMetered).onHomeLan(), isTrue);
  });

  test('onHomeLan false on mobile AND offline (NOT `!= mobile`)', () async {
    expect(await r(NetworkType.mobile).onHomeLan(), isFalse);
    expect(await r(NetworkType.offline).onHomeLan(), isFalse);
  });
}
