import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/pairing_qr.dart';

void main() {
  test('parses a valid CWP1 payload', () {
    final qr = PairingQr.parse('CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R');
    expect(qr.hostPort, '192.168.1.5:8443');
    expect(qr.baseUrl, 'https://192.168.1.5:8443');
    expect(qr.code, 'K7QF3M2P');
    expect(qr.fpTag, 'J4XQ2A7BWZ9K3M5R');
  });

  test('rejects wrong magic', () {
    expect(() => PairingQr.parse('XXXX*h:1*c*t'), throwsFormatException);
  });

  test('rejects wrong arity', () {
    expect(() => PairingQr.parse('CWP1*h:1*c'), throwsFormatException);
    expect(() => PairingQr.parse('CWP1*h:1*c*t*extra'), throwsFormatException);
  });

  test('rejects an empty field', () {
    expect(() => PairingQr.parse('CWP1**c*t'), throwsFormatException);
    expect(() => PairingQr.parse('CWP1*h:1**t'), throwsFormatException);
    expect(() => PairingQr.parse('CWP1*h:1*c*'), throwsFormatException);
  });

  test('parses the deep-link URL form (raw colon)', () {
    final qr = PairingQr.parse(
        'https://www.castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R');
    expect(qr.hostPort, '192.168.1.5:8443');
    expect(qr.baseUrl, 'https://192.168.1.5:8443');
    expect(qr.code, 'K7QF3M2P');
    expect(qr.fpTag, 'J4XQ2A7BWZ9K3M5R');
  });

  test('parses the deep-link URL form (percent-encoded colon)', () {
    final qr = PairingQr.parse(
        'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R');
    expect(qr.hostPort, '192.168.1.5:8443');
  });

  test('parses the deep-link URL form on the www host', () {
    final qr = PairingQr.parse(
        'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R');
    expect(qr.hostPort, '192.168.1.5:8443');
    expect(qr.code, 'K7QF3M2P');
    expect(qr.fpTag, '1CR5AYMZRKMGWCTRFPHCFV0H6R');
  });

  test('rejects a URL missing a pairing field', () {
    expect(
        () => PairingQr.parse('https://castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P'),
        throwsFormatException);
  });

  test('rejects a non-pairing URL', () {
    expect(() => PairingQr.parse('https://example.com/'), throwsFormatException);
  });
}
