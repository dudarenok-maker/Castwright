import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/loopback_proxy.dart';

/// A programmable fake upstream. Records the URL/range it was asked for and
/// returns a canned PinnedStreamResponse.
class _FakeUpstream {
  int status = 206;
  Map<String, String> headers = {
    'content-type': 'audio/mpeg',
    'content-length': '4',
    'content-range': 'bytes 0-3/4',
    'accept-ranges': 'bytes',
  };
  List<int> bytes = [1, 2, 3, 4];
  final List<String?> ranges = [];
  int cancelled = 0;
  bool throwOnFetch = false;

  Future<PinnedStreamResponse> fetch(Uri url, {String? range}) async {
    ranges.add(range);
    if (throwOnFetch) throw const SocketException('unreachable');
    final ctl = StreamController<List<int>>();
    ctl.onListen = () {
      ctl.add(bytes);
      ctl.close();
    };
    return PinnedStreamResponse(
      statusCode: status,
      headers: headers,
      body: ctl.stream,
      cancel: () async {
        cancelled++;
        // A single-subscription StreamController's close() future only resolves
        // once a listener has drained the "done" event; on a HEAD request or a
        // non-2xx relay, nothing ever listens to `ctl.stream`, so awaiting an
        // unconditional close() here would hang forever.
        if (!ctl.isClosed) {
          if (ctl.hasListener) {
            await ctl.close();
          } else {
            ctl.close();
          }
        }
      },
    );
  }
}

Future<HttpClientResponse> _get(Uri url, {String method = 'GET', String? range}) async {
  final client = HttpClient();
  final req = await client.openUrl(method, url);
  if (range != null) req.headers.set(HttpHeaders.rangeHeader, range);
  final res = await req.close();
  return res;
}

void main() {
  late _FakeUpstream up;
  late LoopbackProxy proxy;

  setUp(() async {
    up = _FakeUpstream();
    // Seeded Random so ids are deterministic in tests.
    proxy = LoopbackProxy(up.fetch, random: Random(1));
    await proxy.start();
  });

  tearDown(() async => proxy.dispose());

  test('register returns a loopback URL that streams upstream bytes', () async {
    final loopback = proxy.register(upstream: Uri.parse('https://lan:8443/a.mp3'));
    expect(loopback.host, '127.0.0.1');
    expect(loopback.path, startsWith('/s/'));
    final res = await _get(loopback, range: 'bytes=0-3');
    expect(res.statusCode, 206);
    expect(res.headers.value('content-range'), 'bytes 0-3/4');
    expect(res.headers.value(HttpHeaders.acceptRangesHeader), 'bytes');
    final body = await res.fold<List<int>>(<int>[], (a, c) => a..addAll(c));
    expect(body, [1, 2, 3, 4]);
    expect(up.ranges.last, 'bytes=0-3'); // Range forwarded
  });

  test('unknown / stale id -> 404; non-GET/HEAD -> 405', () async {
    final loopback = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final bad = loopback.replace(path: '/s/deadbeef');
    expect((await _get(bad)).statusCode, 404);
    expect((await _get(loopback, method: 'POST')).statusCode, 405);
  });

  test('HEAD relays headers only (no body); cancels upstream', () async {
    final loopback = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final res = await _get(loopback, method: 'HEAD');
    expect(res.statusCode, 206);
    expect(res.headers.value(HttpHeaders.contentTypeHeader), 'audio/mpeg');
    final body = await res.fold<List<int>>(<int>[], (a, c) => a..addAll(c));
    expect(body, isEmpty);
    expect(up.cancelled, greaterThanOrEqualTo(1));
  });

  test('registering a new chapter evicts the prior id (old URL 404s)', () async {
    final first = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final second = proxy.register(upstream: Uri.parse('https://lan/b.mp3'));
    expect((await _get(first)).statusCode, 404);
    expect((await _get(second)).statusCode, 206);
  });

  test('non-2xx upstream sets lastUpstreamStatus and relays the code', () async {
    up.status = 401;
    final loopback = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final res = await _get(loopback);
    expect(res.statusCode, 401);
    expect(proxy.lastUpstreamStatus, 401);
  });

  test('fetch throw -> 502 and lastUpstreamStatus 0', () async {
    up.throwOnFetch = true;
    final loopback = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final res = await _get(loopback);
    expect(res.statusCode, 502);
    expect(proxy.lastUpstreamStatus, 0);
  });

  test('register() resets lastUpstreamStatus to null', () async {
    up.status = 500;
    await _get(proxy.register(upstream: Uri.parse('https://lan/a.mp3')));
    expect(proxy.lastUpstreamStatus, 500);
    proxy.register(upstream: Uri.parse('https://lan/b.mp3'));
    expect(proxy.lastUpstreamStatus, isNull);
  });

  test('start() is idempotent (same port on a second call)', () async {
    final before = proxy.register(upstream: Uri.parse('https://lan/a.mp3')).port;
    await proxy.start();
    final after = proxy.register(upstream: Uri.parse('https://lan/b.mp3')).port;
    expect(after, before);
  });
}
