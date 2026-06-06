/// Connection details the app pairs to, parsed from the pairing QR payload
/// `{ url, token, caFingerprint }` (plan 188, app-2 / srv-20). Pure data with
/// no platform dependencies, so it lives in the domain layer and is fully
/// unit-testable. `caFingerprint` is the server CA's SHA-256, verified against
/// the cert fetched from `/cert/root.crt` before the app pins it.
class PairedServer {
  const PairedServer({
    required this.url,
    required this.token,
    required this.caFingerprint,
  });

  final String url;
  final String token;
  final String caFingerprint;

  factory PairedServer.fromJson(Map<String, dynamic> json) {
    final url = _requireNonEmptyString(json, 'url');
    final token = _requireNonEmptyString(json, 'token');
    final caFingerprint = _requireNonEmptyString(json, 'caFingerprint');
    return PairedServer(url: url, token: token, caFingerprint: caFingerprint);
  }

  Map<String, dynamic> toJson() => {
        'url': url,
        'token': token,
        'caFingerprint': caFingerprint,
      };

  static String _requireNonEmptyString(Map<String, dynamic> json, String key) {
    final value = json[key];
    if (value is! String || value.isEmpty) {
      throw FormatException('pairing payload missing a non-empty "$key"');
    }
    return value;
  }
}
