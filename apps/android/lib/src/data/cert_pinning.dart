import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'crockford_base32.dart';

/// Cert-fingerprint pinning for the pairing flow (plan 188, app-2 / srv-20).
///
/// The server's pairing QR carries `caFingerprint` — the SHA-256 (X.509
/// fingerprint256) of its mkcert root CA. At pair time the app fetches
/// `/cert/root.crt` over a one-shot, validation-bypassing client, computes the
/// same fingerprint here, and pins the CA **only if it matches** — automated
/// MitM protection with no manual hex compare and no OS-level cert install.
///
/// These are pure functions (no `dart:io`, no platform deps) so the security
/// logic is fully unit-testable without a device.

/// Decodes the DER bytes from a PEM `CERTIFICATE` block (strips the
/// `-----BEGIN/END-----` armor and base64-decodes the body).
List<int> pemToDer(String pem) {
  final body = pem
      .split(RegExp(r'\r?\n'))
      .where((l) => l.isNotEmpty && !l.startsWith('-----'))
      .join();
  return base64.decode(body);
}

/// Formats a digest as Node's `X509Certificate.fingerprint256` does:
/// uppercase hex, colon-separated (e.g. `AB:CD:01`).
String formatFingerprint(List<int> digest) =>
    digest.map((b) => b.toRadixString(16).padLeft(2, '0').toUpperCase()).join(':');

/// SHA-256 fingerprint of the certificate in [pem], matching the server's
/// `caFingerprint`.
String caFingerprintFromPem(String pem) =>
    formatFingerprint(sha256.convert(pemToDer(pem)).bytes);

/// Compares two fingerprints, ignoring case and any non-hex separators
/// (`:`, whitespace) so formatting differences never cause a false mismatch.
bool fingerprintsMatch(String a, String b) {
  String norm(String s) => s.replaceAll(RegExp('[^0-9a-fA-F]'), '').toUpperCase();
  final na = norm(a);
  return na.isNotEmpty && na == norm(b);
}

/// True when the fetched CA [pem] matches the [expected] pinned fingerprint.
bool verifyCaFingerprint(String pem, String expected) =>
    fingerprintsMatch(caFingerprintFromPem(pem), expected);

/// True when [tag] equals the Crockford-base32 of the first 10 bytes (80 bits)
/// of the certificate's SHA-256 — the QR's compact integrity tag. Normalised to
/// upper-case alphanumerics so case differences never cause a false mismatch.
bool fingerprintTagMatches(String pem, String tag) {
  final digest = sha256.convert(pemToDer(pem)).bytes;
  final expected = crockfordBase32(digest.sublist(0, 10));
  String norm(String s) => s.toUpperCase().replaceAll(RegExp('[^0-9A-Z]'), '');
  return norm(expected) == norm(tag);
}
