import 'dart:convert';
import 'dart:io';

import 'pairing_service.dart' show Connection;

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
  ApiClient(this.connection, {HttpSend? send})
      : _send = send ?? _pinnedSend(connection);

  final Connection connection;
  final HttpSend _send;

  Uri _u(String path) => Uri.parse('${connection.server.url}$path');

  Future<Map<String, dynamic>> getJson(String path) async {
    final res = await _send('GET', _u(path), {
      HttpHeaders.authorizationHeader: 'Bearer ${connection.server.token}',
    });
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
}

/// Real transport: a `dart:io` HttpClient that trusts ONLY the pinned CA and
/// reuses one connection pool for the paired server's lifetime.
HttpSend _pinnedSend(Connection connection) {
  final ctx = SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(utf8.encode(connection.caPem));
  final client = HttpClient(context: ctx);
  return (method, url, headers) async {
    final req = await client.openUrl(method, url);
    headers.forEach(req.headers.set);
    final res = await req.close();
    final body = await res.transform(utf8.decoder).join();
    return HttpResult(res.statusCode, body);
  };
}
