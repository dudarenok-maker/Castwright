/// Parsed companion pairing QR (`CWP1*host:port*code*fpTag`). Pure data, no
/// platform deps — fully unit-testable. Replaces the old JSON QR payload.
class PairingQr {
  const PairingQr({required this.hostPort, required this.code, required this.fpTag});

  final String hostPort;
  final String code;
  final String fpTag;

  String get baseUrl => 'https://$hostPort';

  factory PairingQr.parse(String raw) {
    final parts = raw.split('*');
    if (parts.length != 4 || parts[0] != 'CWP1') {
      throw const FormatException('not a CWP1 pairing payload');
    }
    final hostPort = parts[1], code = parts[2], fpTag = parts[3];
    if (hostPort.isEmpty || code.isEmpty || fpTag.isEmpty) {
      throw const FormatException('pairing payload has an empty field');
    }
    return PairingQr(hostPort: hostPort, code: code, fpTag: fpTag);
  }
}
