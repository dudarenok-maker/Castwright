/* Crockford base32 (no padding) — encode-only. Used for the ephemeral pairing
   code and the 80-bit CA fingerprint tag in the companion pairing QR. Output is
   a subset of QR alphanumeric mode, so the QR stays in its densest encoding.
   Alphabet excludes I, L, O, U to avoid visual ambiguity in manual entry. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function crockfordBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}
