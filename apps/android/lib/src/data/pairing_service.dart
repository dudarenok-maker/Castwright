import 'dart:convert';
import 'dart:io';

import '../domain/paired_server.dart';
import '../domain/pairing_qr.dart';
import 'cert_pinning.dart';

enum PairingErrorKind { unreachable, fingerprintMismatch, tokenRejected, server }

class PairingException implements Exception {
  const PairingException(this.kind, this.message);
  final PairingErrorKind kind;
  final String message;
  @override
  String toString() => 'PairingException($kind): $message';
}

/// Thrown by a redeem fn when the server rejects the code (HTTP 401/410).
class RedeemRejected implements Exception {
  const RedeemRejected();
}

class Connection {
  const Connection({required this.server, required this.caPem});
  final PairedServer server;
  final String caPem;
}

class RedeemResult {
  const RedeemResult({required this.token, required this.caFingerprint});
  final String token;
  final String caFingerprint; // full SHA-256, stored on PairedServer
}

typedef CaFetcher = Future<String> Function(String baseUrl);
typedef TagVerifier = bool Function(String caPem, String fpTag);
typedef CodeRedeemer = Future<RedeemResult> Function(String baseUrl, String code, String caPem);

/// Pairs the app to a server (QR redesign):
/// 1. fetch the CA over an untrusted one-shot client,
/// 2. verify its 80-bit fingerprint tag == the QR's `fpTag` (else refuse),
/// 3. redeem the code over a CA-pinned client to mint a per-device token.
class PairingService {
  PairingService({CaFetcher? fetchCa, TagVerifier? verifyTag, CodeRedeemer? redeem})
      : _fetchCa = fetchCa ?? _defaultFetchCa,
        _verifyTag = verifyTag ?? fingerprintTagMatches,
        _redeem = redeem ?? _defaultRedeem;

  final CaFetcher _fetchCa;
  final TagVerifier _verifyTag;
  final CodeRedeemer _redeem;

  Future<Connection> pair(PairingQr qr, {required String label}) async {
    String caPem;
    try {
      caPem = await _fetchCa(qr.baseUrl);
    } catch (e) {
      throw PairingException(PairingErrorKind.unreachable,
          'Could not reach the server to fetch its certificate ($e).');
    }
    if (!_verifyTag(caPem, qr.fpTag)) {
      throw const PairingException(PairingErrorKind.fingerprintMismatch,
          'The server certificate did not match the pairing code. Refusing to pair.');
    }
    RedeemResult r;
    try {
      r = await _redeem(qr.baseUrl, qr.code, caPem);
    } on RedeemRejected {
      throw const PairingException(PairingErrorKind.tokenRejected,
          'The server rejected the pairing code. Re-scan a fresh code.');
    } catch (e) {
      throw PairingException(PairingErrorKind.unreachable,
          'Certificate verified, but redeeming the code failed ($e).');
    }
    final server = PairedServer(url: qr.baseUrl, token: r.token, caFingerprint: r.caFingerprint);
    return Connection(server: server, caPem: caPem);
  }
}

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

Future<RedeemResult> _defaultRedeem(String baseUrl, String code, String caPem) async {
  final ctx = SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(utf8.encode(caPem));
  final client = HttpClient(context: ctx);
  try {
    final req = await client.postUrl(Uri.parse('$baseUrl/api/pair/redeem'));
    req.headers.contentType = ContentType.json;
    req.write(jsonEncode({'code': code, 'label': Platform.localHostname}));
    final res = await req.close();
    if (res.statusCode == 401 || res.statusCode == 410) throw const RedeemRejected();
    if (res.statusCode >= 400) throw HttpException('redeem status ${res.statusCode}');
    final body = jsonDecode(await res.transform(utf8.decoder).join()) as Map<String, dynamic>;
    final token = body['token'] as String;
    return RedeemResult(token: token, caFingerprint: caFingerprintFromPem(caPem));
  } finally {
    client.close(force: true);
  }
}
