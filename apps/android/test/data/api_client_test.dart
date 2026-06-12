import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/domain/paired_server.dart';

Connection conn() => const Connection(
      server: PairedServer(url: 'https://10.0.0.5:8443', token: 'tok', caFingerprint: 'f'),
      caPem: 'PEM',
    );

void main() {
  group('ApiClient', () {
    test('getJson returns the parsed body and sends the Bearer token', () async {
      String? sentAuth;
      Uri? sentUrl;
      final api = ApiClient(conn(), send: (method, url, headers) async {
        sentAuth = headers['authorization'];
        sentUrl = url;
        return const HttpResult(200, '{"appVersion":"1.6.0"}');
      });
      final body = await api.info();
      expect(body['appVersion'], '1.6.0');
      expect(sentAuth, 'Bearer tok');
      expect(sentUrl.toString(), 'https://10.0.0.5:8443/api/info');
    });

    test('throws ApiException on 401', () async {
      final api = ApiClient(conn(), send: (_, _, _) async => const HttpResult(401, ''));
      await expectLater(
        api.info(),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 401)),
      );
    });

    test('throws ApiException on 5xx', () async {
      final api = ApiClient(conn(), send: (_, _, _) async => const HttpResult(503, ''));
      await expectLater(
        api.info(),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'status', 503)),
      );
    });

    // Regression (offline spinner): when the device is offline the real
    // transport's connect hangs until the OS TCP timeout instead of failing
    // fast, so every request — and the library/player UIs that await them —
    // spins for tens of seconds before the offline fallback can run. A hanging
    // send must abort with a TimeoutException so callers' catch-and-fall-back
    // path fires promptly.
    test('getJson aborts a hanging transport with TimeoutException', () async {
      final api = ApiClient(
        conn(),
        requestTimeout: const Duration(milliseconds: 50),
        send: (_, _, _) => Completer<HttpResult>().future, // never completes
      );
      await expectLater(api.info(), throwsA(isA<TimeoutException>()));
    });
  });
}
