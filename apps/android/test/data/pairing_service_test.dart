import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/cert_pinning.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/domain/paired_server.dart';

String pemOf(List<int> der) =>
    '-----BEGIN CERTIFICATE-----\n${base64.encode(der)}\n-----END CERTIFICATE-----\n';

void main() {
  final pem = pemOf(List<int>.generate(48, (i) => (i * 5 + 1) % 256));
  final goodFp = caFingerprintFromPem(pem);
  PairedServer server({String? fp}) =>
      PairedServer(url: 'https://10.0.0.5:8443', token: 'tok', caFingerprint: fp ?? goodFp);

  group('PairingService.pair', () {
    test('succeeds when the fingerprint matches and the probe is 2xx', () async {
      final svc = PairingService(fetchCa: (_) async => pem, probe: (_, _) async => 200);
      final conn = await svc.pair(server());
      expect(conn.server.token, 'tok');
      expect(conn.caPem, pem);
    });

    test('refuses (fingerprintMismatch) and never probes on a bad fingerprint', () async {
      var probed = false;
      final svc = PairingService(
        fetchCa: (_) async => pem,
        probe: (_, _) async {
          probed = true;
          return 200;
        },
      );
      await expectLater(
        svc.pair(server(fp: 'AB:CD:EF')),
        throwsA(isA<PairingException>()
            .having((e) => e.kind, 'kind', PairingErrorKind.fingerprintMismatch)),
      );
      expect(probed, isFalse);
    });

    test('maps a fetch failure to unreachable', () async {
      final svc = PairingService(
        fetchCa: (_) async => throw const SocketException('no route'),
        probe: (_, _) async => 200,
      );
      await expectLater(
        svc.pair(server()),
        throwsA(
            isA<PairingException>().having((e) => e.kind, 'kind', PairingErrorKind.unreachable)),
      );
    });

    test('maps 401 and 403 to tokenRejected', () async {
      for (final code in [401, 403]) {
        final svc = PairingService(fetchCa: (_) async => pem, probe: (_, _) async => code);
        await expectLater(
          svc.pair(server()),
          throwsA(isA<PairingException>()
              .having((e) => e.kind, 'kind', PairingErrorKind.tokenRejected)),
        );
      }
    });

    test('maps other 5xx to server', () async {
      final svc = PairingService(fetchCa: (_) async => pem, probe: (_, _) async => 500);
      await expectLater(
        svc.pair(server()),
        throwsA(isA<PairingException>().having((e) => e.kind, 'kind', PairingErrorKind.server)),
      );
    });
  });
}
