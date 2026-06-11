/// Parsed companion pairing QR (`CWP1*host:port*code*fpTag`). Pure data, no
/// platform deps — fully unit-testable. Replaces the old JSON QR payload.
class PairingQr {
  const PairingQr({required this.hostPort, required this.code, required this.fpTag});

  final String hostPort;
  final String code;
  final String fpTag;

  String get baseUrl => 'https://$hostPort';

  factory PairingQr.parse(String raw) {
    final trimmed = raw.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return PairingQr._fromUrl(trimmed);
    }
    return PairingQr._fromCwp1(trimmed);
  }

  /// Legacy/compact form: `CWP1*host:port*code*fpTag`.
  factory PairingQr._fromCwp1(String raw) {
    final parts = raw.split('*');
    if (parts.length != 4 || parts[0] != 'CWP1') {
      throw const FormatException('not a CWP1 pairing payload');
    }
    return PairingQr._checked(parts[1], parts[2], parts[3]);
  }

  /// Deep-link form: `https://castwright.ai/pair?h=host:port&c=code&f=fpTag`.
  factory PairingQr._fromUrl(String raw) {
    final uri = Uri.tryParse(raw);
    if (uri == null) throw const FormatException('unparseable pairing URL');
    final q = uri.queryParameters;
    return PairingQr._checked(q['h'] ?? '', q['c'] ?? '', q['f'] ?? '');
  }

  factory PairingQr._checked(String hostPort, String code, String fpTag) {
    if (hostPort.isEmpty || code.isEmpty || fpTag.isEmpty) {
      throw const FormatException('pairing payload has an empty field');
    }
    return PairingQr(hostPort: hostPort, code: code, fpTag: fpTag);
  }
}
