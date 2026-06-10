/// Connection details the app pairs to, stored from a successful pairing
/// `{ url, token, caFingerprint }` (plan 188, app-2 / srv-20). Pure data with
/// no platform dependencies, so it lives in the domain layer and is fully
/// unit-testable. `caFingerprint` is the server CA's SHA-256, verified against
/// the cert fetched from `/cert/root.crt` before the app pins it.
class PairedServer {
  const PairedServer({
    required this.url,
    required this.token,
    required this.caFingerprint,
    this.pairedAt,
  });

  final String url;
  final String token;
  final String caFingerprint;

  /// ISO-8601 timestamp this server was paired (set at save; null for legacy
  /// pairings predating this field). Surfaced as "paired since" in settings.
  final String? pairedAt;

  PairedServer copyWith({String? pairedAt}) => PairedServer(
        url: url,
        token: token,
        caFingerprint: caFingerprint,
        pairedAt: pairedAt ?? this.pairedAt,
      );

  factory PairedServer.fromJson(Map<String, dynamic> json) {
    final url = _requireNonEmptyString(json, 'url');
    final token = _requireNonEmptyString(json, 'token');
    final caFingerprint = _requireNonEmptyString(json, 'caFingerprint');
    return PairedServer(
      url: url,
      token: token,
      caFingerprint: caFingerprint,
      pairedAt: json['pairedAt'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
        'url': url,
        'token': token,
        'caFingerprint': caFingerprint,
        if (pairedAt != null) 'pairedAt': pairedAt,
      };

  static String _requireNonEmptyString(Map<String, dynamic> json, String key) {
    final value = json[key];
    if (value is! String || value.isEmpty) {
      throw FormatException('pairing payload missing a non-empty "$key"');
    }
    return value;
  }
}
