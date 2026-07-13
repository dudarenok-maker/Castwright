import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show visibleForTesting;

import '../domain/sync_manifest.dart';
import 'chapter_downloader.dart' show RangeFetch, RangeResponse;
import 'listen_stats_service.dart' show ListenStatsApi, StatDay;
import 'pairing_service.dart' show Connection;
import 'resume_sync_service.dart' show ListenProgressApi, RemoteProgress;
import 'sync_engine.dart' show ManifestApi;

/// Result of a raw HTTP send (status + body) — the injection seam that lets the
/// API client be unit-tested without real TLS.
class HttpResult {
  const HttpResult(this.statusCode, this.body);
  final int statusCode;
  final String body;
}

typedef HttpSend = Future<HttpResult> Function(
    String method, Uri url, Map<String, String> headers);

/// A streamed, CA-pinned range response for the loopback proxy (`app-10`). The
/// [body] is a single-subscription stream that preserves backpressure; [cancel]
/// aborts THIS request's socket via the held subscription — it never closes the
/// shared streaming client, so sibling concurrent range fetches keep running.
class PinnedStreamResponse {
  const PinnedStreamResponse({
    required this.statusCode,
    required this.headers,
    required this.body,
    required this.cancel,
  });
  final int statusCode;
  final Map<String, String> headers; // lower-cased header names
  final Stream<List<int>> body;
  final Future<void> Function() cancel;
}

class ApiException implements Exception {
  const ApiException(this.statusCode, this.message);
  final int statusCode;
  final String message;
  @override
  String toString() => 'ApiException($statusCode): $message';
}

/// Authenticated, CA-pinned HTTP client for the paired server (app-2). Every
/// request validates the server cert against the pinned CA (from pairing) and
/// carries the Bearer token. The transport is injectable for tests.
class ApiClient {
  ApiClient(this.connection,
      {HttpSend? send,
      this.requestTimeout = const Duration(seconds: 4),
      HttpClient Function(Connection)? httpClientFactory})
      : _makeClient = httpClientFactory ?? _pinnedHttpClient {
    if (send != null) {
      _send = send; // test transport: no owned client to close
    } else {
      final client = _makeClient(connection);
      _ownedSendClient = client;
      _send = _sendVia(client);
    }
  }

  final Connection connection;

  /// Builds a CA-pinned client for the long-lived owned transports (JSON send,
  /// range download, LAN stream). Overridable in tests via `httpClientFactory`.
  final HttpClient Function(Connection) _makeClient;

  late final HttpSend _send;

  /// The client backing the JSON [_send] transport when it wasn't injected —
  /// held so [dispose] can force-close it. Null when a test injects `send`.
  HttpClient? _ownedSendClient;

  /// Upper bound on a single JSON request. Offline, the connect fails fast via
  /// [_connectTimeout]; this is the backstop for a connection that opens but
  /// then stalls, so callers never spin indefinitely on a wedged server.
  final Duration requestTimeout;

  Uri _u(String path) => Uri.parse('${connection.server.url}$path');

  Future<Map<String, dynamic>> getJson(String path) async {
    final res = await _send('GET', _u(path), {
      HttpHeaders.authorizationHeader: 'Bearer ${connection.server.token}',
    }).timeout(requestTimeout);
    if (res.statusCode == 401 || res.statusCode == 403) {
      throw ApiException(res.statusCode, 'Not authorised — re-pair the device.');
    }
    if (res.statusCode >= 400) {
      throw ApiException(res.statusCode, 'Request to $path failed (${res.statusCode}).');
    }
    final decoded = jsonDecode(res.body);
    if (decoded is! Map<String, dynamic>) {
      throw ApiException(res.statusCode, 'Expected a JSON object from $path.');
    }
    return decoded;
  }

  /// GET /api/info — the server version / capabilities handshake (used to
  /// gate features + confirm the server is new enough for the sync manifest).
  Future<Map<String, dynamic>> info() => getJson('/api/info');

  /// GET /api/library/sync-manifest — the srv-32 INDEX (one row per book + the
  /// full active-book set). `?since=` (an ISO timestamp) trims the `books` list,
  /// never the active set.
  Future<SyncManifestIndex> syncManifestIndex({String? since}) async {
    final q = since == null ? '' : '?since=${Uri.encodeQueryComponent(since)}';
    return SyncManifestIndex.fromJson(await getJson('/api/library/sync-manifest$q'));
  }

  /// GET `/api/library/sync-manifest?bookId=` — the srv-32 per-book DETAIL
  /// (uuid-keyed chapters + the full active-chapter set).
  Future<SyncManifestBookDetail> syncManifestBookDetail(String bookId) async {
    return SyncManifestBookDetail.fromJson(await getJson(
        '/api/library/sync-manifest?bookId=${Uri.encodeQueryComponent(bookId)}'));
  }

  /// Adapter so this client satisfies the sync engine's [ManifestApi] port.
  ManifestApi get manifestApi => _ApiManifestApi(this);

  /// Adapter so this client satisfies the resume sync's [ListenProgressApi].
  ListenProgressApi get listenProgressApi => _ApiListenProgressApi(this);

  /// Adapter so this client satisfies the stats flush's [ListenStatsApi].
  ListenStatsApi get listenStatsApi => _ApiListenStatsApi(this);

  /// CA-pinned, authenticated GET returning the full response bytes (e.g. a
  /// book cover). Throws [ApiException] on >= 400 (404 = no cover).
  Future<List<int>> getBytes(String path) async {
    final fetch = pinnedRangeFetch();
    final res = await fetch(_u(path), const {});
    if (res.statusCode >= 400) {
      throw ApiException(res.statusCode, 'GET $path failed (${res.statusCode}).');
    }
    final out = <int>[];
    await for (final chunk in res.body) {
      out.addAll(chunk);
    }
    return out;
  }

  /// Per-chapter waveform peaks (240 normalized RMS bins) from the existing
  /// chapter-audio meta endpoint. Empty list on ANY failure — a missing or
  /// non-List `peaks` field, an HTTP error (ApiException), or a transport
  /// failure when the server is unreachable/offline (SocketException /
  /// TimeoutException). Callers treat "no peaks" as "show the plain bar", so
  /// this never throws.
  Future<List<double>> getChapterPeaks(String bookId, int chapterId) async {
    try {
      final j = await getJson('/api/books/$bookId/chapters/$chapterId/audio');
      final raw = j['peaks'];
      if (raw is List) {
        return [for (final e in raw) (e as num).toDouble()];
      }
    } catch (_) {
      /* HTTP error, offline transport, or malformed body → no waveform */
    }
    return const [];
  }

  /// GET the server resume bookmark; null when the server has none (404).
  Future<RemoteProgress?> getListenProgress(String bookId) async {
    try {
      final j = await getJson('/api/books/$bookId/listen-progress');
      return RemoteProgress(
        chapterUuid: j['chapterUuid'] as String?,
        chapterId: (j['chapterId'] as num?)?.toInt() ?? 0,
        currentSec: (j['currentSec'] as num?)?.toDouble() ?? 0,
        updatedAt: j['updatedAt'] as String? ?? '',
      );
    } on ApiException catch (e) {
      if (e.statusCode == 404) return null;
      rethrow;
    }
  }

  /// PUT a resume bookmark with the client [listenedAt] (srv-34). Real, CA-pinned
  /// transport (device-tested, like [pinnedRangeFetch]).
  Future<void> putListenProgress(
    String bookId, {
    required int chapterId,
    required double currentSec,
    required String listenedAt,
  }) async {
    final client = _pinnedHttpClient(connection);
    try {
      final req = await client.putUrl(_u('/api/books/$bookId/listen-progress'));
      req.headers.set(HttpHeaders.authorizationHeader,
          'Bearer ${connection.server.token}');
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode({
        'chapterId': chapterId,
        'currentSec': currentSec,
        'listenedAt': listenedAt,
      }));
      final res = await req.close();
      await res.drain<void>();
      if (res.statusCode >= 400) {
        throw ApiException(res.statusCode, 'listen-progress PUT failed');
      }
    } finally {
      client.close(force: true);
    }
  }

  /// Builds the JSON body for [setShelfStatus]: only the non-null flags are
  /// included so callers can pass a single changed field without overwriting
  /// the other on the server.
  @visibleForTesting
  Map<String, dynamic> shelfStatusBody({bool? finished, bool? hidden}) {
    final body = <String, dynamic>{};
    if (finished != null) body['finished'] = finished;
    if (hidden != null) body['hidden'] = hidden;
    return body;
  }

  /// POST the shelf status (finished and/or hidden) for a book to the server
  /// (app-19 cross-device finished sync). Only the supplied fields are included
  /// in the body — callers pass just the flag they changed. CA-pinned, same
  /// transport as [putListenProgress]. Best-effort — callers swallow errors via
  /// `.catchError((_) {})`.
  Future<void> setShelfStatus(String bookId,
      {bool? finished, bool? hidden}) async {
    final client = _pinnedHttpClient(connection);
    try {
      final body = shelfStatusBody(finished: finished, hidden: hidden);
      final req = await client.postUrl(
          _u('/api/books/${Uri.encodeComponent(bookId)}/shelf-status'));
      req.headers.set(
          HttpHeaders.authorizationHeader, 'Bearer ${connection.server.token}');
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode(body));
      final res = await req.close();
      await res.drain<void>();
      if (res.statusCode >= 400) {
        throw ApiException(res.statusCode, 'shelf-status POST failed');
      }
    } finally {
      client.close(force: true);
    }
  }

  /// PUT absolute listening-time accruals (fs-16). Body: `{ sessionId, days }`.
  /// CA-pinned, same transport as [putListenProgress].
  Future<void> putListenStats(
    String bookId, {
    required String sessionId,
    required List<StatDay> days,
  }) async {
    final client = _pinnedHttpClient(connection);
    try {
      final req = await client.putUrl(_u('/api/books/$bookId/listen-stats'));
      req.headers.set(
          HttpHeaders.authorizationHeader, 'Bearer ${connection.server.token}');
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode({
        'sessionId': sessionId,
        'days': [for (final d in days) {'date': d.date, 'seconds': d.seconds}],
      }));
      final res = await req.close();
      await res.drain<void>();
      if (res.statusCode >= 400) {
        throw ApiException(res.statusCode, 'listen-stats PUT failed');
      }
    } finally {
      client.close(force: true);
    }
  }

  /// A range-capable, CA-pinned, authenticated byte fetcher for chapter audio
  /// downloads — the engine's [RangeFetch] seam. Streams the response body so
  /// large chapters never buffer fully in memory; the `Range` header (set by the
  /// downloader on a resume) is forwarded verbatim.
  HttpClient? _rangeClient;

  RangeFetch pinnedRangeFetch() {
    // Reuse ONE pinned client across the download session's range fetches
    // (connection reuse), held so [dispose] can force-close it.
    final client = _rangeClient ??= _makeClient(connection);
    final token = connection.server.token;
    return (Uri url, Map<String, String> headers) async {
      final req = await client.getUrl(url);
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      headers.forEach(req.headers.set);
      final res = await req.close();
      return RangeResponse(statusCode: res.statusCode, body: res);
    };
  }

  HttpClient? _streamClient;

  /// A range-capable, CA-pinned, streamed byte fetcher for `app-10` LAN preview.
  /// Reuses ONE pinned client across concurrent range fetches in a playback
  /// session (connection reuse); each response's [PinnedStreamResponse.cancel]
  /// aborts only its own socket. The Bearer is injected here, so the loopback
  /// proxy never sees the token.
  Future<PinnedStreamResponse> pinnedRangeStream(Uri url, {String? range}) {
    final client = _streamClient ??= _makeClient(connection);
    return streamRange(client, url, bearer: connection.server.token, range: range);
  }

  /// Force-close every owned pinned client (JSON send, range download, LAN
  /// stream). Called from [CompanionRuntime.dispose] so a re-pair (new runtime →
  /// new [ApiClient]) doesn't orphan the old connection pools. The per-call
  /// clients in [putListenProgress]/[setShelfStatus]/[putListenStats] close
  /// themselves in their own `finally`, so they aren't tracked here. Idempotent —
  /// fields are nulled, so a second call is a no-op. (#1579)
  Future<void> dispose() async {
    _ownedSendClient?.close(force: true);
    _rangeClient?.close(force: true);
    _streamClient?.close(force: true);
    _ownedSendClient = null;
    _rangeClient = null;
    _streamClient = null;
  }
}

/// Wraps [ApiClient] as the engine-facing [ManifestApi].
class _ApiManifestApi implements ManifestApi {
  _ApiManifestApi(this._client);
  final ApiClient _client;

  @override
  Future<SyncManifestIndex> index({String? since}) =>
      _client.syncManifestIndex(since: since);

  @override
  Future<SyncManifestBookDetail> bookDetail(String bookId) =>
      _client.syncManifestBookDetail(bookId);
}

/// Wraps [ApiClient] as the stats flush's [ListenStatsApi].
class _ApiListenStatsApi implements ListenStatsApi {
  _ApiListenStatsApi(this._client);
  final ApiClient _client;

  @override
  Future<void> putListenStats(
    String bookId, {
    required String sessionId,
    required List<StatDay> days,
  }) =>
      _client.putListenStats(bookId, sessionId: sessionId, days: days);
}

/// Wraps [ApiClient] as the resume sync's [ListenProgressApi].
class _ApiListenProgressApi implements ListenProgressApi {
  _ApiListenProgressApi(this._client);
  final ApiClient _client;

  @override
  Future<RemoteProgress?> getListenProgress(String bookId) =>
      _client.getListenProgress(bookId);

  @override
  Future<void> putListenProgress(String bookId,
          {required int chapterId,
          required double currentSec,
          required String listenedAt}) =>
      _client.putListenProgress(bookId,
          chapterId: chapterId, currentSec: currentSec, listenedAt: listenedAt);
}

/// How long to wait for the TCP/TLS connection to the paired server before
/// giving up. Offline (server unreachable on the LAN) the connect would
/// otherwise hang until the OS-default timeout — tens of seconds — leaving the
/// library/player UIs spinning before their offline fallback can run. Bounding
/// it makes "server is gone" surface fast so the local-library path takes over.
const Duration _connectTimeout = Duration(seconds: 2);

/// Build the CA-pinned HttpClient shared by every real transport, with the
/// fast-fail [_connectTimeout] applied so offline connects don't hang.
HttpClient _pinnedHttpClient(Connection connection) {
  final ctx = SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(utf8.encode(connection.caPem));
  return HttpClient(context: ctx)..connectionTimeout = _connectTimeout;
}

/// Real transport: sends over the given (CA-pinned) [client], reusing its one
/// connection pool for the paired server's lifetime. The client is owned by the
/// [ApiClient] (held as `_ownedSendClient`) so it can be force-closed on dispose.
HttpSend _sendVia(HttpClient client) {
  return (method, url, headers) async {
    final req = await client.openUrl(method, url);
    headers.forEach(req.headers.set);
    final res = await req.close();
    final body = await res.transform(utf8.decoder).join();
    return HttpResult(res.statusCode, body);
  };
}

/// Transport core for [ApiClient.pinnedRangeStream], split out so the streaming +
/// cancel behaviour is unit-testable against a real plaintext `HttpServer`
/// (production passes the CA-pinned client). Holds the response subscription so
/// [PinnedStreamResponse.cancel] tears down ONLY this socket.
@visibleForTesting
Future<PinnedStreamResponse> streamRange(HttpClient client, Uri url,
    {required String bearer, String? range}) async {
  final req = await client.getUrl(url);
  req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
  if (range != null) req.headers.set(HttpHeaders.rangeHeader, range);
  final res = await req.close();

  final headers = <String, String>{};
  res.headers.forEach((name, values) => headers[name] = values.join(','));

  final out = StreamController<List<int>>();
  // Subscribe EAGERLY (then pause) — not lazily in onListen — so `cancel()` can
  // always tear down the real socket, even on a HEAD / non-2xx path where the
  // body is never drained (`addStream` never fires onListen). A lazy subscription
  // would leave the HttpClientResponse dangling on every HEAD probe and every
  // 401/404/5xx upstream. dart:io delivers events async, so the pause below can't
  // race a synchronous first event.
  final sub = res.listen(
    out.add,
    onError: out.addError,
    onDone: () {
      if (!out.isClosed) out.close();
    },
    cancelOnError: true,
  );
  sub.pause();
  out.onListen = () => sub.resume();
  out.onPause = () => sub.pause();
  out.onResume = () => sub.resume();
  out.onCancel = () => sub.cancel();

  Future<void> cancel() async {
    await sub.cancel(); // abort THIS socket only — never client.close()
    if (!out.isClosed) {
      // A single-subscription StreamController's close() future only resolves
      // once a listener has drained the "done" event — on a HEAD request or a
      // non-2xx upstream relay the body is never listened to, so awaiting an
      // unconditional close() here would hang forever. Await only when there's
      // actually a listener to deliver the done event to.
      if (out.hasListener) {
        await out.close();
      } else {
        out.close();
      }
    }
  }

  return PinnedStreamResponse(
    statusCode: res.statusCode,
    headers: headers,
    body: out.stream,
    cancel: cancel,
  );
}
