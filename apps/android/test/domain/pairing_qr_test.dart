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

  test('rejects a non-private (public) host', () {
    expect(
        () => PairingQr.parse(
            'https://www.castwright.ai/pair?h=8.8.8.8:8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R'),
        throwsFormatException);
  });

  test('rejects a non-IP host', () {
    expect(
        () => PairingQr.parse(
            'https://www.castwright.ai/pair?h=evil.example.com:8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R'),
        throwsFormatException);
  });

  test('accepts the three RFC1918 ranges + loopback', () {
    for (final h in ['10.0.0.4:8443', '172.16.5.6:8443', '192.168.1.5:8443', '127.0.0.1:8443']) {
      expect(PairingQr.parse('https://www.castwright.ai/pair?h=$h&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R').hostPort, h);
    }
  });
}
