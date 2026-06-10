import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/domain/pairing_qr.dart';

const _qr = 'CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R';
// Injected fetchCa/verifyTag/redeem mean this PEM is never parsed — any non-empty string is fine.
const _pem = 'PEM-CONTENT';

void main() {
  PairingQr qr() => PairingQr.parse(_qr);

  test('verifies tag, redeems code over pinned channel, returns token + full fp', () async {
    final svc = PairingService(
      fetchCa: (_) async => _pem,
      verifyTag: (_, _) => true,
      redeem: (baseUrl, code, caPem) async {
        expect(baseUrl, 'https://192.168.1.5:8443');
        expect(code, 'K7QF3M2P');
        expect(caPem, _pem);
        return const RedeemResult(token: 'tok_abc', caFingerprint: 'AB:CD:EF');
      },
    );
    final conn = await svc.pair(qr(), label: 'Pixel');
    expect(conn.server.token, 'tok_abc');
    expect(conn.server.url, 'https://192.168.1.5:8443');
    expect(conn.server.caFingerprint, 'AB:CD:EF');
    expect(conn.caPem, _pem);
  });

  test('refuses on fingerprint-tag mismatch (MitM)', () async {
    final svc = PairingService(fetchCa: (_) async => _pem, verifyTag: (pem, tag) => false);
    expect(
      () => svc.pair(qr(), label: 'x'),
      throwsA(isA<PairingException>()
          .having((e) => e.kind, 'kind', PairingErrorKind.fingerprintMismatch)),
    );
  });

  test('maps a rejected code to tokenRejected', () async {
    final svc = PairingService(
      fetchCa: (_) async => _pem,
      verifyTag: (_, _) => true,
      redeem: (url, code, pem) async => throw const RedeemRejected(),
    );
    expect(
      () => svc.pair(qr(), label: 'x'),
      throwsA(isA<PairingException>()
          .having((e) => e.kind, 'kind', PairingErrorKind.tokenRejected)),
    );
  });

  test('maps an unreachable CA fetch to unreachable', () async {
    final svc = PairingService(fetchCa: (_) async => throw Exception('no route'));
    expect(
      () => svc.pair(qr(), label: 'x'),
      throwsA(isA<PairingException>()
          .having((e) => e.kind, 'kind', PairingErrorKind.unreachable)),
    );
  });
}
