import { describe, it, expect } from 'vitest';
import QRCode from 'qrcode';

/* Regression for the real-phone pairing-scan failure (2026-06-10).

   The RETIRED pairing QR encoded `{url, token, caFingerprint}` as JSON — 193+
   chars → QR version 10 (57×57 modules). flutter_zxing (zxing-cpp) could not
   decode that dense code captured off a screen, even though the phone's native
   camera could (proven by decoding the user's real camera frames through the
   same engine: 0/8 decoded).

   The fix shrinks the QR by carrying a compact `CWP1*host:port*code*fpTag`
   payload instead. These assertions lock the density win so the QR can never
   silently regress back to an unscannable version. The QRCode options here
   (errorCorrectionLevel 'M') mirror the modal's `QRCode.toDataURL` call in
   `pair-device.tsx`.

   Spec: docs/superpowers/specs/2026-06-10-pairing-qr-redesign-design.md */
describe('pairing QR density (scan-failure regression)', () => {
  // Worst-case realistic payload: longest IPv4 + port, 8-char code, 16-char tag.
  const cwp1Payload = 'CWP1*255.255.255.255:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R';

  it('encodes to a low-version (≤ 4) QR the scanner can read', () => {
    const qr = QRCode.create(cwp1Payload, { errorCorrectionLevel: 'M' });
    expect(qr.version).toBeLessThanOrEqual(4);
  });

  it('is a strictly smaller QR than the retired JSON payload', () => {
    const retiredJson = JSON.stringify({
      url: 'https://255.255.255.255:8443',
      token: 'Q'.repeat(32),
      caFingerprint: Array.from({ length: 32 }, () => 'AB').join(':'),
    });
    const retiredVersion = QRCode.create(retiredJson, { errorCorrectionLevel: 'M' }).version;
    const cwp1Version = QRCode.create(cwp1Payload, { errorCorrectionLevel: 'M' }).version;
    expect(cwp1Version).toBeLessThan(retiredVersion);
  });
});
