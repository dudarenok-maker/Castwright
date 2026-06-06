import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/cert_pinning.dart';

String pemOf(List<int> der) =>
    '-----BEGIN CERTIFICATE-----\n${base64.encode(der)}\n-----END CERTIFICATE-----\n';

void main() {
  group('cert pinning', () {
    test('pemToDer strips armor and decodes the base64 body', () {
      final der = List<int>.generate(40, (i) => i);
      expect(pemToDer(pemOf(der)), der);
    });

    test('formatFingerprint emits uppercase colon-separated hex', () {
      expect(formatFingerprint([0xab, 0x01, 0xff]), 'AB:01:FF');
    });

    test('fingerprintsMatch ignores case and separators', () {
      expect(fingerprintsMatch('ab:cd:ef', 'ABCDEF'), isTrue);
      expect(fingerprintsMatch('AB CD EF', 'ab:cd:ef'), isTrue);
      expect(fingerprintsMatch('ab:cd', 'ab:ce'), isFalse);
      expect(fingerprintsMatch('', 'abcd'), isFalse);
    });

    test('verifyCaFingerprint round-trips: matches its own fingerprint, rejects others', () {
      final pem = pemOf(List<int>.generate(64, (i) => (i * 7) % 256));
      final fp = caFingerprintFromPem(pem);
      // A real SHA-256 is 32 bytes -> 32 colon-separated hex groups.
      expect(fp.split(':').length, 32);
      expect(verifyCaFingerprint(pem, fp), isTrue);
      // Same fingerprint, server-style lowercase without colons, still matches.
      expect(verifyCaFingerprint(pem, fp.replaceAll(':', '').toLowerCase()), isTrue);
      expect(verifyCaFingerprint(pem, 'AB:CD:EF'), isFalse);
    });
  });
}
