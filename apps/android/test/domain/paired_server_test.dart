import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/paired_server.dart';

void main() {
  group('PairedServer', () {
    test('parses a valid pairing payload', () {
      final s = PairedServer.fromJson({
        'url': 'https://192.168.1.50:8443',
        'token': 'tok-123',
        'caFingerprint': 'AB:CD:EF',
      });
      expect(s.url, 'https://192.168.1.50:8443');
      expect(s.token, 'tok-123');
      expect(s.caFingerprint, 'AB:CD:EF');
    });

    test('round-trips through json', () {
      const s = PairedServer(url: 'u', token: 't', caFingerprint: 'f');
      expect(PairedServer.fromJson(s.toJson()).toJson(), s.toJson());
    });

    test('copyWith stamps pairedAt and it round-trips; legacy json has none', () {
      const base = PairedServer(url: 'u', token: 't', caFingerprint: 'f');
      expect(base.pairedAt, isNull);
      expect(base.toJson().containsKey('pairedAt'), isFalse); // legacy-clean
      final stamped = base.copyWith(pairedAt: '2026-06-07T10:00:00.000Z');
      expect(PairedServer.fromJson(stamped.toJson()).pairedAt,
          '2026-06-07T10:00:00.000Z');
    });

    test('rejects a payload with a missing or empty required field', () {
      expect(
        () => PairedServer.fromJson({'url': 'u', 'token': 't'}),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => PairedServer.fromJson({'url': 'u', 'token': '', 'caFingerprint': 'f'}),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => PairedServer.fromJson({'token': 't', 'caFingerprint': 'f'}),
        throwsA(isA<FormatException>()),
      );
    });

  });
}
