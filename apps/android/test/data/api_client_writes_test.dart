import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/listen_stats_service.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/domain/paired_server.dart';

/// The three companion writes (listen-progress, shelf-status, listen-stats)
/// build their client from the injectable `httpClientFactory`, so a plaintext
/// loopback server can record the method, path, auth header and body they send.
void main() {
  late HttpServer server;
  late List<Map<String, Object?>> seen;

  setUp(() async {
    seen = [];
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final body = await utf8.decodeStream(req);
      seen.add({
        'method': req.method,
        'path': req.uri.path,
        'auth': req.headers.value(HttpHeaders.authorizationHeader),
        'body': body.isEmpty ? null : jsonDecode(body),
      });
      req.response.statusCode = 200;
      await req.response.close();
    });
  });

  tearDown(() async => server.close(force: true));

  ApiClient api() => ApiClient(
        Connection(
          server: PairedServer(
              url: 'http://127.0.0.1:${server.port}', token: 'tok', caFingerprint: 'f'),
          caPem: 'PEM',
        ),
        httpClientFactory: (_) => HttpClient(),
      );

  test('putListenProgress sends PUT /listen-progress with bearer + JSON body', () async {
    await api().putListenProgress('b1',
        chapterId: 3, currentSec: 12.5, listenedAt: '2026-11-24T00:00:00Z');
    expect(seen, hasLength(1));
    expect(seen[0]['method'], 'PUT');
    expect(seen[0]['path'], '/api/books/b1/listen-progress');
    expect(seen[0]['auth'], 'Bearer tok');
    expect(seen[0]['body'],
        {'chapterId': 3, 'currentSec': 12.5, 'listenedAt': '2026-11-24T00:00:00Z'});
  });

  test('setShelfStatus sends POST /shelf-status with the encoded id', () async {
    await api().setShelfStatus('b 1', finished: true);
    expect(seen, hasLength(1));
    expect(seen[0]['method'], 'POST');
    expect(seen[0]['path'], '/api/books/b%201/shelf-status');
    expect(seen[0]['auth'], 'Bearer tok');
    expect(seen[0]['body'], {'finished': true});
  });

  test('putListenStats sends PUT /listen-stats with sessionId and days', () async {
    await api().putListenStats('b1', sessionId: 's1', days: [
      StatDay(date: '2026-11-23', seconds: 90),
    ]);
    expect(seen, hasLength(1));
    expect(seen[0]['method'], 'PUT');
    expect(seen[0]['path'], '/api/books/b1/listen-stats');
    expect(seen[0]['auth'], 'Bearer tok');
    expect(seen[0]['body'], {
      'sessionId': 's1',
      'days': [
        {'date': '2026-11-23', 'seconds': 90}
      ],
    });
  });
}
