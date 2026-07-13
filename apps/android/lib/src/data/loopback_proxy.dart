import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'api_client.dart' show PinnedStreamResponse;

/// Fetches one upstream range over the CA-pinned HTTPS client. Production passes
/// `ApiClient.pinnedRangeStream` (which injects the Bearer), so the proxy stays
/// auth-agnostic and the token never reaches the platform player.
typedef UpstreamFetch = Future<PinnedStreamResponse> Function(Uri url, {String? range});

/// An in-app loopback TLS-terminating proxy (`app-10`). Binds `127.0.0.1:0` on
/// demand and re-serves CA-pinned HTTPS chapter bytes as plaintext to the native
/// platform player, honouring `Range`/`206`. One active mapping at a time
/// (single-player app); a stale loopback id cleanly `404`s. Loopback-only bind +
/// an unguessable 128-bit path id keep it unreachable off-device and unguessable
/// to other local apps.
class LoopbackProxy {
  LoopbackProxy(this._fetch, {Random? random}) : _random = random ?? Random.secure();

  final UpstreamFetch _fetch;
  final Random _random;

  HttpServer? _server;
  String? _activeId;
  Uri? _activeUpstream;
  int? _lastUpstreamStatus;

  /// The last non-2xx upstream code (or `0` for a connection/timeout failure),
  /// scoped to the current registration — [register] resets it to null.
  int? get lastUpstreamStatus => _lastUpstreamStatus;

  /// Bind the loopback socket. Idempotent — a second call is a no-op.
  Future<void> start() async {
    if (_server != null) return;
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen(_handle);
  }

  /// Point the proxy at [upstream] under a fresh 128-bit id and return the
  /// loopback URL to hand to the player. Evicts any prior mapping and resets
  /// [lastUpstreamStatus].
  Uri register({required Uri upstream}) {
    final server = _server;
    if (server == null) {
      throw StateError('LoopbackProxy.register called before start()');
    }
    _lastUpstreamStatus = null;
    final id = _mintId();
    _activeId = id;
    _activeUpstream = upstream;
    return Uri.parse('http://127.0.0.1:${server.port}/s/$id');
  }

  /// Drop the active mapping so any live loopback URL `404`s (called on failure).
  void clearMapping() {
    _activeId = null;
    _activeUpstream = null;
  }

  Future<void> dispose() async {
    clearMapping();
    await _server?.close(force: true);
    _server = null;
  }

  String _mintId() {
    final b = List<int>.generate(16, (_) => _random.nextInt(256));
    return b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    if (req.method != 'GET' && req.method != 'HEAD') {
      res.statusCode = HttpStatus.methodNotAllowed; // 405
      await res.close();
      return;
    }
    final path = req.uri.path;
    final id = path.startsWith('/s/') ? path.substring(3) : '';
    final upstreamUrl = _activeUpstream;
    if (id.isEmpty || id != _activeId || upstreamUrl == null) {
      res.statusCode = HttpStatus.notFound; // 404
      await res.close();
      return;
    }

    final range = req.headers.value(HttpHeaders.rangeHeader);
    PinnedStreamResponse upstream;
    try {
      upstream = await _fetch(upstreamUrl, range: range);
    } catch (_) {
      _lastUpstreamStatus = 0;
      res.statusCode = HttpStatus.badGateway; // 502
      await res.close();
      return;
    }

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      _lastUpstreamStatus = upstream.statusCode;
      res.statusCode = upstream.statusCode;
      await upstream.cancel();
      await res.close();
      return;
    }

    res.statusCode = upstream.statusCode; // 200 | 206
    for (final h in const [
      HttpHeaders.contentTypeHeader,
      HttpHeaders.contentLengthHeader,
      'content-range',
      HttpHeaders.acceptRangesHeader,
    ]) {
      final v = upstream.headers[h];
      if (v != null) res.headers.set(h, v);
    }

    if (req.method == 'HEAD') {
      await upstream.cancel();
      await res.close();
      return;
    }

    try {
      await res.addStream(upstream.body); // backpressure-preserving
      await res.close();
    } catch (_) {
      // Client disconnect (seek/stop) → abort the upstream socket so it can't leak.
      await upstream.cancel();
    }
  }
}
