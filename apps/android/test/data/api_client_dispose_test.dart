import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/domain/paired_server.dart';

/// app-10 follow-up (#1579): [ApiClient.dispose] force-closes the three owned
/// pinned clients (JSON send, range download, LAN stream) so a re-pair doesn't
/// orphan their connection pools. Uses a plain-HTTP client factory against a
/// real loopback server (the pinned-CA client can't talk to plaintext), mirroring
/// api_client_stream_test.dart.
void main() {
  late HttpServer server;

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final res = req.response;
      res.statusCode = 200;
      res.headers.set(HttpHeaders.contentTypeHeader, 'application/json');
      res.write('{}'); // valid JSON for getJson; range/stream just drain it
      await res.close();
    });
  });

  tearDown(() async => server.close(force: true));

  Connection conn() => Connection(
        server: PairedServer(
            url: 'http://127.0.0.1:${server.port}', token: 'tok', caFingerprint: 'f'),
        caPem: 'PEM',
      );

  test('dispose force-closes every owned client; a second dispose is safe', () async {
    final made = <HttpClient>[];
    HttpClient factory(Connection _) {
      final c = HttpClient();
      made.add(c);
      return c;
    }

    final api = ApiClient(conn(), httpClientFactory: factory);

    // Exercise each of the three owned-client seams so they are all created.
    await api.getJson('/api/info'); // JSON send client (built at construction)

    final fetch = api.pinnedRangeFetch(); // range-download client
    final r1 = await fetch(Uri.parse('${conn().server.url}/x'), const {});
    await r1.body.drain<void>();

    // A second pinnedRangeFetch must reuse the ONE held client (memoisation),
    // not build a fresh one — otherwise dispose couldn't close it.
    api.pinnedRangeFetch();

    final r2 = await api // LAN-stream client
        .pinnedRangeStream(Uri.parse('${conn().server.url}/y'));
    await r2.body.drain<void>();

    expect(made.length, 3,
        reason: 'send + range + stream clients, each built once and reused '
            '(the 2nd pinnedRangeFetch reuses the held range client)');

    await api.dispose();

    // A force-closed HttpClient throws on any new request. Wrapping in Future()
    // normalises a possibly-synchronous throw into a rejected future.
    for (final c in made) {
      await expectLater(
        Future(() => c.getUrl(Uri.parse('http://127.0.0.1:${server.port}/z'))),
        throwsA(anything),
        reason: 'each owned client must be force-closed by dispose',
      );
    }

    // Idempotent — fields were nulled, so a second dispose is a no-op.
    await api.dispose();
  });
}
