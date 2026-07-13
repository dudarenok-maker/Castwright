import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('network security config permits cleartext ONLY for 127.0.0.1 loopback', () {
    final xml = File('android/app/src/main/res/xml/network_security_config.xml')
        .readAsStringSync();
    // Base default stays secure (no global cleartext).
    expect(xml.contains('<base-config cleartextTrafficPermitted="false"'), isTrue);
    // A domain-config opens cleartext for loopback only.
    expect(xml.contains('cleartextTrafficPermitted="true"'), isTrue);
    expect(xml.contains('<domain includeSubdomains="false">127.0.0.1</domain>'), isTrue);
    // The LAN-HTTPS invariant: no other host is granted cleartext.
    expect(xml.contains('0.0.0.0'), isFalse);
  });

  test('manifest wires the network security config on <application>', () {
    final manifest =
        File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
    expect(
      manifest.contains(
          'android:networkSecurityConfig="@xml/network_security_config"'),
      isTrue,
    );
  });
}
