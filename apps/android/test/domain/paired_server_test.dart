import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/paired_server.dart';

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

    group('fromQrPayload', () {
      test('parses a scanned JSON payload', () {
        final s = PairedServer.fromQrPayload(
          '{"url":"https://10.0.0.5:8443","token":"t","caFingerprint":"AB:CD"}',
        );
        expect(s.url, 'https://10.0.0.5:8443');
        expect(s.token, 't');
        expect(s.caFingerprint, 'AB:CD');
      });

      test('rejects non-JSON and non-object payloads', () {
        expect(() => PairedServer.fromQrPayload('not json'), throwsA(isA<FormatException>()));
        expect(() => PairedServer.fromQrPayload('"a string"'), throwsA(isA<FormatException>()));
        expect(() => PairedServer.fromQrPayload('[1,2,3]'), throwsA(isA<FormatException>()));
      });
    });
  });
}
