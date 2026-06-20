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
      {HttpSend? send, this.requestTimeout = const Duration(seconds: 4)})
      : _send = send ?? _pinnedSend(connection);

  final Connection connection;
  final HttpSend _send;

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
  RangeFetch pinnedRangeFetch() {
    final client = _pinnedHttpClient(connection);
    final token = connection.server.token;
    return (Uri url, Map<String, String> headers) async {
      final req = await client.getUrl(url);
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      headers.forEach(req.headers.set);
      final res = await req.close();
      return RangeResponse(statusCode: res.statusCode, body: res);
    };
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

/// Real transport: a `dart:io` HttpClient that trusts ONLY the pinned CA and
/// reuses one connection pool for the paired server's lifetime.
HttpSend _pinnedSend(Connection connection) {
  final client = _pinnedHttpClient(connection);
  return (method, url, headers) async {
    final req = await client.openUrl(method, url);
    headers.forEach(req.headers.set);
    final res = await req.close();
    final body = await res.transform(utf8.decoder).join();
    return HttpResult(res.statusCode, body);
  };
}
