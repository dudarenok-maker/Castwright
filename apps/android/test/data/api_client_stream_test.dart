import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/api_client.dart';

void main() {
  late HttpServer server;
  final received = <HttpRequest>[];

  setUp(() async {
    received.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      received.add(req);
      final res = req.response;
      res.statusCode = req.headers.value(HttpHeaders.rangeHeader) != null ? 206 : 200;
      res.headers.set(HttpHeaders.contentTypeHeader, 'audio/mpeg');
      res.headers.set('x-echo-range', req.headers.value(HttpHeaders.rangeHeader) ?? '');
      res.headers.set('x-echo-auth', req.headers.value(HttpHeaders.authorizationHeader) ?? '');
      res.add([1, 2, 3, 4]);
      await res.close();
    });
  });

  tearDown(() async => server.close(force: true));

  Uri url() => Uri.parse('http://127.0.0.1:${server.port}/audio.mp3');

  test('streamRange passes status, headers, body; injects Bearer; forwards Range', () async {
    final client = HttpClient();
    final r = await streamRange(client, url(), bearer: 'TKN', range: 'bytes=0-3');
    expect(r.statusCode, 206);
    expect(r.headers['content-type'], 'audio/mpeg');
    expect(r.headers['x-echo-range'], 'bytes=0-3');
    expect(r.headers['x-echo-auth'], 'Bearer TKN');
    final bytes = <int>[];
    await for (final chunk in r.body) {
      bytes.addAll(chunk);
    }
    expect(bytes, [1, 2, 3, 4]);
    client.close(force: true);
  });

  test('cancel aborts only this request; a sibling on the same client survives', () async {
    // A slow server that streams a byte, waits, then finishes — so we can cancel
    // request `a` mid-stream (after it has actually started reading).
    final slow = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    slow.listen((req) async {
      final res = req.response;
      res.add([9]);
      await res.flush();
      await Future<void>.delayed(const Duration(milliseconds: 200));
      res.add([9]);
      await res.close();
    });
    final slowUrl = Uri.parse('http://127.0.0.1:${slow.port}/x');
    final client = HttpClient(); // ONE shared client for both requests

    final a = await streamRange(client, slowUrl, bearer: 't');
    final b = await streamRange(client, slowUrl, bearer: 't');

    // ACTIVELY read `a` up to its first chunk so a real socket read is in flight
    // on the shared client — otherwise cancel() would be a no-op and prove nothing.
    final aStarted = Completer<void>();
    final aSub = a.body.listen((_) {
      if (!aStarted.isCompleted) aStarted.complete();
    });
    await aStarted.future.timeout(const Duration(seconds: 2));

    // Drain b fully in parallel, then cancel a mid-stream.
    final bDone = b.body.fold<List<int>>(<int>[], (acc, c) => acc..addAll(c));
    await a.cancel();
    await aSub.cancel();

    // The sibling completes despite a's mid-stream cancel — cancel tore down only
    // a's socket, not the shared client's pool.
    final bBytes = await bDone.timeout(const Duration(seconds: 2));
    expect(bBytes, [9, 9]);
    client.close(force: true);
    await slow.close(force: true);
  });

  test('cancel completes even when body is never listened to (no hang)', () async {
    final client = HttpClient();
    final r = await streamRange(client, url(), bearer: 't');
    // Never touch r.body — mirrors the HEAD / non-2xx-relay paths where the
    // response stream has no listener. A regression here would hang forever
    // awaiting the single-subscription StreamController's close() future, so
    // the timeout is the failure signal.
    await r.cancel().timeout(const Duration(seconds: 2));
    client.close(force: true);
  });
}
