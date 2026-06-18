import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:crypto/crypto.dart';
import 'package:castwright/src/data/cert_pinning.dart';
import 'package:castwright/src/data/crockford_base32.dart';

String pemOf(List<int> der) =>
    '-----BEGIN CERTIFICATE-----\n${base64.encode(der)}\n-----END CERTIFICATE-----\n';

/// Named constant reused by the fingerprintTagMatches test.
final _testPem = pemOf(List<int>.generate(64, (i) => (i * 7) % 256));

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

    test('fingerprintTagMatches accepts the first-16-byte tag, case-insensitive', () {
      final digest = sha256.convert(pemToDer(_testPem)).bytes;
      final tag = crockfordBase32(digest.sublist(0, 16));
      expect(tag.length, 26);
      expect(fingerprintTagMatches(_testPem, tag), isTrue);
      expect(fingerprintTagMatches(_testPem, tag.toLowerCase()), isTrue);
      expect(fingerprintTagMatches(_testPem, 'Z' * 26), isFalse);
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
