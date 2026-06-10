/// Crockford base32 (no padding), encode-only. Mirrors the server's
/// `crockford-base32.ts` so the companion can recompute the CA fingerprint tag
/// and compare it to the QR's `fpTag`. Alphabet excludes I, L, O, U.
const _alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

String crockfordBase32(List<int> bytes) {
  final out = StringBuffer();
  var buffer = 0, bits = 0;
  for (final byte in bytes) {
    buffer = (buffer << 8) | (byte & 0xff);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.write(_alphabet[(buffer >> bits) & 0x1f]);
    }
  }
  if (bits > 0) out.write(_alphabet[(buffer << (5 - bits)) & 0x1f]);
  return out.toString();
}
