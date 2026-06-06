import 'dart:convert';
import 'dart:io';

import '../domain/paired_server.dart';
import 'cert_pinning.dart';

/// Why a pairing attempt failed — drives the user-facing error copy.
enum PairingErrorKind { unreachable, fingerprintMismatch, tokenRejected, server }

class PairingException implements Exception {
  const PairingException(this.kind, this.message);
  final PairingErrorKind kind;
  final String message;
  @override
  String toString() => 'PairingException($kind): $message';
}

/// A successful pairing: the verified base URL + token + the pinned CA (PEM),
/// ready to build authenticated, cert-pinned requests from.
class Connection {
  const Connection({required this.server, required this.caPem});
  final PairedServer server;
  final String caPem;
}

/// Fetches the server CA (`/cert/root.crt`) over an *untrusted* channel —
/// injectable so the pairing flow is unit-testable without real TLS.
typedef CaFetcher = Future<String> Function(String baseUrl);

/// Probes an authenticated, cert-pinned endpoint to confirm the token works —
/// injectable for the same reason. Returns the HTTP status code.
typedef AuthProbe = Future<int> Function(PairedServer server, String caPem);

/// Pairs the app to a server (plan 188, app-2 / srv-20):
/// 1. fetch the CA over a one-shot validation-bypassing client,
/// 2. verify its SHA-256 == the QR's `caFingerprint` (else refuse),
/// 3. probe an /api endpoint with the token over a CA-pinned client.
class PairingService {
  PairingService({CaFetcher? fetchCa, AuthProbe? probe})
      : _fetchCa = fetchCa ?? _defaultFetchCa,
        _probe = probe ?? _defaultProbe;

  final CaFetcher _fetchCa;
  final AuthProbe _probe;

  Future<Connection> pair(PairedServer server) async {
    String caPem;
    try {
      caPem = await _fetchCa(server.url);
    } catch (e) {
      throw PairingException(
        PairingErrorKind.unreachable,
        'Could not reach the server to fetch its certificate ($e).',
      );
    }

    if (!verifyCaFingerprint(caPem, server.caFingerprint)) {
      throw const PairingException(
        PairingErrorKind.fingerprintMismatch,
        'The server certificate did not match the pairing code. Refusing to '
        'pair — this could be a man-in-the-middle.',
      );
    }

    int status;
    try {
      status = await _probe(server, caPem);
    } catch (e) {
      throw PairingException(
        PairingErrorKind.unreachable,
        'Paired certificate verified, but the authenticated probe failed ($e).',
      );
    }
    if (status == 401 || status == 403) {
      throw const PairingException(
        PairingErrorKind.tokenRejected,
        'The server rejected the access token. Re-scan the current pairing code.',
      );
    }
    if (status >= 400) {
      throw PairingException(
        PairingErrorKind.server,
        'The server returned an unexpected status ($status).',
      );
    }
    return Connection(server: server, caPem: caPem);
  }
}

/// Default CA fetch: a one-shot client that accepts the (not-yet-trusted)
/// self-signed cert ONLY to download `/cert/root.crt`; the bytes are then
/// fingerprint-verified before anything is trusted.
Future<String> _defaultFetchCa(String baseUrl) async {
  final client = HttpClient()..badCertificateCallback = (_, _, _) => true;
  try {
    final req = await client.getUrl(Uri.parse('$baseUrl/cert/root.crt'));
    final res = await req.close();
    return await res.transform(utf8.decoder).join();
  } finally {
    client.close(force: true);
  }
}

/// Default authenticated probe: GET `/api/info` over a client that trusts ONLY
/// the just-verified CA, with the Bearer token.
Future<int> _defaultProbe(PairedServer server, String caPem) async {
  final ctx = SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(utf8.encode(caPem));
  final client = HttpClient(context: ctx);
  try {
    final req = await client.getUrl(Uri.parse('${server.url}/api/info'));
    req.headers.set(HttpHeaders.authorizationHeader, 'Bearer ${server.token}');
    final res = await req.close();
    await res.drain<void>();
    return res.statusCode;
  } finally {
    client.close(force: true);
  }
}
